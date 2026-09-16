"""
Compose EnfusionMapMaker nadir screenshots into one north-up mosaic covering the
full world rectangle (0..worldSize on both axes), ready for tile_pyramid.py.

Each screenshot {prefix}_{x}_{z}.png was taken with the camera exactly above
world (x, z), `--cam-height` metres above the terrain under it, looking
straight down with a vertical FOV of `--fov`. Only the centre (step x step)
metres of every frame are used, so every tile is near-nadir.

Two projection modes:

* flat (default): centre-crop `step * ppm` px, rotate north-up, paste. Assumes
  the ground is a plane at the camera's own terrain height, so on hilly maps
  neighbouring frames (shot from different altitudes) disagree by
  lever * dh / cam_height at the seams (Kolguyev: up to 8 m at step 200).

* ortho (`--heightmap`): true orthorectification. For every output pixel the
  terrain elevation is read from the Builder heightmap and projected into the
  frame through the pinhole model (f = (H_px / 2) / tan(fov / 2)), so ground
  at any elevation lands where it belongs and seams only carry the parallax of
  objects standing above the ground (trees lean ~1-2 m at the crop edge).

Frame orientation is NOT fixed between capture sessions (the camera keeps the
viewport's yaw): measure `--rot` with nadir_orient.py.

Usage:
  py nadir_mosaic.py <dir> <out> --world 4100 --step 100 --ppm 6.05 --rot 90.67
  py nadir_mosaic.py <dir> <out> --world 13000 --step 200 --rot 89.5 \
      --heightmap ../ts-mission-builder/web/public/heightmaps/kolguyev.bin [--bbox ...]
"""
from __future__ import annotations
import argparse, json, math, re, sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
NAME_RE = re.compile(r"^(?P<prefix>.+)_(?P<x>\d+)_(?P<z>\d+)\.png$")


class Heightmap:
    """Builder heightmap (.bin uint16 + .json): row 0 = SOUTH edge (worldZ 0), pixel i at
    i*cellSizeM — the same convention the Builder's engine-validated heightmap.ts sampler uses
    (its docstring says north, its code says south; the Chernarus water mask confirmed south)."""

    def __init__(self, bin_path: Path):
        meta = json.loads(bin_path.with_suffix(".json").read_text())
        self.cs = float(meta["cellSizeM"])
        self.w = int(meta["widthPx"])
        self.h = int(meta["heightPx"])
        raw = np.fromfile(bin_path, dtype=np.uint16)
        if raw.size != self.w * self.h:
            raise SystemExit(f"{bin_path}: {raw.size} samples, expected {self.w * self.h}")
        self.hm = (raw.astype(np.float32) * float(meta["heightScale"]) + float(meta["minElevationM"])).reshape(self.h, self.w)

    def sample(self, xs: np.ndarray, zs: np.ndarray) -> np.ndarray:
        """Bilinear elevation at world (x, z) arrays of equal shape."""
        import cv2
        px = (xs / self.cs).astype(np.float32)
        py = (zs / self.cs).astype(np.float32)
        return cv2.remap(self.hm, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    def at(self, x: float, z: float) -> float:
        return float(self.sample(np.array([[x]], np.float32), np.array([[z]], np.float32))[0, 0])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("indir")
    ap.add_argument("out")
    ap.add_argument("--world", type=float, required=True, help="world size in metres (square)")
    ap.add_argument("--step", type=float, default=100.0, help="camera step in metres")
    ap.add_argument("--ppm", type=float, help="flat mode: measured pixels per metre in the raw frames")
    ap.add_argument("--scale", type=float, default=1.0, help="output scale (0.125 = preview)")
    ap.add_argument("--rot", type=float, default=90.0,
                    help="clockwise rotation (degrees) that makes a crop north-up — measure it per capture "
                         "with nadir_orient.py (Arland 90.67, Kolguyev sessions 13.0 / 89.5)")
    ap.add_argument("--flipx", action="store_true")
    ap.add_argument("--flipz", action="store_true")
    ap.add_argument("--bbox", type=float, nargs=4, metavar=("XMIN", "ZMIN", "XMAX", "ZMAX"),
                    help="only render this world rectangle (metres) — full-res seam checks on a strip")
    ap.add_argument("--heightmap", type=Path, help="ortho mode: Builder heightmap .bin (its .json beside it)")
    ap.add_argument("--cam-height", type=float, default=950.0, help="plugin camera height above terrain (m)")
    ap.add_argument("--fov", type=float, default=15.0, help="plugin vertical FOV (degrees)")
    a = ap.parse_args()

    root = Path(a.indir)
    frames = sorted(root.rglob("*.png"))
    # Only the plugin's per-column folders count; anything parked in an
    # underscore folder (e.g. _bad/ for frames awaiting recapture) is ignored,
    # otherwise it would be pasted over the fresh frames.
    frames = [
        f for f in frames
        if NAME_RE.match(f.name)
        and not f.name.endswith("_tile.png")
        and not any(p.name.startswith("_") for p in f.relative_to(root).parents)
    ]
    if not frames:
        sys.exit("no frames found")

    hm = Heightmap(a.heightmap) if a.heightmap else None
    with Image.open(frames[0]) as im0:
        fw, fh = im0.size
    if hm is not None:
        f_px = (fh / 2.0) / math.tan(math.radians(a.fov) / 2.0)   # focal length in pixels
        native_ppm = f_px / a.cam_height                            # px/m at nadir
        print(f"ortho: f={f_px:.0f}px, nadir {native_ppm:.3f} px/m, heightmap {a.heightmap.name} ({hm.w}x{hm.h} @ {hm.cs} m)")
    else:
        if not a.ppm:
            sys.exit("flat mode needs --ppm (or pass --heightmap for ortho mode)")
        native_ppm = a.ppm
    crop = int(round(a.step * native_ppm))          # px per tile in raw frame
    tile = max(1, int(round(crop * a.scale)))       # px per tile in output
    out_ppm = tile / a.step
    # Canvas = the whole world (0..world on both axes) unless --bbox narrows it;
    # placement below is always computed in world metres, then shifted by the
    # bbox origin, so a bbox render is pixel-identical to the matching cut of
    # the full mosaic.
    x0, z0, x1, z1 = a.bbox if a.bbox else (0.0, 0.0, a.world, a.world)
    size_x = int(round((x1 - x0) * out_ppm))
    size_z = int(round((z1 - z0) * out_ppm))
    print(f"frames={len(frames)} crop={crop}px tile={tile}px out={size_x}x{size_z} ({out_ppm:.3f} px/m)")
    mosaic = Image.new("RGB", (size_x, size_z), (13, 15, 17))

    # Image-space unit vectors of world +X and +Z (y down). nadir_orient.py
    # reports rot_cw = -angle(+X), and +Z sits 90° counter-clockwise of +X.
    ang_x = math.radians(-a.rot)
    ux = (math.cos(ang_x), math.sin(ang_x))
    uz = (math.sin(ang_x), -math.cos(ang_x))
    if a.flipz:
        uz = (-uz[0], -uz[1])
    if a.flipx:
        ux = (-ux[0], -ux[1])

    if hm is not None:
        import cv2
        # world coords of output pixel centres inside one tile (west→east, north→south)
        loc = (np.arange(tile, dtype=np.float32) + 0.5) / out_ppm - a.step / 2.0
        DX, DZ = np.meshgrid(loc, -loc)          # DZ: row 0 = north = +step/2

    for i, f in enumerate(frames):
        m = NAME_RE.match(f.name)
        x, z = float(m["x"]), float(m["z"])
        if x + a.step / 2 <= x0 or x - a.step / 2 >= x1 or z + a.step / 2 <= z0 or z - a.step / 2 >= z1:
            continue
        if hm is not None:
            frame = cv2.imread(str(f), cv2.IMREAD_COLOR)
            cam_h = hm.at(x, z) + a.cam_height
            elev = hm.sample(x + DX, z + DZ)
            s = f_px / np.maximum(cam_h - elev, 1.0)          # px per metre at each pixel's elevation
            u = (fw - 1) / 2.0 + (DX * ux[0] + DZ * uz[0]) * s
            v = (fh - 1) / 2.0 + (DX * ux[1] + DZ * uz[1]) * s
            tile_bgr = cv2.remap(frame, u.astype(np.float32), v.astype(np.float32), cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=(17, 15, 13))
            c = Image.fromarray(cv2.cvtColor(tile_bgr, cv2.COLOR_BGR2RGB))
        else:
            im = Image.open(f)
            w, h = im.size
            # Rotate a larger centred square first so the final crop has no empty
            # corners for non-90° angles (source needed = crop·(|cos|+|sin|)).
            th = math.radians(a.rot)
            src = int(math.ceil(crop * (abs(math.cos(th)) + abs(math.sin(th))))) + 2
            if src > min(w, h):
                sys.exit(f"crop {crop}px rotated by {a.rot}° needs a {src}px square but frames are {w}x{h}: reduce --step")
            l, t = (w - src) // 2, (h - src) // 2
            c = im.crop((l, t, l + src, t + src))
            if a.rot % 360:
                c = c.rotate(-a.rot, resample=Image.BICUBIC)   # PIL rotates CCW; negative = CW; same size, about the centre
            o = (src - crop) // 2
            c = c.crop((o, o, o + crop, o + crop))
            if a.flipx:
                c = c.transpose(Image.FLIP_LEFT_RIGHT)
            if a.flipz:
                c = c.transpose(Image.FLIP_TOP_BOTTOM)
            if tile != crop:
                c = c.resize((tile, tile), Image.LANCZOS)
        px = int(round((x - a.step / 2 - x0) * out_ppm))
        py = int(round((z1 - (z + a.step / 2)) * out_ppm))  # north (max Z) at the top
        mosaic.paste(c, (px, py))
        if i % 200 == 0:
            print(f"  {i}/{len(frames)}")
    mosaic.save(a.out, quality=92)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
