"""
Measure the frame orientation and scale of an EnfusionMapMaker nadir capture.

The World Editor camera keeps whatever yaw the viewport had before the tool
started, so the image axes are NOT the world axes and differ between capture
sessions (Arland 2026-09-15: world +X = image up; Kolguyev 2026-09-16: 13° off
that). For a sample of neighbouring frame pairs this script finds where a
patch of frame A lands in frame B (normalised cross-correlation) and derives:

  * px per metre        (|shift| / step)
  * the image-space direction of world +X and +Z
  * the clockwise rotation that makes the crops north-up (+X right, +Z up),
    to pass to nadir_mosaic.py --rot

Usage:
  py nadir_orient.py <input dir> --step 100 [--samples 12]
"""
from __future__ import annotations
import argparse, glob, math, os, random, re
import cv2
import numpy as np

NAME_RE = re.compile(r"_(\d+)_(\d+)\.png$")


def load(p: str) -> np.ndarray:
    return cv2.imread(p, cv2.IMREAD_GRAYSCALE)


def find_shift(a: np.ndarray, b: np.ndarray) -> tuple[float, float, float] | None:
    """Where does the content of A appear in B? Returns (dx, dy, ncc) in px."""
    H, W = a.shape
    best = None
    # A grid of candidate patches: whichever one still lies inside B's frame
    # after the (unknown) shift wins on correlation, so no assumption about
    # the shift direction is needed.
    rows = [60, H // 2 - 100, H - 260]
    cols = list(range(200, W - 500, 450))
    for r0 in rows:
        for c0 in cols:
            P = a[r0:r0 + 200, c0:c0 + 300]
            if P.std() < 12:
                continue
            res = cv2.matchTemplate(b, P, cv2.TM_CCOEFF_NORMED)
            _, mx, _, loc = cv2.minMaxLoc(res)
            if best is None or mx > best[2]:
                best = (loc[0] - c0, loc[1] - r0, mx)
    return best


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("indir")
    ap.add_argument("--step", type=float, required=True)
    ap.add_argument("--step-x", type=float, default=None, help="column spacing (world X) when it differs from --step")
    ap.add_argument("--samples", type=int, default=12)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()

    frames: dict[tuple[int, int], str] = {}
    for f in glob.glob(os.path.join(a.indir, "*", "*.png")):
        m = NAME_RE.search(f)
        if m and not os.path.basename(os.path.dirname(f)).startswith("_"):
            frames[(int(m[1]), int(m[2]))] = f
    if not frames:
        raise SystemExit("no frames")
    step = int(a.step)
    step_x = int(a.step_x or a.step)
    rng = random.Random(a.seed)
    xpairs = [(k, (k[0] + step_x, k[1])) for k in frames if (k[0] + step_x, k[1]) in frames]
    zpairs = [(k, (k[0], k[1] + step)) for k in frames if (k[0], k[1] + step) in frames]
    rng.shuffle(xpairs)
    rng.shuffle(zpairs)

    def sample(pairs, label, dist):
        vecs = []
        for (ka, kb) in pairs:
            if len(vecs) >= a.samples:
                break
            A = load(frames[ka]); B = load(frames[kb])
            if A.std() < 12:
                continue  # sea
            r = find_shift(A, B)
            if r and r[2] > 0.6:
                # content shifts opposite to the camera's image-space motion:
                # world +axis direction in the image = -(content shift)
                vecs.append((-r[0], -r[1], r[2]))
        if not vecs:
            print(f"{label}: no confident pairs"); return None
        v = np.array(vecs)
        dx, dy = np.median(v[:, 0]), np.median(v[:, 1])
        length = math.hypot(dx, dy)
        ang = math.degrees(math.atan2(dy, dx))  # image coords, y down: clockwise from +x
        angs = np.degrees(np.arctan2(v[:, 1], v[:, 0]))
        lens = np.hypot(v[:, 0], v[:, 1]) / dist
        print(f"{label}: {len(vecs)} pairs (NCC median {np.median(v[:, 2]):.2f}); world +axis points ({dx:+.0f}, {dy:+.0f}) px "
              f"= {length / dist:.3f} px/m, {ang:+.1f} deg clockwise from image right "
              f"[angle spread {angs.min():+.1f}..{angs.max():+.1f}, px/m spread {lens.min():.2f}..{lens.max():.2f}]")
        return dx, dy, length

    print(f"frames={len(frames)}  step={step} m  column step={step_x} m")
    x = sample(xpairs, "world +X", step_x)
    z = sample(zpairs, "world +Z", step)
    if not x:
        return
    ppm = x[2] / step_x
    ang_x = math.degrees(math.atan2(x[1], x[0]))
    # rotate clockwise by -ang_x so +X points right (angle 0)
    rot_cw = (-ang_x) % 360
    print(f"\npx/m = {ppm:.3f}")
    print(f"north-up rotation for nadir_mosaic.py: --rot {rot_cw:.2f}  (clockwise degrees)")
    if z:
        ang_z = math.degrees(math.atan2(z[1], z[0]))
        rel = (ang_z - ang_x) % 360
        # after the rotation +X is at 0°; +Z should be at -90° (up) => rel == 270
        if abs(rel - 270) < 5:
            print("handedness OK: +Z ends up pointing up")
        elif abs(rel - 90) < 5:
            print("WARNING: +Z ends up pointing DOWN — the capture is mirrored; add --flipz")
        else:
            print(f"WARNING: +Z is {rel:.1f}° from +X (expected 270°) — measurement inconsistent")


if __name__ == "__main__":
    main()
