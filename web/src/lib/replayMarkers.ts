/**
 * Shared HTML builders for replay markers. Used by both MapClient (wraps
 * each output in a Leaflet DivIcon) and MapClient3D (drops the HTML into
 * CSS2DObject elements). Keeping the SVG / class names in one place so the
 * 2D and 3D viewports render visually identical markers.
 *
 * The 3D viewport renders the SVG **shape** as a real WebGL mesh (so yaw
 * rotates in world space, not screen space) but keeps the **label / hover
 * label / vehicle badge** as DOM elements via CSS2DObject. The `*HudHtml`
 * variants here emit the surrounding DOM scaffold (hover-target square +
 * label / hover-label) without the SVG body — exactly what the 3D
 * viewport needs.
 */

import type {
  ReplayCharRenderable,
  ReplayVehicleRenderable,
} from "@/components/MapClient";

/** Grey hex used to detect "this triangle is destroyed". Duplicated from
 *  lib/replay.ts (HEX_DESTROYED) so this util doesn't import from there. */
export const TRIANGLE_DESTROYED_HEX = "#9ca3af";

export function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (m) =>
    m === "<" ? "&lt;" : m === ">" ? "&gt;" : m === "&" ? "&amp;" : "&quot;",
  );
}

export function replayCharHtml(c: ReplayCharRenderable): string {
  const fill = c.color;
  const stroke = c.color === TRIANGLE_DESTROYED_HEX ? "#4b5563" : "#0f172a";
  const shape = c.isDeadPlayer
    ? `<svg width="18" height="20" viewBox="0 0 18 20" fill="none" xmlns="http://www.w3.org/2000/svg" style="overflow: visible; position: absolute; left: -9px; top: -10px;"><path d="M0.666668 11.6666V9.33356C0.666668 7.03671 1.62954 4.82011 3.31022 3.24762C5.01137 1.65549 7.23736 0.865479 9.56413 1.01813C13.9502 1.31185 17.3337 5.08762 17.3337 9.55719V11.6666C17.3337 13.5705 16.1891 15.2064 14.5553 15.9322C14.1344 17.6906 12.5522 18.9996 10.6667 18.9996H7.33366C5.44803 18.9996 3.86489 17.6907 3.44401 15.9322C1.81056 15.2063 0.666668 13.5703 0.666668 11.6666Z" fill="#9CA3AF"/><path d="M9.49867 2.01598C7.446 1.88131 5.492 2.57598 3.994 3.97798C2.51467 5.36198 1.66667 7.31398 1.66667 9.33331V11.6666C1.66667 13.3446 2.79933 14.7626 4.34 15.1966C4.44133 16.76 5.74533 18 7.33333 18H10.6667C12.2547 18 13.5587 16.76 13.66 15.1966C15.2007 14.7626 16.3333 13.3446 16.3333 11.6666V9.55664C16.3333 5.58464 13.3313 2.27264 9.49867 2.01598ZM14.3333 11.6666C14.3333 12.586 13.5853 13.3333 12.6667 13.3333C12.114 13.3333 11.6667 13.7813 11.6667 14.3333V15C11.6667 15.5513 11.218 16 10.6667 16H7.33333C6.782 16 6.33333 15.5513 6.33333 15V14.3333C6.33333 13.7813 5.886 13.3333 5.33333 13.3333C4.41467 13.3333 3.66667 12.586 3.66667 11.6666V9.33331C3.66667 7.84398 4.268 6.45998 5.36 5.43864C6.36 4.50331 7.63933 3.99998 8.99667 3.99998C9.11867 3.99998 9.242 4.00398 9.36533 4.01264C12.1513 4.19798 14.3333 6.63398 14.3333 9.55664V11.6666ZM6.33333 7.99998C5.598 7.99998 5 8.59798 5 9.33331C5 10.0686 5.598 10.6666 6.33333 10.6666C7.06867 10.6666 7.66667 10.0686 7.66667 9.33331C7.66667 8.59798 7.06867 7.99998 6.33333 7.99998ZM11.6667 7.99998C10.9313 7.99998 10.3333 8.59798 10.3333 9.33331C10.3333 10.0686 10.9313 10.6666 11.6667 10.6666C12.402 10.6666 13 10.0686 13 9.33331C13 8.59798 12.402 7.99998 11.6667 7.99998ZM10.3333 13.3333C10.3333 14.07 9.73667 14 9 14C8.26333 14 7.66667 14.07 7.66667 13.3333C7.66667 12.5966 8.26333 11.3333 9 11.3333C9.73667 11.3333 10.3333 12.5966 10.3333 13.3333Z" fill="black"/></svg>`
    : `<svg width="22" height="22" viewBox="-11 -11 22 22" xmlns="http://www.w3.org/2000/svg" style="overflow: visible; position: absolute; left: -11px; top: -11px; transform: rotate(${c.yaw}deg);"><polygon points="0,-9 7,7 -7,7" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" /></svg>`;
  const label = c.label
    ? `<div class="ts-replay-name-label">${escapeHtml(c.label)}</div>`
    : "";
  const hover = c.hoverLabel
    ? `<div class="ts-replay-name-hover">${escapeHtml(c.hoverLabel)}</div>`
    : "";
  const opacityStyle = c.opacity < 1 ? ` style="opacity: ${c.opacity}"` : "";
  return `<div class="ts-replay-char"${opacityStyle}>${shape}${label}${hover}</div>`;
}

/** SVG body for a vehicle marker, sized to fit inside the 18×32 envelope
 *  the caller wraps with a hover-target wrapper. Three glyphs share that
 *  envelope so the marker anchor and hover hitbox stay identical across
 *  kinds:
 *    - `vehicle_unarmed` — tall pentagon (peak north).
 *    - `vehicle_armed` — same pentagon with an interior turret glyph
 *      (vertical barrel above a hollow circle) drawn in the stroke color.
 *    - `static_weapon` — square footprint with a barrel sticking out the
 *      north side and a T-shaped baseplate inside. Visibly squat next to
 *      the pentagons so a glance separates emplacements from mobiles.
 *  `fill` is the resolved faction/state color; `stroke` is the outline
 *  (dark for live, mid-grey for destroyed). Interior detail uses the
 *  stroke color so it stays legible across all faction fills. */
function vehicleShapeSvg(
  kind: ReplayVehicleRenderable["kind"],
  fill: string,
  stroke: string,
  yaw: number,
): string {
  const open = `<svg width="18" height="32" viewBox="-9 -16 18 32" xmlns="http://www.w3.org/2000/svg" style="overflow: visible; position: absolute; left: -9px; top: -16px; transform: rotate(${yaw}deg);">`;
  if (kind === "static_weapon") {
    return (
      open +
      // Square body
      `<rect x="-7" y="-2" width="14" height="14" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" />` +
      // One continuous barrel — starts outside the square (north) and runs
      // down through the body to meet the baseplate crossbar.
      `<rect x="-1.25" y="-13" width="2.5" height="19" fill="${stroke}" />` +
      // Horizontal baseplate crossbar (the foot of the T).
      `<rect x="-4" y="4" width="8" height="2" fill="${stroke}" />` +
      `</svg>`
    );
  }
  // Both pentagon variants share the outer shape.
  const pentagon = `<polygon points="0,-15 7,-7 7,14 -7,14 -7,-7" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" />`;
  if (kind === "vehicle_armed") {
    return (
      open +
      pentagon +
      // Barrel
      `<rect x="-1.25" y="-6" width="2.5" height="9" fill="${stroke}" />` +
      // Turret circle (hollow so the faction fill shows through)
      `<circle cx="0" cy="7" r="4" fill="none" stroke="${stroke}" stroke-width="2" />` +
      `</svg>`
    );
  }
  // Default: vehicle_unarmed.
  return open + pentagon + `</svg>`;
}

export function replayVehicleHtml(v: ReplayVehicleRenderable): string {
  const fill = v.color;
  const stroke = v.color === TRIANGLE_DESTROYED_HEX ? "#4b5563" : "#0f172a";
  const shape = vehicleShapeSvg(v.kind, fill, stroke, v.yaw);
  const hover =
    v.occupantNames.length > 0
      ? `<div class="ts-replay-veh-hover">${v.occupantNames.map((n) => `<div>${escapeHtml(n)}</div>`).join("")}</div>`
      : "";
  return `<div class="ts-replay-veh">${shape}${hover}</div>`;
}

export function replayVehicleBadgeHtml(v: ReplayVehicleRenderable): string {
  return `<div style="position: absolute; left: 6px; top: -16px; min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box; background: #14181a; color: #fafafa; border: 1px solid #f4db50; border-radius: 8px; font: 600 10px var(--font-roboto), ui-sans-serif, system-ui; line-height: 14px; text-align: center; pointer-events: none;">${v.playerBadge}</div>`;
}

/** 3D-viewport HUD scaffold for a char: just the wrapper + a transparent
 *  hover-target square (so CSS :hover on the wrapper fires when the cursor
 *  is over the marker location) + label + hover-label. NO SVG triangle —
 *  the triangle is a real 3D mesh in the WebGL scene.
 *  Dead players are an exception: the skull is purely cosmetic with no
 *  heading, so we route through the full {@link replayCharHtml} instead
 *  so the screen-aligned skull stays. */
export function replayCharHudHtml(c: ReplayCharRenderable): string {
  if (c.isDeadPlayer) return replayCharHtml(c);
  const hoverTarget = `<div style="position:absolute;left:-11px;top:-11px;width:22px;height:22px;pointer-events:auto;"></div>`;
  const label = c.label
    ? `<div class="ts-replay-name-label">${escapeHtml(c.label)}</div>`
    : "";
  const hover = c.hoverLabel
    ? `<div class="ts-replay-name-hover">${escapeHtml(c.hoverLabel)}</div>`
    : "";
  const opacityStyle = c.opacity < 1 ? ` style="opacity: ${c.opacity}"` : "";
  return `<div class="ts-replay-char"${opacityStyle}>${hoverTarget}${label}${hover}</div>`;
}

/** 3D-viewport HUD scaffold for a vehicle: hover-target + occupant hover
 *  list. The pentagon shape is a real 3D mesh. The optional player-count
 *  badge is a separate CSS2D object owned by the caller (matches the 2D
 *  viewport's separate pane to avoid z-stacking with neighboring vehicles). */
export function replayVehicleHudHtml(v: ReplayVehicleRenderable): string {
  const hoverTarget = `<div style="position:absolute;left:-9px;top:-16px;width:18px;height:32px;pointer-events:auto;"></div>`;
  const hover =
    v.occupantNames.length > 0
      ? `<div class="ts-replay-veh-hover">${v.occupantNames.map((n) => `<div>${escapeHtml(n)}</div>`).join("")}</div>`
      : "";
  return `<div class="ts-replay-veh">${hoverTarget}${hover}</div>`;
}
