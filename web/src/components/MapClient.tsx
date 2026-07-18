"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Circle,
  CircleMarker,
  MapContainer,
  ImageOverlay,
  Marker,
  Pane,
  Polygon,
  Polyline,
  TileLayer,
  ZoomControl,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L, { CRS, DivIcon, Transformation } from "leaflet";
import type { LatLngBoundsLiteral } from "leaflet";
import "leaflet/dist/leaflet.css";
import { markerDivIconHtml, militaryDivIconHtml } from "@/components/MarkerIcon";
import type { IconEntry } from "@/lib/markerLibrary";
import type { MapConfig } from "@/lib/maps";
import { loadHeightmap, type HeightmapSampler } from "@/lib/heightmap";
import { useT } from "@/components/LanguageProvider";
import {
  replayCharHtml,
  replayVehicleHtml,
  replayVehicleBadgeHtml,
} from "@/lib/replayMarkers";
import type { VehicleKind } from "@/lib/replay";

type RenderableBase = {
  id: string;
  worldX: number;
  worldY: number;
  label: string;
  rotation: number;
  selected: boolean;
  /** Imported-from-Workbench markers: render-only, no selection/drag/delete. */
  readOnly?: boolean;
};

export type RenderableMarker =
  | (RenderableBase & { kind: "custom"; icon: IconEntry; color: string })
  | (RenderableBase & { kind: "military"; iconUrl: string });

export type RenderableLine = {
  id: string;
  color: string;        // hex
  widthMeters: number;  // world thickness — converted to px per zoom
  points: [number, number][]; // [[worldX, worldY], ...]
  selected: boolean;
};

export type RenderablePolygon = {
  id: string;
  points: [number, number][]; // [[worldX, worldY], ...]
  fillColor: string;       // "#rrggbb"
  fillOpacity: number;     // 0..1
  strokeColor: string;     // "#rrggbb"
  strokeOpacity: number;   // 0..1
  strokeWidth: number;     // pixels
  fillOutside: boolean;
};

/** Live character rendered during replay playback. Rendered as a small SVG
 *  triangle pointing in the heading direction. Color is precomputed by the
 *  caller via lib/replay.ts.resolveCharHex — typically the char's faction
 *  color, or grey when destroyed. */
export type ReplayCharRenderable = {
  charId: number;
  worldX: number;
  worldY: number;
  yaw: number;
  /** CSS hex color (e.g. "#3b82f6"). When equal to HEX_DESTROYED grey, the
   *  triangle uses a softer outline. */
  color: string;
  /** When non-null, render the player's name beside the triangle. Gated on
   *  the showNames toggle in the panel — null when the toggle is off. */
  label: string | null;
  /** When non-null, surface the player's name in a Leaflet tooltip on hover.
   *  Independent of `label` / showNames — hover always reveals the name when
   *  one exists, so a viewer can probe identity without committing to the
   *  full-time label overlay. Null for AI chars (no playerName to show). */
  hoverLabel: string | null;
  /** Marker opacity in [0, 1]. 1.0 in normal playback; fades toward 0 in
   *  the tail of the post-death linger window for player casualties whose
   *  body has been despawned. */
  opacity: number;
  /** Dead player-controlled chars render as a skull instead of the grey
   *  triangle. Dead AI still get the grey triangle (the skull is reserved
   *  for human casualties so they stand out on the map). */
  isDeadPlayer: boolean;
};

/** Vehicle marker — wheeled, helicopter, or static weapon. Distinct shape
 *  from the char triangle so the map reads at a glance. The badge field
 *  shows a count of named-player occupants when > 0; AI-only / empty / not-
 *  yet-occupied vehicles render badge-less. */
export type ReplayVehicleRenderable = {
  vehicleId: number;
  worldX: number;
  worldY: number;
  yaw: number;
  /** CSS hex from resolveVehicleHex (yellow / grey / faction color). */
  color: string;
  /** Vehicle display name — currently unused on the map but available for
   *  future tooltips or hover labels. */
  name: string;
  /** Mod-resolved category. Drives which SVG glyph the renderer uses:
   *  pentagon (unarmed), pentagon-w/-turret (armed), or square-w/-barrel
   *  (static weapon). */
  kind: VehicleKind;
  /** When > 0, render a number badge near the marker. Counts only named
   *  players (no AI), per the spec. */
  playerBadge: number;
  /** Display names of the named-player occupants currently riding in this
   *  vehicle, surfaced as a stacked list in the hover tooltip. AI occupants
   *  are excluded (they have no playerName). Length matches `playerBadge`
   *  by construction. Empty when nobody named is aboard. */
  occupantNames: string[];
};

/** Active shot rendered as a tracer line (origin → hit) or an explosion ring
 *  when origin == hit. Opacity is precomputed by the caller from age + fade
 *  window (see lib/replay.ts.activeShotsAt). */
export type ReplayShotRenderable = {
  /** Stable identity for React keys. Mod-side `t` is unique per shot. */
  key: string;
  originX: number;
  originZ: number;
  hitX: number;
  hitZ: number;
  opacity: number;
  isExplosion: boolean;
  /** True when origin and hit differ enough that drawing a line is meaningful.
   *  Bullets always have hasLine=true. Explosives have hasLine=true except in
   *  the legacy degenerate case (origin==hit) where the line collapses. */
  hasLine: boolean;
  /** Heavy ordnance flag (rockets, mortars). Layer renders a thicker dashed
   *  trail. Only meaningful when isExplosion is also true. */
  isHeavy: boolean;
  /** CSS hex color resolved by the caller (faction-accurate when available,
   *  blue/red identity fallback otherwise). */
  color: string;
  /** [0, 1] — 0 at moment of shot, 1 at end of fade. Used to grow the
   *  explosion ring; ignored for tracers. */
  age: number;
};

/** CRS.Simple: 1 world unit = 2^zoom pixels. Clamped so lines never vanish. */
function metersToWeight(m: number, zoom: number): number {
  return Math.max(1.5, m * Math.pow(2, zoom));
}

function boundsFor(cfg: MapConfig): LatLngBoundsLiteral {
  return [
    [cfg.worldBL[1], cfg.worldBL[0]],
    [cfg.worldUR[1], cfg.worldUR[0]],
  ];
}

function panBoundsFor(cfg: MapConfig): LatLngBoundsLiteral {
  const pad = Math.max(cfg.worldUR[0] - cfg.worldBL[0], cfg.worldUR[1] - cfg.worldBL[1]) * 0.1;
  return [
    [cfg.worldBL[1] - pad, cfg.worldBL[0] - pad],
    [cfg.worldUR[1] + pad, cfg.worldUR[0] + pad],
  ];
}

function makeIcon(
  m: RenderableMarker,
  interactive: boolean,
  labelColor: "black" | "white",
) {
  const html =
    m.kind === "military"
      ? militaryDivIconHtml(m.iconUrl, m.label, m.rotation, 54, m.selected, interactive, 1, labelColor)
      : markerDivIconHtml(m.icon, m.color, m.label, m.rotation, 54, m.selected, interactive, 1, labelColor);
  return new DivIcon({
    className: "",
    html,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

/** Pentagon-house marker for replay vehicles. Rotated by yaw like the char
 *  triangle. Slightly larger than the triangle so the two are easy to tell
 *  apart on the map. Optional badge (top-right) shows named-player count.
 *  Stroke darkens when the vehicle is destroyed (grey fill + grey outline
 *  would otherwise blend into the basemap). HTML body lives in
 *  lib/replayMarkers.ts so the 3D viewport can render the same DOM via
 *  CSS2DObject — Leaflet's DivIcon is wrapped around it here. */
function makeReplayVehicleIcon(v: ReplayVehicleRenderable): DivIcon {
  // Occupant list is inlined into the icon HTML and gated via CSS :hover
  // (see globals.css .ts-replay-veh-hover). Rendering via react-leaflet's
  // <Tooltip> instead led to stale tooltips during playback — every frame
  // setIcon swaps the underlying DOM element, and Leaflet's tooltip
  // lifecycle didn't track that swap reliably. CSS :hover re-evaluates
  // against whichever element is mounted right now and self-clears the
  // moment the cursor leaves.
  return new DivIcon({
    html: replayVehicleHtml(v),
    className: "ts-replay-vehicle-icon",
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

/** Standalone occupant-count badge. Rendered as a separate Marker in a
 *  dedicated pane above the marker pane so it never gets covered by other
 *  vehicle pentagons stacked nearby (Leaflet sorts markers within a single
 *  pane by latitude, so a southern vehicle's pentagon would paint over a
 *  northern vehicle's badge if both lived in markerPane). Non-interactive
 *  so pointer events still reach the underlying vehicle marker. */
function makeReplayVehicleBadgeIcon(v: ReplayVehicleRenderable): DivIcon {
  return new DivIcon({
    html: replayVehicleBadgeHtml(v),
    className: "ts-replay-vehicle-badge-icon",
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

/** Triangle marker for replay chars. yaw=0 points north (up); positive yaw
 *  rotates clockwise, matching Reforger's convention. iconAnchor (0,0) so the
 *  triangle's centroid lands at the world position. */
function makeReplayIcon(c: ReplayCharRenderable): DivIcon {
  return new DivIcon({
    className: "",
    html: replayCharHtml(c),
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

export type ClickPoint = { worldX: number; worldY: number };

function ClickCapture({
  onClick,
  onDoubleClick,
  onMouseMove,
  onContextMenu,
}: {
  onClick: (p: ClickPoint) => void;
  onDoubleClick?: (p: ClickPoint) => void;
  onMouseMove?: (p: ClickPoint) => void;
  onContextMenu?: (p: ClickPoint) => void;
}) {
  useMapEvents({
    click(e) {
      onClick({
        worldX: Math.round(e.latlng.lng),
        worldY: Math.round(e.latlng.lat),
      });
    },
    dblclick(e) {
      if (!onDoubleClick) return;
      onDoubleClick({
        worldX: Math.round(e.latlng.lng),
        worldY: Math.round(e.latlng.lat),
      });
    },
    mousemove(e) {
      if (!onMouseMove) return;
      onMouseMove({
        worldX: Math.round(e.latlng.lng),
        worldY: Math.round(e.latlng.lat),
      });
    },
    contextmenu(e) {
      // Always suppress the browser's native context menu over the map so the
      // right-click feels like a Leaflet-native gesture.
      e.originalEvent.preventDefault();
      if (!onContextMenu) return;
      onContextMenu({
        worldX: Math.round(e.latlng.lng),
        worldY: Math.round(e.latlng.lat),
      });
    },
  });
  return null;
}

// Imperative pan-and-zoom hook for parent-driven focus requests. Watches
// the `mapFocus.key` so every fresh click in the event log triggers a
// flyTo even when the coordinates happen to match the previous request.
// Renders nothing.
function MapFocusEffect({
  focus,
}: {
  focus: { worldX: number; worldY: number; zoom: number; key: number } | null;
}) {
  const map = useMap();
  const lastKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (!focus) return;
    if (lastKeyRef.current === focus.key) return;
    lastKeyRef.current = focus.key;
    // CRS.Simple: lat = worldY, lng = worldX.
    map.flyTo([focus.worldY, focus.worldX], focus.zoom, { duration: 0.6 });
  }, [focus, map]);
  return null;
}

// Imperative shot-tracer layer. Replaces the per-element react-leaflet
// rendering of Polyline/Circle for shots. Why imperative: with ~tens of
// fading lines whose props change every RAF tick, react-leaflet's per-element
// reconciliation occasionally leaked Leaflet layers (a polyline would stay
// painted on the map after its React element unmounted). Owning a single
// LayerGroup and clearing it each frame eliminates that whole class of bug —
// the group is the source of truth, and on cleanup it removes itself.
function ReplayShotLayer({ shots }: { shots: ReplayShotRenderable[] }) {
  const map = useMap();
  const groupRef = useRef<L.LayerGroup | null>(null);

  // One-time: attach the layer group, detach on unmount.
  useEffect(() => {
    const group = L.layerGroup().addTo(map);
    groupRef.current = group;
    return () => {
      map.removeLayer(group);
      groupRef.current = null;
    };
  }, [map]);

  // Per-frame: rebuild the group's contents from the latest props. clearLayers
  // releases every Leaflet layer the group owns, so nothing can outlive its
  // most recent render.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    group.clearLayers();
    for (const s of shots) {
      const hex = s.color;
      // Explosives draw a line + circle pair when they have a meaningful
      // origin (frag thrown 15m, rocket fired across the valley); the line
      // is dashed and dimmed so the blast circle reads as the focal element.
      // Bullets keep the original solid line. The legacy degenerate case
      // (explosion with origin==hit) draws the circle alone.
      if (s.isExplosion && s.hasLine) {
        // Heavy ordnance (rocket, mortar) renders with a thicker stroke and
        // a wider dash gap so it reads as a more emphatic trail than a
        // grenade arc. The blast circle below stays the same size in both.
        const lineWeight = s.isHeavy ? 3 : 1.5;
        const lineDash = s.isHeavy ? "8 8" : "4 6";
        L.polyline(
          [
            [s.originZ, s.originX],
            [s.hitZ, s.hitX],
          ],
          {
            color: hex,
            weight: lineWeight,
            opacity: s.opacity * 0.6,
            dashArray: lineDash,
            interactive: false,
          },
        ).addTo(group);
      }
      if (s.isExplosion) {
        const radius = 1 + s.age * 11;
        L.circle([s.hitZ, s.hitX], {
          radius,
          color: hex,
          weight: 1.5,
          opacity: s.opacity,
          fillColor: hex,
          fillOpacity: s.opacity * 0.15,
          interactive: false,
        }).addTo(group);
      } else if (s.hasLine) {
        L.polyline(
          [
            [s.originZ, s.originX],
            [s.hitZ, s.hitX],
          ],
          {
            color: hex,
            weight: 1.5,
            opacity: s.opacity,
            interactive: false,
          },
        ).addTo(group);
      }
    }
  }, [shots]);

  return null;
}

function FitWorld({ bounds }: { bounds: LatLngBoundsLiteral }) {
  const map = useMap();
  useEffect(() => {
    const fit = () => {
      map.invalidateSize();
      // Clamp min zoom to the fit zoom — users can't zoom further out than the
      // whole-map view, otherwise the map becomes a tiny island on a black void.
      const fitZoom = map.getBoundsZoom(bounds, false, L.point(20, 20));
      map.setMinZoom(fitZoom);
      map.fitBounds(bounds, { padding: [20, 20], animate: false });
    };
    // Initial fit — and on window resize, where "window changed" is a fair
    // signal to rehome the view.
    fit();
    window.addEventListener("resize", fit);
    // Container resize (e.g. mobile tool sheet opening/closing) — just
    // re-project tiles; don't refit, so the user's current zoom/pan sticks.
    const container = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(container);
    return () => {
      window.removeEventListener("resize", fit);
      ro.disconnect();
    };
  }, [map, bounds]);
  return null;
}

/** Toggles the map-container cursor.
 *   - "off":        default grab.
 *   - "container":  crosshair on empty map; `.leaflet-interactive` children
 *                   keep their pointer (for selectable markers/lines).
 *   - "aggressive": crosshair on the container AND every interactive child
 *                   (drawing modes where nothing should look selectable).
 *
 *  react-leaflet's MapContainer freezes className in useState on first render,
 *  so className props don't react to changes — we toggle imperatively. */
function CrosshairClass({
  mode,
}: {
  mode: "off" | "container" | "aggressive";
}) {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    el.classList.toggle("ts-cursor-crosshair", mode === "container");
    el.classList.toggle("leaflet-crosshair", mode === "aggressive");
    return () => {
      el.classList.remove("ts-cursor-crosshair");
      el.classList.remove("leaflet-crosshair");
    };
  }, [map, mode]);
  return null;
}

function ZoomTracker({ onChange }: { onChange: (z: number) => void }) {
  const map = useMap();
  useEffect(() => {
    onChange(map.getZoom());
    const handler = () => onChange(map.getZoom());
    map.on("zoom", handler);
    map.on("zoomend", handler);
    return () => {
      map.off("zoom", handler);
      map.off("zoomend", handler);
    };
  }, [map, onChange]);
  return null;
}

/** 4-digit MGRS-style reference: worldCoordMeters / 10, zero-padded to 4. */
function grid4(m: number): string {
  const v = Math.max(0, Math.floor(m / 10));
  return v.toString().padStart(4, "0");
}

/** Tracks the cursor on the map and renders a grid + elevation readout that
 *  follows it.  Grid always shown (over any map); elevation only when a
 *  heightmap is loaded and the cursor is inside terrain bounds. */
function CursorHint({ sampler }: { sampler: HeightmapSampler | null }) {
  const map = useMap();
  const [state, setState] = useState<
    { cx: number; cy: number; worldX: number; worldY: number; elev: number | null } | null
  >(null);

  useEffect(() => {
    const onMove = (e: L.LeafletMouseEvent) => {
      const worldX = e.latlng.lng;
      const worldY = e.latlng.lat;
      let elev: number | null = null;
      if (sampler) {
        const e = sampler.sample(worldX, worldY);
        if (Number.isFinite(e)) elev = e;
      }
      setState({
        cx: e.containerPoint.x,
        cy: e.containerPoint.y,
        worldX,
        worldY,
        elev,
      });
    };
    const onOut = () => setState(null);
    map.on("mousemove", onMove);
    map.on("mouseout", onOut);
    return () => {
      map.off("mousemove", onMove);
      map.off("mouseout", onOut);
    };
  }, [map, sampler]);

  if (!state) return null;
  return (
    <div
      // Hidden on touch viewports: Leaflet fires a synthetic mousemove on tap,
      // so the hint would freeze at the last tap point and read as a "ghost
      // pin" with stale coords.
      className="hidden md:block"
      style={{
        position: "absolute",
        left: state.cx + 14,
        top: state.cy + 14,
        background: "rgba(32,36,39,0.88)",
        color: "#fff",
        padding: "2px 6px",
        borderRadius: 4,
        fontFamily: "var(--font-roboto), ui-sans-serif, system-ui",
        fontSize: 12,
        fontVariantNumeric: "tabular-nums",
        pointerEvents: "none",
        zIndex: 2000,
        whiteSpace: "nowrap",
        lineHeight: 1.25,
      }}
    >
      <div>{`${grid4(state.worldX)} ${grid4(state.worldY)}`}</div>
      {state.elev !== null && <div>{`${Math.round(state.elev)} m`}</div>}
    </div>
  );
}

export type RulerRender = {
  start: [number, number];
  /** Null while the second point is still pending and the cursor hasn't moved
   *  (mobile — no mousemove between taps). MapClient still renders a start
   *  anchor so the user sees "I tapped here". */
  end: [number, number] | null;
  /** True while awaiting the second click (dashed preview); false once committed. */
  pending: boolean;
};

function formatDistance(m: number): string {
  return `${Math.round(m)} m`;
}

/** Bearing in degrees, clockwise from north (worldY+ is north in Reforger). */
function bearingDeg(start: [number, number], end: [number, number]): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function RulerLabel({
  start,
  end,
  variant = "line",
}: {
  start: [number, number];
  end: [number, number];
  variant?: "line" | "radial";
}) {
  const map = useMap();
  const [, force] = useState(0);
  useEffect(() => {
    const handler = () => force((v) => v + 1);
    map.on("move", handler);
    map.on("zoom", handler);
    map.on("resize", handler);
    return () => {
      map.off("move", handler);
      map.off("zoom", handler);
      map.off("resize", handler);
    };
  }, [map]);

  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return null;
  const midWorldX = (start[0] + end[0]) / 2;
  const midWorldY = (start[1] + end[1]) / 2;
  const mid = map.latLngToContainerPoint([midWorldY, midWorldX]);

  return (
    <div
      style={{
        position: "absolute",
        left: mid.x,
        top: mid.y,
        transform: "translate(-50%, -50%)",
        background: "rgba(32,36,39,0.92)",
        color: "#fff",
        padding: "4px 8px",
        borderRadius: 6,
        fontFamily: "var(--font-roboto), ui-sans-serif, system-ui",
        fontVariantNumeric: "tabular-nums",
        pointerEvents: "none",
        zIndex: 2000,
        whiteSpace: "nowrap",
        lineHeight: 1.15,
        textAlign: "center",
        border: "1px solid rgba(244,219,80,0.5)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
      }}
    >
      {variant === "radial" ? (
        <div style={{ fontSize: 14, fontWeight: 500 }}>
          {`R ${formatDistance(dist)}`}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{formatDistance(dist)}</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 1 }}>
            {Math.round(bearingDeg(start, end)).toString().padStart(3, "0")}°
          </div>
        </>
      )}
    </div>
  );
}

/** Small round icon-only action chip (Figma 27:76 / 27:83). */
function ActionChip({
  iconSrc,
  onClick,
  title,
  iconColor,
}: {
  iconSrc: string;
  onClick: () => void;
  title: string;
  iconColor: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 32,
        height: 32,
        borderRadius: 999,
        background: "#202427",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        border: "none",
        padding: 0,
        boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 16,
          height: 16,
          backgroundColor: iconColor,
          WebkitMaskImage: `url(${iconSrc})`,
          maskImage: `url(${iconSrc})`,
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
          WebkitMaskSize: "contain",
          maskSize: "contain",
        }}
      />
    </button>
  );
}

/** Draggable rotation handle anchored at the selected marker's "12 o'clock"
 *  in rotation-space. Drag to rotate; bearing is north-clockwise (Reforger
 *  convention). Snaps to 5°; hold Shift for 1° steps. */
function RotationHandle({
  worldX,
  worldY,
  rotation,
  onRotate,
}: {
  worldX: number;
  worldY: number;
  rotation: number;
  onRotate: (deg: number) => void;
}) {
  const { t } = useT();
  const map = useMap();
  const ref = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const handler = () => force((v) => v + 1);
    map.on("move", handler);
    map.on("zoom", handler);
    map.on("resize", handler);
    return () => {
      map.off("move", handler);
      map.off("zoom", handler);
      map.off("resize", handler);
    };
  }, [map]);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    L.DomEvent.disableClickPropagation(node);
    L.DomEvent.disableScrollPropagation(node);
  }, []);

  const center = map.latLngToContainerPoint([worldY, worldX]);
  const RADIUS = 48;
  const rad = (rotation * Math.PI) / 180;
  const hx = center.x + Math.sin(rad) * RADIUS;
  const hy = center.y - Math.cos(rad) * RADIUS;

  function bearingFromCursor(e: React.PointerEvent): number {
    const rect = map.getContainer().getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const dx = cx - center.x;
    const dy = cy - center.y;
    let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const step = e.shiftKey ? 1 : 5;
    deg = Math.round(deg / step) * step;
    return ((deg % 360) + 360) % 360;
  }

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDragging(true);
    onRotate(bearingFromCursor(e));
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging) return;
    onRotate(bearingFromCursor(e));
  }
  function onPointerUp(e: React.PointerEvent) {
    setDragging(false);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released */
    }
  }

  return (
    <>
      <svg
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 1999,
        }}
      >
        <line
          x1={center.x}
          y1={center.y}
          x2={hx}
          y2={hy}
          stroke="#fbbf24"
          strokeWidth={1.5}
          strokeDasharray="3 3"
          opacity={0.85}
        />
      </svg>
      <div
        ref={ref}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title={t("tool.rotate", { deg: Math.round(rotation) })}
        style={{
          position: "absolute",
          left: hx,
          top: hy,
          transform: "translate(-50%, -50%)",
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: dragging ? "#fbbf24" : "#202427",
          border: "2px solid #fbbf24",
          cursor: dragging ? "grabbing" : "grab",
          zIndex: 2000,
          boxShadow: "0 2px 6px rgba(0,0,0,0.5)",
          touchAction: "none",
        }}
      />
    </>
  );
}

/** Floating duplicate/delete overlay anchored below a selected marker. */
function MarkerActions({
  worldX,
  worldY,
  onDuplicate,
  onDelete,
}: {
  worldX: number;
  worldY: number;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  const map = useMap();
  const ref = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);
  useEffect(() => {
    const handler = () => force((v) => v + 1);
    map.on("move", handler);
    map.on("zoom", handler);
    map.on("resize", handler);
    return () => {
      map.off("move", handler);
      map.off("zoom", handler);
      map.off("resize", handler);
    };
  }, [map]);
  // Prevent clicks and scroll-wheel from bubbling to the Leaflet map (which
  // would deselect the marker or zoom).
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    L.DomEvent.disableClickPropagation(node);
    L.DomEvent.disableScrollPropagation(node);
  }, []);

  const pt = map.latLngToContainerPoint([worldY, worldX]);
  // Marker icon is 54px tall, anchored center. Drop the chips just under its
  // lower edge with a small gap.
  const top = pt.y + 36;
  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        left: pt.x,
        top,
        transform: "translateX(-50%)",
        display: "flex",
        gap: 6,
        zIndex: 2000,
      }}
    >
      <ActionChip
        iconSrc="/icons/figma/copy.svg"
        onClick={onDuplicate}
        title={t("action.duplicate")}
        iconColor="#ffffff"
      />
      <ActionChip
        iconSrc="/icons/figma/trash.svg"
        onClick={onDelete}
        title={t("action.delete")}
        iconColor="#f26f63"
      />
    </div>
  );
}

export default function MapClient({
  mapConfig,
  labelColor = "black",
  markers,
  lines,
  polygons = [],
  replayChars = [],
  replayShots = [],
  replayVehicles = [],
  draft,
  ruler,
  rulerMode = "line",
  radial = null,
  cursorMode = "off",
  linesInteractive = true,
  markersInteractive = true,
  planOpacity = 1,
  mapFocus = null,
  showCursorHint = true,
  onMapClick,
  onMapDoubleClick,
  onMapMouseMove,
  onMapContextMenu,
  onMarkerClick,
  onMarkerDrag,
  onLineClick,
  onDuplicateMarker,
  onDeleteMarker,
  onRotateMarker,
  onHeightmapChange,
}: {
  mapConfig: MapConfig;
  /** Global web-only marker-label text color. "black" reads on light terrain;
   *  "white" is the contrast option for dark basemaps. Not pushed to the mod. */
  labelColor?: "black" | "white";
  markers: RenderableMarker[];
  lines: RenderableLine[];
  /** Read-only imported polygons (from Workbench Markers.layer). */
  polygons?: RenderablePolygon[];
  /** Replay-mode character triangles. Empty/omitted in plan mode. */
  replayChars?: ReplayCharRenderable[];
  /** Replay-mode active shots (tracers + explosion rings). Empty/omitted
   *  outside replay mode or when the user toggled shots off. */
  replayShots?: ReplayShotRenderable[];
  /** Replay-mode vehicles (pentagons w/ optional player-count badge). */
  replayVehicles?: ReplayVehicleRenderable[];
  /** In-progress line being drafted. Rendered as a preview polyline. */
  draft: { color: string; widthMeters: number; points: [number, number][] } | null;
  /** Active ruler measurement. Rendered as a line with distance + bearing label. */
  ruler: RulerRender | null;
  /** Which ruler variant is active. "line" = straight segment, "radial" = visibility circle. */
  rulerMode?: "line" | "radial";
  /** Committed radial-LOS mask. When set, MapClient overlays it inside the
   *  circle defined by `ruler.start` / `ruler.end`. */
  radial?: {
    maskUrl: string;
    worldBL: [number, number];
    worldUR: [number, number];
  } | null;
  /** Map cursor mode.
   *   - "off": default grab.
   *   - "container": crosshair on empty map; selectable children stay pointer.
   *   - "aggressive": crosshair everywhere, even over interactive children. */
  cursorMode?: "off" | "container" | "aggressive";
  /** When false, existing lines do not respond to clicks (e.g. during drafting). */
  linesInteractive?: boolean;
  /** When false, markers ignore pointer events so clicks pass through to the map. */
  markersInteractive?: boolean;
  /** Multiplier applied to plan-content opacity (markers, lines, polygons).
   *  Used in replay mode when the "Show plan" overlay is dimmed via the
   *  opacity slider. 1 = fully opaque (plan-mode default). Replay-content
   *  layers (chars, vehicles, shots) are unaffected. */
  planOpacity?: number;
  /** Imperative pan-and-zoom request from the parent. Each new object
   *  (identified by `key`) triggers a single flyTo on the underlying
   *  Leaflet map. Used by the event log's click-to-focus behavior. */
  mapFocus?: {
    worldX: number;
    worldY: number;
    zoom: number;
    /** Bumped on every focus request so re-clicking the same event still
     *  re-centers the map (otherwise React would consider the prop value
     *  unchanged when coordinates match). */
    key: number;
  } | null;
  /** Show the floating grid + elevation hint that follows the cursor.
   *  Useful in plan mode for placing markers at exact coords; hidden in
   *  replay mode where it's just noise on top of the action. */
  showCursorHint?: boolean;
  onMapClick: (p: ClickPoint) => void;
  onMapDoubleClick?: (p: ClickPoint) => void;
  onMapMouseMove?: (p: ClickPoint) => void;
  /** Right-click on the map. Native browser context menu is always suppressed. */
  onMapContextMenu?: (p: ClickPoint) => void;
  onMarkerClick: (id: string) => void;
  onMarkerDrag: (id: string, p: ClickPoint) => void;
  onLineClick: (id: string) => void;
  onDuplicateMarker?: () => void;
  onDeleteMarker?: () => void;
  onRotateMarker?: (deg: number) => void;
  /** Fires whenever the heightmap sampler for the current map is (re)loaded or cleared. */
  onHeightmapChange?: (sampler: HeightmapSampler | null) => void;
}) {
  const selectedMarker = markers.find((m) => m.selected) ?? null;
  const [zoom, setZoom] = useState<number>(-4);
  const worldBounds = useMemo(() => boundsFor(mapConfig), [mapConfig]);
  // For tiled maps, shift the world into the positive pixel quadrant via a custom
  // CRS transformation. Default CRS.Simple maps our (lat=worldY) → pixel_y = -lat,
  // which puts the map at negative pixel-Y. TileLayer then requests tile y=-64..0,
  // which can't map cleanly to positive filesystem paths. Translating by +maxY in
  // the transformation moves the entire map into [0, maxY] pixel space while
  // keeping north at the top of the screen.
  const tiledCrs = useMemo(() => {
    if (!(mapConfig.tilePattern && mapConfig.tileMaxZoom !== undefined)) return CRS.Simple;
    const maxY = mapConfig.worldUR[1];
    return L.extend({}, CRS.Simple, {
      transformation: new Transformation(1, 0, -1, maxY),
    });
  }, [mapConfig]);
  const panBounds = useMemo(() => panBoundsFor(mapConfig), [mapConfig]);

  // Lazy-load the heightmap when mapConfig changes (or clear it if this world
  // doesn't have one).
  const [heightmap, setHeightmap] = useState<HeightmapSampler | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHeightmap(null);
    onHeightmapChange?.(null);
    if (mapConfig.heightmapBin && mapConfig.heightmapMeta) {
      loadHeightmap(mapConfig.heightmapBin, mapConfig.heightmapMeta)
        .then((hm) => {
          if (cancelled) return;
          setHeightmap(hm);
          onHeightmapChange?.(hm);
        })
        .catch((err) => {
          console.warn(`[MapClient] heightmap load failed for ${mapConfig.key}:`, err);
        });
    }
    return () => { cancelled = true; };
  }, [mapConfig, onHeightmapChange]);
  const centerLat = (mapConfig.worldBL[1] + mapConfig.worldUR[1]) / 2;
  const centerLng = (mapConfig.worldBL[0] + mapConfig.worldUR[0]) / 2;
  return (
    <MapContainer
      key={mapConfig.key}
      crs={tiledCrs}
      center={[centerLat, centerLng]}
      zoom={-4}
      maxBounds={panBounds}
      maxBoundsViscosity={0.8}
      minZoom={-6}
      maxZoom={4}
      zoomSnap={0.25}
      attributionControl={false}
      zoomControl={false}
      doubleClickZoom={false}
      style={{ width: "100%", height: "100%", background: "#0f172a" }}
    >
      <CrosshairClass mode={cursorMode} />
      <ZoomControl position="topright" />
      <MapFocusEffect focus={mapFocus} />
      {mapConfig.tilePattern && mapConfig.tileMaxZoom !== undefined ? (
        // Pyramid layout: pyramid-z=0 is the whole map in one 256px tile and
        // pyramid-z=tileMaxZoom is native. In CRS.Simple with a square map of
        // W world units, Leaflet zoom Z yields W·2^Z screen pixels — so
        // Leaflet zoom 0 corresponds to pyramid-z=tileMaxZoom. We bridge by
        // offsetting the URL-z so the whole Leaflet zoom range maps to the
        // correct pyramid levels; tiles only exist for Leaflet zoom in
        // [-tileMaxZoom, 0] and Leaflet scales outside that range.
        <TileLayer
          url={mapConfig.tilePattern}
          tileSize={256}
          // minZoom/maxZoom here are the TileLayer's allowed Leaflet zoom range
          // (not the pyramid z). Default is [0, undefined], which drops every tile
          // because our map's Leaflet zoom range is negative. Set explicitly.
          minZoom={-mapConfig.tileMaxZoom}
          maxZoom={4}
          minNativeZoom={-mapConfig.tileMaxZoom}
          maxNativeZoom={0}
          zoomOffset={mapConfig.tileMaxZoom}
          noWrap
          bounds={L.latLngBounds(worldBounds)}
        />
      ) : (
        <ImageOverlay url={mapConfig.imagePath} bounds={worldBounds} />
      )}

      {/* Imported polygon zones. Fill-outside uses a ring polygon (worldBounds
          outer, zone inner) for the exterior mask; the stroke always traces
          the zone itself. Non-interactive. */}
      {polygons.map((p) => {
        const ring = p.points.map(([x, y]) => [y, x] as [number, number]);
        const outer: [number, number][] = [
          [mapConfig.worldBL[1], mapConfig.worldBL[0]],
          [mapConfig.worldBL[1], mapConfig.worldUR[0]],
          [mapConfig.worldUR[1], mapConfig.worldUR[0]],
          [mapConfig.worldUR[1], mapConfig.worldBL[0]],
        ];
        return (
          <div key={p.id} style={{ display: "contents" }}>
            <Polygon
              positions={p.fillOutside ? [outer, ring] : ring}
              pathOptions={{
                fillColor: p.fillColor,
                fillOpacity: p.fillOpacity * planOpacity,
                stroke: false,
                interactive: false,
              }}
            />
            <Polygon
              positions={ring}
              pathOptions={{
                color: p.strokeColor,
                opacity: p.strokeOpacity * planOpacity,
                weight: p.strokeWidth,
                fill: false,
                interactive: false,
              }}
            />
          </div>
        );
      })}

      <FitWorld bounds={worldBounds} />
      <ZoomTracker onChange={setZoom} />
      <ClickCapture
        onClick={onMapClick}
        onDoubleClick={onMapDoubleClick}
        onMouseMove={onMapMouseMove}
        onContextMenu={onMapContextMenu}
      />
      {showCursorHint && <CursorHint sampler={heightmap} />}

      {/* Committed lines — selection halo rendered as a thicker faint stroke beneath. */}
      {lines.map((ln) => {
        const latlngs = ln.points.map(([x, y]) => [y, x] as [number, number]);
        const weight = metersToWeight(ln.widthMeters, zoom);
        return (
          <div key={ln.id} style={{ display: "contents" }}>
            {ln.selected && (
              <Polyline
                positions={latlngs}
                pathOptions={{
                  color: "#fbbf24",
                  weight: weight + 8,
                  opacity: 0.55 * planOpacity,
                  interactive: false,
                }}
              />
            )}
            <Polyline
              positions={latlngs}
              pathOptions={{
                color: ln.color,
                weight,
                opacity: planOpacity,
                lineCap: "butt",
                lineJoin: "round",
                interactive: false,
              }}
            />
            {/* Invisible hit area — keeps click targets generous at zoom levels
                where the visible stroke thins to its 1.5px floor. */}
            {linesInteractive && (
              <Polyline
                positions={latlngs}
                bubblingMouseEvents={false}
                pathOptions={{
                  color: ln.color,
                  weight: Math.max(weight, 14),
                  opacity: 0,
                  lineCap: "butt",
                  lineJoin: "round",
                }}
                eventHandlers={{
                  click: (e) => {
                    L.DomEvent.stopPropagation(e);
                    onLineClick(ln.id);
                  },
                }}
              />
            )}
          </div>
        );
      })}

      {/* Ruler measurement. Two variants:
          - line: straight segment from A→B with distance + bearing label.
          - radial: circle centered at A with radius = |AB|; when committed, overlay a
            visibility mask covering blocked areas. Label shows radius. */}
      {ruler && rulerMode === "line" && (
        <>
          {/* Start anchor — visible the moment the first point is placed,
              independent of pointer tracking (important on touch). */}
          <CircleMarker
            center={[ruler.start[1], ruler.start[0]]}
            radius={4}
            pathOptions={{
              color: "#000000",
              weight: 1.5,
              fillColor: "#f4db50",
              fillOpacity: 1,
              interactive: false,
            }}
          />
          {ruler.end && (
            <>
              <Polyline
                positions={[
                  [ruler.start[1], ruler.start[0]],
                  [ruler.end[1], ruler.end[0]],
                ]}
                pathOptions={{
                  color: "#000000",
                  weight: 2,
                  opacity: 0.95,
                  dashArray: ruler.pending ? "6 6" : undefined,
                  lineCap: "round",
                  interactive: false,
                }}
              />
              <RulerLabel start={ruler.start} end={ruler.end} />
            </>
          )}
        </>
      )}
      {ruler && rulerMode === "radial" && (
        <>
          <CircleMarker
            center={[ruler.start[1], ruler.start[0]]}
            radius={4}
            pathOptions={{
              color: "#000000",
              weight: 1.5,
              fillColor: "#f4db50",
              fillOpacity: 1,
              interactive: false,
            }}
          />
          {ruler.end && (
            <>
              <Circle
                center={[ruler.start[1], ruler.start[0]]}
                radius={Math.hypot(
                  ruler.end[0] - ruler.start[0],
                  ruler.end[1] - ruler.start[1],
                )}
                pathOptions={{
                  color: "#000000",
                  weight: 1.5,
                  opacity: 0.95,
                  fill: false,
                  dashArray: ruler.pending ? "6 6" : undefined,
                  interactive: false,
                }}
              />
              {!ruler.pending && radial && (
                <ImageOverlay
                  url={radial.maskUrl}
                  bounds={[
                    [radial.worldBL[1], radial.worldBL[0]],
                    [radial.worldUR[1], radial.worldUR[0]],
                  ]}
                  opacity={1}
                  interactive={false}
                />
              )}
              {ruler.pending && (
                <RulerLabel
                  start={ruler.start}
                  end={ruler.end}
                  variant="radial"
                />
              )}
            </>
          )}
        </>
      )}

      {/* In-progress draft (non-interactive). */}
      {draft && draft.points.length > 0 && (
        <Polyline
          positions={draft.points.map(([x, y]) => [y, x] as [number, number])}
          pathOptions={{
            color: draft.color,
            weight: metersToWeight(draft.widthMeters, zoom),
            dashArray: "6 6",
            opacity: 0.85,
            lineCap: "butt",
            lineJoin: "round",
            interactive: false,
          }}
        />
      )}

      {markers.map((m) => {
        const interactive = markersInteractive && !m.readOnly;
        return (
          <Marker
            key={m.id}
            position={[m.worldY, m.worldX]}
            icon={makeIcon(m, interactive, labelColor)}
            draggable={interactive}
            interactive={interactive}
            opacity={planOpacity}
            eventHandlers={
              interactive
                ? {
                    click: (e) => {
                      L.DomEvent.stopPropagation(e);
                      onMarkerClick(m.id);
                    },
                    dragend: (e) => {
                      const ll = (e.target as L.Marker).getLatLng();
                      onMarkerDrag(m.id, {
                        worldX: Math.round(ll.lng),
                        worldY: Math.round(ll.lat),
                      });
                    },
                  }
                : undefined
            }
          />
        );
      })}

      {/* Replay-mode shot tracers/explosions. Imperative: ReplayShotLayer
          owns a single LayerGroup and rebuilds its contents each frame from
          replayShots, so a layer can never outlive its props. The earlier
          per-shot react-leaflet rendering occasionally leaked Leaflet layers
          when the RAF loop unmounted polylines mid-redraw. */}
      <ReplayShotLayer shots={replayShots} />


      {/* Replay-mode vehicles. Drawn before chars so a person standing
          right next to a vehicle remains visible on top. Color reflects
          state (yellow=empty, grey=destroyed, faction-color=occupied);
          badge counts named-player occupants. Markers are interactive
          purely for hover tooltips — bubblingMouseEvents lets the click /
          drag flow through to the map so panning over a vehicle still
          works. */}
      {replayVehicles.map((v) => (
        <Marker
          key={`replay-veh-${v.vehicleId}`}
          position={[v.worldY, v.worldX]}
          icon={makeReplayVehicleIcon(v)}
          bubblingMouseEvents
        />
      ))}

      {/* Occupant-count badges live on a dedicated pane (z-index 610) above
          the default markerPane (600). Without this lift, Leaflet's per-
          marker lat-based z-ordering causes a southern vehicle's pentagon to
          paint over a northern vehicle's badge. Non-interactive so hover
          still hits the vehicle pentagon underneath. */}
      <Pane name="ts-replay-veh-badges" style={{ zIndex: 610 }}>
        {replayVehicles
          .filter((v) => v.playerBadge > 0)
          .map((v) => (
            <Marker
              key={`replay-veh-badge-${v.vehicleId}`}
              position={[v.worldY, v.worldX]}
              icon={makeReplayVehicleBadgeIcon(v)}
              interactive={false}
              bubblingMouseEvents
              pane="ts-replay-veh-badges"
            />
          ))}
      </Pane>

      {/* Replay-mode characters. Triangle orientation is the char's heading
          (yaw clockwise from north). Color is precomputed by the caller via
          teamColorFor. Hover surfaces the player's name regardless of the
          Names toggle so a viewer can probe identity without committing to
          full-time labels. */}
      {replayChars.map((c) => (
        <Marker
          key={`replay-${c.charId}`}
          position={[c.worldY, c.worldX]}
          icon={makeReplayIcon(c)}
          bubblingMouseEvents
        />
      ))}

      {selectedMarker && onDuplicateMarker && onDeleteMarker && (
        <MarkerActions
          key={selectedMarker.id}
          worldX={selectedMarker.worldX}
          worldY={selectedMarker.worldY}
          onDuplicate={onDuplicateMarker}
          onDelete={onDeleteMarker}
        />
      )}

      {selectedMarker && onRotateMarker && (
        <RotationHandle
          key={`rot-${selectedMarker.id}`}
          worldX={selectedMarker.worldX}
          worldY={selectedMarker.worldY}
          rotation={selectedMarker.rotation}
          onRotate={onRotateMarker}
        />
      )}
    </MapContainer>
  );
}
