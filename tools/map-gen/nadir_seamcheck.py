"""
Quantify residual seam error of the ortho projection: render the same world
window (straddling the seam between two neighbouring frames) from BOTH frames
through the ortho model and correlate. Zero residual = perfect stitch; the
residual vector (metres) is what the mosaic shows as a crack.

Usage:
  py nadir_seamcheck.py <dir> --step 200 --rot 89.8 --heightmap <bin> [--samples 40]
"""
from __future__ import annotations
import argparse, glob, math, os, random, re, sys
from pathlib import Path
import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from nadir_mosaic import Heightmap  # noqa: E402

NAME_RE = re.compile(r"_(\d+)_(\d+)\.png$")


def render(frame, hm, cx, cz, cam_h, f_px, ux, uz, wx0, wz0, wx1, wz1, ppm):
    """Ortho-render world window [wx0,wx1]x[wz0,wz1] (north up) from one frame."""
    nx, nz = int(round((wx1 - wx0) * ppm)), int(round((wz1 - wz0) * ppm))
    xs = wx0 + (np.arange(nx, dtype=np.float32) + 0.5) / ppm
    zs = wz1 - (np.arange(nz, dtype=np.float32) + 0.5) / ppm
    X, Z = np.meshgrid(xs, zs)
    elev = hm.sample(X, Z)
    s = f_px / np.maximum(cam_h - elev, 1.0)
    DX, DZ = X - cx, Z - cz
    H, W = frame.shape[:2]
    u = (W - 1) / 2.0 + (DX * ux[0] + DZ * uz[0]) * s
    v = (H - 1) / 2.0 + (DX * ux[1] + DZ * uz[1]) * s
    return cv2.remap(frame, u.astype(np.float32), v.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("indir")
    ap.add_argument("--step", type=float, required=True)
    ap.add_argument("--rot", type=float, required=True)
    ap.add_argument("--heightmap", type=Path, required=True)
    ap.add_argument("--cam-height", type=float, default=950.0)
    ap.add_argument("--fov", type=float, default=15.0)
    ap.add_argument("--samples", type=int, default=40)
    ap.add_argument("--cam-scale", type=float, default=1.0, help="multiply the modelled camera height above terrain (experiment)")
    ap.add_argument("--x-step", type=float, default=None,
                    help="column spacing to evaluate (default = --step); e.g. --step 100 --x-step 300 measures the "
                         "seams a 300 m column step WOULD produce, using every third column of a 100 m capture")
    ap.add_argument("--lag", type=float, default=0.0,
                    help="camera lag (m) along the inner-loop travel direction (+Z): the editor camera has not fully "
                         "arrived when the frame is shot, so the true position is z - lag (first stop of a column: 0)")
    a = ap.parse_args()

    hm = Heightmap(a.heightmap)
    frames = {}
    for f in glob.glob(os.path.join(a.indir, "*", "*.png")):
        m = NAME_RE.search(f)
        if m and not os.path.basename(os.path.dirname(f)).startswith("_"):
            frames[(int(m[1]), int(m[2]))] = f
    step = int(a.step)
    ang = math.radians(-a.rot)
    ux, uz = (math.cos(ang), math.sin(ang)), (math.sin(ang), -math.cos(ang))
    fh = cv2.imread(next(iter(frames.values())), cv2.IMREAD_GRAYSCALE).shape[0]
    f_px = (fh / 2.0) / math.tan(math.radians(a.fov) / 2.0)
    ppm = 6.0
    xstep = a.x_step or step
    pairs = [((x, z), (x + xstep, z), "NS") for (x, z) in frames if (x + xstep, z) in frames] + \
            [((x, z), (x, z + step), "EW") for (x, z) in frames if (x, z + step) in frames]
    random.Random(2).shuffle(pairs)
    zmin = min(k[1] for k in frames)

    def cam(k):
        """Modelled camera XZ: nominal stop minus the travel lag (none on a column's first stop)."""
        return (k[0], k[1] - (a.lag if k[1] != zmin else 0.0))

    out = []
    for ka, kb, kind in pairs:
        if len(out) >= a.samples:
            break
        A = cv2.imread(frames[ka], cv2.IMREAD_GRAYSCALE)
        if A.std() < 14:
            continue
        B = cv2.imread(frames[kb], cv2.IMREAD_GRAYSCALE)
        # world window: 60 m either side of the seam, 200 m along it
        if kind == "NS":
            sx = ka[0] + xstep / 2
            wx0, wx1, wz0, wz1 = sx - 60, sx + 60, ka[1] - 100, ka[1] + 100
        else:
            sz = ka[1] + step / 2
            wx0, wx1, wz0, wz1 = ka[0] - 100, ka[0] + 100, sz - 60, sz + 60
        ca, cb = cam(ka), cam(kb)
        ra = render(A, hm, ca[0], ca[1], hm.at(*ca) + a.cam_height * a.cam_scale, f_px, ux, uz, wx0, wz0, wx1, wz1, ppm)
        rb = render(B, hm, cb[0], cb[1], hm.at(*cb) + a.cam_height * a.cam_scale, f_px, ux, uz, wx0, wz0, wx1, wz1, ppm)
        if ra.std() < 10:
            continue
        # template: centre of ra, search in rb (±40 px = ±6.7 m)
        h, w = ra.shape
        P = ra[h // 2 - 150:h // 2 + 150, w // 2 - 150:w // 2 + 150] if kind == "NS" else ra[h // 2 - 150:h // 2 + 150, w // 2 - 150:w // 2 + 150]
        res = cv2.matchTemplate(rb, P, cv2.TM_CCOEFF_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(res)
        dx, dy = loc[0] - (w // 2 - 150), loc[1] - (h // 2 - 150)
        if mx < 0.5:
            continue
        dh = hm.at(*kb) - hm.at(*ka)
        out.append((kind, ka, dx / ppm, dy / ppm, math.hypot(dx, dy) / ppm, dh, mx))
    if not out:
        sys.exit("no measurable pairs")
    out = [o for o in out if o[4] < 20]  # drop wrong matches (search window is ±6.7 m anyway)
    err = np.array([o[4] for o in out]); dh = np.array([abs(o[5]) for o in out])
    print(f"lag={a.lag} m  pairs={len(out)}  residual seam error: median {np.median(err):.2f} m  p75 {np.percentile(err, 75):.2f}  p90 {np.percentile(err, 90):.2f}  max {err.max():.2f} m")
    print(f"correlation |err| vs |terrain dh between stops|: r={np.corrcoef(err, dh)[0, 1]:.2f}")
    for kind in ("NS", "EW"):
        sub = [o for o in out if o[0] == kind]
        if sub:
            ex = np.array([o[2] for o in sub]); ez = np.array([-o[3] for o in sub])
            print(f"  {kind} pairs={len(sub)}: median dx {np.median(ex):+.2f} m, median dz {np.median(ez):+.2f} m, |err| median {np.median(np.hypot(ex, ez)):.2f} m")
    print("kind  stop        dx(m)  dz(m)  |err|  dh(m)  ncc")
    for kind, ka, ex, ey, e, d, ncc in sorted(out, key=lambda o: -o[4])[:12]:
        print(f"{kind}  {ka[0]:5d},{ka[1]:5d}  {ex:+6.2f} {-ey:+6.2f}  {e:5.2f}  {d:+6.1f}  {ncc:.2f}")


if __name__ == "__main__":
    main()
