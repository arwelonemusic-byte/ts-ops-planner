"""
Generate a Leaflet-compatible XYZ tile pyramid from a single-JPG map image.

Leaflet's CRS.Simple + TileLayer only loads the ~20 currently-visible tiles at the
current zoom, instead of decoding the entire 16400x16400 source every frame. For
Zimnitrita this takes the in-memory working set from ~1 GB to a few MB.

Tile layout matches the standard Google/OSM XYZ scheme (y=0 at top, matching
PIL image row 0), so Leaflet's default TileLayer consumes it without a custom
getTileUrl. Tiles are written to `<out_root>/<map_key>/<z>/<x>/<y>.jpg`.

Zoom levels: z=0 is the whole map in a single 256-px tile; each higher z doubles
linear resolution. max_z = ceil(log2(max(W, H) / tile_size)) — just enough to
expose the source's native resolution without synthetic upscaling.

Usage:
  py tools/map-gen/tile_pyramid.py web/public/zimnitrita_final.jpg zimnitrita
  py tools/map-gen/tile_pyramid.py <source.jpg> <key> [--quality 85] [--tile-size 256]
"""

from __future__ import annotations
import argparse
import math
import shutil
import sys
from pathlib import Path

from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # our maps exceed the default anti-bomb limit


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="Source image (JPG/PNG). Must be the final map image.")
    ap.add_argument("map_key", help="Map key (e.g. 'zimnitrita'). Tiles go in <out-root>/<map_key>/.")
    ap.add_argument("--tile-size", type=int, default=256)
    ap.add_argument("--quality", type=int, default=85)
    ap.add_argument("--out-root", default="web/public/tiles",
                    help="Directory to write tiles into (relative to repo root). Existing <map_key> dir is wiped.")
    ap.add_argument("--pad-color", default="15,23,42",
                    help="Comma-separated R,G,B used to pad edge tiles whose source region is smaller "
                         "than tile_size. Default matches MapClient's #0f172a map-container background so "
                         "the overhang blends into the viewport bg instead of showing as black.")
    args = ap.parse_args()

    src_path = Path(args.source)
    if not src_path.exists():
        sys.exit(f"source not found: {src_path}")

    try:
        pad_color = tuple(int(c) for c in args.pad_color.split(","))
        if len(pad_color) != 3:
            raise ValueError
    except ValueError:
        sys.exit(f"invalid --pad-color {args.pad_color!r}: want 'R,G,B'")

    print(f"[tile_pyramid] opening {src_path}...")
    src = Image.open(src_path).convert("RGB")
    W, H = src.size
    max_dim = max(W, H)
    max_z = math.ceil(math.log2(max_dim / args.tile_size))
    print(f"[tile_pyramid] source {W}x{H}  tile={args.tile_size}px  max_z={max_z}")

    out_dir = Path(args.out_root) / args.map_key
    if out_dir.exists():
        print(f"[tile_pyramid] wiping existing {out_dir}...")
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    total = 0
    for z in range(max_z + 1):
        # Scale so that at z=max_z we're at native resolution (no upscale), and at
        # z=0 the whole image fits in one tile.
        scale = 2 ** (z - max_z)
        new_w = max(1, round(W * scale))
        new_h = max(1, round(H * scale))
        img = src.resize((new_w, new_h), Image.LANCZOS) if (new_w, new_h) != (W, H) else src
        cols = math.ceil(new_w / args.tile_size)
        rows = math.ceil(new_h / args.tile_size)

        count = 0
        for x in range(cols):
            for y in range(rows):
                left = x * args.tile_size
                top = y * args.tile_size
                right = min(left + args.tile_size, new_w)
                bot = min(top + args.tile_size, new_h)
                tile = img.crop((left, top, right, bot))
                # Pad edge tiles so every file is a clean 256x256 JPEG. Color matches the
                # map-container background so the overhang blends with the viewport.
                if tile.size != (args.tile_size, args.tile_size):
                    canvas = Image.new("RGB", (args.tile_size, args.tile_size), pad_color)
                    canvas.paste(tile, (0, 0))
                    tile = canvas
                tile_dir = out_dir / str(z) / str(x)
                tile_dir.mkdir(parents=True, exist_ok=True)
                tile.save(tile_dir / f"{y}.jpg", "JPEG", quality=args.quality, optimize=False)
                count += 1
        total += count
        print(f"[tile_pyramid]   z={z}  {new_w}x{new_h}  {cols}x{rows}  {count} tiles")

    # Sum on-disk size.
    size_bytes = sum(f.stat().st_size for f in out_dir.rglob("*.jpg"))
    print(f"[tile_pyramid] done. {total} tiles, {size_bytes / 1024 / 1024:.1f} MB at {out_dir}")
    print(f"[tile_pyramid] register with: tilePattern=\"/tiles/{args.map_key}/{{z}}/{{x}}/{{y}}.jpg\", maxZoom={max_z}")


if __name__ == "__main__":
    main()
