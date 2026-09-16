"""
Compose EnfusionMapMaker nadir screenshots into one north-up mosaic covering the
full world rectangle (0..worldSize on both axes), ready for tile_pyramid.py.

Each screenshot {prefix}_{x}_{z}.png was taken with the camera exactly above
world (x, z). Only the centre crop (step * px_per_m square) is used, so every
tile is near-nadir. The World Editor camera looks down with world X running
DOWN the frame and world Z running LEFT (measured on the Arland capture), so
each crop is rotated to north-up before placement.

Usage:
  py nadir_mosaic.py <input dir> <out.png> --world 4100 --step 100 --ppm 6.05 [--scale 0.125] [--rot 90]
"""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
NAME_RE = re.compile(r"^(?P<prefix>.+)_(?P<x>\d+)_(?P<z>\d+)\.png$")

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("indir")
    ap.add_argument("out")
    ap.add_argument("--world", type=float, required=True, help="world size in metres (square)")
    ap.add_argument("--step", type=float, default=100.0, help="camera step in metres")
    ap.add_argument("--ppm", type=float, required=True, help="measured pixels per metre in the raw frames")
    ap.add_argument("--scale", type=float, default=1.0, help="output scale (0.125 = preview)")
    ap.add_argument("--rot", type=int, default=90, help="rotation applied to each crop, degrees CW (0/90/180/270)")
    ap.add_argument("--flipx", action="store_true")
    ap.add_argument("--flipz", action="store_true")
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
    crop = int(round(a.step * a.ppm))          # px per tile in raw frame
    tile = max(1, int(round(crop * a.scale)))   # px per tile in output
    out_ppm = tile / a.step
    size = int(round(a.world * out_ppm))
    print(f"frames={len(frames)} crop={crop}px tile={tile}px out={size}x{size} ({out_ppm:.3f} px/m)")
    mosaic = Image.new("RGB", (size, size), (13, 15, 17))
    for i, f in enumerate(frames):
        m = NAME_RE.match(f.name)
        x, z = float(m["x"]), float(m["z"])
        im = Image.open(f)
        w, h = im.size
        l, t = (w - crop) // 2, (h - crop) // 2
        c = im.crop((l, t, l + crop, t + crop))
        if a.rot:
            c = c.rotate(-a.rot, expand=True)   # PIL rotates CCW; negative = CW
        if a.flipx:
            c = c.transpose(Image.FLIP_LEFT_RIGHT)
        if a.flipz:
            c = c.transpose(Image.FLIP_TOP_BOTTOM)
        if tile != crop:
            c = c.resize((tile, tile), Image.LANCZOS)
        px = int(round((x - a.step / 2) * out_ppm))
        py = int(round((a.world - (z + a.step / 2)) * out_ppm))  # north (max Z) at the top
        mosaic.paste(c, (px, py))
        if i % 200 == 0:
            print(f"  {i}/{len(frames)}")
    mosaic.save(a.out, quality=92)
    print("wrote", a.out)

if __name__ == "__main__":
    main()
