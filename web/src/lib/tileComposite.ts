// Stitches a map's XYZ tile pyramid into one canvas for the 3D view's
// terrain texture (ported from ts-mission-builder). Loading the single
// full-res JPG instead is prohibitive on big maps (Zimnitrita's 16400²
// source decodes to ~1 GB RGBA); the composite picks the deepest zoom
// level whose stitched size stays within MAX_TEXTURE_PX and draws every
// available tile. Tiles beyond the world's data extent don't exist (404)
// — the pre-filled background color shows there instead.
import type { MapConfig } from "./maps";

const MAX_TEXTURE_PX = 6144;
const TILE_PX = 256;
/** Matches the 3D scene background (and the 2D MapContainer background). */
const BACKGROUND = "#0f172a";
/** Keep at most this many composites alive — a 5000² canvas is ~100 MB RGBA. */
const CACHE_CAP = 3;

const cache = new Map<string, Promise<HTMLCanvasElement>>();

/** Null when the map has no tile pyramid — caller falls back to imagePath. */
export function compositeTerrainTexture(cfg: MapConfig): Promise<HTMLCanvasElement> | null {
  if (!cfg.tilePattern || cfg.tileMaxZoom === undefined) return null;
  const hit = cache.get(cfg.key);
  if (hit) return hit;
  const p = build(cfg, cfg.tilePattern, cfg.tileMaxZoom);
  cache.set(cfg.key, p);
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_CAP) break;
    if (key !== cfg.key) cache.delete(key);
  }
  return p;
}

async function build(cfg: MapConfig, tilePattern: string, tileMaxZoom: number): Promise<HTMLCanvasElement> {
  const w = cfg.worldUR[0] - cfg.worldBL[0];
  const h = cfg.worldUR[1] - cfg.worldBL[1];
  // Meters-per-pixel doubles per level up from the native tileMaxZoom.
  let z = tileMaxZoom;
  while (z > 0 && Math.max(w, h) / 2 ** (tileMaxZoom - z) > MAX_TEXTURE_PX) z--;
  const mpp = 2 ** (tileMaxZoom - z);
  const cw = Math.ceil(w / mpp);
  const ch = Math.ceil(h / mpp);

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, cw, ch);

  // Tile (0,0) sits at the world's NW corner; rows grow southward (same
  // orientation the 2D TileLayer uses via its flipped-Y CRS transformation).
  const jobs: Promise<void>[] = [];
  for (let ty = 0; ty * TILE_PX < ch; ty++) {
    for (let tx = 0; tx * TILE_PX < cw; tx++) {
      const url = tilePattern
        .replace("{z}", String(z))
        .replace("{x}", String(tx))
        .replace("{y}", String(ty));
      jobs.push(
        loadImage(url)
          .then((img) => {
            ctx.drawImage(img, tx * TILE_PX, ty * TILE_PX);
          })
          .catch(() => {}) // absent edge tile — background fill stays
      );
    }
  }
  await Promise.all(jobs);
  return canvas;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}
