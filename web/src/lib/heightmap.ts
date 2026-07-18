/**
 * Loads a heightmap (raw little-endian uint16 binary + sidecar JSON) and
 * returns a sampler that converts (worldX, worldY) → elevation in metres.
 *
 * The .bin file preserves full 1/65535 precision (≈ 3 cm at Arland's scale),
 * unlike the debug .png which is degraded by 8-bit canvas reads.
 */

export type HeightmapMeta = {
  bin: string;
  png: string;
  widthPx: number;
  heightPx: number;
  cellSizeM: number;
  worldWidthM: number;
  worldHeightM: number;
  heightScale: number;
  minElevationM: number;
  sourceCellSizeM: number;
};

export type HeightmapSampler = {
  meta: HeightmapMeta;
  /** Returns elevation in metres, or NaN if (worldX, worldY) is out of bounds. */
  sample: (worldX: number, worldY: number) => number;
};

/**
 * Row 0 of the source grid corresponds to the NORTH edge of the world
 * (max worldY); row (h-1) = the SOUTH edge (worldY = 0).
 */
export async function loadHeightmap(
  binUrl: string,
  metaUrl: string,
): Promise<HeightmapSampler> {
  const [meta, buf] = await Promise.all([
    fetch(metaUrl).then((r) => r.json() as Promise<HeightmapMeta>),
    fetch(binUrl).then((r) => r.arrayBuffer()),
  ]);

  const raw = new Uint16Array(buf);
  const expected = meta.widthPx * meta.heightPx;
  if (raw.length !== expected) {
    throw new Error(
      `heightmap size mismatch: expected ${expected} u16 values, got ${raw.length}`,
    );
  }

  const { worldWidthM, worldHeightM, widthPx, heightPx, minElevationM, heightScale } = meta;
  const xScale = (widthPx - 1) / worldWidthM;
  const yScale = (heightPx - 1) / worldHeightM;

  const maxPx = widthPx - 1;
  const maxPy = heightPx - 1;
  // Bilinear sampling. Nearest-neighbor caused dot/scanline noise in the
  // radial LOS mask when adjacent ray steps (4m apart) landed in the same
  // 10m cell then abruptly jumped to a neighbor several meters higher.
  // Row 0 of the heightmap corresponds to worldY=0 (south) — larger worldY
  // means larger py.
  const sample = (worldX: number, worldY: number): number => {
    if (worldX < 0 || worldX > worldWidthM) return NaN;
    if (worldY < 0 || worldY > worldHeightM) return NaN;
    const fx = worldX * xScale;
    const fy = worldY * yScale;
    const x0 = Math.min(maxPx, Math.floor(fx));
    const y0 = Math.min(maxPy, Math.floor(fy));
    const x1 = Math.min(maxPx, x0 + 1);
    const y1 = Math.min(maxPy, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const h00 = raw[y0 * widthPx + x0];
    const h10 = raw[y0 * widthPx + x1];
    const h01 = raw[y1 * widthPx + x0];
    const h11 = raw[y1 * widthPx + x1];
    const h = (h00 * (1 - tx) + h10 * tx) * (1 - ty)
            + (h01 * (1 - tx) + h11 * tx) * ty;
    return minElevationM + h * heightScale;
  };

  return { meta, sample };
}
