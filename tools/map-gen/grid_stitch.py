"""
Grid-aware stitcher for Arma Reforger map tiles.

Each tile contains a 1km × 1km cell (bounded by thick gridlines) roughly
centered in the capture. This script:

  1. Detects the thick 1km gridlines in every tile (they're ~1.4× the height
     of the thin 100m lines in a 1D projection of pixel darkness).
  2. Picks the two thick-line positions that bracket the tile's center.
     That rectangle is the tile's "core 1km cell".
  3. Crops each tile to its core cell, resizes to a uniform target size,
     and butt-joins them into a perfectly gridded mosaic.

No feature matching. Per-tile scale is measured independently, so variable
zoom between captures is corrected for. Pure-water tiles work fine because
the gridlines are still visible on water.

Filename convention: RR-CC.png, row 01 = south (bottom), col 01 = west (left).

Usage:
  py grid_stitch.py <input_dir> [-o out.png] [--target 500] \\
                    [--world-bl 0,0 --world-ur 12800,12800]
"""

from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

import cv2
import numpy as np


GRID_NAME_RE = re.compile(r"^(\d{2})-(\d{2})\.png$", re.IGNORECASE)


def parse_grid_name(name: str) -> tuple[int, int] | None:
    m = GRID_NAME_RE.match(name)
    if m is None:
        return None
    return int(m.group(1)), int(m.group(2))


def find_1d_peaks(arr: np.ndarray, min_dist: int = 30, min_height: float = 0.2) -> np.ndarray:
    """Tiny local-maximum peak finder; no scipy dependency."""
    peaks: list[int] = []
    for i in range(1, len(arr) - 1):
        if arr[i] >= min_height and arr[i] > arr[i - 1] and arr[i] >= arr[i + 1]:
            if not peaks or i - peaks[-1] >= min_dist:
                peaks.append(i)
            elif arr[i] > arr[peaks[-1]]:
                peaks[-1] = i
    return np.array(peaks, dtype=int)


def detect_gridlines_axis(img_bgr: np.ndarray, axis: int):
    """
    axis=0 → sum down columns → peaks are vertical-line x-positions.
    axis=1 → sum across rows   → peaks are horizontal-line y-positions.

    Returns (all_peaks, thick_peaks, thin_spacing_px).
    Thick = upper-quantile peak heights (1km lines stand out above 100m lines).
    """
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    dark = 255 - gray
    proj = dark.sum(axis=axis).astype(np.float32)
    rng = proj.max() - proj.min()
    if rng <= 0:
        return np.array([]), np.array([]), None
    proj = (proj - proj.min()) / rng

    peaks = find_1d_peaks(proj, min_dist=30, min_height=0.2)
    if len(peaks) < 2:
        return peaks, np.array([], dtype=int), None

    # Estimate thin-line spacing — median of peak-to-peak distances that look
    # like 100m (roughly 80–150px at typical zoom).
    diffs = np.diff(peaks)
    candidate = diffs[(diffs >= 50) & (diffs <= 200)]
    thin_spacing = float(np.median(candidate)) if len(candidate) else float(np.median(diffs))

    # Thick peaks = tallest.  Thin lines cluster around ~0.72 in our samples,
    # thick lines around 1.0.  Use the 85th percentile of peak heights but
    # never below 0.85 as the threshold.
    heights = proj[peaks]
    cutoff = max(0.85, float(np.percentile(heights, 85)))
    thick = peaks[heights >= cutoff]

    return peaks, thick, thin_spacing


def find_center_cell_bounds(thick_peaks: np.ndarray, center: int, px_per_km: float):
    """
    Pick the two thick-line positions that bracket `center`. Returns (lo, hi)
    or None if (a) no line on one side or (b) the cell width is far off
    from the expected px_per_km (±15%).
    """
    left = [p for p in thick_peaks if p <= center]
    right = [p for p in thick_peaks if p >= center]
    if not left or not right:
        return None
    lo = int(max(left))
    hi = int(min(right))
    width = hi - lo
    if width <= 0:
        return None
    if abs(width - px_per_km) / px_per_km > 0.15:
        return None
    return (lo, hi)


def bracket_center_with_thick_lines(thick_peaks: np.ndarray, center: int):
    """Pick the two thick-line positions bracketing `center`.
    Returns (lo, hi) or None if no bracketing pair exists. No sanity check —
    thick-line distance is itself the 1km ground truth."""
    left = [p for p in thick_peaks if p <= center]
    right = [p for p in thick_peaks if p >= center]
    if not left or not right:
        return None
    lo = int(max(left))
    hi = int(min(right))
    if hi <= lo:
        return None
    return (lo, hi)


def synthesize_bounds_from_one_side(thick_peaks: np.ndarray, center: int, px_per_km: float):
    """Fallback when only one thick line exists on this axis (edge-row / edge-col
    captures where the opposite boundary is at/beyond the terrain edge). Uses the
    single available thick line plus a known px_per_km to infer the missing side.
    Returns (lo, hi, direction) where direction is 'synth_low' or 'synth_high'
    indicating which side was synthesized, or None if no thick line at all."""
    left = [p for p in thick_peaks if p <= center]
    right = [p for p in thick_peaks if p >= center]
    if left and not right:
        lo = int(max(left))
        hi = int(round(lo + px_per_km))
        return (lo, hi, "synth_high")
    if right and not left:
        hi = int(min(right))
        lo = int(round(hi - px_per_km))
        return (lo, hi, "synth_low")
    return None


def crop_with_padding(img: np.ndarray, top: int, bot: int, left: int, right: int) -> np.ndarray:
    """Crop img[top:bot, left:right] but pad with black when the region extends
    past the image bounds. Used for edge-row/col tiles where a synthesized
    boundary lands outside the captured frame (off-terrain area)."""
    h, w = img.shape[:2]
    out_h = bot - top
    out_w = right - left
    out = np.zeros((out_h, out_w, 3), dtype=np.uint8)
    src_top = max(0, top)
    src_bot = min(h, bot)
    src_left = max(0, left)
    src_right = min(w, right)
    if src_top >= src_bot or src_left >= src_right:
        return out
    dst_top = src_top - top
    dst_left = src_left - left
    out[dst_top:dst_top + (src_bot - src_top),
        dst_left:dst_left + (src_right - src_left)] = img[src_top:src_bot, src_left:src_right]
    return out


def process_tile(path: Path, target_size: int, fallback_px_per_km: float | None = None):
    img = cv2.imread(str(path))
    if img is None:
        return None, "failed to read"
    h, w = img.shape[:2]

    _, thick_v, thin_v = detect_gridlines_axis(img, axis=0)
    _, thick_h, thin_h = detect_gridlines_axis(img, axis=1)

    v_bounds = bracket_center_with_thick_lines(thick_v, w // 2)
    h_bounds = bracket_center_with_thick_lines(thick_h, h // 2)

    # Prefer same-tile cross-axis span for synthesis; fall back to caller-provided
    # median from tiles that fully bracketed. This keeps per-tile zoom correction
    # intact whenever possible.
    v_span = (v_bounds[1] - v_bounds[0]) if v_bounds else None
    h_span = (h_bounds[1] - h_bounds[0]) if h_bounds else None
    if v_span is not None and h_span is not None:
        px_per_km = float(np.mean([v_span, h_span]))
    elif v_span is not None:
        px_per_km = float(v_span)
    elif h_span is not None:
        px_per_km = float(h_span)
    elif fallback_px_per_km is not None:
        px_per_km = float(fallback_px_per_km)
    else:
        return None, (f"no thick lines bracket center on either axis "
                      f"(thick at x={list(thick_v)}, y={list(thick_h)})")

    synth_notes: list[str] = []
    if v_bounds is None:
        synth = synthesize_bounds_from_one_side(thick_v, w // 2, px_per_km)
        if synth is None:
            return None, f"no thick-V line to anchor synthesis (thick at x={list(thick_v)})"
        v_bounds = (synth[0], synth[1])
        synth_notes.append(f"V {synth[2]}")
    if h_bounds is None:
        synth = synthesize_bounds_from_one_side(thick_h, h // 2, px_per_km)
        if synth is None:
            return None, f"no thick-H line to anchor synthesis (thick at y={list(thick_h)})"
        h_bounds = (synth[0], synth[1])
        synth_notes.append(f"H {synth[2]}")

    left, right = v_bounds
    top, bot = h_bounds

    # Sanity: the two spans should agree within ±15% (near-square 1km cell).
    # Only enforce when both axes were bracketed from real thick lines; a
    # synthesized bound is constructed to match px_per_km exactly by design.
    if not synth_notes and abs((right - left) - (bot - top)) / px_per_km > 0.15:
        return None, f"V-span {right-left} and H-span {bot-top} disagree > 15%"

    crop = crop_with_padding(img, top, bot, left, right)
    resized = cv2.resize(crop, (target_size, target_size), interpolation=cv2.INTER_AREA)
    note = ("; ".join(synth_notes)) if synth_notes else None
    return (resized, px_per_km, note), None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("input_dir", type=Path, help="Directory of RR-CC.png tiles")
    ap.add_argument("-o", "--output", type=Path, default=Path("stitched.png"))
    ap.add_argument("--target", type=int, default=500,
                    help="Pixel size per 1km tile in the output (default 500 → 500 m/px = 2 m/km)")
    ap.add_argument("--world-bl", type=str, default=None, help="e.g. '0,0'")
    ap.add_argument("--world-ur", type=str, default=None, help="e.g. '12800,12800'")
    args = ap.parse_args()

    paths = sorted(p for p in args.input_dir.glob("*.png") if not p.name.startswith("_"))
    if not paths:
        sys.exit(f"No PNG tiles in {args.input_dir}")

    print(f"Processing {len(paths)} tiles (target {args.target}px per 1km cell)...")
    tiles: dict[tuple[int, int], np.ndarray] = {}
    scales: list[float] = []
    deferred: list[tuple[tuple[int, int], Path]] = []
    skipped: list[tuple[str, str]] = []
    synth_tiles: list[tuple[str, str]] = []

    # Pass 1: try each tile without a fallback. Tiles with thick lines on both
    # axes (or at least one axis) succeed here and seed px/km. Tiles that can't
    # find any thick line on one axis get deferred to pass 2.
    for p in paths:
        rc = parse_grid_name(p.name)
        if rc is None:
            skipped.append((p.name, "filename not RR-CC.png"))
            continue
        result, err = process_tile(p, args.target, fallback_px_per_km=None)
        if result is None:
            deferred.append((rc, p))
            continue
        crop, pxkm, note = result
        tiles[rc] = crop
        scales.append(pxkm)
        if note:
            synth_tiles.append((p.name, note))

    # Pass 2: retry deferred tiles using the median px/km from pass 1 as the
    # synthesis fallback. This rescues tiles whose single visible thick line
    # can't anchor to same-tile cross-axis data (pure-edge captures).
    if deferred:
        fallback_pxkm = float(np.median(scales)) if scales else None
        for rc, p in deferred:
            result, err = process_tile(p, args.target, fallback_px_per_km=fallback_pxkm)
            if result is None:
                skipped.append((p.name, err))
                continue
            crop, pxkm, note = result
            tiles[rc] = crop
            scales.append(pxkm)
            if note:
                synth_tiles.append((p.name, note))

    if scales:
        print(f"Detected px/km: min={min(scales):.1f}  max={max(scales):.1f}  median={np.median(scales):.1f}")

    if synth_tiles:
        print(f"\nSynthesized boundaries on {len(synth_tiles)} edge tile(s):")
        for name, note in synth_tiles[:20]:
            print(f"  {name}: {note}")
        if len(synth_tiles) > 20:
            print(f"  ... +{len(synth_tiles) - 20} more")

    if skipped:
        print(f"\nSkipped {len(skipped)} tile(s):")
        for name, err in skipped[:20]:
            print(f"  {name}: {err}")
        if len(skipped) > 20:
            print(f"  ... +{len(skipped) - 20} more")

    if not tiles:
        sys.exit("No tiles could be processed.")

    rows = sorted({r for r, _ in tiles})
    cols = sorted({c for _, c in tiles})
    max_row = max(rows)
    min_col = min(cols)
    print(f"\nGrid extent: rows {rows[0]}..{rows[-1]}, cols {cols[0]}..{cols[-1]}, placing {len(tiles)} tiles")

    T = args.target
    canvas_w = len(cols) * T
    canvas_h = len(rows) * T
    canvas = np.zeros((canvas_h, canvas_w, 3), dtype=np.uint8)

    for (r, c), tile in tiles.items():
        cy = (max_row - r) * T          # row 1 → bottom of canvas
        cx = (c - min_col) * T          # col 1 → left of canvas
        canvas[cy:cy + T, cx:cx + T] = tile

    args.output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(args.output), canvas)
    print(f"\nWrote {args.output}  ({canvas_w}×{canvas_h})")

    if args.world_bl and args.world_ur:
        wbl = [float(x) for x in args.world_bl.split(",")]
        wur = [float(x) for x in args.world_ur.split(",")]
        meta = {
            "image": args.output.name,
            "width": canvas_w,
            "height": canvas_h,
            "worldBounds": {"bottomLeft": wbl, "upperRight": wur},
            "metersPerPixelX": (wur[0] - wbl[0]) / canvas_w,
            "metersPerPixelY": (wur[1] - wbl[1]) / canvas_h,
        }
        sidecar = args.output.with_suffix(".json")
        sidecar.write_text(json.dumps(meta, indent=2))
        print(f"Wrote {sidecar}")


if __name__ == "__main__":
    main()
