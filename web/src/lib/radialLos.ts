import type { HeightmapSampler } from "./heightmap";

export type RadialLosResult = {
  /** PNG data URL for an ImageOverlay; transparent where visible, 70% black where blocked. */
  maskUrl: string;
  /** World-meter bottom-left (min worldX, min worldY) of the mask bbox. */
  worldBL: [number, number];
  /** World-meter upper-right (max worldX, max worldY) of the mask bbox. */
  worldUR: [number, number];
  radiusM: number;
};

export type RadialLosOptions = {
  /** Added to observer and target ground elevations. Default 1.7m. */
  eyeHeightM?: number;
  /** Number of angular samples around the full circle. Default 720 (0.5°). */
  rays?: number;
  /** Meters per mask pixel; also the ray march step size. Default 4. */
  mPerPx?: number;
};

const BLOCKED_ALPHA = 178; // 70% of 255
const EPSILON = 1e-6;

export function computeRadialLos(
  sampler: HeightmapSampler,
  center: [number, number],
  radiusM: number,
  opts: RadialLosOptions = {},
): RadialLosResult | null {
  if (!(radiusM > 0)) return null;
  const eye = opts.eyeHeightM ?? 1.7;
  // 1440 rays = 0.25° angular resolution. At rim ~500m, adjacent rays are
  // ~2.2m apart — sub-pixel at 4m/px, so neighbouring pixels consistently
  // bucket into the same ray and rim stripe-aliasing disappears.
  const rays = opts.rays ?? 1440;
  const mPerPx = opts.mPerPx ?? 4;
  const stepM = mPerPx;

  const groundAtCenter = sampler.sample(center[0], center[1]);
  const observerGround = Number.isFinite(groundAtCenter) ? groundAtCenter : 0;
  const observerEye = observerGround + eye;

  const stepsPerRay = Math.max(1, Math.ceil(radiusM / stepM));

  // Per-ray horizon scan. For each step, track two slopes from the observer:
  //   slopeFromEye    = (terrain   - observerEye)    / d  → running max = horizon
  //   targetSlope     = (terrain   - observerGround) / d  → equals slope from
  //       observerEye to a 1.7m-tall standing target (obs_eye → terrain + eye),
  //       because the two eye heights cancel on the numerator.
  // A step is blocked iff targetSlope is below the max slopeFromEye so far.
  // (Earlier version used targetSlope on both sides, which adds a spurious
  // +eye/d to intermediate terrain slopes and causes tiny nearby bumps to
  // swallow everything beyond ~50m. Symptom: "almost nothing visible".)
  const rayBlocked: Uint8Array[] = new Array(rays);
  for (let r = 0; r < rays; r++) {
    const theta = (r / rays) * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const flags = new Uint8Array(stepsPerRay);
    let maxSlope = -Infinity;
    for (let i = 0; i < stepsPerRay; i++) {
      const d = (i + 1) * stepM;
      const wx = center[0] + cos * d;
      const wy = center[1] + sin * d;
      const terrain = sampler.sample(wx, wy);
      if (!Number.isFinite(terrain)) {
        flags[i] = 1;
        continue;
      }
      const slopeFromEye = (terrain - observerEye) / d;
      const targetSlope = (terrain - observerGround) / d;
      if (targetSlope + EPSILON < maxSlope) {
        flags[i] = 1;
      } else if (slopeFromEye > maxSlope) {
        maxSlope = slopeFromEye;
      }
    }
    rayBlocked[r] = flags;
  }

  // Rasterize the mask. Row 0 = north edge (worldY = center.y + r).
  const size = Math.max(1, Math.ceil((2 * radiusM) / mPerPx));
  const image = new Uint8ClampedArray(size * size * 4);
  const raysPerRad = rays / (Math.PI * 2);
  const r2 = radiusM * radiusM;
  for (let py = 0; py < size; py++) {
    const dy = radiusM - (py + 0.5) * mPerPx;
    for (let px = 0; px < size; px++) {
      const dx = (px + 0.5) * mPerPx - radiusM;
      const dd = dx * dx + dy * dy;
      if (dd > r2) continue; // outside circle → transparent
      const d = Math.sqrt(dd);
      let theta = Math.atan2(dy, dx);
      if (theta < 0) theta += Math.PI * 2;
      const rayIdx = Math.floor(theta * raysPerRad) % rays;
      const stepIdx = Math.min(
        stepsPerRay - 1,
        Math.max(0, Math.round(d / stepM) - 1),
      );
      if (rayBlocked[rayIdx][stepIdx]) {
        const off = (py * size + px) * 4;
        image[off + 3] = BLOCKED_ALPHA; // rgb stays 0,0,0
      }
    }
  }

  const maskUrl = imageDataToPngUrl(image, size, size);
  return {
    maskUrl,
    worldBL: [center[0] - radiusM, center[1] - radiusM],
    worldUR: [center[0] + radiusM, center[1] + radiusM],
    radiusM,
  };
}

function imageDataToPngUrl(pixels: Uint8ClampedArray, w: number, h: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  const imageData = ctx.createImageData(w, h);
  imageData.data.set(pixels);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}
