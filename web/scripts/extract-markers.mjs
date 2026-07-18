// Extracts marker icon metadata from one or more sources (TS Better Markers,
// vanilla Reforger), parses their imagesets for sprite positions, copies atlas
// PNGs into public/icons/, and emits src/lib/markerLibrary.ts as a typed
// static snapshot. Rerun when a source adds or renames entries.

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

const ATLAS_SOURCES = [
  {
    key: "ts",
    name: "TS Better Markers",
    config:
      "C:/Users/djdav/Documents/My Games/ArmaReforgerWorkbench/addons/Unpacked/TS Better Markers/Configs/Map/MapMarkerConfig.conf",
    imageset:
      "C:/Users/djdav/Documents/My Games/ArmaReforgerWorkbench/addons/Unpacked/TS Better Markers/UI/Textures/Icons/TS_Markers.imageset",
    png: "C:/Users/djdav/Documents/My Games/ArmaReforgerWorkbench/addons/Unpacked/TS Better Markers/UI/Textures/Icons/TSMarkers2.png",
    publicUrl: "/icons/ts-markers.png",
    publicPath: "public/icons/ts-markers.png",
    atlasWidth: 1248,
    atlasHeight: 1248,
    defaultCategory: "ts",
  },
  {
    key: "vanilla",
    name: "Vanilla Reforger",
    config:
      "D:/VSCode_dev/arma-reforger/reference/ReforgerData/Configs/Map/MapMarkerConfig.conf",
    imageset:
      "D:/VSCode_dev/arma-reforger/reference/edds to png/icons_mapMarkersUI.imageset",
    png: "D:/VSCode_dev/arma-reforger/reference/edds to png/icons_mapMarkersUI-400_atlas.png",
    publicUrl: "/icons/vanilla-markers.png",
    publicPath: "public/icons/vanilla-markers.png",
    atlasWidth: 1248,
    atlasHeight: 1520,
    defaultCategory: "general",
  },
];

function parseImageset(path) {
  const src = readFileSync(path, "utf8");
  const refMatch = src.match(/RefSize\s+(\d+)\s+(\d+)/);
  if (!refMatch) throw new Error(`RefSize not found in ${path}`);
  const refWidth = Number(refMatch[1]);
  const refHeight = Number(refMatch[2]);
  const quads = new Map();
  let currentName = null;
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    const nameMatch = line.match(/^ImageSetDefClass\s+"?([^"\s{]+)"?/);
    if (nameMatch) {
      currentName = nameMatch[1];
      continue;
    }
    if (!currentName) continue;
    const posMatch = line.match(/^Pos\s+(\d+)\s+(\d+)/);
    const sizeMatch = line.match(/^Size\s+(\d+)\s+(\d+)/);
    if (posMatch || sizeMatch) {
      const existing = quads.get(currentName) ?? {};
      if (posMatch) {
        existing.x = Number(posMatch[1]);
        existing.y = Number(posMatch[2]);
      }
      if (sizeMatch) {
        existing.w = Number(sizeMatch[1]);
        existing.h = Number(sizeMatch[2]);
      }
      quads.set(currentName, existing);
    }
    if (line === "}") currentName = null;
  }
  return { refWidth, refHeight, quads };
}

function parseConfig(path, defaultCategory) {
  const src = readFileSync(path, "utf8");
  const entries = [];
  let inEntry = false;
  let depth = 0;
  let cat = null;
  let quad = null;
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!inEntry && line.startsWith("SCR_MarkerIconEntry")) {
      inEntry = true;
      depth = 0;
      cat = null;
      quad = null;
    }
    if (inEntry) {
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      const catMatch = line.match(/^m_sCategoryIdentifier\s+"([^"]+)"/);
      if (catMatch) cat = catMatch[1];
      const quadMatch = line.match(/^m_sIconImagesetQuad\s+"([^"]+)"/);
      if (quadMatch) quad = quadMatch[1];
      if (depth === 0 && line.includes("}")) {
        if (quad) {
          entries.push({
            category: cat ?? defaultCategory,
            quad: quad,
          });
        }
        inEntry = false;
      }
    }
  }
  return entries;
}

// Per-quad display-label overrides. The quad id is authoritative for data
// (persists in saved plans), but the human-facing label can drift from it.
const LABEL_OVERRIDES = {
  "ts-bof": "SBF",
};

function toLabel(quad) {
  if (LABEL_OVERRIDES[quad]) return LABEL_OVERRIDES[quad];
  const s = quad.startsWith("ts-") ? quad.slice(3) : quad;
  return s.replace(/-/g, " ").toUpperCase();
}

const allIcons = [];
const atlasesOut = {};

for (const source of ATLAS_SOURCES) {
  const imageset = parseImageset(source.imageset);
  const entries = parseConfig(source.config, source.defaultCategory);
  const scaleX = source.atlasWidth / imageset.refWidth;
  const scaleY = source.atlasHeight / imageset.refHeight;

  mkdirSync(dirname(source.publicPath), { recursive: true });
  copyFileSync(source.png, source.publicPath);
  console.log(`copied ${source.png} -> ${source.publicPath}`);

  atlasesOut[source.key] = {
    url: source.publicUrl,
    width: source.atlasWidth,
    height: source.atlasHeight,
  };

  let added = 0;
  for (const entry of entries) {
    const pos = imageset.quads.get(entry.quad);
    if (!pos || pos.x == null || pos.w == null) {
      console.warn(
        `[${source.name}] no position for quad "${entry.quad}" — skipping`,
      );
      continue;
    }
    allIcons.push({
      category: entry.category,
      quad: entry.quad,
      label: toLabel(entry.quad),
      atlas: source.key,
      x: Math.round(pos.x * scaleX),
      y: Math.round(pos.y * scaleY),
      w: Math.round(pos.w * scaleX),
      h: Math.round(pos.h * scaleY),
    });
    added++;
  }
  console.log(`[${source.name}] ${added} icons`);
}

// Palette matches the engine's placed-marker color config 1:1, plus `black`
// added by the TS Better Markers dependency.  Keep in sync with
// src/lib/markerLibrary.ts COLORS.  `engine` is the config name; `hex` is the
// sRGB display value (source: Figma node 19:1159) — do NOT copy the engine
// config's float RGBs here, those are *linear* and render too dark in a
// browser.
const colors = [
  { name: "BLACK",       label: "Black",        hex: "#000000", engine: "black" },
  { name: "DARK_BROWN",  label: "Dark Brown",   hex: "#60383d", engine: "darkBrown" },
  { name: "PURPLE",      label: "Purple",       hex: "#9151a0", engine: "purple" },
  { name: "PING",        label: "Ping",         hex: "#f038db", engine: "ping" },
  { name: "NAVY_BLUE",   label: "Navy Blue",    hex: "#0d6079", engine: "navyBlue" },
  { name: "CYAN",        label: "Cyan",         hex: "#22c3f3", engine: "cyan" },
  { name: "BLUE",        label: "Blue",         hex: "#0d7aed", engine: "blue" },
  { name: "DARK_GREEN",  label: "Dark Green",   hex: "#005b26", engine: "darkGreen" },
  { name: "GREEN",       label: "Green",        hex: "#22b24f", engine: "green" },
  { name: "RED",         label: "Red",          hex: "#ee2e2e", engine: "red" },
  { name: "DARK_RED",    label: "Dark Red",     hex: "#821c1c", engine: "darkRed" },
  { name: "DARK_ORANGE", label: "Dark Orange",  hex: "#e2a84f", engine: "darkOrange" },
  { name: "ORANGE",      label: "Orange",       hex: "#f9d368", engine: "orange" },
  { name: "WHITE",       label: "White",        hex: "#ffffff", engine: "white" },
];

const atlasKeys = ATLAS_SOURCES.map((s) => JSON.stringify(s.key)).join(" | ");

const out = [
  `// GENERATED by scripts/extract-markers.mjs — do not edit by hand.`,
  `// Re-run: \`node scripts/extract-markers.mjs\``,
  `// Sources: ${ATLAS_SOURCES.map((s) => s.name).join(", ")}`,
  ``,
  `export type AtlasKey = ${atlasKeys};`,
  ``,
  `export type AtlasInfo = { url: string; width: number; height: number };`,
  ``,
  `export const ATLASES: Record<AtlasKey, AtlasInfo> = {`,
];
for (const [key, info] of Object.entries(atlasesOut)) {
  out.push(
    `  ${JSON.stringify(key)}: { url: ${JSON.stringify(info.url)}, width: ${info.width}, height: ${info.height} },`,
  );
}
out.push(`};`);
out.push(``);
out.push(`export type IconEntry = {`);
out.push(`  category: string;`);
out.push(`  quad: string;`);
out.push(`  label: string;`);
out.push(`  atlas: AtlasKey;`);
out.push(`  /** Sprite position within the atlas, in atlas-pixel units. */`);
out.push(`  x: number;`);
out.push(`  y: number;`);
out.push(`  w: number;`);
out.push(`  h: number;`);
out.push(`};`);
out.push(``);
out.push(`export type ColorEntry = {`);
out.push(`  name: string;`);
out.push(`  label: string;`);
out.push(`  hex: string;`);
out.push(`  engine: string;`);
out.push(`};`);
out.push(``);
out.push(`export const ICONS: IconEntry[] = [`);
for (const icon of allIcons) {
  out.push(
    `  { category: ${JSON.stringify(icon.category)}, quad: ${JSON.stringify(icon.quad)}, label: ${JSON.stringify(icon.label)}, atlas: ${JSON.stringify(icon.atlas)}, x: ${icon.x}, y: ${icon.y}, w: ${icon.w}, h: ${icon.h} },`,
  );
}
out.push(`];`);
out.push(``);
out.push(`export const COLORS: ColorEntry[] = [`);
for (const c of colors) {
  out.push(
    `  { name: ${JSON.stringify(c.name)}, label: ${JSON.stringify(c.label)}, hex: ${JSON.stringify(c.hex)}, engine: ${JSON.stringify(c.engine)} },`,
  );
}
out.push(`];`);
out.push(``);
out.push(`export const DEFAULT_ICON = ICONS[0];`);
out.push(`export const DEFAULT_COLOR = COLORS.find(c => c.name === "BLACK") ?? COLORS[0];`);
out.push(``);

const outPath = "src/lib/markerLibrary.ts";
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out.join("\n"));
console.log(`wrote ${outPath} (${allIcons.length} icons, ${colors.length} colors, ${ATLAS_SOURCES.length} atlases)`);
