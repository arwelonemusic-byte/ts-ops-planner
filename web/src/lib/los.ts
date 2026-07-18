import type { HeightmapSampler } from "./heightmap";

export type LosSample = {
  /** Meters from A along the ground line. */
  d: number;
  /** Terrain elevation in meters. */
  elev: number;
};

export type LosResult = {
  samples: LosSample[];
  aElev: number;
  bElev: number;
  totalDistance: number;
  /** Index into `samples` of the first obstruction, or null when LOS is clear. */
  obstructionIdx: number | null;
  obstructionDist: number | null;
};

export type LosOptions = {
  /** Added to both A and B ground elevations for the sight line. Default 1.7m. */
  eyeHeightM?: number;
  /** Upper bound on sample count along the profile. Default 512. */
  maxSamples?: number;
};

const EPSILON_M = 0.1;

export function computeLineOfSight(
  sampler: HeightmapSampler,
  a: [number, number],
  b: [number, number],
  opts: LosOptions = {},
): LosResult | null {
  const eye = opts.eyeHeightM ?? 1.7;
  const maxSamples = opts.maxSamples ?? 512;

  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const totalDistance = Math.hypot(dx, dy);
  if (!(totalDistance > 0)) return null;

  const cellSize = sampler.meta.sourceCellSizeM || 1;
  const stepFromCap = totalDistance / Math.max(1, maxSamples - 1);
  const step = Math.max(cellSize, stepFromCap);
  const count = Math.max(2, Math.ceil(totalDistance / step) + 1);

  const samples: LosSample[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = i === count - 1 ? 1 : i / (count - 1);
    const wx = a[0] + dx * t;
    const wy = a[1] + dy * t;
    const raw = sampler.sample(wx, wy);
    const elev = Number.isFinite(raw) ? raw : 0;
    samples[i] = { d: t * totalDistance, elev };
  }

  const aElev = samples[0].elev;
  const bElev = samples[count - 1].elev;

  let obstructionIdx: number | null = null;
  for (let i = 1; i < count - 1; i++) {
    const t = samples[i].d / totalDistance;
    const sight = aElev + eye + (bElev - aElev) * t;
    if (samples[i].elev > sight + EPSILON_M) {
      obstructionIdx = i;
      break;
    }
  }

  return {
    samples,
    aElev,
    bElev,
    totalDistance,
    obstructionIdx,
    obstructionDist: obstructionIdx === null ? null : samples[obstructionIdx].d,
  };
}
