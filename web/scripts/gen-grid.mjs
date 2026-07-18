// Generates public/everon-grid.svg — a 12,800m-square gridded placeholder.
// 1 SVG unit == 1 world meter. Used as ImageOverlay for the Leaflet CRS.Simple map
// during Stage 1, before the real Everon tileset is wired up.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SIZE = 12800;
const STEP_MINOR = 1000;
const STEP_MAJOR = 5000;

const out = [];
out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
out.push(
  `<svg viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">`,
);

out.push(`  <rect width="${SIZE}" height="${SIZE}" fill="#f1f5f9"/>`);

// Vertical gridlines: worldX == SVG x, no flip needed.
// Horizontal gridlines: worldY == SIZE - SVG y, so we draw horizontals at SVG y = SIZE - v.
out.push(`  <g stroke="#cbd5e1" stroke-width="25" fill="none">`);
for (let v = STEP_MINOR; v < SIZE; v += STEP_MINOR) {
  if (v % STEP_MAJOR === 0) continue;
  out.push(`    <line x1="${v}" y1="0" x2="${v}" y2="${SIZE}"/>`);
  const svgY = SIZE - v;
  out.push(`    <line x1="0" y1="${svgY}" x2="${SIZE}" y2="${svgY}"/>`);
}
out.push(`  </g>`);

out.push(`  <g stroke="#475569" stroke-width="60" fill="none">`);
for (let v = STEP_MAJOR; v < SIZE; v += STEP_MAJOR) {
  out.push(`    <line x1="${v}" y1="0" x2="${v}" y2="${SIZE}"/>`);
  const svgY = SIZE - v;
  out.push(`    <line x1="0" y1="${svgY}" x2="${SIZE}" y2="${svgY}"/>`);
}
out.push(`  </g>`);

out.push(
  `  <text x="6400" y="550" text-anchor="middle" font-family="monospace" font-size="360" font-weight="bold" fill="#64748b">N (worldY = 12800)</text>`,
);
out.push(
  `  <text x="6400" y="12500" text-anchor="middle" font-family="monospace" font-size="360" font-weight="bold" fill="#64748b">S (worldY = 0)</text>`,
);
out.push(
  `  <text x="250" y="6500" font-family="monospace" font-size="360" font-weight="bold" fill="#64748b" transform="rotate(-90 250 6500)">W (worldX = 0)</text>`,
);
out.push(
  `  <text x="12550" y="6500" font-family="monospace" font-size="360" font-weight="bold" fill="#64748b" text-anchor="end" transform="rotate(-90 12550 6500)">E (worldX = 12800)</text>`,
);

out.push(
  `  <g fill="#0f172a" font-family="monospace" font-size="260" font-weight="bold">`,
);
for (let v = STEP_MINOR; v < SIZE; v += STEP_MINOR) {
  const svgY = SIZE - v - 80;
  out.push(`    <text x="750" y="${svgY}">Y=${v}</text>`);
}
out.push(`  </g>`);

out.push(
  `  <g fill="#0f172a" font-family="monospace" font-size="260" font-weight="bold" text-anchor="start">`,
);
for (let v = STEP_MINOR; v < SIZE; v += STEP_MINOR) {
  out.push(`    <text x="${v + 100}" y="12100">X=${v}</text>`);
}
out.push(`  </g>`);

out.push(
  `  <text x="6400" y="6400" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="460" font-weight="bold" fill="#cbd5e1">EVERON (PLACEHOLDER)</text>`,
);

out.push(`</svg>`);

const outPath = "public/everon-grid.svg";
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out.join("\n"));
console.log(`wrote ${outPath} (${out.length} lines)`);
