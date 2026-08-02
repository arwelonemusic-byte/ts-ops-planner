"use client";

/**
 * 3D viewport with replay overlays.
 *
 * Coordinate mapping:
 *   - three.js X = worldX
 *   - three.js Y = elevation (m)
 *   - three.js Z = -worldY  (north has the most negative Z)
 *
 * Controls (custom, no OrbitControls):
 *   - LMB drag           pan target on the ground plane
 *   - MMB drag           orbit around the terrain point under the cursor
 *   - Wheel              cursor-anchored zoom (dolly)
 *   - WASD / Q / E       keyboard pan / orbit around the viewport center
 *
 * Architecture: useEffect on [mapConfig] builds the terrain + camera + WebGL
 * + CSS2D renderers and stashes everything on a ref. Per-frame replay data
 * (chars, vehicles, shots) flows through separate sync effects that mutate
 * the existing world — so playback at 60fps doesn't rebuild the scene each
 * frame.
 *
 * The terrain core (MeshGrid drape/pick, tile-composite texture, unlit
 * material, camera tween, keyboard rig) is shared lineage with
 * ts-mission-builder's MissionMap3D — that file was forked from this one,
 * grew editing support, and the improved core was ported back here.
 *
 *   - Terrain renders UNLIT (MeshBasicMaterial): the map tiles already carry
 *     baked hillshading, engine lighting would double-shade slopes.
 *   - Texture = the XYZ tile pyramid stitched into a canvas at runtime
 *     (lib/tileComposite); single-JPG fallback for maps without tiles.
 *   - pickTerrain is an analytic ray-march over the rendered height grid —
 *     cheap enough for pointermove-rate picking (Raycaster vs the ~130k-tri
 *     terrain mesh is not).
 *
 * Markers (chars, vehicles, badges) are rendered as CSS2DObjects so the same
 * HTML the 2D viewport uses (triangle SVG, skull, pentagon, hover labels)
 * works unchanged. Shot tracers / explosion rings are real 3D meshes with
 * depthTest off so terrain never occludes them.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import type { MapConfig } from "@/lib/maps";
import { loadHeightmap, type HeightmapSampler } from "@/lib/heightmap";
import { compositeTerrainTexture } from "@/lib/tileComposite";
import MapViewControls from "@/components/MapViewControls";
import { markerDivIconHtml, militaryDivIconHtml } from "@/components/MarkerIcon";
import { isDirectionalIcon } from "@/lib/directionalMarkers";
import type {
  ClickPoint,
  MapApi,
  RenderableMarker,
  RenderableLine,
  RenderablePolygon,
  RulerRender,
  ReplayCharRenderable,
  ReplayVehicleRenderable,
  ReplayShotRenderable,
} from "@/components/MapClient";
import {
  replayCharHudHtml,
  replayVehicleHudHtml,
  replayVehicleBadgeHtml,
  TRIANGLE_DESTROYED_HEX,
} from "@/lib/replayMarkers";

type Props = {
  mapConfig: MapConfig;
  /** Plan markers (custom + military), read-only in 3D for now. Rendered as
   *  CSS2DObjects reusing the exact 2D DivIcon HTML. */
  markers?: RenderableMarker[];
  /** Plan lines — draped Line2 ribbons with REAL world-meter widths
   *  (LineMaterial worldUnits), which is truer to `widthM` than the 2D
   *  viewport's px approximation. */
  lines?: RenderableLine[];
  /** Imported .layer polygons. fillOutside zones render outline-only — an
   *  exterior mask doesn't port to a draped mesh. */
  polygons?: RenderablePolygon[];
  /** In-progress line draft — rendered dashed, live-updated as the page
   *  appends the cursor point on mousemove. */
  draft?: { color: string; widthMeters: number; points: [number, number][] } | null;
  /** Active ruler measurement (line mode renders in 3D; radial mode is
   *  2D-only — the page force-switches views when it's armed). */
  ruler?: RulerRender | null;
  rulerMode?: "line" | "radial";
  /** Marker-label text color (web-only global setting). */
  labelColor?: "black" | "white";
  /** Plan-overlay opacity multiplier (replay "Show plan" slider). */
  planOpacity?: number;
  /** Map cursor: anything but "off" shows a crosshair (3D draws no
   *  distinction between the 2D "container"/"aggressive" variants). */
  cursorMode?: "off" | "container" | "aggressive";
  /** When false, markers are render-only (no select/drag). */
  markersInteractive?: boolean;
  /** When false, lines ignore clicks (e.g. while drafting). */
  linesInteractive?: boolean;
  onMapClick?: (p: ClickPoint) => void;
  onMapDoubleClick?: (p: ClickPoint) => void;
  onMapMouseMove?: (p: ClickPoint) => void;
  onMapContextMenu?: (p: ClickPoint) => void;
  onMarkerClick?: (id: string) => void;
  onMarkerDrag?: (id: string, p: ClickPoint) => void;
  onLineClick?: (id: string) => void;
  onDuplicateMarker?: () => void;
  onDeleteMarker?: () => void;
  replayChars?: ReplayCharRenderable[];
  replayVehicles?: ReplayVehicleRenderable[];
  replayShots?: ReplayShotRenderable[];
  /** Imperative focus request from the parent — keyed so the same coords
   *  clicked twice still re-trigger the fly-to (mirrors the 2D viewport's
   *  MapFocusEffect). On each new key the camera tweens to center the
   *  point at max zoom while keeping the current tilt / azimuth. */
  mapFocus?: {
    worldX: number;
    worldY: number;
    zoom: number;
    key: number;
  } | null;
  /** Viewport handed over from the 2D map at toggle time (fit-square). */
  initialView?: { x: number; z: number; radius: number } | null;
  /** Publishes the imperative API (getView / fitWholeMap) to the parent. */
  onApi?: (api: MapApi) => void;
  view3D: boolean;
  onToggleView: () => void;
};

const POLAR_MIN = (1 * Math.PI) / 180;
const POLAR_MAX = (75 * Math.PI) / 180;
const MIN_DISTANCE = 50;
const FOV = 55;

/** LMB movement below this many px counts as a click, not a pan. */
const CLICK_SLOP_PX = 5;
/** CSS2D drag controller threshold (mirrors ts-mission-builder). */
const DRAG_THRESHOLD_PX = 4;
/** Screen-space pick radius for line selection — mirrors the 2D viewport's
 *  invisible 14px hit polyline. */
const LINE_PICK_PX = 14;

/* ---------------------------------------------------------------------------
 * Decimated terrain grid + interpolation/picking against the RENDERED mesh
 * ------------------------------------------------------------------------ */

/** The exact vertex grid buildTerrain rendered — draped overlays and picking
 * both interpolate THIS (triangle-exact), never the raw heightmap, so they
 * agree with what's on screen even on heavily decimated big maps. */
type MeshGrid = {
  heights: Float32Array;
  vertsX: number;
  vertsY: number;
  x0: number; // world X of the grid's west edge (worldBL[0])
  y0: number; // world Y of the grid's south edge (worldBL[1])
  w: number; // world width (X), m
  h: number; // world height (Y), m
  minY: number;
  maxY: number;
};

function flatGrid(x0: number, y0: number, w: number, h: number): MeshGrid {
  return { heights: new Float32Array(4), vertsX: 2, vertsY: 2, x0, y0, w, h, minY: 0, maxY: 0 };
}

/** Elevation of the rendered mesh at (worldX, worldY) — triangle-exact
 * against the buildTerrain triangulation (quads split along b–c). */
function meshY(g: MeshGrid, x: number, y: number): number {
  const gx = Math.min(Math.max(((x - g.x0) / g.w) * (g.vertsX - 1), 0), g.vertsX - 1);
  const gz = Math.min(Math.max(((y - g.y0) / g.h) * (g.vertsY - 1), 0), g.vertsY - 1);
  let i0 = Math.floor(gx);
  let j0 = Math.floor(gz);
  if (i0 >= g.vertsX - 1) i0 = g.vertsX - 2;
  if (j0 >= g.vertsY - 1) j0 = g.vertsY - 2;
  const fx = gx - i0;
  const fz = gz - j0;
  const h00 = g.heights[j0 * g.vertsX + i0];
  const h10 = g.heights[j0 * g.vertsX + i0 + 1];
  const h01 = g.heights[(j0 + 1) * g.vertsX + i0];
  const h11 = g.heights[(j0 + 1) * g.vertsX + i0 + 1];
  if (fx + fz <= 1) return h00 + fx * (h10 - h00) + fz * (h01 - h00);
  return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
}

const pickRaycaster = new THREE.Raycaster();
const pickNdc = new THREE.Vector2();
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// Scratch vectors for the per-frame marker-bearing projection (no allocs).
const bearingA = new THREE.Vector3();
const bearingB = new THREE.Vector3();

/** Char or vehicle entry: a real 3D mesh for the shape (so yaw is in
 *  world space — rotates correctly under any camera tilt) plus the
 *  CSS2DObject scaffold that hosts label / hover-label / badge. */
type MarkerEntry = {
  /** Flat triangle / pentagon lying in the XZ plane. Null only for dead
   *  players (which render the skull via the hud DOM instead). */
  shape: THREE.Mesh | null;
  /** Stroke around the shape, matching the 2D viewport's dark outline. */
  outline: THREE.LineLoop | null;
  /** Interior detail glyph (gun symbol for armed vehicles, barrel+baseplate
   *  for static weapons). Null for chars and for unarmed vehicles. Drawn in
   *  stroke color on top of the body fill. */
  detail: THREE.Mesh | null;
  /** DOM overlay anchored at the marker's world position. */
  hud: CSS2DObject;
};

/** Persistent three.js state shared across renders. Built once per mapConfig,
 *  populated by setup, mutated by sync effects, torn down on unmount. */
type World = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  webgl: THREE.WebGLRenderer;
  css2d: CSS2DRenderer;
  sampler: HeightmapSampler | null;
  /** Decimated render grid — drape/pick source of truth. */
  grid: MeshGrid;
  terrain: THREE.Mesh | null;
  /** Closure-managed camera target (the lookAt point). Mutated by control
   *  handlers; exposed on the ref so the parent-driven focus effect can
   *  also tween it. */
  target: THREE.Vector3;
  minDistance: number;
  maxDistance: number;
  /** Whole-map framing (fit button + initial placement). */
  center: THREE.Vector3;
  dist0: number;
  /** Active focus animation, so a new request can cancel the in-flight
   *  tween instead of fighting it. */
  focusAnimId: number | null;
  tweenTo: (endTar: THREE.Vector3, endDist: number) => void;
  /** All plan-overlay content (draped lines/fills + CSS2D marker icons).
   *  Cleared + rebuilt by syncPlan — same philosophy as the 2D viewport's
   *  declarative re-render, and cheap at plan scale (edits are rare
   *  compared to replay's per-frame churn). */
  planGroup: THREE.Group;
  syncPlan: () => void;
  /** Transient overlay (line draft + ruler) — rebuilt on every cursor move
   *  while drafting, so it lives apart from the heavier planGroup. */
  draftGroup: THREE.Group;
  syncDraft: () => void;
  /** Screen-space line-pick data (sampled world points per plan line),
   *  rebuilt by syncPlan. Canvas clicks test these before dispatching a
   *  map click — mirrors the 2D invisible fat hit polyline. */
  planLinePicks: { id: string; pts: [number, number][]; widthMeters: number }[];
  /** Per-frame bearing correction for plan-marker sprites. `rotation` is a
   *  WORLD bearing (0 = north, clockwise — that's what the mod receives),
   *  but the icon HTML rotates in SCREEN space. In 2D those coincide
   *  (north-up map); under a yawed/tilted 3D camera they don't, so render()
   *  re-projects each marker's bearing vector to a screen angle every
   *  frame and rewrites the icon div's CSS rotation. `el` is the inner
   *  rotating node of the CSS2D marker HTML. */
  planMarkerSprites: { el: HTMLElement; x: number; y: number; rotation: number }[];
  /** Shared geometries — one instance, reused across all marker meshes
   *  via mesh.scale. Disposed once on unmount. */
  triGeom: THREE.BufferGeometry;
  triOutlineGeom: THREE.BufferGeometry;
  pentGeom: THREE.BufferGeometry;
  pentOutlineGeom: THREE.BufferGeometry;
  squareGeom: THREE.BufferGeometry;
  squareOutlineGeom: THREE.BufferGeometry;
  armedDetailGeom: THREE.BufferGeometry;
  staticDetailGeom: THREE.BufferGeometry;
  /** Per-id marker state. Updated in place each sync (DOM stays attached,
   *  meshes mutate position/rotation/color). */
  charEntries: Map<number, MarkerEntry>;
  vehicleEntries: Map<number, MarkerEntry>;
  badgeObjs: Map<number, CSS2DObject>;
  shotGroup: THREE.Group;
  render: () => void;
  /** Lift markers this much above the sampled terrain elevation so they
   *  read clearly on slopes. depthTest is also off so this is mostly
   *  cosmetic — keeps the mesh visually above grass-level terrain. */
  markerLiftM: number;
};

/** Ray-pick the rendered terrain. Analytic march over the height grid —
 * cheap enough for pointermove-rate picking. Returns the world-space hit
 * ({x, y} in world coords) or null (sky / outside the world). */
function pickTerrain(world: World, clientX: number, clientY: number): { x: number; y: number } | null {
  const dom = world.webgl.domElement;
  const rect = dom.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  pickNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pickNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  pickRaycaster.setFromCamera(pickNdc, world.camera);
  const o = pickRaycaster.ray.origin;
  const d = pickRaycaster.ray.direction;
  const g = world.grid;

  // Vertical clip: only the [minY, maxY] band can contain terrain.
  const top = g.maxY + 0.5;
  const bottom = g.minY - 0.5;
  let t0 = 0;
  let t1 = Infinity;
  if (d.y < -1e-9) {
    t0 = Math.max(0, (top - o.y) / d.y);
    t1 = (bottom - o.y) / d.y;
  } else if (o.y > top) {
    return null; // looking up from above the terrain band
  } else if (d.y > 1e-9) {
    t1 = (top - o.y) / d.y;
  }
  // Horizontal clip to the world rect (three: x ∈ [x0, x0+w], z ∈ [-(y0+h), -y0]).
  const clip = (p: number, dir: number, lo: number, hi: number): boolean => {
    if (Math.abs(dir) < 1e-12) return p >= lo && p <= hi;
    let a = (lo - p) / dir;
    let b = (hi - p) / dir;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    return true;
  };
  if (!clip(o.x, d.x, g.x0, g.x0 + g.w)) return null;
  if (!clip(o.z, d.z, -(g.y0 + g.h), -g.y0)) return null;
  if (t1 <= t0) return null;

  const above = (t: number): number => {
    const x = o.x + d.x * t;
    const z = o.z + d.z * t;
    return o.y + d.y * t - meshY(g, x, -z);
  };
  const cell = Math.min(g.w / (g.vertsX - 1), g.h / (g.vertsY - 1));
  const step = Math.max(1, cell * 0.5);
  let tPrev = t0;
  if (above(t0) <= 0) {
    // Camera ray already starts under the surface — snap to the entry point.
    const x = o.x + d.x * t0;
    const z = o.z + d.z * t0;
    return { x: clamp(x, g.x0, g.x0 + g.w), y: clamp(-z, g.y0, g.y0 + g.h) };
  }
  for (let i = 0; i < 4096; i++) {
    const t = Math.min(tPrev + step, t1);
    if (above(t) <= 0) {
      // Bisect [tPrev, t] onto the surface.
      let lo = tPrev;
      let hi = t;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (above(mid) <= 0) hi = mid;
        else lo = mid;
      }
      const x = o.x + d.x * hi;
      const z = o.z + d.z * hi;
      return { x: clamp(x, g.x0, g.x0 + g.w), y: clamp(-z, g.y0, g.y0 + g.h) };
    }
    if (t >= t1) return null;
    tPrev = t;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Plan-overlay drape helpers (lines / polygons hug the RENDERED mesh)
 * ------------------------------------------------------------------------ */

/** Lift draped plan geometry above the terrain to kill z-fighting. */
const LINE_LIFT = 1.5;
const FILL_LIFT = 0.75;
const ICON_LIFT = 2;

/** Resample a polyline's segments at ~half the terrain grid cell so draped
 *  geometry follows the rendered mesh instead of cutting through ridges.
 *  Returns the densified world-space [x, y][] list. */
function samplePolyline(g: MeshGrid, pts: [number, number][], closed = false): [number, number][] {
  const step = Math.max(2, Math.min(g.w / (g.vertsX - 1), g.h / (g.vertsY - 1)) * 0.5);
  const out: [number, number][] = [];
  const list = closed && pts.length > 1 ? [...pts, pts[0]] : pts;
  for (let i = 0; i < list.length - 1; i++) {
    const [ax, ay] = list[i];
    const [bx, by] = list[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      out.push([ax + (bx - ax) * f, ay + (by - ay) * f]);
    }
  }
  out.push([...list[list.length - 1]]);
  return out;
}

/** Drape a sampled point list into flat [x, y, z, ...] positions for
 *  LineGeometry.setPositions. */
function drapeSampled(g: MeshGrid, sampled: [number, number][], lift: number): number[] {
  const out: number[] = [];
  for (const [x, y] of sampled) out.push(x, meshY(g, x, y) + lift, -y);
  return out;
}

function drapedPolylinePositions(
  g: MeshGrid,
  pts: [number, number][],
  lift: number,
  closed = false,
): number[] {
  return drapeSampled(g, samplePolyline(g, pts, closed), lift);
}

function makePlanLine(positions: number[], mat: LineMaterial): Line2 {
  const geom = new LineGeometry();
  geom.setPositions(positions);
  const line = new Line2(geom, mat);
  if (mat.dashed) line.computeLineDistances();
  line.renderOrder = 2;
  return line;
}

function planFillMaterial(color: string, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/** Draped fill for an arbitrary (possibly concave) polygon: ear-clip
 *  triangulate, then midpoint-subdivide every triangle until edges are at
 *  or below the terrain grid's cell size — finer wouldn't follow the mesh
 *  any better, coarser cuts through hills. Vertex budget capped. */
function drapedPolygonFill(
  g: MeshGrid,
  pts: [number, number][],
  mat: THREE.MeshBasicMaterial,
  lift: number,
): THREE.Mesh | null {
  if (pts.length < 3) return null;
  let tris: [number, number][][];
  try {
    const contour = pts.map(([x, y]) => new THREE.Vector2(x, y));
    const idx = THREE.ShapeUtils.triangulateShape(contour, []);
    tris = idx.map(([a, b, c]) => [pts[a], pts[b], pts[c]]);
  } catch {
    return null; // degenerate ring — outline still renders
  }
  const edge = (p: [number, number], q: [number, number]) =>
    Math.hypot(q[0] - p[0], q[1] - p[1]);
  const maxEdge = Math.max(25, Math.min(g.w / (g.vertsX - 1), g.h / (g.vertsY - 1)));
  for (let iter = 0; iter < 6; iter++) {
    let split = false;
    const next: [number, number][][] = [];
    for (const [a, b, c] of tris) {
      if (
        Math.max(edge(a, b), edge(b, c), edge(c, a)) > maxEdge &&
        next.length + tris.length < 20000
      ) {
        const mab: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const mbc: [number, number] = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
        const mca: [number, number] = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
        next.push([a, mab, mca], [mab, b, mbc], [mca, mbc, c], [mab, mbc, mca]);
        split = true;
      } else {
        next.push([a, b, c]);
      }
    }
    tris = next;
    if (!split) break;
  }
  const positions = new Float32Array(tris.length * 9);
  let i = 0;
  for (const t of tris) {
    for (const [x, y] of t) {
      positions[i++] = x;
      positions[i++] = meshY(g, x, y) + lift;
      positions[i++] = -y;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 1;
  return mesh;
}

/** CSS2D node whose host element is forced to 0×0: the shared marker HTML
 *  self-centers via translate(-50%,-50%) (built for Leaflet's iconAnchor
 *  [0,0]), and CSS2DRenderer ALSO centers its host element — zeroing the
 *  host makes the renderer's centering a no-op so the two don't stack. */
function planCss2dNode(html: string): CSS2DObject {
  const el = document.createElement("div");
  el.style.width = "0";
  el.style.height = "0";
  el.innerHTML = html;
  return new CSS2DObject(el);
}

/** Screen-space pick against the plan lines: project each line's sampled
 *  points and take the closest point-to-segment distance in px. Threshold
 *  is the greater of the 2D-parity 14px and the line's projected half
 *  width. Returns the closest hit line's id or null. */
function pickPlanLine(world: World, clientX: number, clientY: number): string | null {
  const dom = world.webgl.domElement;
  const rect = dom.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const tanHalfFov = Math.tan((world.camera.fov * Math.PI) / 360);
  let bestId: string | null = null;
  let bestScore = Infinity;
  for (const line of world.planLinePicks) {
    let prevX: number | null = null;
    let prevY: number | null = null;
    let prevWorld: THREE.Vector3 | null = null;
    for (const [wx, wy] of line.pts) {
      const wp = new THREE.Vector3(wx, meshY(world.grid, wx, wy) + LINE_LIFT, -wy);
      bearingA.copy(wp).project(world.camera);
      // Outside the depth range (behind the camera / beyond far) — break the
      // segment chain so we don't connect through the viewer.
      if (bearingA.z < -1 || bearingA.z > 1) {
        prevX = prevY = null;
        prevWorld = null;
        continue;
      }
      const sx = ((bearingA.x + 1) / 2) * rect.width;
      const sy = ((1 - bearingA.y) / 2) * rect.height;
      if (prevX !== null && prevY !== null && prevWorld !== null) {
        // Point-to-segment distance in screen px.
        const dx = sx - prevX;
        const dy = sy - prevY;
        const lenSq = dx * dx + dy * dy;
        let t = 0;
        if (lenSq > 1e-9) t = clamp(((px - prevX) * dx + (py - prevY) * dy) / lenSq, 0, 1);
        const cx = prevX + t * dx;
        const cy = prevY + t * dy;
        const d = Math.hypot(px - cx, py - cy);
        // Projected half-width at the segment's depth (world meters → px).
        const dist = world.camera.position.distanceTo(prevWorld);
        const halfWidthPx =
          ((line.widthMeters / 2) * rect.height) / Math.max(1, 2 * dist * tanHalfFov);
        const threshold = Math.max(LINE_PICK_PX, halfWidthPx + 4);
        if (d < threshold && d < bestScore) {
          bestScore = d;
          bestId = line.id;
        }
      }
      prevX = sx;
      prevY = sy;
      prevWorld = wp;
    }
  }
  return bestId;
}

type DragHandlers = {
  onClick: () => void;
  onDragLive?: (x: number, y: number) => void;
  onDragEnd?: (x: number, y: number) => void;
};

/** Shared drag controller for interactive CSS2D nodes (plan markers).
 *  Pointer events are captured on the element, so the canvas never sees
 *  them — camera panning is suppressed structurally. Movement below
 *  DRAG_THRESHOLD_PX = click. Ported from ts-mission-builder. */
function makeDraggable(
  world: World,
  el: HTMLElement,
  obj: CSS2DObject,
  lift: number,
  handlers: DragHandlers,
) {
  let startClient: { x: number; y: number } | null = null;
  let startWorld: { x: number; y: number } | null = null;
  let moved = false;
  let last: { x: number; y: number } | null = null;

  const onDown = (e: PointerEvent) => {
    if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    startClient = { x: e.clientX, y: e.clientY };
    startWorld = { x: obj.position.x, y: -obj.position.z };
    moved = false;
    last = null;
  };
  const onMove = (e: PointerEvent) => {
    if (!startClient || !e.isPrimary) return;
    if (!moved && Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y) < DRAG_THRESHOLD_PX)
      return;
    moved = true;
    const hit = pickTerrain(world, e.clientX, e.clientY);
    if (!hit) return; // above the horizon — keep the last valid point
    last = hit;
    obj.position.set(hit.x, meshY(world.grid, hit.x, hit.y) + lift, -hit.y);
    handlers.onDragLive?.(hit.x, hit.y);
    world.render();
  };
  const onUp = (e: PointerEvent) => {
    if (!startClient || !e.isPrimary) return;
    const wasMoved = moved;
    const fin = last;
    startClient = null;
    moved = false;
    last = null;
    if (wasMoved && fin) handlers.onDragEnd?.(fin.x, fin.y);
    else if (!wasMoved) handlers.onClick();
  };
  const onCancel = () => {
    if (!startClient) return;
    const sw = startWorld;
    startClient = null;
    moved = false;
    last = null;
    if (sw) {
      obj.position.set(sw.x, meshY(world.grid, sw.x, sw.y) + lift, -sw.y);
      handlers.onDragLive?.(sw.x, sw.y);
    }
    world.render();
  };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);
}

/** Triangle vertices match the 2D SVG (points: 0,-9 / 7,7 / -7,7). The
 *  shape lies in the XZ plane with the tip pointing -Z (= world north),
 *  so mesh.rotation.y = -yaw_rad orients it correctly under our world
 *  mapping (positive worldY = north = -Z). */
function makeTriangleGeometry(): THREE.BufferGeometry {
  const verts = new Float32Array([
    0, 0, -9,
    7, 0, 7,
    -7, 0, 7,
  ]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geom.setIndex([0, 2, 1]); // CCW from above (+Y) for front-face up
  return geom;
}
function makeTriangleOutlineGeometry(): THREE.BufferGeometry {
  // LineLoop closes the path for us, so just the three vertices.
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, -9),
    new THREE.Vector3(7, 0, 7),
    new THREE.Vector3(-7, 0, 7),
  ]);
}
/** Pentagon vertices match the 2D SVG (points: 0,-15 / 7,-7 / 7,14 /
 *  -7,14 / -7,-7). Peak points -Z, base squares to the south. */
function makePentagonGeometry(): THREE.BufferGeometry {
  const verts = new Float32Array([
    0, 0, -15,
    7, 0, -7,
    7, 0, 14,
    -7, 0, 14,
    -7, 0, -7,
  ]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  // Two triangles fan from the apex (vertex 0). CCW from above.
  geom.setIndex([0, 4, 1, 1, 4, 2, 2, 4, 3]);
  return geom;
}
function makePentagonOutlineGeometry(): THREE.BufferGeometry {
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, -15),
    new THREE.Vector3(7, 0, -7),
    new THREE.Vector3(7, 0, 14),
    new THREE.Vector3(-7, 0, 14),
    new THREE.Vector3(-7, 0, -7),
  ]);
}
/** Square footprint for static-weapon markers — mirrors the 2D SVG's
 *  `rect` body. Interior detail (barrel, T-baseplate) doesn't translate
 *  to flat 3D mesh, so the 3D viewport relies on silhouette alone to
 *  separate emplacements from vehicles. */
function makeSquareGeometry(): THREE.BufferGeometry {
  const verts = new Float32Array([
    -7, 0, -2,
    7, 0, -2,
    7, 0, 12,
    -7, 0, 12,
  ]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geom.setIndex([0, 3, 1, 1, 3, 2]);
  return geom;
}
function makeSquareOutlineGeometry(): THREE.BufferGeometry {
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-7, 0, -2),
    new THREE.Vector3(7, 0, -2),
    new THREE.Vector3(7, 0, 12),
    new THREE.Vector3(-7, 0, 12),
  ]);
}

/** Interior turret glyph for armed vehicles — vertical barrel rect + a hollow
 *  ring at the lower-center, both filled flat in the stroke color. Mirrors
 *  the 2D SVG's `<rect>` + `<circle stroke>`. SVG y maps to 3D z. */
function makeArmedDetailGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  // Barrel rect: x ∈ [-1.25, 1.25], z ∈ [-6, 3].
  positions.push(
    -1.25, 0, -6,
     1.25, 0, -6,
     1.25, 0,  3,
    -1.25, 0,  3,
  );
  indices.push(0, 3, 1, 1, 3, 2);
  // Ring at (0, 7) — inner r=3, outer r=5. Two concentric rings of verts
  // sweeping a full circle; each segment makes two triangles forming a quad.
  const cz = 7;
  const rIn = 3;
  const rOut = 5;
  const segs = 32;
  const base = 4;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    positions.push(cosA * rIn, 0, cz + sinA * rIn);
    positions.push(cosA * rOut, 0, cz + sinA * rOut);
  }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    const a = base + i * 2;       // inner-i
    const b = base + i * 2 + 1;   // outer-i
    const c = base + j * 2;       // inner-j
    const d = base + j * 2 + 1;   // outer-j
    indices.push(a, c, b);
    indices.push(b, c, d);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geom.setIndex(indices);
  return geom;
}

/** Continuous-barrel + crossbar baseplate for static weapons. One mesh
 *  with two filled rectangles — matches the 2D SVG's combined barrel and
 *  T-foot drawn in stroke color. */
function makeStaticDetailGeometry(): THREE.BufferGeometry {
  const positions = new Float32Array([
    // Barrel: x ∈ [-1.25, 1.25], z ∈ [-13, 6].
    -1.25, 0, -13,
     1.25, 0, -13,
     1.25, 0,   6,
    -1.25, 0,   6,
    // Crossbar (foot of the T): x ∈ [-4, 4], z ∈ [4, 6].
    -4, 0, 4,
     4, 0, 4,
     4, 0, 6,
    -4, 0, 6,
  ]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex([0, 3, 1, 1, 3, 2, 4, 7, 5, 5, 7, 6]);
  return geom;
}

// (No size constant — the per-frame scale formula in `render` keeps
//  1 mesh-unit ≈ 1 screen pixel at the marker's depth. Since the triangle
//  geometry spans 16 mesh units in height and the 2D viewport's SVG
//  triangle spans the same 16 px, the visual size matches across modes.)

function disposeMaterial(
  m: THREE.Material | THREE.Material[],
): void {
  if (Array.isArray(m)) m.forEach((x) => x.dispose());
  else m.dispose();
}

/** Outline color for non-destroyed markers — dark navy to keep the
 *  triangle popping over the (often) light terrain texture. Mirrors the
 *  2D viewport's stroke color. */
const MARKER_STROKE_NORMAL = 0x0f172a;
/** Outline color for destroyed (grey-filled) markers; brighter so the
 *  shape still reads on the basemap. Mirrors the 2D viewport. */
const MARKER_STROKE_DESTROYED = 0x4b5563;

/** Sample elevation at (worldX, worldY); zero when no heightmap or out of
 *  bounds (graceful — matches the 2D viewport's flat fallback). */
function terrainY(
  worldX: number,
  worldY: number,
  sampler: HeightmapSampler | null,
): number {
  if (!sampler) return 0;
  const h = sampler.sample(worldX, worldY);
  return Number.isFinite(h) ? h : 0;
}

/** 4-digit MGRS-style reference: worldCoordMeters / 10, zero-padded to 4.
 *  Mirrors the 2D CursorHint's grid readout. */
function grid4(m: number): string {
  const v = Math.max(0, Math.floor(m / 10));
  return v.toString().padStart(4, "0");
}

export default function MapClient3D({
  mapConfig,
  markers = [],
  lines = [],
  polygons = [],
  draft = null,
  ruler = null,
  rulerMode = "line",
  labelColor = "black",
  planOpacity = 1,
  cursorMode = "off",
  markersInteractive = false,
  linesInteractive = false,
  onMapClick,
  onMapDoubleClick,
  onMapMouseMove,
  onMapContextMenu,
  onMarkerClick,
  onMarkerDrag,
  onLineClick,
  onDuplicateMarker,
  onDeleteMarker,
  replayChars,
  replayVehicles,
  replayShots,
  mapFocus,
  initialView,
  onApi,
  view3D,
  onToggleView,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);
  const coordsRef = useRef<HTMLSpanElement>(null);
  // The 2D handoff applies to the FIRST setup only — a map switch while
  // in 3D re-runs setup with coords that belong to the previous world.
  const initialViewRef = useRef(initialView ?? null);
  // Latest plan props for syncPlan (defined once in the setup closure —
  // reading through the ref keeps it off the stale-closure hook).
  const planRef = useRef({
    markers, lines, polygons, labelColor, planOpacity, markersInteractive,
  });
  // Transient overlay state for syncDraft — changes every mousemove while
  // drafting, so it's kept apart from the heavier planRef sync.
  const draftRef = useRef({ draft, ruler, rulerMode });
  // Interaction callbacks + gates, refreshed every render so the setup
  // closure's listeners never go stale.
  const cbRef = useRef({
    cursorMode, linesInteractive, markersInteractive,
    onMapClick, onMapDoubleClick, onMapMouseMove, onMapContextMenu,
    onMarkerClick, onMarkerDrag, onLineClick, onDuplicateMarker, onDeleteMarker,
  });
  useEffect(() => {
    cbRef.current = {
      cursorMode, linesInteractive, markersInteractive,
      onMapClick, onMapDoubleClick, onMapMouseMove, onMapContextMenu,
      onMarkerClick, onMarkerDrag, onLineClick, onDuplicateMarker, onDeleteMarker,
    };
  });

  // ===== Setup effect — runs only when mapConfig changes ==================
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;

    const widthM = mapConfig.worldUR[0] - mapConfig.worldBL[0];
    const heightM = mapConfig.worldUR[1] - mapConfig.worldBL[1];

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);

    const camera = new THREE.PerspectiveCamera(
      FOV,
      Math.max(1, mount.clientWidth / Math.max(1, mount.clientHeight)),
      1,
      Math.max(widthM, heightM) * 8,
    );
    const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);

    const webgl = new THREE.WebGLRenderer({ antialias: true });
    webgl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    webgl.setSize(mount.clientWidth, mount.clientHeight);
    webgl.outputColorSpace = THREE.SRGBColorSpace;
    webgl.domElement.style.position = "absolute";
    webgl.domElement.style.inset = "0";
    mount.appendChild(webgl.domElement);

    // CSS2DRenderer layers HTML markers over the WebGL canvas. Pointer
    // events on the container are disabled so the underlying canvas
    // still receives mouse input (the markers themselves opt back in
    // for hover via their own CSS).
    const css2d = new CSS2DRenderer();
    css2d.setSize(mount.clientWidth, mount.clientHeight);
    css2d.domElement.style.position = "absolute";
    css2d.domElement.style.inset = "0";
    css2d.domElement.style.pointerEvents = "none";
    css2d.domElement.style.overflow = "hidden";
    mount.appendChild(css2d.domElement);

    // No scene lights: the tiles already carry baked hillshading, so the
    // terrain renders UNLIT (MeshBasicMaterial) — engine lighting would
    // double-shade slopes and make 3D darker than the 2D tiles.

    // Camera state model: `target` is the lookAt point and `camera.position`
    // is the eye. Both are primary state — pan moves them together, MMB
    // rotates them as a pair around an arbitrary pivot (the cursor's
    // terrain point), wheel dollies the eye along the eye→target line.
    // This decouples the rotation pivot from the lookAt point, which is
    // what lets MMB-drag spin around the cursor without snapping the view.
    const centerX = (mapConfig.worldBL[0] + mapConfig.worldUR[0]) * 0.5;
    const centerY = (mapConfig.worldBL[1] + mapConfig.worldUR[1]) * 0.5;

    const halfDiag = Math.hypot(widthM, heightM) * 0.5;
    const maxDistance = halfDiag * 5;
    const dist0 = halfDiag / tanHalfFov;
    const polar0 = 0.45;

    // Initial framing: the handed-over 2D viewport if present (consumed once,
    // and only if it lies inside this world), else whole map.
    const iv0 = initialViewRef.current;
    initialViewRef.current = null;
    const iv =
      iv0 &&
      iv0.x >= mapConfig.worldBL[0] &&
      iv0.x <= mapConfig.worldUR[0] &&
      iv0.z >= mapConfig.worldBL[1] &&
      iv0.z <= mapConfig.worldUR[1]
        ? iv0
        : null;
    const startDist = iv
      ? Math.min(maxDistance, Math.max(MIN_DISTANCE, (iv.radius / tanHalfFov) * 1.1))
      : dist0;
    const target = new THREE.Vector3(iv ? iv.x : centerX, 0, -(iv ? iv.z : centerY));
    camera.position.set(
      target.x,
      target.y + startDist * Math.cos(polar0),
      target.z + startDist * Math.sin(polar0),
    );
    camera.lookAt(target);

    const shotGroup = new THREE.Group();
    scene.add(shotGroup);
    const planGroup = new THREE.Group();
    scene.add(planGroup);
    const draftGroup = new THREE.Group();
    scene.add(draftGroup);

    const triGeom = makeTriangleGeometry();
    const triOutlineGeom = makeTriangleOutlineGeometry();
    const pentGeom = makePentagonGeometry();
    const pentOutlineGeom = makePentagonOutlineGeometry();
    const squareGeom = makeSquareGeometry();
    const squareOutlineGeom = makeSquareOutlineGeometry();
    const armedDetailGeom = makeArmedDetailGeometry();
    const staticDetailGeom = makeStaticDetailGeometry();

    const world: World = {
      scene,
      camera,
      webgl,
      css2d,
      sampler: null,
      grid: flatGrid(mapConfig.worldBL[0], mapConfig.worldBL[1], widthM, heightM),
      terrain: null,
      target,
      minDistance: MIN_DISTANCE,
      maxDistance,
      center: new THREE.Vector3(centerX, 0, -centerY),
      dist0,
      focusAnimId: null,
      tweenTo: () => {},
      planGroup,
      syncPlan: () => {},
      draftGroup,
      syncDraft: () => {},
      planLinePicks: [],
      planMarkerSprites: [],
      triGeom,
      triOutlineGeom,
      pentGeom,
      pentOutlineGeom,
      squareGeom,
      squareOutlineGeom,
      armedDetailGeom,
      staticDetailGeom,
      charEntries: new Map(),
      vehicleEntries: new Map(),
      badgeObjs: new Map(),
      shotGroup,
      markerLiftM: 1.5,
      render: () => {
        // Marker meshes are world-aligned (yaw rotates them about the
        // world Y axis, not screen-space) but we want screen size to
        // stay roughly constant across zoom — otherwise they vanish
        // when zoomed out and dominate when zoomed in. Compute a
        // per-entry scale so a 1-unit mesh edge maps to ~1 screen
        // pixel at the entry's depth.
        const heightPx = webgl.domElement.clientHeight || 1;
        const camPos = camera.position;
        for (const e of world.charEntries.values()) {
          if (!e.shape) continue;
          const d = camPos.distanceTo(e.shape.position);
          // 1 mesh-unit = 1 screen pixel; triangle base is ~16 units →
          // ~16 px tall on screen, matching the 2D viewport's polygon.
          const s = (2 * d * tanHalfFov) / heightPx;
          e.shape.scale.setScalar(s);
          if (e.outline) e.outline.scale.setScalar(s);
        }
        for (const e of world.vehicleEntries.values()) {
          const d = camPos.distanceTo(e.shape!.position);
          const s = (2 * d * tanHalfFov) / heightPx;
          e.shape!.scale.setScalar(s);
          e.outline!.scale.setScalar(s);
          // Interior glyph rides the same screen-space scale as the body
          // so the gun/turret detail stays proportional at any zoom.
          if (e.detail) e.detail.scale.setScalar(s);
        }
        webgl.render(scene, camera);
        // Bearing-correct the plan-marker sprites AFTER webgl.render (which
        // refreshed the camera matrices) and BEFORE css2d.render, so the CSS
        // rotation and the CSS2D position land in the same paint. The
        // marker's world bearing is projected to a screen angle: two points
        // 20 m apart along the bearing → screen-space delta → CSS rotate.
        for (const s of world.planMarkerSprites) {
          const y0 = meshY(world.grid, s.x, s.y) + ICON_LIFT;
          bearingA.set(s.x, y0, -s.y).project(camera);
          const rad = (s.rotation * Math.PI) / 180;
          bearingB
            .set(s.x + Math.sin(rad) * 20, y0, -(s.y + Math.cos(rad) * 20))
            .project(camera);
          // NDC deltas → pixel deltas (y flips: NDC up+, screen down+),
          // then clockwise-from-screen-up angle = atan2(dx, -dy).
          const dx = (bearingB.x - bearingA.x) * webgl.domElement.clientWidth;
          const dy = (bearingB.y - bearingA.y) * webgl.domElement.clientHeight;
          const ang = (Math.atan2(dx, dy) * 180) / Math.PI;
          s.el.style.transform = `rotate(${ang}deg)`;
        }
        css2d.render(scene, camera);
      },
    };
    worldRef.current = world;

    // ---- Terrain -----------------------------------------------------------
    // Dark placeholder until the texture arrives; swapped to white + map.
    const terrainMat = new THREE.MeshBasicMaterial({ color: 0x1a2025 });

    function disposeTerrain() {
      if (!world.terrain) return;
      scene.remove(world.terrain);
      world.terrain.geometry.dispose();
      world.terrain = null;
    }

    function buildTerrain(sampler: HeightmapSampler | null) {
      disposeTerrain();
      const segX = sampler ? Math.min(sampler.meta.widthPx - 1, 256) : 1;
      const segY = sampler ? Math.min(sampler.meta.heightPx - 1, 256) : 1;
      const vertsX = segX + 1;
      const vertsY = segY + 1;
      const positions = new Float32Array(vertsX * vertsY * 3);
      const uvs = new Float32Array(vertsX * vertsY * 2);
      const heights = new Float32Array(vertsX * vertsY);
      const indices: number[] = [];
      let minY = Infinity;
      let maxY = -Infinity;
      for (let j = 0; j < vertsY; j++) {
        for (let i = 0; i < vertsX; i++) {
          const u = i / segX;
          const v = j / segY;
          const wx = mapConfig.worldBL[0] + u * widthM;
          const wy = mapConfig.worldBL[1] + v * heightM;
          const raw = sampler ? sampler.sample(wx, wy) : 0;
          const elev = Number.isFinite(raw) ? raw : 0;
          const idx = j * vertsX + i;
          positions[idx * 3 + 0] = wx;
          positions[idx * 3 + 1] = elev;
          positions[idx * 3 + 2] = -wy;
          uvs[idx * 2 + 0] = u;
          uvs[idx * 2 + 1] = v;
          heights[idx] = elev;
          if (elev < minY) minY = elev;
          if (elev > maxY) maxY = elev;
        }
      }
      for (let j = 0; j < segY; j++) {
        for (let i = 0; i < vertsX - 1; i++) {
          const a = j * vertsX + i;
          const b = a + 1;
          const c = a + vertsX;
          const d = c + 1;
          // CCW from above (+Y) — front face up so the camera looking
          // down sees the textured side.
          indices.push(a, b, c, b, d, c);
        }
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geom.setIndex(indices);
      world.terrain = new THREE.Mesh(geom, terrainMat);
      scene.add(world.terrain);
      world.grid = {
        heights,
        vertsX,
        vertsY,
        x0: mapConfig.worldBL[0],
        y0: mapConfig.worldBL[1],
        w: widthM,
        h: heightM,
        minY,
        maxY,
      };
    }
    buildTerrain(null);
    world.render();

    // Texture: tile-pyramid composite when the map ships one (all current
    // maps do); single-JPG fallback otherwise. The composite stays within
    // GPU-friendly bounds — the full-res JPG path decodes Zimnitrita to
    // ~1 GB RGBA, which is why the composite is the primary path.
    let texture: THREE.Texture | null = null;
    const applyTexture = (tex: THREE.Texture) => {
      texture = tex;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = webgl.capabilities.getMaxAnisotropy();
      terrainMat.map = tex;
      terrainMat.color.set(0xffffff);
      terrainMat.needsUpdate = true;
      world.render();
    };
    const composite = compositeTerrainTexture(mapConfig);
    if (composite) {
      composite
        .then((canvas) => {
          if (disposed) return;
          applyTexture(new THREE.CanvasTexture(canvas));
        })
        .catch((err) => {
          console.warn(`[MapClient3D] tile composite failed for ${mapConfig.key}:`, err);
        });
    } else {
      new THREE.TextureLoader().load(
        mapConfig.imagePath,
        (tex) => {
          if (disposed) {
            tex.dispose();
            return;
          }
          applyTexture(tex);
        },
        undefined,
        (err) => {
          console.warn(`[MapClient3D] texture load failed: ${mapConfig.imagePath}`, err);
        },
      );
    }

    if (mapConfig.heightmapBin && mapConfig.heightmapMeta) {
      loadHeightmap(mapConfig.heightmapBin, mapConfig.heightmapMeta)
        .then((sampler) => {
          if (disposed) return;
          world.sampler = sampler;
          buildTerrain(sampler);
          // The camera was framed against a flat y=0 world — lift the whole
          // rig by the terrain height at the target so a close-in initial
          // view (2D handoff over high ground) can't start underground.
          const ty = meshY(world.grid, target.x, -target.z);
          if (Math.abs(ty - target.y) > 0.01) {
            const dy = ty - target.y;
            target.y += dy;
            camera.position.y += dy;
            camera.lookAt(target);
          }
          // Re-snap any markers already placed (chars/vehicles whose sync
          // ran before the heightmap arrived sit at y=0).
          for (const e of world.charEntries.values()) {
            const set = (p: THREE.Vector3) => {
              p.y = terrainY(p.x, -p.z, sampler) + world.markerLiftM;
            };
            if (e.shape) set(e.shape.position);
            if (e.outline) set(e.outline.position);
            set(e.hud.position);
          }
          for (const e of world.vehicleEntries.values()) {
            const set = (p: THREE.Vector3) => {
              p.y = terrainY(p.x, -p.z, sampler) + world.markerLiftM;
            };
            if (e.shape) set(e.shape.position);
            if (e.outline) set(e.outline.position);
            set(e.hud.position);
          }
          for (const [, obj] of world.badgeObjs) {
            const p = obj.position;
            p.y = terrainY(p.x, -p.z, sampler) + world.markerLiftM;
          }
          // Re-drape the plan + transient overlays — everything built
          // against the flat grid is sitting at y=0.
          world.syncPlan();
          world.syncDraft();
          world.render();
        })
        .catch((err) => {
          console.warn(
            `[MapClient3D] heightmap load failed for ${mapConfig.key}:`,
            err,
          );
        });
    }

    // ---- Camera tween (focus / fit) ---------------------------------------
    world.tweenTo = (endTar: THREE.Vector3, endDist: number) => {
      const startCam = camera.position.clone();
      const startTar = target.clone();
      const dir = new THREE.Vector3().subVectors(startCam, startTar);
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
      dir.normalize();
      const endCam = endTar.clone().addScaledVector(dir, endDist);
      const DURATION = 600;
      const t0 = performance.now();
      const ease = (x: number) => 1 - Math.pow(1 - x, 3); // matches Leaflet flyTo feel
      if (world.focusAnimId !== null) cancelAnimationFrame(world.focusAnimId);
      const step = () => {
        if (disposed) return;
        const k = Math.min(1, (performance.now() - t0) / DURATION);
        const e = ease(k);
        camera.position.lerpVectors(startCam, endCam, e);
        target.lerpVectors(startTar, endTar, e);
        camera.lookAt(target);
        world.render();
        world.focusAnimId = k < 1 ? requestAnimationFrame(step) : null;
      };
      world.focusAnimId = requestAnimationFrame(step);
    };

    // ---- Plan overlay (markers / lines / polygons) ------------------------
    world.syncPlan = () => {
      if (disposed) return;
      const p = planRef.current;
      const g = world.grid;
      // Clear + rebuild. Removing CSS2DObjects dispatches 'removed', which
      // detaches their DOM elements.
      world.planGroup.traverse((obj) => {
        const anyObj = obj as THREE.Mesh;
        if (anyObj.geometry) anyObj.geometry.dispose();
        if (anyObj.material) disposeMaterial(anyObj.material);
      });
      world.planGroup.clear();
      world.planMarkerSprites = [];
      world.planLinePicks = [];

      const resW = webgl.domElement.clientWidth || 1;
      const resH = webgl.domElement.clientHeight || 1;
      const lineMat = (opts: {
        color: string;
        widthMeters?: number;
        widthPx?: number;
        opacity: number;
        dashed?: boolean;
      }): LineMaterial => {
        const mat = new LineMaterial({
          color: new THREE.Color(opts.color).getHex(),
          linewidth: opts.widthMeters ?? opts.widthPx ?? 1,
          worldUnits: opts.widthMeters !== undefined,
          transparent: true,
          opacity: opts.opacity,
          dashed: !!opts.dashed,
          ...(opts.dashed ? { dashSize: 8, gapSize: 8 } : {}),
        });
        mat.resolution.set(resW, resH);
        return mat;
      };

      // Imported polygons first (under lines/markers, matching 2D order).
      // fillOutside zones render outline-only: the 2D exterior mask (world
      // ring minus zone hole) doesn't port to a draped mesh.
      for (const poly of p.polygons) {
        if (poly.points.length < 2) continue;
        if (!poly.fillOutside && poly.fillOpacity > 0) {
          const fill = drapedPolygonFill(
            g,
            poly.points,
            planFillMaterial(poly.fillColor, poly.fillOpacity * p.planOpacity),
            FILL_LIFT,
          );
          if (fill) world.planGroup.add(fill);
        }
        world.planGroup.add(
          makePlanLine(
            drapedPolylinePositions(g, poly.points, LINE_LIFT, true),
            lineMat({
              color: poly.strokeColor,
              widthPx: poly.strokeWidth,
              opacity: poly.strokeOpacity * p.planOpacity,
            }),
          ),
        );
      }

      // Plan lines. Selection halo mirrors the 2D viewport's under-stroke.
      for (const ln of p.lines) {
        if (ln.points.length < 2) continue;
        const sampled = samplePolyline(g, ln.points);
        const positions = drapeSampled(g, sampled, LINE_LIFT);
        world.planLinePicks.push({ id: ln.id, pts: sampled, widthMeters: ln.widthMeters });
        if (ln.selected) {
          const halo = makePlanLine(
            positions,
            lineMat({
              color: "#fbbf24",
              widthMeters: ln.widthMeters + 6,
              opacity: 0.55 * p.planOpacity,
            }),
          );
          halo.renderOrder = 1;
          world.planGroup.add(halo);
        }
        world.planGroup.add(
          makePlanLine(
            positions,
            lineMat({
              color: ln.color,
              widthMeters: ln.widthMeters,
              opacity: p.planOpacity,
            }),
          ),
        );
      }

      // Markers — the exact 2D DivIcon HTML in a CSS2DObject (screen-
      // constant for free). Interactive markers opt back into pointer
      // events (the CSS2D container is pointer-events:none) and get the
      // shared drag controller; read-only ones bake pointer-events:none
      // into the HTML so camera input passes through.
      for (const m of p.markers) {
        const interactive = p.markersInteractive && !m.readOnly;
        const html =
          m.kind === "military"
            ? militaryDivIconHtml(
                m.iconUrl, m.label, m.rotation, 54, m.selected, interactive, p.planOpacity, p.labelColor,
              )
            : markerDivIconHtml(
                m.icon, m.color, m.label, m.rotation, 54, m.selected, interactive, p.planOpacity, p.labelColor,
              );
        const node = planCss2dNode(html);
        node.position.set(m.worldX, meshY(g, m.worldX, m.worldY) + ICON_LIFT, -m.worldY);
        world.planGroup.add(node);
        if (interactive) {
          // pointer-events is inherited: auto on the 0×0 host re-enables
          // the whole icon wrapper (label/halo re-disable themselves).
          node.element.style.pointerEvents = "auto";
          makeDraggable(world, node.element, node, ICON_LIFT, {
            onClick: () => cbRef.current.onMarkerClick?.(m.id),
            onDragEnd: (x, y) =>
              cbRef.current.onMarkerDrag?.(m.id, {
                worldX: Math.round(x),
                worldY: Math.round(y),
              }),
          });
        }
        // DIRECTIONAL icons treat `rotation` as a world bearing: register
        // the inner rotating node (the only element the builders give an
        // inline rotate() transform) for the per-frame bearing correction
        // in render(); the baked screen-space rotation is a harmless
        // initial value the first frame overwrites. Upright icons (flags,
        // dots, point badges — and all military frames) keep the baked
        // screen-space rotation, exactly like 2D.
        if (m.kind === "custom" && isDirectionalIcon(m.icon)) {
          const rotEl = node.element.querySelector<HTMLElement>(
            'div[style*="rotate("], img[style*="rotate("]',
          );
          if (rotEl) {
            world.planMarkerSprites.push({
              el: rotEl,
              x: m.worldX,
              y: m.worldY,
              rotation: m.rotation,
            });
          }
        }
        // Selected marker gets the floating duplicate/delete chips under
        // it (2D MarkerActions parity) as a separate non-draggable node.
        if (interactive && m.selected) {
          const chip = (icon: string, color: string, act: string) => `
            <button type="button" data-act="${act}" style="width:32px;height:32px;border-radius:999px;background:#202427;display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;padding:0;box-shadow:0 4px 12px rgba(0,0,0,0.5);">
              <span style="display:inline-block;width:16px;height:16px;background-color:${color};-webkit-mask-image:url(${icon});mask-image:url(${icon});-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;-webkit-mask-size:contain;mask-size:contain;"></span>
            </button>`;
          const actions = planCss2dNode(
            `<div style="position:absolute;top:36px;left:0;transform:translateX(-50%);display:flex;gap:6px;">
              ${chip("/icons/figma/copy.svg", "#ffffff", "dup")}
              ${chip("/icons/figma/trash.svg", "#f26f63", "del")}
            </div>`,
          );
          actions.element.style.pointerEvents = "auto";
          actions.position.copy(node.position);
          world.planGroup.add(actions);
          actions.element
            .querySelector('[data-act="dup"]')
            ?.addEventListener("click", (e) => {
              e.stopPropagation();
              cbRef.current.onDuplicateMarker?.();
            });
          actions.element
            .querySelector('[data-act="del"]')
            ?.addEventListener("click", (e) => {
              e.stopPropagation();
              cbRef.current.onDeleteMarker?.();
            });
        }
      }

      world.render();
    };

    // ---- Transient overlay: line draft + ruler ----------------------------
    // Rebuilt on every cursor move while drafting/measuring — cheap (one or
    // two Line2s + CSS2D labels), so it lives apart from syncPlan.
    world.syncDraft = () => {
      if (disposed) return;
      const d = draftRef.current;
      const g = world.grid;
      world.draftGroup.traverse((obj) => {
        const anyObj = obj as THREE.Mesh;
        if (anyObj.geometry) anyObj.geometry.dispose();
        if (anyObj.material) disposeMaterial(anyObj.material);
      });
      world.draftGroup.clear();

      const resW = webgl.domElement.clientWidth || 1;
      const resH = webgl.domElement.clientHeight || 1;

      if (d.draft && d.draft.points.length >= 2) {
        const mat = new LineMaterial({
          color: new THREE.Color(d.draft.color).getHex(),
          linewidth: d.draft.widthMeters,
          worldUnits: true,
          transparent: true,
          opacity: 0.85,
          dashed: true,
          dashSize: 8,
          gapSize: 8,
        });
        mat.resolution.set(resW, resH);
        world.draftGroup.add(
          makePlanLine(drapedPolylinePositions(g, d.draft.points, LINE_LIFT), mat),
        );
      }

      // Ruler — line mode only (radial is 2D-only; the page force-switches
      // views when it's armed). Start dot always; segment + label once the
      // live end exists. Mirrors the 2D CircleMarker/Polyline/RulerLabel.
      if (d.ruler && d.rulerMode === "line") {
        const start = d.ruler.start;
        const dot = planCss2dNode(
          `<div style="transform:translate(-50%,-50%);width:9px;height:9px;border-radius:50%;background:#f4db50;border:1.5px solid #000;"></div>`,
        );
        dot.position.set(start[0], meshY(g, start[0], start[1]) + ICON_LIFT, -start[1]);
        world.draftGroup.add(dot);
        const end = d.ruler.end;
        if (end) {
          const mat = new LineMaterial({
            color: 0x000000,
            linewidth: 2,
            worldUnits: false,
            transparent: true,
            opacity: 0.95,
            dashed: d.ruler.pending,
            ...(d.ruler.pending ? { dashSize: 6, gapSize: 6 } : {}),
          });
          mat.resolution.set(resW, resH);
          world.draftGroup.add(
            makePlanLine(drapedPolylinePositions(g, [start, end], LINE_LIFT), mat),
          );
          const dx = end[0] - start[0];
          const dy = end[1] - start[1];
          const dist = Math.hypot(dx, dy);
          if (dist >= 1) {
            const bearing = Math.round(((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360)
              .toString()
              .padStart(3, "0");
            // display:inline-block — the 0×0 CSS2D host would otherwise give
            // this in-flow div a 0 containing-block width and the nowrap text
            // would overflow the pill.
            const label = planCss2dNode(
              `<div style="display:inline-block;transform:translate(-50%,-50%);background:rgba(32,36,39,0.92);color:#fff;padding:4px 8px;border-radius:6px;font-family:var(--font-roboto),ui-sans-serif,system-ui;font-variant-numeric:tabular-nums;white-space:nowrap;line-height:1.15;text-align:center;border:1px solid rgba(244,219,80,0.5);box-shadow:0 2px 8px rgba(0,0,0,0.4);">
                <div style="font-size:14px;font-weight:500;">${Math.round(dist)} m</div>
                <div style="font-size:11px;color:rgba(255,255,255,0.7);margin-top:1px;">${bearing}&deg;</div>
              </div>`,
            );
            const mx = (start[0] + end[0]) / 2;
            const my = (start[1] + end[1]) / 2;
            label.position.set(mx, meshY(g, mx, my) + ICON_LIFT, -my);
            world.draftGroup.add(label);
          }
        }
      }

      world.render();
    };

    // ---- Controls ---------------------------------------------------------
    const dom = webgl.domElement;
    dom.style.touchAction = "none";

    const restoreCursor = () => {
      dom.style.cursor = cbRef.current.cursorMode !== "off" ? "crosshair" : "grab";
    };
    restoreCursor();

    let dragging = false;
    let dragButton = -1;
    let lastX = 0;
    let lastY = 0;
    let moveAccum = 0;

    const mmbPivot = new THREE.Vector3();

    const captureMMBPivot = (clientX: number, clientY: number): void => {
      // Default: orbit around current target. If the cursor is over
      // terrain, use that point instead.
      mmbPivot.copy(target);
      const hit = pickTerrain(world, clientX, clientY);
      if (hit) mmbPivot.set(hit.x, meshY(world.grid, hit.x, hit.y), -hit.y);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      dragging = true;
      dragButton = e.button;
      lastX = e.clientX;
      lastY = e.clientY;
      moveAccum = 0;
      dom.style.cursor = "grabbing";
      if (e.button === 1) captureMMBPivot(e.clientX, e.clientY);
      e.preventDefault();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      moveAccum += Math.abs(dx) + Math.abs(dy);
      if (dragButton === 0) {
        // LMB pan: translate both camera and target by the same world
        // offset so the view shifts uniformly. worldPerPx is scaled to the
        // current eye→target distance so the cursor approximately sticks
        // to the terrain.
        const dist = camera.position.distanceTo(target);
        const worldPerPx = (2 * dist * tanHalfFov) / Math.max(1, dom.clientHeight);
        const fwd = new THREE.Vector3().subVectors(target, camera.position);
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        const off = new THREE.Vector3()
          .addScaledVector(right, -dx * worldPerPx)
          .addScaledVector(fwd, dy * worldPerPx);
        target.add(off);
        camera.position.add(off);
      } else if (dragButton === 1) {
        // MMB orbit around the captured pivot. Yaw rotates around world Y
        // at the pivot; pitch rotates around the camera-right axis at the
        // pivot, with a polar clamp so we don't tumble past the horizon.
        const yawDelta = -dx * 0.005;
        const pitchDelta = dy * 0.005;

        const cy = Math.cos(yawDelta);
        const sy = Math.sin(yawDelta);
        const yawAround = (v: THREE.Vector3) => {
          const rx = v.x - mmbPivot.x;
          const rz = v.z - mmbPivot.z;
          v.x = mmbPivot.x + rx * cy - rz * sy;
          v.z = mmbPivot.z + rx * sy + rz * cy;
        };
        yawAround(camera.position);
        yawAround(target);

        const lookHoriz = new THREE.Vector3().subVectors(target, camera.position);
        lookHoriz.y = 0;
        if (lookHoriz.lengthSq() > 1e-6) {
          lookHoriz.normalize();
          const rightAxis = new THREE.Vector3(-lookHoriz.z, 0, lookHoriz.x);
          const q = new THREE.Quaternion().setFromAxisAngle(rightAxis, pitchDelta);
          const tmpCam = camera.position.clone().sub(mmbPivot).applyQuaternion(q).add(mmbPivot);
          const tmpTar = target.clone().sub(mmbPivot).applyQuaternion(q).add(mmbPivot);
          const off = new THREE.Vector3().subVectors(tmpCam, tmpTar);
          const offLen = off.length();
          if (offLen > 1e-3) {
            const newPolar = Math.acos(Math.max(-1, Math.min(1, off.y / offLen)));
            if (newPolar >= POLAR_MIN && newPolar <= POLAR_MAX) {
              camera.position.copy(tmpCam);
              target.copy(tmpTar);
            }
          }
        }
      }
      camera.lookAt(target);
      world.render();
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!dragging) return;
      const wasButton = dragButton;
      dragging = false;
      dragButton = -1;
      restoreCursor();
      // LMB up with < slop movement = a map click. Lines get first shot
      // (mirrors the 2D hit-polyline swallowing the click), then the
      // terrain click flows into the page-side tool dispatcher.
      if (wasButton === 0 && moveAccum < CLICK_SLOP_PX) {
        const cb = cbRef.current;
        if (cb.linesInteractive && cb.onLineClick) {
          const lineId = pickPlanLine(world, e.clientX, e.clientY);
          if (lineId) {
            cb.onLineClick(lineId);
            return;
          }
        }
        const hit = pickTerrain(world, e.clientX, e.clientY);
        if (hit)
          cb.onMapClick?.({ worldX: Math.round(hit.x), worldY: Math.round(hit.y) });
      }
    };
    const onDblClick = (e: MouseEvent) => {
      const hit = pickTerrain(world, e.clientX, e.clientY);
      if (hit)
        cbRef.current.onMapDoubleClick?.({
          worldX: Math.round(hit.x),
          worldY: Math.round(hit.y),
        });
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      // Right-click mirrors Escape for in-progress gestures (cancel draft /
      // ruler). Coords match the 2D contract even though the page-side
      // handler currently ignores them.
      const hit = pickTerrain(world, e.clientX, e.clientY);
      cbRef.current.onMapContextMenu?.({
        worldX: Math.round(hit?.x ?? 0),
        worldY: Math.round(hit?.y ?? 0),
      });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
      const curDist = camera.position.distanceTo(target);
      if (curDist < 1e-6) return;
      const newDist = Math.max(MIN_DISTANCE, Math.min(maxDistance, curDist * factor));
      const f = newDist / curDist;
      if (Math.abs(f - 1) < 1e-6) return; // hit the min/max clamp

      // Cursor-anchored zoom: scale both (camera - pivot) and (target -
      // pivot) by the same factor so the view direction stays constant
      // and the cursor's terrain point stays under the cursor. Falls back
      // to a plain eye→target dolly when the cursor is over the background.
      const hit = pickTerrain(world, e.clientX, e.clientY);
      if (hit) {
        const pivot = new THREE.Vector3(hit.x, meshY(world.grid, hit.x, hit.y), -hit.y);
        camera.position.set(
          pivot.x + (camera.position.x - pivot.x) * f,
          pivot.y + (camera.position.y - pivot.y) * f,
          pivot.z + (camera.position.z - pivot.z) * f,
        );
        target.set(
          pivot.x + (target.x - pivot.x) * f,
          pivot.y + (target.y - pivot.y) * f,
          pivot.z + (target.z - pivot.z) * f,
        );
      } else {
        const dir = new THREE.Vector3()
          .subVectors(camera.position, target)
          .divideScalar(curDist);
        camera.position.copy(target).addScaledVector(dir, newDist);
      }
      camera.lookAt(target);
      world.render();
    };

    // ---- Keyboard: WASD pans on the ground plane, Q/E orbits around the
    // terrain point at the viewport center. Physical key codes (layout-
    // independent — works on ЙЦУКЕН too). Held keys drive a rAF loop with
    // delta-time; the view stays render-on-demand otherwise.
    const KEY_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE"]);
    const KEY_PAN = 0.7; // viewport heights per second
    const KEY_YAW = (100 * Math.PI) / 180; // rad per second
    const keysDown = new Set<string>();
    let keyRaf = 0;
    let keyLast = 0;
    const yawPivot = new THREE.Vector3();
    let yawPivotValid = false;

    const isTyping = () => {
      const el = document.activeElement;
      return (
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          (el as HTMLElement).isContentEditable)
      );
    };

    const keyStep = (now: number) => {
      const dt = Math.min(0.05, (now - keyLast) / 1000);
      keyLast = now;
      let moved = false;

      let px = 0; // screen-right
      let pf = 0; // screen-up (forward on the ground)
      if (keysDown.has("KeyW")) pf += 1;
      if (keysDown.has("KeyS")) pf -= 1;
      if (keysDown.has("KeyA")) px -= 1;
      if (keysDown.has("KeyD")) px += 1;
      if (px || pf) {
        const dist = camera.position.distanceTo(target);
        const speed = KEY_PAN * 2 * dist * tanHalfFov * dt;
        const fwd = new THREE.Vector3().subVectors(target, camera.position);
        fwd.y = 0;
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
        fwd.normalize();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        const off = new THREE.Vector3()
          .addScaledVector(right, px * speed)
          .addScaledVector(fwd, pf * speed);
        target.add(off);
        camera.position.add(off);
        yawPivotValid = false; // panning moves the viewport center
        moved = true;
      }

      let spin = 0;
      if (keysDown.has("KeyQ")) spin += 1;
      if (keysDown.has("KeyE")) spin -= 1;
      if (spin) {
        if (!yawPivotValid) {
          // Pivot = terrain under the screen center (fallback: camera target).
          const rect = dom.getBoundingClientRect();
          const hit = pickTerrain(world, rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (hit) yawPivot.set(hit.x, meshY(world.grid, hit.x, hit.y), -hit.y);
          else yawPivot.copy(target);
          yawPivotValid = true;
        }
        const a = spin * KEY_YAW * dt;
        const cy = Math.cos(a);
        const sy = Math.sin(a);
        const yawAround = (v: THREE.Vector3) => {
          const rx = v.x - yawPivot.x;
          const rz = v.z - yawPivot.z;
          v.x = yawPivot.x + rx * cy - rz * sy;
          v.z = yawPivot.z + rx * sy + rz * cy;
        };
        yawAround(camera.position);
        yawAround(target);
        moved = true;
      }

      if (moved) {
        camera.lookAt(target);
        world.render();
      }
      keyRaf = keysDown.size > 0 ? requestAnimationFrame(keyStep) : 0;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!KEY_CODES.has(e.code) || e.ctrlKey || e.metaKey || e.altKey || isTyping()) return;
      if (keysDown.has(e.code)) return; // key auto-repeat
      if ((e.code === "KeyQ" || e.code === "KeyE") && !keysDown.has("KeyQ") && !keysDown.has("KeyE"))
        yawPivotValid = false; // fresh rotate session — re-pick the center
      keysDown.add(e.code);
      if (!keyRaf) {
        keyLast = performance.now();
        keyRaf = requestAnimationFrame(keyStep);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysDown.delete(e.code);
    };
    const onWindowBlur = () => {
      keysDown.clear(); // alt-tab must not leave keys stuck down
    };

    // Grid + elevation readout under the cursor (rAF-throttled terrain
    // pick). Mirrors the 2D CursorHint's format; corner-anchored because a
    // cursor-following box would fight the CSS2D marker overlays.
    let hoverRaf = 0;
    const onHover = (e: MouseEvent) => {
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        if (disposed) return;
        const hit = pickTerrain(world, e.clientX, e.clientY);
        if (!hit) return;
        const el = coordsRef.current;
        if (el) {
          let text = `${grid4(hit.x)} ${grid4(hit.y)}`;
          if (world.sampler) {
            const elev = world.sampler.sample(hit.x, hit.y);
            if (Number.isFinite(elev)) text += ` · ${Math.round(elev)} m`;
          }
          el.textContent = text;
        }
        // Feeds the page's rubber-band cursor (draft preview / live ruler
        // end). The page only stores it while drafting or measuring, so
        // this doesn't cause re-render storms in normal browsing.
        cbRef.current.onMapMouseMove?.({
          worldX: Math.round(hit.x),
          worldY: Math.round(hit.y),
        });
      });
    };

    dom.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    dom.addEventListener("dblclick", onDblClick);
    dom.addEventListener("contextmenu", onContextMenu);
    dom.addEventListener("mousemove", onHover);
    // Wheel goes on the mount container, not the canvas, so it bubbles up
    // from CSS2D marker overlays too — otherwise scroll-to-zoom is silently
    // blocked whenever the cursor is over a player/vehicle marker (they
    // have pointer-events: auto for hover labels).
    mount.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      webgl.setSize(w, h);
      css2d.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // LineMaterial needs the render-target resolution for px-width and
      // dash math; refresh the overlay materials on resize.
      for (const group of [world.planGroup, world.draftGroup]) {
        group.traverse((obj) => {
          const mat = (obj as THREE.Mesh).material;
          if (mat instanceof LineMaterial) mat.resolution.set(w, h);
        });
      }
      world.render();
    });
    ro.observe(mount);

    // ---- Imperative API for the parent (view handoff + fit) ---------------
    onApi?.({
      fitWholeMap: () => {
        const y = meshY(world.grid, centerX, centerY);
        world.tweenTo(new THREE.Vector3(centerX, y, -centerY), dist0);
      },
      getView: () => ({
        x: target.x,
        z: -target.z,
        radius: camera.position.distanceTo(target) * tanHalfFov,
      }),
    });

    world.render();

    return () => {
      disposed = true;
      dom.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      dom.removeEventListener("dblclick", onDblClick);
      dom.removeEventListener("contextmenu", onContextMenu);
      dom.removeEventListener("mousemove", onHover);
      mount.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      if (keyRaf) cancelAnimationFrame(keyRaf);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      ro.disconnect();
      if (dom.parentNode === mount) mount.removeChild(dom);
      if (css2d.domElement.parentNode === mount)
        mount.removeChild(css2d.domElement);
      disposeTerrain();
      terrainMat.dispose();
      texture?.dispose();
      // Marker meshes share geometries (disposed below) but each has its
      // own material — dispose materials before clearing the maps.
      for (const e of world.charEntries.values()) {
        if (e.shape) disposeMaterial(e.shape.material);
        if (e.outline) disposeMaterial(e.outline.material);
      }
      for (const e of world.vehicleEntries.values()) {
        if (e.shape) disposeMaterial(e.shape.material);
        if (e.outline) disposeMaterial(e.outline.material);
        if (e.detail) disposeMaterial(e.detail.material);
      }
      world.charEntries.clear();
      world.vehicleEntries.clear();
      world.badgeObjs.clear();
      if (world.focusAnimId !== null) cancelAnimationFrame(world.focusAnimId);
      shotGroup.clear();
      for (const group of [world.planGroup, world.draftGroup]) {
        group.traverse((obj) => {
          const anyObj = obj as THREE.Mesh;
          if (anyObj.geometry) anyObj.geometry.dispose();
          if (anyObj.material) disposeMaterial(anyObj.material);
        });
        group.clear();
      }
      triGeom.dispose();
      triOutlineGeom.dispose();
      pentGeom.dispose();
      pentOutlineGeom.dispose();
      squareGeom.dispose();
      squareOutlineGeom.dispose();
      armedDetailGeom.dispose();
      staticDetailGeom.dispose();
      webgl.dispose();
      worldRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapConfig]);

  // ===== Plan-overlay sync ===============================================
  // Clear-and-rebuild on any plan-content change — same dep list shape as
  // the 2D viewport's declarative re-render.
  useEffect(() => {
    planRef.current = { markers, lines, polygons, labelColor, planOpacity, markersInteractive };
    worldRef.current?.syncPlan();
  }, [markers, lines, polygons, labelColor, planOpacity, markersInteractive]);

  // Transient overlay (draft rubber-band + ruler) — changes every mousemove
  // while drafting, so it syncs separately from the heavy plan rebuild.
  useEffect(() => {
    draftRef.current = { draft, ruler, rulerMode };
    worldRef.current?.syncDraft();
  }, [draft, ruler, rulerMode]);

  // Cursor reflects the page-side tool (crosshair while placing/drawing).
  useEffect(() => {
    const w = worldRef.current;
    if (w) w.webgl.domElement.style.cursor = cursorMode !== "off" ? "crosshair" : "grab";
  }, [cursorMode]);

  // ===== Replay sync — chars =============================================
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const want = new Map<number, ReplayCharRenderable>();
    for (const c of replayChars ?? []) want.set(c.charId, c);

    // Remove gone chars.
    for (const [id, entry] of world.charEntries) {
      if (!want.has(id)) {
        if (entry.shape) {
          world.scene.remove(entry.shape);
          disposeMaterial(entry.shape.material);
        }
        if (entry.outline) {
          world.scene.remove(entry.outline);
          disposeMaterial(entry.outline.material);
        }
        world.scene.remove(entry.hud);
        world.charEntries.delete(id);
      }
    }

    // Upsert.
    for (const [id, c] of want) {
      let entry = world.charEntries.get(id);
      const wantShape = !c.isDeadPlayer;
      if (!entry) {
        const hudEl = document.createElement("div");
        const hud = new CSS2DObject(hudEl);
        world.scene.add(hud);
        entry = { shape: null, outline: null, detail: null, hud };
        world.charEntries.set(id, entry);
      }
      // Add/remove the 3D shape as the dead-player flag toggles. The
      // skull glyph renders inside the hud DOM instead, so dead players
      // keep only the screen-aligned skull.
      if (wantShape && !entry.shape) {
        const mat = new THREE.MeshBasicMaterial({
          color: c.color,
          side: THREE.DoubleSide,
          depthTest: false,
          transparent: true,
          opacity: c.opacity,
        });
        const shape = new THREE.Mesh(world.triGeom, mat);
        shape.renderOrder = 5;
        world.scene.add(shape);
        entry.shape = shape;
        const omat = new THREE.LineBasicMaterial({
          color:
            c.color === TRIANGLE_DESTROYED_HEX
              ? MARKER_STROKE_DESTROYED
              : MARKER_STROKE_NORMAL,
          depthTest: false,
          transparent: true,
          opacity: c.opacity,
        });
        const outline = new THREE.LineLoop(world.triOutlineGeom, omat);
        outline.renderOrder = 6;
        world.scene.add(outline);
        entry.outline = outline;
      } else if (!wantShape && entry.shape) {
        world.scene.remove(entry.shape);
        disposeMaterial(entry.shape.material);
        entry.shape = null;
        if (entry.outline) {
          world.scene.remove(entry.outline);
          disposeMaterial(entry.outline.material);
          entry.outline = null;
        }
      }

      entry.hud.element.innerHTML = replayCharHudHtml(c);
      const y = terrainY(c.worldX, c.worldY, world.sampler) + world.markerLiftM;
      entry.hud.position.set(c.worldX, y, -c.worldY);

      if (entry.shape) {
        entry.shape.position.set(c.worldX, y, -c.worldY);
        // CSS rotation is clockwise looking down; three.js +Y rotation
        // is counter-clockwise (right-hand rule). Negate yaw so the
        // world-space direction matches the 2D viewport's convention
        // (yaw=0 → north, yaw=90 → east).
        entry.shape.rotation.y = -(c.yaw * Math.PI) / 180;
        const mat = entry.shape.material as THREE.MeshBasicMaterial;
        mat.color.set(c.color);
        mat.opacity = c.opacity;
        if (entry.outline) {
          entry.outline.position.copy(entry.shape.position);
          entry.outline.rotation.y = entry.shape.rotation.y;
          const omat = entry.outline.material as THREE.LineBasicMaterial;
          omat.color.set(
            c.color === TRIANGLE_DESTROYED_HEX
              ? MARKER_STROKE_DESTROYED
              : MARKER_STROKE_NORMAL,
          );
          omat.opacity = c.opacity;
        }
      }
    }
    world.render();
  }, [replayChars]);

  // ===== Replay sync — vehicles =========================================
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const want = new Map<number, ReplayVehicleRenderable>();
    for (const v of replayVehicles ?? []) want.set(v.vehicleId, v);

    for (const [id, entry] of world.vehicleEntries) {
      if (!want.has(id)) {
        if (entry.shape) {
          world.scene.remove(entry.shape);
          disposeMaterial(entry.shape.material);
        }
        if (entry.outline) {
          world.scene.remove(entry.outline);
          disposeMaterial(entry.outline.material);
        }
        if (entry.detail) {
          world.scene.remove(entry.detail);
          disposeMaterial(entry.detail.material);
        }
        world.scene.remove(entry.hud);
        world.vehicleEntries.delete(id);
      }
    }
    for (const [id, obj] of world.badgeObjs) {
      const v = want.get(id);
      if (!v || v.playerBadge <= 0) {
        world.scene.remove(obj);
        world.badgeObjs.delete(id);
      }
    }

    for (const [id, v] of want) {
      let entry = world.vehicleEntries.get(id);
      if (!entry) {
        // Body silhouette: square for static weapons, pentagon for vehicles
        // (armed and unarmed share the outer shape — they're differentiated
        // by the interior detail mesh below). Kind is stable per vehicle
        // (set once on register), so geometry choice is one-shot at create.
        const isStatic = v.kind === "static_weapon";
        const shapeGeom = isStatic ? world.squareGeom : world.pentGeom;
        const outlineGeom = isStatic ? world.squareOutlineGeom : world.pentOutlineGeom;
        const mat = new THREE.MeshBasicMaterial({
          color: v.color,
          side: THREE.DoubleSide,
          depthTest: false,
          transparent: true,
        });
        const shape = new THREE.Mesh(shapeGeom, mat);
        shape.renderOrder = 5;
        world.scene.add(shape);
        const omat = new THREE.LineBasicMaterial({
          color:
            v.color === TRIANGLE_DESTROYED_HEX
              ? MARKER_STROKE_DESTROYED
              : MARKER_STROKE_NORMAL,
          depthTest: false,
        });
        const outline = new THREE.LineLoop(outlineGeom, omat);
        outline.renderOrder = 6;
        world.scene.add(outline);
        // Interior glyph (gun symbol / barrel + baseplate), drawn in stroke
        // color on top of the body fill. Unarmed mobiles get nothing.
        let detail: THREE.Mesh | null = null;
        const detailGeom =
          v.kind === "vehicle_armed"
            ? world.armedDetailGeom
            : v.kind === "static_weapon"
              ? world.staticDetailGeom
              : null;
        if (detailGeom) {
          const dmat = new THREE.MeshBasicMaterial({
            color:
              v.color === TRIANGLE_DESTROYED_HEX
                ? MARKER_STROKE_DESTROYED
                : MARKER_STROKE_NORMAL,
            side: THREE.DoubleSide,
            depthTest: false,
            transparent: true,
          });
          detail = new THREE.Mesh(detailGeom, dmat);
          // Above the body (5) and the outline (6) so the glyph sits on top.
          detail.renderOrder = 7;
          world.scene.add(detail);
        }
        const hudEl = document.createElement("div");
        const hud = new CSS2DObject(hudEl);
        world.scene.add(hud);
        entry = { shape, outline, detail, hud };
        world.vehicleEntries.set(id, entry);
      }
      entry.hud.element.innerHTML = replayVehicleHudHtml(v);
      const y = terrainY(v.worldX, v.worldY, world.sampler) + world.markerLiftM;
      entry.hud.position.set(v.worldX, y, -v.worldY);
      if (entry.shape) {
        entry.shape.position.set(v.worldX, y, -v.worldY);
        entry.shape.rotation.y = -(v.yaw * Math.PI) / 180;
        (entry.shape.material as THREE.MeshBasicMaterial).color.set(v.color);
      }
      if (entry.outline) {
        entry.outline.position.copy(entry.shape!.position);
        entry.outline.rotation.y = entry.shape!.rotation.y;
        (entry.outline.material as THREE.LineBasicMaterial).color.set(
          v.color === TRIANGLE_DESTROYED_HEX
            ? MARKER_STROKE_DESTROYED
            : MARKER_STROKE_NORMAL,
        );
      }
      if (entry.detail) {
        entry.detail.position.copy(entry.shape!.position);
        entry.detail.rotation.y = entry.shape!.rotation.y;
        (entry.detail.material as THREE.MeshBasicMaterial).color.set(
          v.color === TRIANGLE_DESTROYED_HEX
            ? MARKER_STROKE_DESTROYED
            : MARKER_STROKE_NORMAL,
        );
      }
      if (v.playerBadge > 0) {
        let badge = world.badgeObjs.get(id);
        if (!badge) {
          const el = document.createElement("div");
          el.style.pointerEvents = "none";
          badge = new CSS2DObject(el);
          world.badgeObjs.set(id, badge);
          world.scene.add(badge);
        }
        badge.element.innerHTML = replayVehicleBadgeHtml(v);
        badge.position.set(v.worldX, y, -v.worldY);
      }
    }
    world.render();
  }, [replayVehicles]);

  // ===== Replay sync — shots ============================================
  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    // Shots are short-lived (fade out within a second or two), so the
    // cheap rebuild is the simpler path — no per-shot identity tracking.
    while (world.shotGroup.children.length > 0) {
      const child = world.shotGroup.children[0];
      world.shotGroup.remove(child);
      if ((child as THREE.Line | THREE.Mesh).geometry)
        (child as THREE.Line | THREE.Mesh).geometry.dispose();
      const mat = (child as THREE.Line | THREE.Mesh).material;
      if (mat) {
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    }

    const SHOT_LIFT = 1.5;
    for (const s of replayShots ?? []) {
      const oy = terrainY(s.originX, s.originZ, world.sampler) + SHOT_LIFT;
      const hy = terrainY(s.hitX, s.hitZ, world.sampler) + SHOT_LIFT;
      // Tracer / dashed-trail line.
      if ((s.isExplosion && s.hasLine) || (!s.isExplosion && s.hasLine)) {
        const pts = [
          new THREE.Vector3(s.originX, oy, -s.originZ),
          new THREE.Vector3(s.hitX, hy, -s.hitZ),
        ];
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const isHeavyTrail = s.isExplosion && s.isHeavy;
        const mat = new THREE.LineDashedMaterial({
          color: s.color,
          transparent: true,
          opacity: s.isExplosion ? s.opacity * 0.6 : s.opacity,
          dashSize: s.isExplosion ? (isHeavyTrail ? 8 : 4) : 1e9,
          gapSize: s.isExplosion ? (isHeavyTrail ? 8 : 6) : 0,
          depthTest: false,
          linewidth: 1,
        });
        const line = new THREE.Line(geom, mat);
        line.computeLineDistances();
        line.renderOrder = 2;
        world.shotGroup.add(line);
      }
      if (s.isExplosion) {
        // Expanding ring on the ground at the hit point.
        const radius = 1 + s.age * 11;
        const segs = 48;
        const ringPts: THREE.Vector3[] = [];
        for (let i = 0; i <= segs; i++) {
          const a = (i / segs) * Math.PI * 2;
          const rx = s.hitX + Math.cos(a) * radius;
          const rz = s.hitZ + Math.sin(a) * radius;
          const ry = terrainY(rx, rz, world.sampler) + SHOT_LIFT;
          ringPts.push(new THREE.Vector3(rx, ry, -rz));
        }
        const ringGeom = new THREE.BufferGeometry().setFromPoints(ringPts);
        const ringMat = new THREE.LineBasicMaterial({
          color: s.color,
          transparent: true,
          opacity: s.opacity,
          depthTest: false,
        });
        const ring = new THREE.Line(ringGeom, ringMat);
        ring.renderOrder = 3;
        world.shotGroup.add(ring);
      }
    }
    world.render();
  }, [replayShots]);

  // ===== Parent-driven focus (event-log click) ===========================
  // Tween the camera so the requested world point sits in the center of
  // the view at max zoom. We keep the current tilt + azimuth — only the
  // target moves and the eye→target distance collapses to minDistance.
  // Keyed by mapFocus.key so the same coords clicked twice still re-fire.
  const lastFocusKeyRef = useRef<number | null>(null);
  useEffect(() => {
    const world = worldRef.current;
    if (!world || !mapFocus) return;
    if (lastFocusKeyRef.current === mapFocus.key) return;
    lastFocusKeyRef.current = mapFocus.key;

    // Snap the new target onto the terrain so the focus point isn't
    // floating in the air (or buried in a hill).
    const terrainHere = terrainY(mapFocus.worldX, mapFocus.worldY, world.sampler);
    const endTar = new THREE.Vector3(
      mapFocus.worldX,
      Number.isFinite(terrainHere) ? terrainHere : 0,
      -mapFocus.worldY,
    );
    world.tweenTo(endTar, world.minDistance);
  }, [mapFocus]);

  const zoomBy = (factor: number) => {
    const world = worldRef.current;
    if (!world) return;
    const { camera, target } = world;
    const curDist = camera.position.distanceTo(target);
    if (curDist < 1e-6) return;
    const newDist = Math.max(world.minDistance, Math.min(world.maxDistance, curDist * factor));
    const dir = new THREE.Vector3().subVectors(camera.position, target).divideScalar(curDist);
    camera.position.copy(target).addScaledVector(dir, newDist);
    camera.lookAt(target);
    world.render();
  };

  return (
    <div className="absolute inset-0">
      <div ref={mountRef} className="absolute inset-0 overflow-hidden" />

      <MapViewControls
        onZoomIn={() => zoomBy(1 / 1.4)}
        onZoomOut={() => zoomBy(1.4)}
        onFit={() => {
          const world = worldRef.current;
          if (!world) return;
          world.tweenTo(
            new THREE.Vector3(
              world.center.x,
              meshY(world.grid, world.center.x, -world.center.z),
              world.center.z,
            ),
            world.dist0,
          );
        }}
        view3D={view3D}
        onToggleView={onToggleView}
      />

      {/* coordinate + elevation readout (no scale bar — perspective has no
          single scale) */}
      <div className="max-md:hidden absolute right-4 bottom-4 z-[1000] pointer-events-none">
        <div className="bg-[rgba(32,36,39,0.9)] rounded-[8px] px-[10px] py-[6px] shadow-[0px_4px_12px_0px_rgba(0,0,0,0.4)]">
          <span ref={coordsRef} className="font-mono text-[11px] leading-none font-medium text-white/75">
            {"—"}
          </span>
        </div>
      </div>
    </div>
  );
}
