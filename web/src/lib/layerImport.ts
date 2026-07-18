// Parser for Reforger's .layer file format (Enfusion worldEditor text).
// Extracts scenario-framework markers from the `Markers` layer:
//   GenericEntity AreaMarkers (Area.et)
//     -> GenericEntity LayerN (Layer.et)
//       -> $grp GenericEntity (SlotMarker.et)
//         -> SlotMarkerN
//            -> SCR_ScenarioFrameworkSlotMarker
//               -> m_MapMarkerType (Custom | Military)
//
// World horizontal coords are (engineX, engineZ). Vertical Y in the file is
// ignored (plan schema is 2D). Layer.coords are added if nonzero, even though
// they're almost always (0 0 0).

import { ICONS } from "./markerLibrary";
import type { Faction, MilitaryType } from "./militaryLibrary";

type BaseMarker = {
  id: string;
  worldX: number;
  worldY: number;
  text: string;
  rotation: number;
};

type CustomMarker = BaseMarker & {
  kind: "custom";
  iconCategory: string;
  iconQuad: string;
  colorName: string;
};

type MilitaryMarker = BaseMarker & {
  kind: "military";
  faction: Faction;
  type: MilitaryType;
};

export type ImportedMarker = CustomMarker | MilitaryMarker;

export type ImportedPolygon = {
  id: string;
  /** Polygon ring in [worldX, worldY] pairs (Reforger X/Z). No repeated
   *  closing vertex — Leaflet closes automatically. */
  points: [number, number][];
  /** Solid fill color "#rrggbb" (sRGB). */
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeOpacity: number;
  /** Stroke width in pixels, matches LineDrawCommand.m_fWidth in the mod. */
  strokeWidth: number;
  /** When true, render the exterior of the polygon filled (the interior is
   *  transparent). The outline still traces the polygon itself. */
  fillOutside: boolean;
};

export type ImportResult = {
  markers: ImportedMarker[];
  polygons: ImportedPolygon[];
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Block extraction — depth-1 brace scan that skips quoted strings.
// ---------------------------------------------------------------------------

/** Given `body` and a header-regex (must have `g` flag), yield each
 *  top-level block whose header the regex matches, returning the substring
 *  inside its following `{ ... }`. */
function* iterBlocks(
  body: string,
  headerPattern: RegExp,
): IterableIterator<{ match: RegExpExecArray; inner: string; end: number }> {
  if (!headerPattern.global) {
    throw new Error("iterBlocks requires a /g regex");
  }
  headerPattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = headerPattern.exec(body)) !== null) {
    const braced = findBracedFrom(body, headerPattern.lastIndex);
    if (!braced) return;
    yield { match: m, inner: braced.inner, end: braced.end };
    headerPattern.lastIndex = braced.end;
  }
}

/** Find the next '{...}' block starting at or after `fromIdx`. Returns the
 *  content between the outer braces (exclusive) and the index one past the
 *  matching '}'. Skips string literals so quoted-brace content doesn't throw
 *  off the depth counter. */
function findBracedFrom(
  body: string,
  fromIdx: number,
): { inner: string; end: number } | null {
  let i = fromIdx;
  while (i < body.length && body[i] !== "{") i++;
  if (i >= body.length) return null;
  const start = i + 1;
  let depth = 1;
  i++;
  while (i < body.length && depth > 0) {
    const c = body[i];
    if (c === '"') {
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { inner: body.slice(start, i - 1), end: i };
}

// ---------------------------------------------------------------------------
// Field extraction helpers — all operate on a block's inner text and look
// for top-level occurrences (they don't recurse into nested blocks, so they
// won't pick up identically-named fields buried deeper).
// ---------------------------------------------------------------------------

/** Match the first `coords X Y Z` at the top of `inner`. */
function readCoords(inner: string): [number, number, number] | null {
  const m = inner.match(/\bcoords\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

/** Quoted-string scalar field, e.g. `m_sMapMarkerText "..."`. Undefined if
 *  missing. Unescapes `\"` and `\\`. */
function readQuoted(inner: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s+"((?:[^"\\\\]|\\\\.)*)"`);
  const m = inner.match(re);
  if (!m) return undefined;
  return m[1].replace(/\\(.)/g, "$1");
}

/** Identifier-like field, e.g. `m_eMapMarkerIcon FLAG`. */
function readIdent(inner: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s+([A-Za-z_][A-Za-z0-9_]*)`);
  const m = inner.match(re);
  return m?.[1];
}

/** Integer scalar, e.g. `m_iMapMarkerRotation 90`. */
function readInt(inner: string, name: string): number | undefined {
  const re = new RegExp(`\\b${name}\\s+(-?\\d+)`);
  const m = inner.match(re);
  return m ? parseInt(m[1], 10) : undefined;
}

// ---------------------------------------------------------------------------
// Enum → web library mapping.
// ---------------------------------------------------------------------------

/** Algorithmically convert an icon-enum name to the web library's `quad`
 *  value: lowercase + `_` → `-`, and insert `-` before a trailing digit run.
 *  Examples: FLAG → "flag", MARK_EXCLAMATION → "mark-exclamation",
 *  CIRCLE2 → "circle-2", DIRECTION_OF_ATTACK_MAIN_PLANNED →
 *  "direction-of-attack-main-planned". */
function enumToQuad(enumName: string): string {
  let s = enumName.toLowerCase().replace(/_/g, "-");
  // Insert dash before trailing digit run if not already separated.
  s = s.replace(/([a-z])(\d+)$/, "$1-$2");
  return s;
}

const COLOR_ENUM_MAP: Record<string, string> = {
  WHITE: "WHITE",
  REFORGER_ORANGE: "DARK_ORANGE",
  ORANGE: "ORANGE",
  RED: "RED",
  OPFOR: "RED",
  INDEPENDENT: "GREEN",
  GREEN: "GREEN",
  BLUE: "BLUE",
  BLUFOR: "BLUE",
  DARK_BLUE: "NAVY_BLUE",
  MAGENTA: "PING",
  CIVILIAN: "PURPLE",
  DARK_PINK: "PING",
};

const IDENTITY_ENUM_MAP: Record<string, Faction> = {
  BLUFOR: "blufor",
  ASSUMED_BLUFOR: "blufor",
  OPFOR: "opfor",
  ASSUMED_OPFOR: "opfor",
  INDFOR: "indfor",
  ASSUMED_INDFOR: "indfor",
  UNKNOWN: "unknown",
  ASSUMED_UNKNOWN: "unknown",
  CIVILIAN: "unknown",
  ASSUMED_CIVILIAN: "unknown",
};

/** EMilitarySymbolIcon bit values (subset — the ones we render). Anything
 *  else produces an "empty" marker. */
const ICON_BITS: Record<string, number> = {
  INFANTRY: 1 << 0,
  MOTORIZED: 1 << 1,
  ARMOR: 1 << 2,
  ANTITANK: 1 << 3,
  MORTAR: 1 << 4,
  ARTILLERY: 1 << 5,
  FIXED_WING: 1 << 6,
  ROTARY_WING: 1 << 7,
  RECON: 1 << 8,
  SUPPLY: 1 << 9,
  MAINTENANCE: 1 << 10,
  MEDICAL: 1 << 11,
};

const BIT_TO_MIL_TYPE: Record<number, MilitaryType> = {
  [1 << 0]: "infantry",
  [1 << 1]: "motorized",
  [1 << 2]: "armor",
  [1 << 3]: "antiarmor",
  [1 << 4]: "mortar",
  [1 << 5]: "artillery",
  [1 << 6]: "fixedwing",
  [1 << 8]: "recon",
  [1 << 9]: "supply",
  [1 << 10]: "maintenance",
  [1 << 11]: "medical",
};

function parseIconMask(raw: string | undefined): number {
  if (!raw) return 0;
  const s = raw.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let mask = 0;
  for (const token of s.split(/[\s|]+/).filter(Boolean)) {
    const bit = ICON_BITS[token];
    if (bit != null) mask |= bit;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Top-level parse.
// ---------------------------------------------------------------------------

// Path-independent — we match by suffix (`/Area.et`, etc.) rather than full
// path because the same prefab GUID can be referenced via multiple paths
// (e.g. `Prefabs/TSSystems/TS_MapOverlay.et` vs `Prefabs/TS_MapOverlay.et`).
const AREA_HEADER =
  /GenericEntity\s+\w+\s*:\s*"\{[^"]+\}[^"]*\/Area\.et"\s*/g;

// Solo: `GenericEntity Layer1 : "{GUID}...Layer.et" { ... }` — one layer with
// prefab reference.
const LAYER_SOLO_HEADER =
  /GenericEntity\s+\w+\s*:\s*"\{[^"]+\}[^"]*\/Layer\.et"\s*/g;

// Grouped: `$grp GenericEntity : "{GUID}...Layer.et" { NamedLayer1 { ... }
// NamedLayer2 { ... } }` — the `$grp` form lets multiple named layer blocks
// share one prefab ref.
const LAYER_GROUP_HEADER =
  /\$grp\s+GenericEntity\s*:\s*"\{[^"]+\}[^"]*\/Layer\.et"\s*/g;

// Solo: `GenericEntity SlotMarker1 : "{GUID}...SlotMarker.et" { components {}
// coords X Y Z }` — one slot marker entity, prefab ref + body.
const SLOT_SOLO_HEADER =
  /GenericEntity\s+\w+\s*:\s*"\{[^"]+\}[^"]*\/SlotMarker\.et"\s*/g;

// Grouped: `$grp GenericEntity : "{GUID}...SlotMarker.et" { SlotMarkerN {
// components{} coords } ... }`.
const SLOT_GROUP_HEADER =
  /\$grp\s+GenericEntity\s*:\s*"\{[^"]+\}[^"]*\/SlotMarker\.et"\s*/g;

// Any identifier followed eventually by '{' — used to iterate the named
// sub-blocks inside a grouped layer or slot group (e.g. `SlotMarker1 {`,
// `Layer8 {`).
const NAMED_BLOCK_HEADER = /\b[A-Za-z_]\w*\s*/g;

const SLOT_COMPONENT_HEADER =
  /SCR_ScenarioFrameworkSlotMarker\s+"\{[^"]+\}"\s*/g;

const MAP_MARKER_TYPE_HEADER =
  /m_MapMarkerType\s+(SCR_ScenarioFrameworkMarkerCustom|SCR_ScenarioFrameworkMarkerMilitary)\s+"\{[^"]+\}"\s*/g;

export function parseMarkersLayer(text: string): ImportResult {
  const warnings: string[] = [];
  const markers: ImportedMarker[] = [];
  const polygons = parsePolygons(text, warnings);

  let areaCount = 0;
  for (const area of iterBlocks(text, AREA_HEADER)) {
    areaCount++;
    const areaCoords = readCoords(area.inner);
    if (!areaCoords) {
      warnings.push(`Area #${areaCount}: missing coords — skipped`);
      continue;
    }
    const [ax, , az] = areaCoords;

    for (const layerInner of iterLayerInners(area.inner)) {
      const layerCoords = readCoords(layerInner) ?? [0, 0, 0];
      const [lx, , lz] = layerCoords;
      for (const slotInner of iterSlotInners(layerInner)) {
        const m = parseSlotMarker(slotInner, ax + lx, az + lz, warnings);
        if (m) markers.push(m);
      }
    }
  }

  return { markers, polygons, warnings };
}

/** Yield each Layer's inner content — handles both solo (`GenericEntity
 *  LayerN : "..."`) and grouped (`$grp GenericEntity : "..." { LayerA {} LayerB
 *  {} }`) forms. The two scans are independent and non-overlapping because
 *  the regexes are mutually exclusive (`$grp` vs `GenericEntity <Name>`). */
function* iterLayerInners(areaInner: string): IterableIterator<string> {
  for (const b of iterBlocks(areaInner, LAYER_SOLO_HEADER)) yield b.inner;
  for (const group of iterBlocks(areaInner, LAYER_GROUP_HEADER)) {
    for (const named of iterBlocks(group.inner, NAMED_BLOCK_HEADER)) {
      yield named.inner;
    }
  }
}

/** Yield each SlotMarker's inner content (the body with `components {...}
 *  coords X Y Z`) — handles both grouped and solo forms. */
function* iterSlotInners(layerInner: string): IterableIterator<string> {
  for (const b of iterBlocks(layerInner, SLOT_SOLO_HEADER)) yield b.inner;
  for (const group of iterBlocks(layerInner, SLOT_GROUP_HEADER)) {
    for (const named of iterBlocks(group.inner, NAMED_BLOCK_HEADER)) {
      yield named.inner;
    }
  }
}

// ---------------------------------------------------------------------------
// Polygon zones — $grp PolylineShapeEntity : "{PREFAB_GUID}..." instances.
// Only overrides are serialized in the .layer, so we merge against the
// known prefab's defaults.
// ---------------------------------------------------------------------------

type PrefabDefaults = {
  /** Vertices by GUID, in the winding order the prefab defines them. */
  vertexOrder: string[];
  vertexLocalPos: Record<string, [number, number, number]>;
  fill: [number, number, number, number];
  outline: [number, number, number, number];
  outlineWidth: number;
  fillOutside: boolean;
};

/** Known TS_MapOverlay prefab defaults. Keyed by prefab GUID as seen in the
 *  `$grp PolylineShapeEntity : "{GUID}path"` header. Values here are copied
 *  verbatim from the prefab .et file (and the class default for
 *  outlineWidth, which the prefab doesn't set). */
const PREFAB_DEFAULTS: Record<string, PrefabDefaults> = {
  "9DF03DB4B7D791C3": {
    vertexOrder: [
      "68568A2CAE54701B",
      "68568A2CAE545584",
      "68568A2CAE545D3E",
      "68568A2CAE5446CE",
    ],
    vertexLocalPos: {
      "68568A2CAE54701B": [24, -1.046, 16],
      "68568A2CAE545584": [24, -1.107, -16],
      "68568A2CAE545D3E": [-24, 0.727, -16],
      "68568A2CAE5446CE": [-24, 0.562, 16],
    },
    fill: [0, 0, 0, 0.669],
    outline: [0, 0, 0, 1],
    outlineWidth: 3.0,
    fillOutside: true,
  },
};

/** Class-level defaults for a standalone `PolylineShapeEntity { ... }` that
 *  has no prefab reference. Sourced from TS_MapOverlayComponent attribute
 *  declarations. */
const STANDALONE_POLYGON_DEFAULTS: PrefabDefaults = {
  vertexOrder: [],
  vertexLocalPos: {},
  fill: [1, 0, 0, 0.3],
  outline: [1, 0, 0, 1],
  outlineWidth: 3.0,
  fillOutside: false,
};

const SHAPE_POINT_HEADER = /ShapePoint\s+"\{([^"}]+)\}"\s*/g;

const OVERLAY_COMPONENT_HEADER = /TS_MapOverlayComponent\s+"\{[^"]+\}"\s*/g;

/** Find all PolylineShapeEntity declarations in the text, regardless of
 *  form: grouped (`$grp PolylineShapeEntity : "{GUID}..." { <instances> }`),
 *  solo prefab (`PolylineShapeEntity : "{GUID}..." { ... }`), or standalone
 *  (`PolylineShapeEntity { ... }` with no prefab). A single forward pass
 *  classifies each by inspecting what precedes and follows the keyword. */
function parsePolygons(text: string, warnings: string[]): ImportedPolygon[] {
  const out: ImportedPolygon[] = [];
  const KEYWORD = "PolylineShapeEntity";
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf(KEYWORD, i);
    if (idx === -1) break;

    // Determine if preceded by `$grp`.
    const beforeStart = Math.max(0, idx - 16);
    const before = text.slice(beforeStart, idx);
    const isGrouped = /\$grp\s*$/.test(before);

    // What follows the keyword — either ':' (prefab ref) or '{' (standalone).
    let j = idx + KEYWORD.length;
    while (j < text.length && /\s/.test(text[j])) j++;

    if (text[j] === ":") {
      j++;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '"') {
        i = j;
        continue;
      }
      const qEnd = text.indexOf('"', j + 1);
      if (qEnd === -1) break;
      const qContent = text.slice(j + 1, qEnd);
      const guidMatch = qContent.match(/^\{([^}]+)\}/);
      if (!guidMatch) {
        i = qEnd + 1;
        continue;
      }
      const prefabGuid = guidMatch[1];
      const braced = findBracedFrom(text, qEnd + 1);
      if (!braced) break;
      i = braced.end;

      const defaults = PREFAB_DEFAULTS[prefabGuid];
      if (!defaults) {
        warnings.push(
          `Unrecognized PolylineShapeEntity prefab {${prefabGuid}} — skipped`,
        );
        continue;
      }

      if (isGrouped) {
        for (const inst of iterInstanceBlocks(braced.inner)) {
          const p = parsePolygonInstance(inst, defaults, warnings);
          if (p) out.push(p);
        }
      } else {
        const p = parsePolygonInstance(braced.inner, defaults, warnings);
        if (p) out.push(p);
      }
    } else if (text[j] === "{") {
      // Standalone — no prefab reference, use class defaults.
      const braced = findBracedFrom(text, j);
      if (!braced) break;
      i = braced.end;
      const p = parsePolygonInstance(
        braced.inner,
        STANDALONE_POLYGON_DEFAULTS,
        warnings,
      );
      if (p) out.push(p);
    } else {
      // Unrecognized syntax after keyword — move past the keyword.
      i = idx + KEYWORD.length;
    }
  }
  return out;
}

/** Iterate top-level instance blocks within a `$grp PolylineShapeEntity` body.
 *  Each instance is either anonymous (`{ ... }`) or named (`Identifier { ... }`)
 *  — Workbench emits both forms in the same group, so a parser that handled
 *  only one would silently drop the other. */
function* iterInstanceBlocks(body: string): IterableIterator<string> {
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) return;
    if (body[i] !== "{") {
      while (i < body.length && /[A-Za-z0-9_]/.test(body[i])) i++;
      while (i < body.length && /\s/.test(body[i])) i++;
      if (i >= body.length || body[i] !== "{") return;
    }
    const braced = findBracedFrom(body, i);
    if (!braced) return;
    yield braced.inner;
    i = braced.end;
  }
}

function parsePolygonInstance(
  inner: string,
  defaults: PrefabDefaults,
  warnings: string[],
): ImportedPolygon | null {
  const coords = readCoords(inner) ?? [0, 0, 0];
  const angles = readVector(inner, "angles") ?? [0, 0, 0];
  const scale = readFloat(inner, "scale") ?? 1;

  // Overrides for vertex positions, keyed by GUID.
  const overrides: Record<string, [number, number, number]> = {};
  const pointsBlock = findNamedBlock(inner, "Points");
  if (pointsBlock) {
    SHAPE_POINT_HEADER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SHAPE_POINT_HEADER.exec(pointsBlock)) !== null) {
      const guid = m[1];
      const braced = findBracedFrom(pointsBlock, SHAPE_POINT_HEADER.lastIndex);
      if (!braced) break;
      SHAPE_POINT_HEADER.lastIndex = braced.end;
      const pos = readVector(braced.inner, "Position");
      if (pos) overrides[guid] = pos;
    }
  }

  // Merge prefab defaults with overrides, preserving prefab's winding order.
  const localVerts: [number, number, number][] = [];
  for (const guid of defaults.vertexOrder) {
    localVerts.push(overrides[guid] ?? defaults.vertexLocalPos[guid]);
  }
  // Also include any override GUIDs the prefab doesn't know about (future-
  // proofing for prefabs with added vertices).
  for (const guid of Object.keys(overrides)) {
    if (!defaults.vertexLocalPos[guid]) localVerts.push(overrides[guid]);
  }

  if (localVerts.length < 3) {
    warnings.push(
      `Polygon at (${coords[0]}, ${coords[2]}) has only ${localVerts.length} vertices — skipped`,
    );
    return null;
  }

  // Apply entity transform (yaw around +Y, scale, translate) to each vertex.
  const yawDeg = angles[1];
  const worldPts: [number, number][] = localVerts.map(([lx, , lz]) =>
    transformToWorld(lx, lz, scale, yawDeg, coords[0], coords[2]),
  );

  // Read component overrides (fill/outline/width/fillOutside).
  const componentsBlock = findNamedBlock(inner, "components");
  let fill = defaults.fill;
  let outline = defaults.outline;
  let outlineWidth = defaults.outlineWidth;
  let fillOutside = defaults.fillOutside;
  if (componentsBlock) {
    for (const comp of iterBlocks(componentsBlock, OVERLAY_COMPONENT_HEADER)) {
      const ci = comp.inner;
      const f = readColor(ci, "m_FillColor");
      if (f) fill = f;
      const o = readColor(ci, "m_OutlineColor");
      if (o) outline = o;
      const w = readFloat(ci, "m_OutlineWidth");
      if (w != null) outlineWidth = w;
      const fo = readInt(ci, "m_FillOutside");
      if (fo != null) fillOutside = fo !== 0;
    }
  }

  return {
    id: crypto.randomUUID(),
    points: worldPts,
    fillColor: rgbFloatsToHex(fill[0], fill[1], fill[2]),
    fillOpacity: clamp01(fill[3]),
    strokeColor: rgbFloatsToHex(outline[0], outline[1], outline[2]),
    strokeOpacity: clamp01(outline[3]),
    strokeWidth: Math.max(0, outlineWidth),
    fillOutside,
  };
}

/** Right-handed yaw around +Y, then scale, then translate. Matches
 *  Reforger's entity transform for horizontal (XZ) plane:
 *    x' = cos(θ)·x + sin(θ)·z
 *    z' = -sin(θ)·x + cos(θ)·z
 *  Returns [worldX, worldZ] for Leaflet (worldY = Z). */
function transformToWorld(
  lx: number,
  lz: number,
  scale: number,
  yawDeg: number,
  ox: number,
  oz: number,
): [number, number] {
  const sx = lx * scale;
  const sz = lz * scale;
  const t = (yawDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [ox + c * sx + s * sz, oz + -s * sx + c * sz];
}

function readVector(
  inner: string,
  name: string,
): [number, number, number] | null {
  const re = new RegExp(
    `\\b${name}\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)`,
  );
  const m = inner.match(re);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

function readColor(
  inner: string,
  name: string,
): [number, number, number, number] | null {
  const re = new RegExp(
    `\\b${name}\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)`,
  );
  const m = inner.match(re);
  if (!m) return null;
  return [
    parseFloat(m[1]),
    parseFloat(m[2]),
    parseFloat(m[3]),
    parseFloat(m[4]),
  ];
}

function readFloat(inner: string, name: string): number | undefined {
  const re = new RegExp(`\\b${name}\\s+(-?[\\d.]+)`);
  const m = inner.match(re);
  return m ? parseFloat(m[1]) : undefined;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function rgbFloatsToHex(r: number, g: number, b: number): string {
  const hex = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function parseSlotMarker(
  slotInner: string,
  areaLayerX: number,
  areaLayerZ: number,
  warnings: string[],
): ImportedMarker | null {
  const slotCoords = readCoords(slotInner);
  if (!slotCoords) return null;
  const worldX = Math.round(areaLayerX + slotCoords[0]);
  const worldY = Math.round(areaLayerZ + slotCoords[2]);

  // Descend: SlotMarkerN -> components {...} -> SCR_ScenarioFrameworkSlotMarker {...}
  //   -> m_MapMarkerType <kind> "{guid}" {...}
  const componentsBlock = findNamedBlock(slotInner, "components");
  if (!componentsBlock) return null;

  let kind: "custom" | "military" | null = null;
  let typeInner = "";
  for (const comp of iterBlocks(componentsBlock, SLOT_COMPONENT_HEADER)) {
    for (const mmt of iterBlocks(comp.inner, MAP_MARKER_TYPE_HEADER)) {
      kind =
        mmt.match[1] === "SCR_ScenarioFrameworkMarkerCustom"
          ? "custom"
          : "military";
      typeInner = mmt.inner;
      break;
    }
    if (kind) break;
  }
  if (!kind) return null;

  const text = readQuoted(typeInner, "m_sMapMarkerText") ?? "";

  if (kind === "custom") {
    const iconEnum = readIdent(typeInner, "m_eMapMarkerIcon") ?? "CIRCLE";
    const colorEnum = readIdent(typeInner, "m_eMapMarkerColor") ?? "WHITE";
    const rotation = readInt(typeInner, "m_iMapMarkerRotation") ?? 0;

    const quad = enumToQuad(iconEnum);
    const iconEntry = ICONS.find((i) => i.quad === quad);
    let iconCategory: string;
    let iconQuad: string;
    if (iconEntry) {
      iconCategory = iconEntry.category;
      iconQuad = iconEntry.quad;
    } else {
      warnings.push(`Unknown icon "${iconEnum}" → DOT`);
      const dot = ICONS.find((i) => i.quad === "dot")!;
      iconCategory = dot.category;
      iconQuad = dot.quad;
    }

    const mappedColor = COLOR_ENUM_MAP[colorEnum];
    let colorName: string;
    if (mappedColor) {
      colorName = mappedColor;
    } else {
      warnings.push(`Unknown color "${colorEnum}" → WHITE`);
      colorName = "WHITE";
    }

    return {
      id: crypto.randomUUID(),
      kind: "custom",
      worldX,
      worldY,
      text,
      rotation: ((Math.round(rotation) % 360) + 360) % 360,
      iconCategory,
      iconQuad,
      colorName,
    };
  }

  // Military. The Enfusion serializer omits fields that equal their class
  // default, so an absent value means "default" (BLUFOR / INFANTRY per the
  // vanilla SCR_ScenarioFrameworkMarkerMilitary attribute annotations), not
  // the enum's numeric zero.
  const factionEnum = readIdent(typeInner, "m_eMapMarkerFactionIcon") ?? "BLUFOR";
  const typeRaw = readIdent(typeInner, "m_eMapMarkerType1Modifier");
  const typeInt = readInt(typeInner, "m_eMapMarkerType1Modifier");
  const mask =
    typeInt != null && typeRaw == null
      ? typeInt
      : typeRaw != null
        ? parseIconMask(typeRaw)
        : ICON_BITS.INFANTRY;

  const faction = IDENTITY_ENUM_MAP[factionEnum] ?? "unknown";
  if (!IDENTITY_ENUM_MAP[factionEnum]) {
    warnings.push(`Unknown military identity "${factionEnum}" → unknown`);
  }

  let milType: MilitaryType = "empty";
  if (mask !== 0) {
    const mapped = BIT_TO_MIL_TYPE[mask];
    if (mapped) {
      milType = mapped;
    } else {
      warnings.push(
        `Military type modifier 0x${mask.toString(16)} not supported → empty (${faction})`,
      );
    }
  }

  return {
    id: crypto.randomUUID(),
    kind: "military",
    worldX,
    worldY,
    text,
    rotation: 0,
    faction,
    type: milType,
  };
}

/** Find a top-level `name { ... }` block in `body` and return its inner text.
 *  Unlike iterBlocks this is single-shot and skips the regex-match ceremony
 *  for known literal names. */
function findNamedBlock(body: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\b\\s*`, "g");
  for (const b of iterBlocks(body, re)) {
    return b.inner;
  }
  return null;
}
