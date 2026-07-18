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
 *   - MMB drag           yaw (horizontal) + pitch (vertical)
 *   - Wheel              zoom (dolly)
 *
 * Architecture: useEffect on [mapConfig] builds the terrain + camera + WebGL
 * + CSS2D renderers and stashes everything on a ref. Per-frame replay data
 * (chars, vehicles, shots) flows through separate sync effects that mutate
 * the existing world — so playback at 60fps doesn't rebuild the scene each
 * frame.
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
import type { MapConfig } from "@/lib/maps";
import { loadHeightmap, type HeightmapSampler } from "@/lib/heightmap";
import type {
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
};

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
  terrain: THREE.Mesh | null;
  /** Closure-managed camera target (the lookAt point). Mutated by control
   *  handlers; exposed on the ref so the parent-driven focus effect can
   *  also tween it. */
  target: THREE.Vector3;
  minDistance: number;
  /** Active focus animation, so a new request can cancel the in-flight
   *  tween instead of fighting it. */
  focusAnimId: number | null;
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

export default function MapClient3D({
  mapConfig,
  replayChars,
  replayVehicles,
  replayShots,
  mapFocus,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);

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
      55,
      Math.max(1, mount.clientWidth / Math.max(1, mount.clientHeight)),
      1,
      Math.max(widthM, heightM) * 8,
    );

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
    mount.appendChild(css2d.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.7);
    sun.position.set(1, 1.4, 0.6).normalize();
    scene.add(sun);

    // Camera state model: `target` is the lookAt point and `camera.position`
    // is the eye. Both are primary state — pan moves them together, MMB
    // rotates them as a pair around an arbitrary pivot (the cursor's
    // terrain point), wheel dollies the eye along the eye→target line.
    // This decouples the rotation pivot from the lookAt point, which is
    // what lets MMB-drag spin around the cursor without snapping the view.
    const centerX = (mapConfig.worldBL[0] + mapConfig.worldUR[0]) * 0.5;
    const centerY = (mapConfig.worldBL[1] + mapConfig.worldUR[1]) * 0.5;
    const target = new THREE.Vector3(centerX, 0, -centerY);

    const halfDiag = Math.hypot(widthM, heightM) * 0.5;
    const minDistance = 50;
    const maxDistance = halfDiag * 5;
    // Clamp on the angle between (camera→target) and world +Y. POLAR_MIN
    // = 1° (89° from horizontal) — a hair below straight-down. The
    // remaining degree of slack avoids the lookAt-up-vector flicker that
    // happens when the look direction is exactly antiparallel to world Y.
    // POLAR_MAX stops the camera at least 15° above the horizon (= 75°
    // from straight-down) — close enough to horizontal for terrain-
    // following views, but a buffer that prevents the camera from grazing
    // through hills on a close zoom.
    const POLAR_MIN = (1 * Math.PI) / 180;
    const POLAR_MAX = (75 * Math.PI) / 180;

    // Initial placement: ~halfDiag-tan(fov/2) distance, ~26° away from
    // top-down (= ~64° above horizon) — clear "looks 3D" without being
    // close to either clamp.
    const dist0 = halfDiag / Math.tan((camera.fov * Math.PI) / 360);
    const polar0 = 0.45;
    camera.position.set(
      target.x,
      target.y + dist0 * Math.cos(polar0),
      target.z + dist0 * Math.sin(polar0),
    );
    camera.lookAt(target);

    const shotGroup = new THREE.Group();
    scene.add(shotGroup);

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
      terrain: null,
      target,
      minDistance,
      focusAnimId: null,
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
        const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
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
        css2d.render(scene, camera);
      },
    };
    worldRef.current = world;

    const texLoader = new THREE.TextureLoader();
    const texture = texLoader.load(
      mapConfig.imagePath,
      () => {
        if (!disposed) world.render();
      },
      undefined,
      (err) => {
        console.warn(
          `[MapClient3D] texture load failed: ${mapConfig.imagePath}`,
          err,
        );
      },
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = webgl.capabilities.getMaxAnisotropy();

    function disposeTerrain() {
      if (!world.terrain) return;
      scene.remove(world.terrain);
      world.terrain.geometry.dispose();
      const m = world.terrain.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
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
      const indices: number[] = [];
      for (let j = 0; j < vertsY; j++) {
        for (let i = 0; i < vertsX; i++) {
          const u = i / segX;
          const v = j / segY;
          const wx = mapConfig.worldBL[0] + u * widthM;
          const wy = mapConfig.worldBL[1] + v * heightM;
          const elev = sampler ? sampler.sample(wx, wy) : 0;
          const idx = j * vertsX + i;
          positions[idx * 3 + 0] = wx;
          positions[idx * 3 + 1] = Number.isFinite(elev) ? elev : 0;
          positions[idx * 3 + 2] = -wy;
          uvs[idx * 2 + 0] = u;
          uvs[idx * 2 + 1] = v;
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
      geom.computeVertexNormals();
      const mat = new THREE.MeshLambertMaterial({ map: texture });
      world.terrain = new THREE.Mesh(geom, mat);
      scene.add(world.terrain);
    }
    buildTerrain(null);
    world.render();

    if (mapConfig.heightmapBin && mapConfig.heightmapMeta) {
      loadHeightmap(mapConfig.heightmapBin, mapConfig.heightmapMeta)
        .then((sampler) => {
          if (disposed) return;
          world.sampler = sampler;
          buildTerrain(sampler);
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
          world.render();
        })
        .catch((err) => {
          console.warn(
            `[MapClient3D] heightmap load failed for ${mapConfig.key}:`,
            err,
          );
        });
    }

    // ---- Controls ---------------------------------------------------------
    const dom = webgl.domElement;
    dom.style.touchAction = "none";
    dom.style.cursor = "grab";

    let dragging = false;
    let dragButton = -1;
    let lastX = 0;
    let lastY = 0;

    // Raycaster captures the cursor's terrain point at MMB-down, then we
    // orbit (camera.position, target) as a pair around it for the duration
    // of the drag. Critically we do NOT change target on press — that's
    // what was causing the view to snap to face the cursor before. Now
    // the lookAt direction is preserved on press and only changes as the
    // user actually rotates.
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const mmbPivot = new THREE.Vector3();

    function captureMMBPivot(clientX: number, clientY: number): void {
      // Default: orbit around current target (existing behavior). If the
      // cursor is over terrain, use that point instead.
      mmbPivot.copy(target);
      if (!world.terrain) return;
      const rect = dom.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(world.terrain, false);
      if (hits.length > 0) mmbPivot.copy(hits[0].point);
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      dragging = true;
      dragButton = e.button;
      lastX = e.clientX;
      lastY = e.clientY;
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
      if (dragButton === 0) {
        // LMB pan: translate both camera and target by the same world
        // offset so the view shifts uniformly. worldPerPx is scaled to the
        // current eye→target distance so the cursor approximately sticks
        // to the terrain.
        const dist = camera.position.distanceTo(target);
        const worldPerPx =
          (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) /
          Math.max(1, dom.clientHeight);
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
    const onMouseUp = () => {
      dragging = false;
      dom.style.cursor = "grab";
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
      const curDist = camera.position.distanceTo(target);
      if (curDist < 1e-6) return;
      const newDist = Math.max(
        minDistance,
        Math.min(maxDistance, curDist * factor),
      );
      const f = newDist / curDist;
      if (Math.abs(f - 1) < 1e-6) return; // hit the min/max clamp

      // Cursor-anchored zoom: scale both (camera - pivot) and (target -
      // pivot) by the same factor so the view direction stays constant
      // and the cursor's terrain point stays under the cursor. Falls back
      // to a plain eye→target dolly when the cursor is over the background.
      let pivot: THREE.Vector3 | null = null;
      if (world.terrain) {
        const rect = dom.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
          ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(ndc, camera);
          const hits = raycaster.intersectObject(world.terrain, false);
          if (hits.length > 0) pivot = hits[0].point;
        }
      }
      if (pivot) {
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

    dom.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    dom.addEventListener("contextmenu", onContextMenu);
    // Wheel goes on the mount container, not the canvas, so it bubbles up
    // from CSS2D marker overlays too — otherwise scroll-to-zoom is silently
    // blocked whenever the cursor is over a player/vehicle marker (they
    // have pointer-events: auto for hover labels).
    mount.addEventListener("wheel", onWheel, { passive: false });

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      webgl.setSize(w, h);
      css2d.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      world.render();
    });
    ro.observe(mount);

    return () => {
      disposed = true;
      dom.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      dom.removeEventListener("contextmenu", onContextMenu);
      mount.removeEventListener("wheel", onWheel);
      ro.disconnect();
      if (dom.parentNode === mount) mount.removeChild(dom);
      if (css2d.domElement.parentNode === mount)
        mount.removeChild(css2d.domElement);
      disposeTerrain();
      texture.dispose();
      // Marker meshes share geometries (disposed below) but each has its
      // own material — dispose materials before clearing the maps.
      for (const e of world.charEntries.values()) {
        if (e.shape) disposeMaterial(e.shape.material);
        if (e.outline) disposeMaterial(e.outline.material);
      }
      for (const e of world.vehicleEntries.values()) {
        if (e.shape) disposeMaterial(e.shape.material);
        if (e.outline) disposeMaterial(e.outline.material);
      }
      world.charEntries.clear();
      world.vehicleEntries.clear();
      world.badgeObjs.clear();
      if (world.focusAnimId !== null) cancelAnimationFrame(world.focusAnimId);
      shotGroup.clear();
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
  }, [mapConfig]);

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

    const startCam = world.camera.position.clone();
    const startTar = world.target.clone();
    // Snap the new target onto the terrain so the focus point isn't
    // floating in the air (or buried in a hill).
    const terrainHere = terrainY(mapFocus.worldX, mapFocus.worldY, world.sampler);
    const endTar = new THREE.Vector3(
      mapFocus.worldX,
      Number.isFinite(terrainHere) ? terrainHere : 0,
      -mapFocus.worldY,
    );
    // Direction from target to camera, preserved across the tween — so
    // tilt and azimuth survive. Distance collapses to minDistance.
    const dir = new THREE.Vector3().subVectors(startCam, startTar);
    if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
    dir.normalize();
    const endCam = endTar.clone().addScaledVector(dir, world.minDistance);

    const DURATION = 600;
    const t0 = performance.now();
    // ease-out-cubic, matches Leaflet flyTo feel
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);

    if (world.focusAnimId !== null) cancelAnimationFrame(world.focusAnimId);
    const step = () => {
      const w = worldRef.current;
      if (!w) return;
      const t = Math.min(1, (performance.now() - t0) / DURATION);
      const e = ease(t);
      w.camera.position.lerpVectors(startCam, endCam, e);
      w.target.lerpVectors(startTar, endTar, e);
      w.camera.lookAt(w.target);
      w.render();
      if (t < 1) {
        w.focusAnimId = requestAnimationFrame(step);
      } else {
        w.focusAnimId = null;
      }
    };
    world.focusAnimId = requestAnimationFrame(step);
  }, [mapFocus]);

  return <div ref={mountRef} className="w-full h-full relative" />;
}
