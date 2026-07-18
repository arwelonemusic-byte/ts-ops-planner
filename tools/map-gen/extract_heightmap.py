"""
Extract a world's heightmap from Arma Reforger's unpacked ReforgerData.

Reads Terrain.terr for metadata (grid size, cell size, min elevation, scale)
and all Terrain_<n>.ttile files for the 16-bit height grid. Emits:

  <out>.png   — 16-bit grayscale PNG of the full raw heightmap
  <out>.json  — sidecar with metadata (minElevation, heightScale, worldSizeM, …)

Formula at runtime:
  elevation_m = minElevation + rawU16 * heightScale

Usage:
  py extract_heightmap.py <world_dir> -o out_base [--downsample-m 10]

  <world_dir> must contain:
      Terrain/Terrain.terr
      Terrain/.Data/Terrain_<n>.ttile   (n = 0..N-1)
"""

from __future__ import annotations
import argparse
import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def iff_chunks(data: bytes):
    """Yield (tag, body) pairs from an IFF FORM."""
    if data[:4] != b"FORM":
        raise ValueError("not IFF")
    form_size = struct.unpack(">I", data[4:8])[0]
    # data[8:12] is the form type (TERR for ours)
    pos = 12
    end = 8 + form_size
    while pos < end:
        tag = data[pos:pos + 4]
        size = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        yield tag, body
        pos += 8 + size
        if size & 1:  # IFF padding
            pos += 1


def read_terr_head(terr_path: Path):
    data = terr_path.read_bytes()
    for tag, body in iff_chunks(data):
        if tag == b"HEAD":
            # 8 × uint32-worth of bytes; first 4 ints then 3 floats + trailing u32
            grid_w, grid_h, blocks, unk = struct.unpack("<IIII", body[:16])
            cell_size, height_scale, min_elev = struct.unpack("<fff", body[16:28])
            return {
                "gridW": grid_w,
                "gridH": grid_h,
                "blocks": blocks,
                "cellSize": float(cell_size),
                "heightScale": float(height_scale),
                "minElevation": float(min_elev),
            }
    raise ValueError("no HEAD chunk in .terr")


def read_ttile_hght(path: Path) -> np.ndarray:
    """Return the HGHT data as a 2D uint16 numpy array (tile_h × tile_w)."""
    data = path.read_bytes()
    for tag, body in iff_chunks(data):
        if tag == b"HGHT":
            count = len(body) // 2
            side = int(math.isqrt(count))
            if side * side != count:
                raise ValueError(f"{path.name}: non-square HGHT ({count})")
            arr = np.frombuffer(body, dtype=np.uint16).reshape(side, side)
            return arr
    raise ValueError(f"no HGHT in {path}")


def assemble_heightmap(world_dir: Path):
    # Auto-locate the single .terr file under world_dir.  Reforger's layout
    # is inconsistent across worlds:
    #   Arland: <world>/Terrain/Terrain.terr + Terrain/.Data/Terrain_N.ttile
    #   Eden:   <world>/Eden/Eden.terr       + Eden/.Data/Eden_N.ttile
    terrs = list(world_dir.rglob("*.terr"))
    if not terrs:
        raise SystemExit(f"no .terr file found under {world_dir}")
    if len(terrs) > 1:
        print(f"WARNING: multiple .terr files found, using first: {terrs[0]}")
    terr = terrs[0]
    data_dir = terr.parent / ".Data"
    meta = read_terr_head(terr)
    grid_w = meta["gridW"]
    grid_h = meta["gridH"]
    print(f"HEAD: {grid_w}×{grid_h} vertices, cellSize={meta['cellSize']}m, "
          f"heightScale={meta['heightScale']}, minElev={meta['minElevation']:.2f}m")

    # Tile filenames look like "<Prefix>_<n>.ttile"; prefix varies per world.
    tile_paths = sorted(
        data_dir.glob("*.ttile"),
        key=lambda p: int(p.stem.rsplit("_", 1)[1]),
    )
    if not tile_paths:
        raise SystemExit(f"no .ttile files in {data_dir}")
    sample = read_ttile_hght(tile_paths[0])
    tile_side = sample.shape[0]  # includes the +1 edge → tile covers (side-1) cells
    faces = tile_side - 1  # number of 2m-cells in one tile edge
    tiles_per_row = (grid_w - 1) // faces
    tiles_per_col = (grid_h - 1) // faces
    expected = tiles_per_row * tiles_per_col
    print(f"tile side={tile_side} vertices ({faces} cells), "
          f"grid is {tiles_per_row}×{tiles_per_col} tiles (expecting {expected})")
    if len(tile_paths) != expected:
        print(f"  WARNING: found {len(tile_paths)} tile files, expected {expected}")

    # Allocate full heightmap
    hm = np.zeros((grid_h, grid_w), dtype=np.uint16)

    # Layout assumption: tile N at (row = N // tiles_per_row, col = N % tiles_per_row),
    # row 0 at the top.  If final PNG ends up flipped relative to worldY, we'll flip
    # in post.
    for p in tile_paths:
        n = int(p.stem.rsplit("_", 1)[1])
        tile = read_ttile_hght(p)
        r = n // tiles_per_row
        c = n % tiles_per_row
        y0 = r * faces
        x0 = c * faces
        # Paste including the +1 edge (last row/col overlaps with next tile, which
        # is fine since it's the same value).
        hm[y0:y0 + tile_side, x0:x0 + tile_side] = tile

    return hm, meta, (tiles_per_row, tiles_per_col)


def downsample(arr: np.ndarray, step: int) -> np.ndarray:
    """Nearest-neighbour downsample; preserves raw uint16."""
    if step <= 1:
        return arr
    return arr[::step, ::step]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("world_dir", type=Path,
                    help="Path to e.g. .../ReforgerData/worlds/Arland")
    ap.add_argument("-o", "--output", type=Path, required=True,
                    help="Output base path (without extension)")
    ap.add_argument("--downsample-m", type=float, default=0,
                    help="Target spacing in metres (0 = keep native resolution)")
    args = ap.parse_args()

    hm, meta, tiles_grid = assemble_heightmap(args.world_dir)
    native_cell = meta["cellSize"]

    step = 1
    if args.downsample_m > 0:
        step = max(1, int(round(args.downsample_m / native_cell)))
    hm_ds = downsample(hm, step)
    effective_cell = native_cell * step

    args.output.parent.mkdir(parents=True, exist_ok=True)
    png_path = args.output.with_suffix(".png")
    bin_path = args.output.with_suffix(".bin")
    json_path = args.output.with_suffix(".json")

    # 16-bit PNG (for eyeballing / debugging). Note: browser <canvas> reads
    # are 8-bit so this is *not* suitable for web sampling.
    img = Image.fromarray(hm_ds, mode="I;16")
    img.save(png_path, optimize=True)

    # Raw little-endian uint16 array — what the web app loads via ArrayBuffer
    # to preserve full 1/65535 precision.
    hm_ds.astype("<u2").tofile(bin_path)

    world_w_m = (meta["gridW"] - 1) * native_cell
    world_h_m = (meta["gridH"] - 1) * native_cell
    info = {
        "bin": bin_path.name,
        "png": png_path.name,
        "widthPx": hm_ds.shape[1],
        "heightPx": hm_ds.shape[0],
        "cellSizeM": effective_cell,
        "worldWidthM": world_w_m,
        "worldHeightM": world_h_m,
        "heightScale": meta["heightScale"],
        "minElevationM": meta["minElevation"],
        "sourceCellSizeM": native_cell,
        "tileLayout": {"cols": tiles_grid[0], "rows": tiles_grid[1]},
    }
    json_path.write_text(json.dumps(info, indent=2))

    # Quick elevation stats for sanity
    min_raw = int(hm_ds.min())
    max_raw = int(hm_ds.max())
    min_elev = meta["minElevation"] + min_raw * meta["heightScale"]
    max_elev = meta["minElevation"] + max_raw * meta["heightScale"]
    print(f"\nWrote {png_path}  ({hm_ds.shape[1]}×{hm_ds.shape[0]}, "
          f"{effective_cell:g} m/px)")
    print(f"Wrote {json_path}")
    print(f"Elevation range: {min_elev:.1f} m .. {max_elev:.1f} m  "
          f"(raw {min_raw}..{max_raw})")


if __name__ == "__main__":
    main()
