"""
Auto-capture a grid of Arma Reforger map tiles.

Assumes:
  - The game is in windowed or borderless mode at your primary monitor's
    native resolution.
  - The map widget is open and the SW-most 1km cell is roughly centered in
    the viewport. At least 2 thick (1km) gridlines are visible along each
    axis so we can auto-calibrate px/km from a single screenshot.
  - Right-click + drag pans the map in "grab" style (cursor left = pan east).
    If your install pans the opposite way, pass --sign-x 1 --sign-y -1.

The script waits `--switch-delay` seconds after launch so you can alt-tab back
into the game, then:
  1. Grabs the initial frame and auto-detects px/km from the thick gridlines
     (same detector grid_stitch.py uses).
  2. Walks rows south-to-north, cols west-to-east, saving each frame as
     RR-CC.png directly — no timestamp rename step needed.
  3. Between columns, drags ~1 km east.
  4. At end of each row, drags back west by (cols-1) km, then north by 1 km.
     Long drags are chunked so we never run off the edge of the screen.

Pixel-perfect pans are NOT required. grid_stitch.py crops each tile to its
own thick-gridline-bounded 1km cell on stitch, so per-drag drift is corrected
per tile, not cumulatively.

Usage:
  py tools/map-gen/auto_capture.py 17x17 Assets/Zimnitrita-map-tiles
  py tools/map-gen/auto_capture.py 5x5  Assets/Foo-map-tiles --switch-delay 5

Dependencies: pyautogui, mss, opencv-python, numpy
  py -m pip install pyautogui mss
"""

from __future__ import annotations
import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from grid_stitch import detect_gridlines_axis  # noqa: E402

import pyautogui  # noqa: E402
import mss  # noqa: E402

pyautogui.PAUSE = 0.0  # we manage timing explicitly


def grab_bgr() -> np.ndarray:
    with mss.mss() as sct:
        mon = sct.monitors[1]  # primary monitor (index 0 is the full virtual desktop)
        raw = np.array(sct.grab(mon))
        return raw[:, :, :3]  # BGRA -> BGR


def correct_pan(axis: str, sign: int, tolerance: int, w: int, h: int, step_x: int, step_y: int,
                duration: float, settle: float, edge_margin: int, label: str) -> None:
    """Closed-loop correction for a just-completed pan along `axis` ('x' or 'y').

    Grabs a probe screenshot, detects the cell-center bracketing thick gridlines on that
    axis, and if the midpoint is more than `tolerance` pixels from the screen center,
    drags to correct. Up to 2 correction passes per call.

    Drift convention: positive drift = undershoot (pan didn't go far enough in the
    intended direction). Correction drag = sign * drift — same formula on both axes
    because the axis-specific flip between drift measurement and drag direction lives
    inside the measure_* functions.
    """
    if tolerance <= 0:
        return
    prev_drift: int | None = None
    for _ in range(2):
        probe = park_and_grab(w, h, step_x, step_y, edge_margin)
        if axis == "x":
            drift = measure_horizontal_drift(probe, w)
        else:
            drift = measure_vertical_drift(probe, h)
        if drift is None:
            print(f"[auto_capture] {label} {axis}: couldn't detect bracket for correction.")
            return
        if abs(drift) <= tolerance:
            print(f"[auto_capture] {label} {axis}: drift {drift:+d}px within tolerance.")
            return
        # Edge-lock detection: if the previous correction drag didn't reduce drift by a
        # meaningful amount, the map is pinned against a world-boundary and further drags
        # are no-ops. Accept the current off-center position and move on — the stitcher
        # crops to whichever cell brackets the screen center, so a partial pan that still
        # lands screen-center inside the target cell will produce a correct tile.
        if prev_drift is not None and abs(drift) >= abs(prev_drift) - 5:
            print(f"[auto_capture] {label} {axis}: edge-locked at drift {drift:+d}px "
                  f"(no progress from {prev_drift:+d}px) — accepting off-center frame.")
            return
        print(f"[auto_capture] {label} {axis}: drift {drift:+d}px, correcting...")
        if axis == "x":
            drag_chunked(sign * drift, 0, duration, settle, edge_margin)
        else:
            drag_chunked(0, sign * drift, duration, settle, edge_margin)
        prev_drift = drift


def park_and_grab(w: int, h: int, step_x: int, step_y: int, edge_margin: int,
                  park_offset: int = 100, park_settle: float = 0.05) -> np.ndarray:
    """Move the cursor to the bottom-left corner of the central 1km cell plus a further
    diagonal offset, then take a screenshot. Reforger's in-game cursor draws a full-screen
    crosshair + coords/elevation HUD; parking it diagonally outside the cell keeps both
    crosshair lines and the HUD text off the captured tile.

    If `step_x`/`step_y` are 0 (pre-calibration), park near the bottom-left screen corner.
    """
    cx, cy = w // 2, h // 2
    if step_x > 0 and step_y > 0:
        park_x = cx - step_x // 2 - park_offset
        park_y = cy + step_y // 2 + park_offset
    else:
        park_x = edge_margin
        park_y = h - edge_margin
    park_x = max(edge_margin, min(w - edge_margin, park_x))
    park_y = max(edge_margin, min(h - edge_margin, park_y))
    pyautogui.moveTo(park_x, park_y)
    time.sleep(park_settle)
    return grab_bgr()


def measure_vertical_drift(img: np.ndarray, h: int) -> int | None:
    """Detect thick H gridlines and return how far the cell-center bracketing pair is off
    from the screen center on the Y axis, in pixels. Positive = undershoot (cell center is
    above screen center → need to pan north more). Returns None if no clean bracketing pair."""
    _, thick_h, _ = detect_gridlines_axis(img, axis=1)
    if len(thick_h) < 2:
        return None
    center = h // 2
    above = [int(p) for p in thick_h if p < center]
    below = [int(p) for p in thick_h if p > center]
    if not above or not below:
        return None
    midpoint = (max(above) + min(below)) / 2
    return int(round(center - midpoint))


def measure_horizontal_drift(img: np.ndarray, w: int) -> int | None:
    """Detect thick V gridlines and return how far the cell-center bracketing pair is off
    from the screen center on the X axis, in pixels. Positive = overshoot (cell center is
    right of screen center → we panned east too far); negative = undershoot. The sign
    convention is OPPOSITE of measure_vertical_drift because pan-east moves content LEFT
    on screen, while pan-north moves content DOWN — the asymmetry flips the drift sign."""
    _, thick_v, _ = detect_gridlines_axis(img, axis=0)
    if len(thick_v) < 2:
        return None
    center = w // 2
    left = [int(p) for p in thick_v if p < center]
    right = [int(p) for p in thick_v if p > center]
    if not left or not right:
        return None
    midpoint = (max(left) + min(right)) / 2
    return int(round(midpoint - center))


def detect_px_per_km(img: np.ndarray) -> tuple[float, float]:
    """Return (px_per_km_x, px_per_km_y). Axes are calibrated independently because
    the map widget can render 1km differently on each axis depending on viewport
    aspect ratio and UI chrome — averaging the two causes cumulative drift on the
    shorter axis."""
    _, thick_v, _ = detect_gridlines_axis(img, axis=0)
    _, thick_h, _ = detect_gridlines_axis(img, axis=1)
    if len(thick_v) < 2 or len(thick_h) < 2:
        sys.exit(
            "Calibration failed: need >=2 thick (1km) gridlines visible on each axis "
            "in the starting viewport. Zoom until at least 2x2 km is on screen."
        )
    px_per_km_x = float(np.median(np.diff(thick_v)))  # vertical lines → horizontal spacing
    px_per_km_y = float(np.median(np.diff(thick_h)))  # horizontal lines → vertical spacing
    return px_per_km_x, px_per_km_y


def drag(start_x: int, start_y: int, dx: int, dy: int, duration: float, settle: float) -> None:
    """One right-button drag from (start_x, start_y) by (dx, dy). Caller picks start + chunks for large deltas."""
    pyautogui.moveTo(start_x, start_y)
    pyautogui.mouseDown(button="right")
    pyautogui.moveRel(dx, dy, duration=duration)
    pyautogui.mouseUp(button="right")
    time.sleep(settle)


def drag_chunked(dx: int, dy: int, duration: float, settle: float, margin: int) -> None:
    """Break a large drag into chunks that always start + end at least `margin` px from the viewport edge.

    Reforger's map widget auto-pans when the cursor hits the viewport edge, which would
    undo our drags. We avoid it by choosing a per-chunk start position on the OPPOSITE
    side of the drag direction, so the cursor travels edge-to-edge (minus margin)
    without ever touching either edge.
    """
    if dx == 0 and dy == 0:
        return
    w, h = pyautogui.size()
    max_x = w - 2 * margin
    max_y = h - 2 * margin
    if max_x < 100 or max_y < 100:
        raise RuntimeError(f"margin {margin}px leaves < 100px usable travel on a {w}x{h} screen")
    rx, ry = dx, dy
    while rx != 0 or ry != 0:
        step_x = max(-max_x, min(max_x, rx)) if rx else 0
        step_y = max(-max_y, min(max_y, ry)) if ry else 0
        # Start on the opposite side of the drag direction so the end stays off the edge.
        if step_x > 0:
            start_x = margin
        elif step_x < 0:
            start_x = w - margin
        else:
            start_x = w // 2
        if step_y > 0:
            start_y = margin
        elif step_y < 0:
            start_y = h - margin
        else:
            start_y = h // 2
        drag(start_x, start_y, step_x, step_y, duration, settle)
        rx -= step_x
        ry -= step_y


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("grid", help="ROWSxCOLS, e.g. 17x17")
    ap.add_argument("output_dir")
    ap.add_argument("--switch-delay", type=float, default=3.0,
                    help="Seconds to wait before capture starts — alt-tab back to the game in this window.")
    ap.add_argument("--duration", type=float, default=1.0,
                    help="Seconds each individual drag takes. 1.0 is the empirical sweet spot — "
                         "the game's input smoothing makes faster drags accumulate drift the "
                         "closed-loop correction can't always catch up with.")
    ap.add_argument("--settle", type=float, default=0.8,
                    help="Seconds to wait after each drag for map animation to settle.")
    ap.add_argument("--sign-x", type=int, default=-1, choices=[-1, 1],
                    help="Sign of cursor dx that pans east (-1 = grab-style, default).")
    ap.add_argument("--sign-y", type=int, default=1, choices=[-1, 1],
                    help="Sign of cursor dy that pans north (+1 = grab-style, default).")
    ap.add_argument("--edge-margin", type=int, default=100,
                    help="Minimum cursor distance from viewport edges during drags (px). "
                         "Reforger's map auto-pans when the cursor hits an edge — margin avoids it.")
    ap.add_argument("--vertical-correct-tolerance", type=int, default=30,
                    help="After pan-north, if the detected cell center is off by more than this many "
                         "pixels from the screen center, do a corrective drag. 0 disables closed-loop correction.")
    ap.add_argument("--horizontal-correct-tolerance", type=int, default=30,
                    help="Same as --vertical-correct-tolerance but applied after every horizontal pan "
                         "between columns. 0 disables.")
    ap.add_argument("--crop-tb", type=int, default=60,
                    help="Pixels to crop off the top AND bottom of each saved tile. Default tuned for the user's 3840x1600 setup.")
    ap.add_argument("--crop-lr", type=int, default=800,
                    help="Pixels to crop off the left AND right of each saved tile. Default tuned for the user's 3840x1600 setup.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Calibrate and do one test east-drag, then abort. Use to verify sign before a full run.")
    args = ap.parse_args()

    try:
        rows, cols = (int(s) for s in args.grid.lower().split("x"))
    except ValueError:
        sys.exit("grid must look like ROWSxCOLS, e.g. 17x17")

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)

    print(f"[auto_capture] waiting {args.switch_delay}s — alt-tab to the game, map open, SW cell centered...")
    time.sleep(args.switch_delay)

    w, h = pyautogui.size()

    print("[auto_capture] calibrating from initial frame...")
    # Pre-calibration park: without step_x/step_y known yet, we park near the BL screen corner.
    first = park_and_grab(w, h, 0, 0, args.edge_margin)
    px_per_km_x, px_per_km_y = detect_px_per_km(first)
    step_x = int(round(px_per_km_x))
    step_y = int(round(px_per_km_y))
    print(f"[auto_capture] px/km  x={px_per_km_x:.1f}  y={px_per_km_y:.1f}  (drag steps: {step_x}px, {step_y}px)")

    if args.dry_run:
        print("[auto_capture] dry-run: doing one east drag then exiting. Check the game — did the map pan east?")
        drag_chunked(args.sign_x * step_x, 0, args.duration, args.settle, args.edge_margin)
        print("[auto_capture] dry-run done. If the map panned WEST instead, re-run with --sign-x 1.")
        return

    total = rows * cols
    i = 0
    # Snake / boustrophedon pattern: row 1 west→east, row 2 east→west, row 3 west→east, etc.
    # Eliminates long return drags and cuts total pan distance roughly in half. The
    # horizontal correction formula (sign_x * drift) works identically for both directions
    # because drift is measured as signed offset from screen center — it self-inverts based
    # on which way we undershot.
    for r in range(1, rows + 1):
        going_east = (r % 2 == 1)
        cols_order = list(range(1, cols + 1)) if going_east else list(range(cols, 0, -1))
        step_sign = args.sign_x if going_east else -args.sign_x
        for idx, c in enumerate(cols_order):
            i += 1
            name = f"{r:02d}-{c:02d}.png"
            img = first if (r == 1 and c == 1) else park_and_grab(w, h, step_x, step_y, args.edge_margin)
            tile = img[args.crop_tb:h - args.crop_tb, args.crop_lr:w - args.crop_lr] if (args.crop_tb or args.crop_lr) else img
            cv2.imwrite(str(out / name), tile)
            print(f"[auto_capture] {i}/{total}  {name}")
            if idx < cols - 1:
                next_c = cols_order[idx + 1]
                drag_chunked(step_sign * step_x, 0, args.duration, args.settle, args.edge_margin)
                correct_pan("x", args.sign_x, args.horizontal_correct_tolerance,
                            w, h, step_x, step_y, args.duration, args.settle, args.edge_margin,
                            label=f"{r:02d}-{c:02d}→{r:02d}-{next_c:02d}")
        if r < rows:
            # pan north by 1 km, starting from the upper-right corner of the current 1km cell
            # (better grab origin than an edge-anchored start — the game interprets the drag
            # more faithfully when initiated well inside the cell we want to move away from).
            ur_x = w // 2 + step_x // 2
            ur_y = h // 2 - step_y // 2
            ur_x = max(args.edge_margin, min(w - args.edge_margin, ur_x))
            ur_y = max(args.edge_margin, min(h - args.edge_margin, ur_y))
            dy = args.sign_y * step_y
            end_y = ur_y + dy
            if args.edge_margin <= end_y <= h - args.edge_margin:
                drag(ur_x, ur_y, 0, dy, args.duration, args.settle)
            else:
                drag_chunked(0, dy, args.duration, args.settle, args.edge_margin)
            correct_pan("y", args.sign_y, args.vertical_correct_tolerance,
                        w, h, step_x, step_y, args.duration, args.settle, args.edge_margin,
                        label=f"row {r}→{r+1}")

    print(f"[auto_capture] done. {total} tiles written to {out}")


if __name__ == "__main__":
    main()
