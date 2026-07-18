"""
Stitch a set of overlapping Arma Reforger map screenshots into a single mosaic.

Two modes, auto-selected from filenames:

  FEATURE MODE (default, arbitrary filenames)
    ORB feature matching pairwise, with a 2D-histogram vote on per-match
    translation vectors, then a greedy max-spanning-tree walk.

  GRID MODE (filenames like "RR-CC.png" — e.g. 01-01 through 13-13)
    Filename encodes the tile's grid position (row-col), where row=01 is the
    bottom row and col=01 is the leftmost column. Feature matching is still
    used, but ONLY between neighboring tiles — and the results are used to
    derive a uniform horizontal / vertical step vector. Every tile is then
    placed deterministically from its grid coords. This is robust even when
    many tiles are visually identical (e.g. open ocean) because only a handful
    of successful matches among terrain tiles are needed to fix the grid.

Other assumptions:
  - All inputs are the 2D map widget at the same zoom level (pure translation).
  - No rotation, no scale change.
  - Input filenames starting with "_" are ignored (reserved for outputs).

Usage:
  py stitch_maps.py <input_dir> [-o output.png] [--no-crop] [--blend] \\
                    [--world-bl X,Y --world-ur X,Y]
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
    return int(m.group(1)), int(m.group(2))  # (row, col)


def detect_features(img_bgr: np.ndarray, n_features: int = 5000):
    """ORB keypoints + descriptors on grayscale."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    orb = cv2.ORB_create(nfeatures=n_features)
    kps, desc = orb.detectAndCompute(gray, None)
    return kps, desc


def pairwise_translation(kps_a, desc_a, kps_b, desc_b, min_matches: int = 15):
    """
    Returns (offset, inlier_count) where offset is (dx, dy) such that
    the origin of image B sits at (dx, dy) in image A's coordinate frame.
    Returns None if the pair doesn't overlap reliably.

    Uses 2D histogram voting on per-match translation vectors — robust to
    maps with repetitive grid patterns that produce clusters of spurious
    matches at regular offsets.
    """
    if desc_a is None or desc_b is None:
        return None

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = bf.match(desc_a, desc_b)
    if len(matches) < min_matches:
        return None

    # For each match, compute the translation vector that would align b to a.
    # If B's origin sits at (tx, ty) in A's frame, then for matched points:
    # p_a == p_b + (tx, ty) -> t = p_a - p_b
    t_vectors = np.array(
        [
            (kps_a[m.queryIdx].pt[0] - kps_b[m.trainIdx].pt[0],
             kps_a[m.queryIdx].pt[1] - kps_b[m.trainIdx].pt[1])
            for m in matches
        ],
        dtype=np.float64,
    )

    # 2D histogram vote. Bin size 4 px — narrow enough to separate nearby
    # grid-cell aliases, wide enough to absorb sub-pixel match noise.
    bin_size = 4.0
    x_min, x_max = t_vectors[:, 0].min(), t_vectors[:, 0].max()
    y_min, y_max = t_vectors[:, 1].min(), t_vectors[:, 1].max()
    nx = max(2, int(np.ceil((x_max - x_min) / bin_size)))
    ny = max(2, int(np.ceil((y_max - y_min) / bin_size)))
    hist, x_edges, y_edges = np.histogram2d(
        t_vectors[:, 0], t_vectors[:, 1], bins=[nx, ny]
    )
    peak_ix, peak_iy = np.unravel_index(hist.argmax(), hist.shape)
    peak_count = int(hist[peak_ix, peak_iy])
    if peak_count < min_matches:
        return None

    # Refine: take the median of all matches whose translation falls within
    # one bin of the peak (±bin_size/2 widened to ±bin_size for safety).
    cx = (x_edges[peak_ix] + x_edges[peak_ix + 1]) / 2
    cy = (y_edges[peak_iy] + y_edges[peak_iy + 1]) / 2
    keep = (np.abs(t_vectors[:, 0] - cx) < bin_size) & (np.abs(t_vectors[:, 1] - cy) < bin_size)
    inliers = int(keep.sum())
    if inliers < min_matches:
        return None
    refined = np.median(t_vectors[keep], axis=0)
    return (float(refined[0]), float(refined[1])), inliers


def solve_positions(n: int, edges: dict[tuple[int, int], tuple[tuple[float, float], int]]):
    """
    Given pairwise offsets keyed by (i, j) with i < j — each value is
    ((dx, dy), inlier_count) where (dx, dy) is the position of j's origin
    in i's frame — lay out all images rooted at image 0.

    Uses a greedy max-spanning-tree walk: each unplaced image is attached
    via its highest-confidence edge to an already-placed image. This
    prevents low-inlier false positives (common with repetitive grid
    patterns between non-adjacent tiles) from misplacing images.
    """
    positions: dict[int, tuple[float, float]] = {0: (0.0, 0.0)}
    edge_used: dict[int, tuple[tuple[int, int], int]] = {}  # placed image -> (edge, score)

    remaining = set(range(1, n))
    while remaining:
        # Find the best edge connecting any remaining image to any placed one.
        best = None  # (score, target_idx, source_idx, offset, edge_dir)
        for (a, b), (off, score) in edges.items():
            if a in positions and b in remaining:
                if best is None or score > best[0]:
                    best = (score, b, a, off, "ab")
            elif b in positions and a in remaining:
                if best is None or score > best[0]:
                    best = (score, a, b, off, "ba")
        if best is None:
            return None, remaining, edge_used
        score, target, source, off, direction = best
        if direction == "ab":
            # j's origin = i's + off  ->  target's pos = source's + off
            positions[target] = (positions[source][0] + off[0], positions[source][1] + off[1])
        else:
            # i's origin = j's - off  ->  target's pos = source's - off
            positions[target] = (positions[source][0] - off[0], positions[source][1] - off[1])
        edge_used[target] = ((source, target), score)
        remaining.discard(target)
    return positions, None, edge_used


def auto_crop(canvas: np.ndarray, coverage: float = 0.95) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """
    Trim rows / cols from the outside where fewer than `coverage` fraction of
    pixels are non-black (i.e. canvas-uncovered). Handles jagged edges that a
    plain non-zero bounding box misses.
    """
    gray = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY)
    nonzero = gray > 0
    row_cov = nonzero.mean(axis=1)
    col_cov = nonzero.mean(axis=0)
    rows_ok = np.where(row_cov >= coverage)[0]
    cols_ok = np.where(col_cov >= coverage)[0]
    if len(rows_ok) == 0 or len(cols_ok) == 0:
        return canvas, (0, 0, canvas.shape[1], canvas.shape[0])
    y0, y1 = int(rows_ok[0]), int(rows_ok[-1]) + 1
    x0, x1 = int(cols_ok[0]), int(cols_ok[-1]) + 1
    return canvas[y0:y1, x0:x1], (x0, y0, x1, y1)


def parse_xy(s: str) -> tuple[float, float]:
    parts = s.split(",")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError(f"Expected 'X,Y', got {s!r}")
    return float(parts[0]), float(parts[1])


def paste(canvas: np.ndarray, img: np.ndarray, dx: int, dy: int, blend: bool):
    """Paste img into canvas at (dx, dy). If blend, average with existing non-zero pixels."""
    h, w = img.shape[:2]
    region = canvas[dy:dy + h, dx:dx + w]
    if not blend:
        region[:] = img
        return
    # Simple overlap blend: where canvas already has content, average.
    existing_mask = region.any(axis=-1)
    new_mask = ~existing_mask
    region[new_mask] = img[new_mask]
    # For overlap: mean of existing and new
    overlap = existing_mask
    if overlap.any():
        region[overlap] = ((region[overlap].astype(np.uint16) + img[overlap].astype(np.uint16)) // 2).astype(np.uint8)


def stitch_grid(
    paths: list[Path],
    output: Path,
    blend: bool,
    crop: bool,
    world_bl: tuple[float, float] | None,
    world_ur: tuple[float, float] | None,
) -> None:
    """
    Grid-mode stitch. Reads (row, col) from each filename, feature-matches
    every adjacent pair, filters outlier matches, then runs bundle adjustment:
    all tile positions are solved simultaneously via weighted least squares.

    Feature-matched edges are strong constraints (weight ∝ inliers). Adjacent
    pairs without a match (e.g. open-ocean ↔ open-ocean) get a weak "grid
    prior" edge at the median step, so water tiles still get placed sensibly
    but don't drag adjacent terrain tiles off their exact matches.
    """
    # Load + index
    tiles: dict[tuple[int, int], np.ndarray] = {}
    for p in paths:
        rc = parse_grid_name(p.name)
        if rc is None:
            raise SystemExit(f"grid mode: filename not RR-CC.png: {p.name}")
        im = cv2.imread(str(p))
        if im is None:
            raise SystemExit(f"Failed to read {p}")
        tiles[rc] = im
    rows = sorted({r for r, _ in tiles})
    cols = sorted({c for _, c in tiles})
    print(f"\nGrid mode: rows {rows[0]}..{rows[-1]}, cols {cols[0]}..{cols[-1]}, {len(tiles)} tiles")

    # Feature detection per tile
    print("\nDetecting features...")
    feats: dict[tuple[int, int], tuple] = {}
    for rc in tiles:
        feats[rc] = detect_features(tiles[rc])

    # Match every adjacent pair (horizontal + vertical)
    print("\nMatching neighbor pairs...")
    # Each entry: (from_rc, to_rc, offset, inlier_count)
    h_matches: list = []
    v_matches: list = []

    for (r, c) in tiles:
        right = (r, c + 1)
        if right in tiles:
            res = pairwise_translation(*feats[(r, c)], *feats[right])
            if res is not None:
                h_matches.append(((r, c), right, res[0], res[1]))
        up = (r + 1, c)
        if up in tiles:
            res = pairwise_translation(*feats[(r, c)], *feats[up])
            if res is not None:
                v_matches.append(((r, c), up, res[0], res[1]))

    print(f"  {len(h_matches)} H matches, {len(v_matches)} V matches (raw)")

    # Outlier filtering — for each axis, reject matches whose offset deviates
    # from the inlier-weighted median by > 3 * MAD. These are mostly false
    # matches on water-adjacent tiles with sparse shared features.
    def filter_outliers(matches: list, label: str) -> list:
        if len(matches) < 5:
            return matches
        offs = np.array([m[2] for m in matches])
        ws = np.array([m[3] for m in matches], dtype=float)
        # weighted median via repeated weights (approx)
        med = np.median(offs, axis=0)
        mad = np.median(np.abs(offs - med), axis=0) + 1e-6
        dev = np.abs(offs - med) / mad
        keep_mask = (dev[:, 0] < 3.0) & (dev[:, 1] < 3.0)
        kept = [m for m, k in zip(matches, keep_mask) if k]
        dropped = len(matches) - len(kept)
        print(f"  {label}: kept {len(kept)}, dropped {dropped} outlier(s)")
        return kept

    h_matches = filter_outliers(h_matches, "H")
    v_matches = filter_outliers(v_matches, "V")

    if not h_matches or not v_matches:
        raise SystemExit(
            f"grid mode: need at least one H AND V match after filtering. "
            f"Got H={len(h_matches)}, V={len(v_matches)}."
        )

    # Derive prior step vectors from the clean set (used for unmatched pairs).
    h_med = np.median(np.array([m[2] for m in h_matches]), axis=0)
    v_med = np.median(np.array([m[2] for m in v_matches]), axis=0)
    print(f"\nPrior horizontal step: ({h_med[0]:+.1f}, {h_med[1]:+.1f})  (from {len(h_matches)} matches)")
    print(f"Prior vertical   step: ({v_med[0]:+.1f}, {v_med[1]:+.1f})  (from {len(v_matches)} matches)")

    # Bundle adjustment — solve for all positions via weighted least squares.
    tile_list = sorted(tiles.keys())
    idx = {rc: i for i, rc in enumerate(tile_list)}
    n = len(tile_list)

    # Normalize match weights into [0.1, 1.0] range so a single very
    # high-inlier match doesn't completely dominate the solve.
    max_w = max((m[3] for m in h_matches + v_matches), default=1)
    def mw(inliers: int) -> float:
        return 0.1 + 0.9 * (inliers / max_w)

    # Two tiers of prior:
    #   EDGE prior — on grid-adjacent pairs with no feature match (relative)
    #   ABS  prior — on every tile, its expected grid position (absolute)
    # Both are weak so that feature matches dominate wherever they exist,
    # but abs priors guarantee any weakly-connected tile cluster is still
    # globally positioned and can't drift arbitrarily.
    EDGE_PRIOR_W = 0.05
    ABS_PRIOR_W = 0.03

    matched_pairs: set = set((a, b) for (a, b, _, _) in h_matches + v_matches)

    equations: list[tuple[int, int, float, float, int]] = []
    # (i, j, rhs, weight, axis)  with axis 0 = x, 1 = y
    for (a, b, off, w) in h_matches + v_matches:
        wt = mw(w)
        equations.append((idx[a], idx[b], float(off[0]), wt, 0))
        equations.append((idx[a], idx[b], float(off[1]), wt, 1))

    # Edge priors for grid neighbors with no feature match
    for (r, c) in tiles:
        right = (r, c + 1)
        if right in tiles and ((r, c), right) not in matched_pairs:
            equations.append((idx[(r, c)], idx[right], float(h_med[0]), EDGE_PRIOR_W, 0))
            equations.append((idx[(r, c)], idx[right], float(h_med[1]), EDGE_PRIOR_W, 1))
        up = (r + 1, c)
        if up in tiles and ((r, c), up) not in matched_pairs:
            equations.append((idx[(r, c)], idx[up], float(v_med[0]), EDGE_PRIOR_W, 0))
            equations.append((idx[(r, c)], idx[up], float(v_med[1]), EDGE_PRIOR_W, 1))

    # Absolute-position priors — every tile relative to (rows[0], cols[0]).
    # Encoded as edges from the anchor tile to each tile so it fits the same
    # form.  Anchor is locked at (0, 0) via ANCHOR_W below, so these act as
    # x_rc ≈ expected, y_rc ≈ expected.
    anchor_rc = (rows[0], cols[0])
    anchor_idx = idx[anchor_rc]
    for rc in tile_list:
        if rc == anchor_rc:
            continue
        r, c = rc
        x_exp = (c - cols[0]) * float(h_med[0]) + (r - rows[0]) * float(v_med[0])
        y_exp = (c - cols[0]) * float(h_med[1]) + (r - rows[0]) * float(v_med[1])
        equations.append((anchor_idx, idx[rc], x_exp, ABS_PRIOR_W, 0))
        equations.append((anchor_idx, idx[rc], y_exp, ABS_PRIOR_W, 1))

    # Build linear system.  Variables: [x0, y0, x1, y1, ..., x_{n-1}, y_{n-1}]
    # Anchor tile (1, 1) at origin with a huge weight so gauge is fixed.
    num_eq = len(equations) + 2
    num_vars = 2 * n
    A = np.zeros((num_eq, num_vars), dtype=np.float64)
    b = np.zeros(num_eq, dtype=np.float64)
    for row_idx, (i, j, rhs, wt, axis) in enumerate(equations):
        A[row_idx, 2 * i + axis] = -wt
        A[row_idx, 2 * j + axis] = wt
        b[row_idx] = wt * rhs

    anchor = idx[(rows[0], cols[0])]  # (1, 1)
    ANCHOR_W = 1e6
    A[-2, 2 * anchor] = ANCHOR_W
    b[-2] = 0.0
    A[-1, 2 * anchor + 1] = ANCHOR_W
    b[-1] = 0.0

    print(f"\nBundle adjust: {num_eq} equations, {num_vars} unknowns, solving...")
    x, residuals, rank, _ = np.linalg.lstsq(A, b, rcond=None)
    print(f"  rank={rank}, residuals shape={residuals.shape}")

    positions: dict[tuple[int, int], tuple[float, float]] = {}
    for rc in tile_list:
        i = idx[rc]
        positions[rc] = (float(x[2 * i]), float(x[2 * i + 1]))

    # Canvas bounds
    corners: list[tuple[float, float]] = []
    for rc, (x, y) in positions.items():
        h, w = tiles[rc].shape[:2]
        corners.append((x, y))
        corners.append((x + w, y + h))
    min_x = min(c[0] for c in corners)
    max_x = max(c[0] for c in corners)
    min_y = min(c[1] for c in corners)
    max_y = max(c[1] for c in corners)
    canvas_w = int(np.ceil(max_x - min_x))
    canvas_h = int(np.ceil(max_y - min_y))
    print(f"\nCanvas: {canvas_w} x {canvas_h}")

    canvas = np.zeros((canvas_h, canvas_w, 3), dtype=np.uint8)
    # Paint from farthest (highest row) to nearest (lowest row) so lower rows
    # overwrite the upper row's overlap at seams — purely cosmetic.
    for rc in sorted(positions.keys(), reverse=True):
        x, y = positions[rc]
        dx = int(round(x - min_x))
        dy = int(round(y - min_y))
        paste(canvas, tiles[rc], dx, dy, blend=blend)

    if crop:
        canvas, (cx0, cy0, cx1, cy1) = auto_crop(canvas)
        print(f"\nAuto-cropped: ({cx0}, {cy0}) -> ({cx1}, {cy1})  new size {cx1 - cx0} x {cy1 - cy0}")

    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output), canvas)
    h_out, w_out = canvas.shape[:2]
    print(f"\nWrote {output}  ({w_out}x{h_out})")

    if world_bl is not None and world_ur is not None:
        sidecar = output.with_suffix(".json")
        meta = {
            "image": output.name,
            "width": w_out,
            "height": h_out,
            "worldBounds": {
                "bottomLeft": [world_bl[0], world_bl[1]],
                "upperRight": [world_ur[0], world_ur[1]],
            },
            "metersPerPixelX": (world_ur[0] - world_bl[0]) / w_out,
            "metersPerPixelY": (world_ur[1] - world_bl[1]) / h_out,
        }
        sidecar.write_text(json.dumps(meta, indent=2))
        print(f"Wrote {sidecar}  (m/px: {meta['metersPerPixelX']:.3f} x, {meta['metersPerPixelY']:.3f} y)")


def stitch(
    paths: list[Path],
    output: Path,
    blend: bool,
    crop: bool,
    world_bl: tuple[float, float] | None,
    world_ur: tuple[float, float] | None,
) -> None:
    imgs = []
    for p in paths:
        im = cv2.imread(str(p))
        if im is None:
            raise SystemExit(f"Failed to read {p}")
        imgs.append(im)
        print(f"  loaded {p.name}  {im.shape[1]}x{im.shape[0]}")

    print("\nDetecting features...")
    feats = [detect_features(im) for im in imgs]
    for i, (kps, _) in enumerate(feats):
        print(f"  img {i}: {len(kps)} keypoints")

    print("\nComputing pairwise translations...")
    edges: dict[tuple[int, int], tuple[tuple[float, float], int]] = {}
    n = len(imgs)
    for i in range(n):
        for j in range(i + 1, n):
            kps_a, desc_a = feats[i]
            kps_b, desc_b = feats[j]
            result = pairwise_translation(kps_a, desc_a, kps_b, desc_b)
            if result is None:
                print(f"  {i} <-> {j}: insufficient overlap")
                continue
            offset, inliers = result
            edges[(i, j)] = (offset, inliers)
            print(f"  {i} <-> {j}: B origin at A({offset[0]:+.1f}, {offset[1]:+.1f}), {inliers} inliers")

    if not edges:
        raise SystemExit("No reliable pairs found — check zoom consistency or overlap.")

    print("\nSolving positions (greedy max-spanning-tree, image 0 as reference)...")
    positions, unplaced, edge_used = solve_positions(n, edges)
    if positions is None:
        raise SystemExit(f"Cannot place images {unplaced} — disconnected from reference 0.")
    for i in sorted(positions):
        x, y = positions[i]
        if i == 0:
            print(f"  img {i}: ({x:+.1f}, {y:+.1f})  [reference]")
        else:
            edge, score = edge_used[i]
            print(f"  img {i}: ({x:+.1f}, {y:+.1f})  via {edge[0]}<->{edge[1]} ({score} inliers)")

    # Compute canvas bounds
    corners = []
    for i, (x, y) in positions.items():
        h, w = imgs[i].shape[:2]
        corners.append((x, y))
        corners.append((x + w, y + h))
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    canvas_w = int(np.ceil(max_x - min_x))
    canvas_h = int(np.ceil(max_y - min_y))
    print(f"\nCanvas: {canvas_w} x {canvas_h}")

    canvas = np.zeros((canvas_h, canvas_w, 3), dtype=np.uint8)
    for i in sorted(positions):
        x, y = positions[i]
        dx = int(round(x - min_x))
        dy = int(round(y - min_y))
        paste(canvas, imgs[i], dx, dy, blend=blend)

    if crop:
        canvas, (cx0, cy0, cx1, cy1) = auto_crop(canvas)
        print(f"\nAuto-cropped: ({cx0}, {cy0}) -> ({cx1}, {cy1})  new size {cx1 - cx0} x {cy1 - cy0}")

    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output), canvas)
    h_out, w_out = canvas.shape[:2]
    print(f"\nWrote {output}  ({w_out}x{h_out})")

    # Sidecar metadata for Leaflet bounds when world coords provided.
    if world_bl is not None and world_ur is not None:
        sidecar = output.with_suffix(".json")
        meta = {
            "image": output.name,
            "width": w_out,
            "height": h_out,
            "worldBounds": {
                "bottomLeft":  [world_bl[0], world_bl[1]],
                "upperRight":  [world_ur[0], world_ur[1]],
            },
            "metersPerPixelX": (world_ur[0] - world_bl[0]) / w_out,
            "metersPerPixelY": (world_ur[1] - world_bl[1]) / h_out,
        }
        sidecar.write_text(json.dumps(meta, indent=2))
        print(f"Wrote {sidecar}  (m/px: {meta['metersPerPixelX']:.3f} x, {meta['metersPerPixelY']:.3f} y)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("input_dir", type=Path, help="Directory of overlapping .png screenshots")
    ap.add_argument("-o", "--output", type=Path, default=Path("stitched.png"))
    ap.add_argument("--blend", action="store_true", help="Average overlapping regions instead of overwriting")
    ap.add_argument("--no-crop", action="store_true", help="Skip the auto-crop of fully-black borders")
    ap.add_argument("--world-bl", type=parse_xy, default=None,
                    help="World coordinates (X,Y) at the BOTTOM-LEFT of the final cropped image")
    ap.add_argument("--world-ur", type=parse_xy, default=None,
                    help="World coordinates (X,Y) at the UPPER-RIGHT of the final cropped image")
    args = ap.parse_args()

    if (args.world_bl is None) != (args.world_ur is None):
        sys.exit("--world-bl and --world-ur must be provided together or not at all")

    # Exclude files starting with "_" — reserved for stitcher outputs and
    # intermediates so re-runs don't try to stitch their own previous output.
    paths = sorted(p for p in args.input_dir.glob("*.png") if not p.name.startswith("_"))
    if len(paths) < 2:
        sys.exit(f"Need >= 2 PNGs in {args.input_dir}, found {len(paths)}")
    print(f"Input: {len(paths)} images from {args.input_dir}")

    # Auto-select grid vs feature mode from filenames.
    grid_named = all(parse_grid_name(p.name) is not None for p in paths)
    if grid_named:
        stitch_grid(
            paths, args.output,
            blend=args.blend,
            crop=not args.no_crop,
            world_bl=args.world_bl,
            world_ur=args.world_ur,
        )
    else:
        stitch(
            paths, args.output,
            blend=args.blend,
            crop=not args.no_crop,
            world_bl=args.world_bl,
            world_ur=args.world_ur,
        )


if __name__ == "__main__":
    main()
