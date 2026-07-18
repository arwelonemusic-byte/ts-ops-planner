"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClickPoint,
  RenderableMarker,
  RenderableLine,
  RenderablePolygon,
  ReplayCharRenderable,
  ReplayShotRenderable,
  ReplayVehicleRenderable,
} from "@/components/MapClient";
import {
  loadReplay,
  listRecentReplays,
  indexReplay,
  getStateAt,
  getVehicleStateAt,
  activeShotsAt,
  charsInVehiclesAt,
  resolveReplayMap,
  resolveReplayMapKey,
  resolveCharHex,
  resolveVehicleHex,
  namedPlayerOccupantNames,
  DAMAGE_INTERMEDIARY,
  DAMAGE_DESTROYED,
  type ReplayData,
  type ReplayIndex,
  type ReplaySummary,
} from "@/lib/replay";
import { MarkerIcon, MaskIcon } from "@/components/MarkerIcon";
import {
  ATLASES,
  ICONS,
  COLORS,
  DEFAULT_ICON,
  DEFAULT_COLOR,
  type IconEntry,
  type ColorEntry,
  type AtlasKey,
} from "@/lib/markerLibrary";
import {
  FACTIONS,
  MILITARY_TYPES,
  DEFAULT_FACTION,
  DEFAULT_MILITARY_TYPE,
  militaryIconUrl,
  militaryLabel,
  type Faction,
  type MilitaryType,
} from "@/lib/militaryLibrary";
import { MAPS, DEFAULT_MAP, findMap } from "@/lib/maps";
import { ImportDialog } from "@/components/ImportDialog";
import { HelpDialog } from "@/components/HelpDialog";
import {
  ImportCodeDialog,
  normalizePlan,
  type LoadedPlan,
} from "@/components/ImportCodeDialog";
import type { ImportResult, ImportedPolygon } from "@/lib/layerImport";
import { useT } from "@/components/LanguageProvider";
import { LOCALES, type Locale } from "@/lib/i18n";
import type { HeightmapSampler } from "@/lib/heightmap";
import { computeLineOfSight } from "@/lib/los";
import { computeRadialLos, type RadialLosResult } from "@/lib/radialLos";
import { MARKER_DEFAULT_TEXT } from "@/lib/markerDefaults";
import {
  resolveMarkerText,
  typeKeyForMarker,
  typeKeyForTemplate,
  type MarkerSnapshot,
} from "@/lib/markerText";
import LineOfSightPanel from "@/components/LineOfSightPanel";
import { ReplayEventLog } from "@/components/ReplayEventLog";

type PickerTab = "military" | "vanilla" | "ts" | "favorites";

/** `labelKey` is the i18n key; brand names ("TS Markers") use a literal. */
const TABS: { key: PickerTab; labelKey: string; icon?: "star" }[] = [
  { key: "military", labelKey: "tabs.military" },
  { key: "vanilla", labelKey: "tabs.vanilla" },
  { key: "ts", labelKey: "tabs.tsMarkers" },
  { key: "favorites", labelKey: "tabs.favorites", icon: "star" },
];

const MapClient = dynamic(() => import("@/components/MapClient"), {
  ssr: false,
  loading: () => <MapLoadingFallback />,
});

const MapClient3D = dynamic(() => import("@/components/MapClient3D"), {
  ssr: false,
  loading: () => <MapLoadingFallback />,
});

function MapLoadingFallback() {
  const { t } = useT();
  return (
    <div className="flex h-full w-full items-center justify-center bg-slate-900 text-slate-400">
      {t("map.loading")}
    </div>
  );
}

const STORAGE_KEY = "ts-ops-planner-markers-v1";
const STORAGE_KEY_LINES = "ts-ops-planner-lines-v1";
const STORAGE_KEY_MAP = "ts-ops-planner-map-v1";
const STORAGE_KEY_IMPORTED = "ts-ops-planner-imported-v1";
const STORAGE_KEY_POLYGONS = "ts-ops-planner-polygons-v1";
const STORAGE_KEY_LABEL_COLOR = "ts-ops-planner-label-color-v1";

/** Global text color for marker labels. Web-only — does not get pushed to the
 *  mod. Lets the user flip to white when the basemap is dark enough that black
 *  text disappears. */
type LabelColor = "black" | "white";
const DEFAULT_LABEL_COLOR: LabelColor = "black";

type Tool = "marker" | "line" | "ruler" | null;

const LINE_WIDTHS = [1, 2, 3, 4, 5] as const;
type LineWidth = (typeof LINE_WIDTHS)[number];
const DEFAULT_LINE_WIDTH: LineWidth = 3;
// Replay playback speed multipliers. Surfaced as a segmented selector
// (see SegmentedSpeed). 1x is the default; 4x covers "scrub through dead
// air"; 8x/16x are for "skim 90-min ops looking for engagement clusters".
const REPLAY_SPEEDS = [1, 4, 8, 16] as const;
// How far before an event-log entry's actual timestamp the playhead lands
// when the user clicks it. Gives the viewer a beat of context (where the
// player was, where they were facing) before the down / connect moment.
const EVENT_LOG_PREROLL_MS = 2000;
// Slider width (1-5) → world thickness in meters. Lines render at these
// metric widths and scale with zoom (see MapClient.metersToWeight).
const LINE_WIDTH_METERS: Record<LineWidth, number> = {
  1: 2,
  2: 4,
  3: 8,
  4: 12,
  5: 16,
};
// Fixed pixel preview used only in the width-picker UI (not the map).
function lineWidthPreviewPx(w: LineWidth): number {
  return 2 + (w - 1) * 2; // 2, 4, 6, 8, 10
}

type PlacedLine = {
  id: string;
  colorName: string;
  width: LineWidth;
  points: [number, number][]; // [[worldX, worldY], ...]
};

type BasePlaced = {
  id: string;
  worldX: number;
  worldY: number;
  text: string;
  rotation: number;
};

type CustomPlaced = BasePlaced & {
  kind: "custom";
  iconCategory: string;
  iconQuad: string;
  colorName: string;
};

type MilitaryPlaced = BasePlaced & {
  kind: "military";
  faction: Faction;
  type: MilitaryType;
};

type PlacedMarker = CustomPlaced | MilitaryPlaced;

function findIcon(category: string, quad: string): IconEntry {
  return (
    ICONS.find((i) => i.category === category && i.quad === quad) ??
    DEFAULT_ICON
  );
}

function findColor(name: string): ColorEntry {
  return COLORS.find((c) => c.name === name) ?? DEFAULT_COLOR;
}

// Most-used markers surfaced inline in the "Favorites" tab. Order defines the
// 3x4 grid reading left-to-right, top-to-bottom.
const FAVORITES: IconEntry[] = [
  findIcon("general", "dot"),
  findIcon("ts", "ts-desc"),
  findIcon("ts", "ts-bof"),
  findIcon("ts", "ts-abf"),
  findIcon("ts", "ts-aoa-right"),
  findIcon("ts", "ts-aoa-left"),
  findIcon("ts", "ts-aoa-straight"),
  findIcon("ts", "ts-trp"),
  findIcon("ts", "ts-fup"),
  findIcon("ts", "ts-mep"),
  findIcon("ts", "ts-wp"),
  findIcon("ts", "ts-cp"),
];

function isFavorite(i: IconEntry): boolean {
  return FAVORITES.some((f) => f.category === i.category && f.quad === i.quad);
}

// Legacy color names that existed in earlier palettes but are no longer in
// COLORS.  Map them to their closest modern swatch so localStorage from
// before this migration still hydrates without losing markers.
const LEGACY_COLOR_MIGRATIONS: Record<string, string> = {
  // Old Figma palette → current engine-aligned names
  MAGENTA: "PING",
  TEAL: "NAVY_BLUE",
  YELLOW: "ORANGE",
  // Old engine-enum-based names
  REFORGER_ORANGE: "ORANGE",
  OPFOR: "RED",
  BLUFOR: "BLUE",
  INDEPENDENT: "GREEN",
  CIVILIAN: "PURPLE",
  DARK_BLUE: "NAVY_BLUE",
  DARK_PINK: "DARK_BROWN",
};

function migrateColorName(raw: string): string {
  return LEGACY_COLOR_MIGRATIONS[raw] ?? raw;
}

// Increments the last numeric run in a marker label. Preserves leading zeros
// by padding to the original width when the incremented value still fits.
// Used when duplicating markers so TRP 100 -> TRP 101, TRP-09 -> TRP-10, etc.
// No numeric run -> returns the text unchanged.
function incrementTrailingNumber(text: string): string {
  const match = text.match(/^(.*?)(\d+)(\D*)$/);
  if (!match) return text;
  const [, prefix, numStr, suffix] = match;
  const next = (parseInt(numStr, 10) + 1).toString().padStart(numStr.length, "0");
  return prefix + next + suffix;
}

function snapshotFromMarker(m: PlacedMarker): MarkerSnapshot {
  if (m.kind === "custom") {
    return { id: m.id, text: m.text, kind: "custom", iconQuad: m.iconQuad };
  }
  return { id: m.id, text: m.text, kind: "military", type: m.type };
}

// Backwards-compat for v1 storage entries that lack `kind`.
function normalizeStored(raw: unknown): PlacedMarker[] {
  if (!Array.isArray(raw)) return [];
  const out: PlacedMarker[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const m = r as Record<string, unknown>;
    const base = {
      id: String(m.id ?? crypto.randomUUID()),
      worldX: Number(m.worldX ?? 0),
      worldY: Number(m.worldY ?? 0),
      text: String(m.text ?? ""),
      rotation: Number(m.rotation ?? 0),
    };
    if (m.kind === "military") {
      out.push({
        ...base,
        kind: "military",
        faction: (m.faction as Faction) ?? DEFAULT_FACTION,
        type: (m.type as MilitaryType) ?? DEFAULT_MILITARY_TYPE,
      });
    } else {
      out.push({
        ...base,
        kind: "custom",
        iconCategory: String(m.iconCategory ?? DEFAULT_ICON.category),
        iconQuad: String(m.iconQuad ?? DEFAULT_ICON.quad),
        colorName: migrateColorName(String(m.colorName ?? DEFAULT_COLOR.name)),
      });
    }
  }
  return out;
}

function normalizeStoredLines(raw: unknown): PlacedLine[] {
  if (!Array.isArray(raw)) return [];
  const out: PlacedLine[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const l = r as Record<string, unknown>;
    const pts = l.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    const points: [number, number][] = [];
    for (const p of pts) {
      if (!Array.isArray(p) || p.length !== 2) continue;
      points.push([Number(p[0]), Number(p[1])]);
    }
    if (points.length < 2) continue;
    const rawWidth = Number(l.width ?? DEFAULT_LINE_WIDTH);
    const width = (LINE_WIDTHS as readonly number[]).includes(rawWidth)
      ? (rawWidth as LineWidth)
      : DEFAULT_LINE_WIDTH;
    out.push({
      id: String(l.id ?? crypto.randomUUID()),
      colorName: String(l.colorName ?? DEFAULT_COLOR.name),
      width,
      points,
    });
  }
  return out;
}

export default function Page() {
  const { t, tp, locale, setLocale } = useT();
  const [markers, setMarkers] = useState<PlacedMarker[]>([]);
  const [importedMarkers, setImportedMarkers] = useState<PlacedMarker[]>([]);
  const [importedPolygons, setImportedPolygons] = useState<ImportedPolygon[]>([]);
  const [lines, setLines] = useState<PlacedLine[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // 3D viewport prototype toggle. Desktop-only — the toggle button is hidden
  // on mobile, so mobile sessions can never flip this true. Plan markers /
  // lines / overlays are not yet drawn in the 3D view; this is terrain only.
  const [view3D, setView3D] = useState(false);

  // Tool & line drafting state.
  const [tool, setTool] = useState<Tool>("marker");
  const [menuOpen, setMenuOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importCodeOpen, setImportCodeOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [menuPicker, setMenuPicker] = useState<
    null | "map" | "language" | "mode" | "labelColor"
  >(null);
  const [labelColor, setLabelColor] = useState<LabelColor>(DEFAULT_LABEL_COLOR);

  // Replay mode — additive UI sharing the same Leaflet map. See lib/replay.ts.
  const [mode, setMode] = useState<"plan" | "replay">("plan");
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [replayCodeInput, setReplayCodeInput] = useState("");
  const [replayLoading, setReplayLoading] = useState(false);
  // Recent replays list for the empty-state dropdown. Fetched once when the
  // user enters replay mode without a loaded replay (and refetched when they
  // unload one) so the list reflects newly-recorded sessions without a hard
  // refresh.
  const [recentReplays, setRecentReplays] = useState<ReplaySummary[] | null>(null);
  const [recentReplaysError, setRecentReplaysError] = useState(false);
  // Progress tuple: (eventsLoaded, eventsTotal). Both null when not loading.
  // Set incrementally as chunks arrive; consumed by the load-state UI.
  const [replayLoadProgress, setReplayLoadProgress] = useState<
    { loaded: number; total: number } | null
  >(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackPlaying, setPlaybackPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showNames, setShowNames] = useState(true);
  const [showPlan, setShowPlan] = useState(false);
  // Plan-overlay opacity in replay mode. Stored as 0-1 for direct passthrough
  // to MapClient; UI slider exposes 20-100 (percent). Default fully opaque so
  // toggling Show plan on first time matches plan-mode rendering exactly.
  const [planOpacity, setPlanOpacity] = useState(1);
  // Plan code surfaced next to the Plan toggle in replay mode. Initialized
  // from `replay.meta.planCode` when present (mod-stamped — see
  // ARCHITECTURE.md and the deferred mod-side hook), otherwise empty so the
  // user can paste a plan code as a fallback. Committed on Enter/blur via
  // handleLoadReplayPlanCode below.
  const [replayPlanCodeInput, setReplayPlanCodeInput] = useState("");
  const [replayPlanCodeError, setReplayPlanCodeError] = useState<string | null>(null);
  // Event log expand/collapse lives at this level so the sidebar layout
  // can grow the log's wrapper to fill the remaining viewport height only
  // when it's expanded (otherwise the collapsed header would leave a
  // tall transparent gap below it).
  const [eventLogExpanded, setEventLogExpanded] = useState(false);
  // Imperative pan-and-zoom target for the map. Bumped whenever an event-
  // log entry is clicked so MapClient flies the camera to the player's
  // last-known position. Null when no focus pending.
  const [mapFocus, setMapFocus] = useState<{
    worldX: number;
    worldY: number;
    zoom: number;
    key: number;
  } | null>(null);
  // When set, overrides the auto-detected map for the loaded replay. Lets the
  // user manually pick a map when terrain detection fails (e.g. modded worlds
  // with non-standard folder structures). Cleared when a new replay loads.
  const [replayMapOverride, setReplayMapOverride] = useState<string | null>(null);
  const [pushedModalOpen, setPushedModalOpen] = useState(false);
  // Mobile: lets the user collapse the bottom tool sheet for a full-screen map
  // while keeping the active tool selected. Reset whenever tool changes.
  const [mobileSheetHidden, setMobileSheetHidden] = useState(false);
  const [mapKey, setMapKey] = useState<string>(DEFAULT_MAP.key);
  const mapConfig = findMap(mapKey);
  const [tLineColor, setTLineColor] = useState<ColorEntry>(DEFAULT_COLOR);
  const [tLineWidth, setTLineWidth] = useState<LineWidth>(DEFAULT_LINE_WIDTH);
  const [draftPoints, setDraftPoints] = useState<[number, number][]>([]);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [rulerStart, setRulerStart] = useState<[number, number] | null>(null);
  const [rulerEnd, setRulerEnd] = useState<[number, number] | null>(null);
  const [losSampler, setLosSampler] = useState<HeightmapSampler | null>(null);
  const [rulerMode, setRulerMode] = useState<"line" | "radial">("line");
  const [radial, setRadial] = useState<RadialLosResult | null>(null);
  // When a line draft was started via Ctrl+click from another tool, remember
  // which tool to restore once the draft commits or cancels. null means the
  // user is in the Line tool normally.
  const [quickLineFromTool, setQuickLineFromTool] = useState<Tool | null>(null);
  // Tracks when a layer (marker/line) click just fired, so the follow-up map
  // click (which Leaflet dispatches because paths bubble by default) can be
  // suppressed regardless of bubblingMouseEvents behavior.
  const layerClickAtRef = useRef(0);

  // Template state — used when no marker is selected.
  const [tIcon, setTIcon] = useState<IconEntry>(DEFAULT_ICON);
  const [tColor, setTColor] = useState<ColorEntry>(DEFAULT_COLOR);
  const [tText, setTText] = useState<string>("");
  const [tRotation, setTRotation] = useState<number>(0);
  const [tFaction, setTFaction] = useState<Faction>(DEFAULT_FACTION);
  const [tMilType, setTMilType] = useState<MilitaryType>(DEFAULT_MILITARY_TYPE);

  const [tab, setTab] = useState<PickerTab>(DEFAULT_ICON.atlas);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedCode, setSavedCode] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Hydrate from localStorage once on mount.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setMarkers(normalizeStored(JSON.parse(stored)));
      }
      const storedLines = localStorage.getItem(STORAGE_KEY_LINES);
      if (storedLines) {
        setLines(normalizeStoredLines(JSON.parse(storedLines)));
      }
      const storedImported = localStorage.getItem(STORAGE_KEY_IMPORTED);
      if (storedImported) {
        setImportedMarkers(normalizeStored(JSON.parse(storedImported)));
      }
      const storedPolys = localStorage.getItem(STORAGE_KEY_POLYGONS);
      if (storedPolys) {
        try {
          const parsed = JSON.parse(storedPolys);
          if (Array.isArray(parsed)) setImportedPolygons(parsed);
        } catch {
          // ignore
        }
      }
      const storedMap = localStorage.getItem(STORAGE_KEY_MAP);
      if (storedMap) {
        setMapKey(findMap(storedMap).key);
      }
      const storedLabelColor = localStorage.getItem(STORAGE_KEY_LABEL_COLOR);
      if (storedLabelColor === "black" || storedLabelColor === "white") {
        setLabelColor(storedLabelColor);
      }
    } catch {
      // ignore
    }
    setHydrated(true);
  }, []);

  // Persist on every change after hydration.
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(markers));
    } catch {
      // ignore
    }
  }, [markers, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY_LINES, JSON.stringify(lines));
    } catch {
      // ignore
    }
  }, [lines, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_KEY_IMPORTED,
        JSON.stringify(importedMarkers),
      );
    } catch {
      // ignore
    }
  }, [importedMarkers, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_KEY_POLYGONS,
        JSON.stringify(importedPolygons),
      );
    } catch {
      // ignore
    }
  }, [importedPolygons, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY_MAP, mapKey);
    } catch {
      // ignore
    }
  }, [mapKey, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY_LABEL_COLOR, labelColor);
    } catch {
      // ignore
    }
  }, [labelColor, hydrated]);

  // Keyboard shortcuts:
  //   Q / W / E — switch to Marker / Line / Ruler tool
  //   Escape — cancel in-progress line draft or ruler
  //   Delete / Backspace — delete the currently selected marker or line
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't interfere with text input / textarea / contentEditable.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable;
      if (isEditable) return;

      // Ctrl/Meta held alone: preemptively switch to the Line tool so
      // markers and lines stop intercepting clicks. If the user releases
      // Ctrl before clicking, onKeyUp reverts.
      if (e.key === "Control" || e.key === "Meta") {
        if (
          tool !== "line" &&
          !selectedId &&
          !selectedLineId &&
          draftPoints.length === 0 &&
          quickLineFromTool === null
        ) {
          setQuickLineFromTool(tool);
          setTool("line");
        }
        return;
      }

      const key = e.key.toLowerCase();
      // Plan-mode tool shortcuts. Numeric so they don't collide with letter
      // keys used elsewhere (and they read as a left-to-right tool order).
      // Replay mode has no tools, so all three branches are gated.
      if (key === "1") {
        if (mode === "plan") switchTool("marker");
      } else if (key === "2") {
        if (mode === "plan") switchTool("line");
      } else if (key === "3") {
        if (mode === "plan") switchTool("ruler");
      } else if (e.key === "Escape" && draftPoints.length > 0) {
        setDraftPoints([]);
        if (quickLineFromTool !== null) {
          setTool(quickLineFromTool);
          setQuickLineFromTool(null);
        }
      } else if (e.key === "Escape" && (rulerStart || rulerEnd)) {
        setRulerStart(null);
        setRulerEnd(null);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId || selectedLineId) {
          e.preventDefault();
          deleteSelected();
        }
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      // Ctrl released without a click → revert the preemptive tool switch.
      // If a click already seeded the draft, keep Line mode until the draft
      // resolves (commit / Escape / right-click).
      if (e.key !== "Control" && e.key !== "Meta") return;
      if (quickLineFromTool !== null && draftPoints.length === 0) {
        setTool(quickLineFromTool);
        setQuickLineFromTool(null);
      }
    }
    function onBlur() {
      // Window lost focus with Ctrl potentially still "held" — the keyup
      // won't arrive. Revert if we're still in the preemptive-only phase.
      if (quickLineFromTool !== null && draftPoints.length === 0) {
        setTool(quickLineFromTool);
        setQuickLineFromTool(null);
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftPoints.length, selectedId, selectedLineId, rulerStart, rulerEnd, tool, quickLineFromTool, mode]);

  const selected = selectedId
    ? (markers.find((m) => m.id === selectedId) ?? null)
    : null;
  const selectedLine = selectedLineId
    ? (lines.find((l) => l.id === selectedLineId) ?? null)
    : null;

  // Color/width shown in the line panel — selected line's values if editing,
  // otherwise the template values for the next line to be drawn.
  const lineColor: ColorEntry = selectedLine
    ? findColor(selectedLine.colorName)
    : tLineColor;
  const lineWidth: LineWidth = selectedLine ? selectedLine.width : tLineWidth;

  const icon: IconEntry =
    selected && selected.kind === "custom"
      ? findIcon(selected.iconCategory, selected.iconQuad)
      : tIcon;
  const color: ColorEntry =
    selected && selected.kind === "custom"
      ? findColor(selected.colorName)
      : tColor;
  const faction: Faction =
    selected && selected.kind === "military" ? selected.faction : tFaction;
  const milType: MilitaryType =
    selected && selected.kind === "military" ? selected.type : tMilType;
  const text: string = selected ? selected.text : tText;
  const rotation: number = selected ? selected.rotation : tRotation;

  // Keep tab in sync with the current selection / template kind.
  useEffect(() => {
    if (!selected) return; // no selection: leave tab alone
    let target: PickerTab;
    if (selected.kind === "military") {
      target = "military";
    } else {
      const ic = findIcon(selected.iconCategory, selected.iconQuad);
      // Preserve favorites tab if the selected marker is a favorite.
      target = tab === "favorites" && isFavorite(ic) ? "favorites" : ic.atlas;
    }
    if (target !== tab) setTab(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function handleTabClick(next: PickerTab) {
    if (next === tab) return;
    // If a marker is selected and we're changing to a kind it isn't, deselect
    // so the tab selection targets the template rather than mutating the kind.
    if (selected) {
      const selIcon =
        selected.kind === "custom"
          ? findIcon(selected.iconCategory, selected.iconQuad)
          : null;
      const currentTabForSelected: PickerTab =
        selected.kind === "military" ? "military" : selIcon!.atlas;
      // Favorites is a cross-atlas view: keep the selection if the selected
      // marker is itself a favorite.
      const keepForFavorites =
        next === "favorites" && selIcon !== null && isFavorite(selIcon);
      if (next !== currentTabForSelected && !keepForFavorites) {
        setSelectedId(null);
      }
    }
    setTab(next);
    if (next === "military") {
      // Military has no per-icon defaults; clear the text template.
      setTText("");
      return;
    }
    // Determine the resulting template icon after the tab change.
    let nextIcon: IconEntry = tIcon;
    if (next === "favorites") {
      if (!isFavorite(tIcon)) nextIcon = FAVORITES[0];
    } else if (tIcon.atlas !== next) {
      const first = ICONS.find((i) => i.atlas === next);
      if (first) nextIcon = first;
    }
    if (nextIcon !== tIcon) setTIcon(nextIcon);
    // Apply that icon's default (or empty) so text matches the new context.
    setTText(MARKER_DEFAULT_TEXT[nextIcon.quad] ?? "");
  }

  function updateSelected(patch: Partial<PlacedMarker>) {
    if (!selectedId) return;
    setMarkers((ms) =>
      ms.map((m) =>
        m.id === selectedId ? ({ ...m, ...patch } as PlacedMarker) : m,
      ),
    );
  }

  function setIcon(i: IconEntry) {
    // Always swap the Text field to the new icon's default; icons without a
    // default (e.g. DESC) clear the field.
    const newText = MARKER_DEFAULT_TEXT[i.quad] ?? "";
    if (selected && selected.kind === "custom") {
      updateSelected({ iconCategory: i.category, iconQuad: i.quad, text: newText });
    } else {
      setTIcon(i);
      setTText(newText);
    }
    setSavedCode(null);
  }
  function setColor(c: ColorEntry) {
    if (selected && selected.kind === "custom") {
      updateSelected({ colorName: c.name });
    } else {
      setTColor(c);
    }
    setSavedCode(null);
  }
  function setFaction(f: Faction) {
    if (selected && selected.kind === "military") {
      updateSelected({ faction: f });
    } else {
      setTFaction(f);
    }
    setSavedCode(null);
  }
  function setMilType(t: MilitaryType) {
    if (selected && selected.kind === "military") {
      updateSelected({ type: t, text: "" });
    } else {
      setTMilType(t);
      setTText("");
    }
    setSavedCode(null);
  }
  function setText(t: string) {
    if (selectedId) updateSelected({ text: t });
    else setTText(t);
    setSavedCode(null);
  }
  // Template substitution when editing an existing marker. Fires on blur so
  // typing `#` or `$` doesn't expand mid-keystroke. New-marker placement
  // substitutes inside handleMapClick.
  function handleTextBlur() {
    if (!selected) return;
    const current = selected.text;
    if (!/[#$%]/.test(current)) return;
    const snapshots: MarkerSnapshot[] = [...markers, ...importedMarkers].map(
      snapshotFromMarker,
    );
    const iconQuad =
      selected.kind === "custom" ? selected.iconQuad : undefined;
    const resolved = resolveMarkerText(
      current,
      typeKeyForMarker(snapshotFromMarker(selected)),
      iconQuad,
      snapshots,
      selected.id,
    );
    if (resolved !== current) updateSelected({ text: resolved });
  }
  function setRotation(r: number) {
    const norm = ((Math.round(r) % 360) + 360) % 360;
    if (selectedId) updateSelected({ rotation: norm });
    else setTRotation(norm);
    setSavedCode(null);
  }

  function handleMapClick(p: ClickPoint) {
    // Ignore map clicks that are actually bubbled from a layer (marker/line).
    if (Date.now() - layerClickAtRef.current < 50) return;
    // Replay mode is read-only on the planning side — only the ruler tool gets
    // through. Marker placement and line drafting are blocked.
    if (mode === "replay" && tool !== "ruler") return;
    // Clicking empty map while something is selected deselects; no placement.
    if (selectedId || selectedLineId) {
      setSelectedId(null);
      setSelectedLineId(null);
      return;
    }
    if (tool === "line") {
      // Add a vertex to the in-progress draft line.
      setDraftPoints((pts) => [...pts, [p.worldX, p.worldY]]);
      setSavedCode(null);
      return;
    }
    if (tool === "ruler") {
      // Click cycle: start → end → clear → start (next). Clearing a
      // completed measurement takes its own click so the value stays
      // readable until you explicitly dismiss it.
      if (rulerStart && rulerEnd) {
        setRulerStart(null);
        setRulerEnd(null);
      } else if (rulerStart) {
        setRulerEnd([p.worldX, p.worldY]);
      } else {
        setRulerStart([p.worldX, p.worldY]);
        setRulerEnd(null);
      }
      return;
    }
    // Placement only happens with the marker tool explicitly active.
    if (tool !== "marker") return;
    const typeKey =
      tab === "military"
        ? typeKeyForTemplate({ kind: "military", type: tMilType })
        : typeKeyForTemplate({ kind: "custom", iconQuad: tIcon.quad });
    const iconQuadForCounter = tab === "military" ? undefined : tIcon.quad;
    const snapshots: MarkerSnapshot[] = [...markers, ...importedMarkers].map(
      snapshotFromMarker,
    );
    const resolvedText = resolveMarkerText(
      tText,
      typeKey,
      iconQuadForCounter,
      snapshots,
    );
    const base = {
      id: crypto.randomUUID(),
      worldX: p.worldX,
      worldY: p.worldY,
      text: resolvedText,
      rotation: tab === "military" ? 0 : tRotation,
    };
    const newMarker: PlacedMarker =
      tab === "military"
        ? { ...base, kind: "military", faction: tFaction, type: tMilType }
        : {
            ...base,
            kind: "custom",
            iconCategory: tIcon.category,
            iconQuad: tIcon.quad,
            colorName: tColor.name,
          };
    setMarkers((ms) => [...ms, newMarker]);
    setSelectedId(null);
    setSelectedLineId(null);
    setSavedCode(null);
  }

  function handleMapContextMenu() {
    // Right-click mirrors Escape for in-progress gestures: cancel the ruler or
    // discard the current line draft. Does nothing when neither is active so
    // right-click remains a no-op for other tools.
    if (tool === "ruler" && (rulerStart || rulerEnd)) {
      setRulerStart(null);
      setRulerEnd(null);
      return;
    }
    if (tool === "line" && draftPoints.length > 0) {
      setDraftPoints([]);
      if (quickLineFromTool !== null) {
        setTool(quickLineFromTool);
        setQuickLineFromTool(null);
      }
    }
  }

  function handleMapDoubleClick() {
    // Double-click commits the current draft line if it has >= 2 points.
    if (tool !== "line") return;
    if (draftPoints.length < 2) {
      setDraftPoints([]);
      if (quickLineFromTool !== null) {
        setTool(quickLineFromTool);
        setQuickLineFromTool(null);
      }
      return;
    }
    const newLine: PlacedLine = {
      id: crypto.randomUUID(),
      colorName: tLineColor.name,
      width: tLineWidth,
      points: draftPoints,
    };
    setLines((ls) => [...ls, newLine]);
    setDraftPoints([]);
    setSavedCode(null);
    if (quickLineFromTool !== null) {
      setTool(quickLineFromTool);
      setQuickLineFromTool(null);
    }
  }

  function handleMapMouseMove(p: ClickPoint) {
    const needsCursor =
      (tool === "line" && draftPoints.length > 0) ||
      (tool === "ruler" && rulerStart !== null && rulerEnd === null);
    if (needsCursor) {
      setCursor([p.worldX, p.worldY]);
    } else if (cursor) {
      setCursor(null);
    }
  }

  function handleMarkerClick(id: string) {
    layerClickAtRef.current = Date.now();
    setSelectedId((prev) => (prev === id ? null : id));
    setSelectedLineId(null);
    setDraftPoints([]);
  }

  function handleMarkerDrag(id: string, p: ClickPoint) {
    setMarkers((ms) =>
      ms.map((m) =>
        m.id === id ? { ...m, worldX: p.worldX, worldY: p.worldY } : m,
      ),
    );
    setSelectedId(id);
    setSelectedLineId(null);
    setSavedCode(null);
  }

  function handleLineClick(id: string) {
    layerClickAtRef.current = Date.now();
    setSelectedLineId((prev) => (prev === id ? null : id));
    setSelectedId(null);
    setDraftPoints([]);
  }

  function duplicateSelected() {
    if (!selected) return;
    // Offset the copy 50m NE so both markers are immediately visible. Matches
    // typical duplicate UX where the new item is near the original and becomes
    // the new selection.
    const offset = 50;
    const id = crypto.randomUUID();
    const newMarker: PlacedMarker = {
      ...selected,
      id,
      worldX: selected.worldX + offset,
      worldY: selected.worldY + offset,
      text: incrementTrailingNumber(selected.text),
    };
    setMarkers((ms) => [...ms, newMarker]);
    setSelectedId(id);
    setSelectedLineId(null);
    setSavedCode(null);
  }

  function deleteSelected() {
    if (selectedLineId) {
      setLines((ls) => ls.filter((l) => l.id !== selectedLineId));
      setSelectedLineId(null);
      setSavedCode(null);
      return;
    }
    if (!selectedId) return;
    setMarkers((ms) => ms.filter((m) => m.id !== selectedId));
    setSelectedId(null);
    setSavedCode(null);
  }

  function updateSelectedLine(patch: Partial<PlacedLine>) {
    if (!selectedLineId) return;
    setLines((ls) =>
      ls.map((l) => (l.id === selectedLineId ? { ...l, ...patch } : l)),
    );
  }

  function setLineColor(c: ColorEntry) {
    if (selectedLine) updateSelectedLine({ colorName: c.name });
    else setTLineColor(c);
    setSavedCode(null);
  }

  function setLineWidth(w: LineWidth) {
    if (selectedLine) updateSelectedLine({ width: w });
    else setTLineWidth(w);
    setSavedCode(null);
  }

  function switchTool(next: Tool) {
    if (next === tool) return;
    setTool(next);
    setSelectedId(null);
    setSelectedLineId(null);
    setDraftPoints([]);
    setCursor(null);
    setRulerStart(null);
    setRulerEnd(null);
    setQuickLineFromTool(null);
    setMobileSheetHidden(false);
  }

  function clearAll() {
    const total =
      markers.length + lines.length + importedMarkers.length + importedPolygons.length;
    if (total === 0) return;
    const impBits: string[] = [];
    if (importedMarkers.length)
      impBits.push(
        t("confirm.imported.markers", {
          n: importedMarkers.length,
          w: tp("count.marker", importedMarkers.length),
        }),
      );
    if (importedPolygons.length)
      impBits.push(
        t("confirm.imported.polygons", {
          n: importedPolygons.length,
          w: tp("count.polygon", importedPolygons.length),
        }),
      );
    const imp = impBits.length ? `, ${impBits.join(", ")}` : "";
    if (
      !confirm(
        t("confirm.clearAll", {
          markers: `${markers.length} ${tp("count.marker", markers.length)}`,
          lines: `${lines.length} ${tp("count.line", lines.length)}`,
          imp,
        }),
      )
    )
      return;
    setMarkers([]);
    setLines([]);
    setImportedMarkers([]);
    setImportedPolygons([]);
    setSelectedId(null);
    setSelectedLineId(null);
    setDraftPoints([]);
    setSavedCode(null);
  }

  function handleImport(result: ImportResult, importMapKey: string) {
    // Switch maps first if the commander picked a different one. Also clear
    // any current selection/draft that belongs to the outgoing map.
    if (importMapKey && importMapKey !== mapKey) {
      setMapKey(findMap(importMapKey).key);
      setSelectedId(null);
      setSelectedLineId(null);
      setDraftPoints([]);
    }
    // Replace both imported buckets — each import supersedes the prior set.
    setImportedMarkers(result.markers);
    setImportedPolygons(result.polygons);
    setSavedCode(null);
  }

  function handleLoadPlan(plan: LoadedPlan) {
    // Replace placed markers + lines with the loaded plan. Imported .layer
    // content (initial markers, polygons) is a separate channel and stays put.
    const newMarkers: PlacedMarker[] = plan.markers.map((m) => {
      if (m.kind === "military") {
        return {
          id: crypto.randomUUID(),
          kind: "military",
          worldX: m.worldX,
          worldY: m.worldY,
          text: m.text,
          rotation: m.rotation,
          faction: m.faction,
          type: m.type,
        };
      }
      return {
        id: crypto.randomUUID(),
        kind: "custom",
        worldX: m.worldX,
        worldY: m.worldY,
        text: m.text,
        rotation: m.rotation,
        iconCategory: m.iconCategory,
        iconQuad: m.iconQuad,
        colorName: m.colorName,
      };
    });
    const newLines: PlacedLine[] = plan.lines.map((l) => ({
      id: crypto.randomUUID(),
      colorName: l.colorName,
      width: l.widthIndex as LineWidth,
      points: l.points,
    }));
    setMarkers(newMarkers);
    setLines(newLines);
    setSelectedId(null);
    setSelectedLineId(null);
    setDraftPoints([]);
    setSavedCode(plan.code);
    setSaveError(null);
  }

  async function save() {
    setSaving(true);
    setSavedCode(null);
    setSaveError(null);
    try {
      const body = {
        schemaVersion: 1,
        // No `code` field: server mints a fresh unique 6-char code per push.
        // Commander hands that code to the admin for `/syncplan <code>`.
        markers: markers.map((m) => {
          if (m.kind === "military") {
            return {
              kind: "military",
              worldX: m.worldX,
              worldY: m.worldY,
              dimension: "land",
              faction: m.faction,
              type: m.type,
              text: m.text.trim(),
              rotation: m.rotation,
            };
          }
          return {
            kind: "custom",
            worldX: m.worldX,
            worldY: m.worldY,
            iconCategory: m.iconCategory,
            iconQuad: m.iconQuad,
            color: findColor(m.colorName).engine,
            text: m.text.trim(),
            rotation: m.rotation,
          };
        }),
        lines: lines.map((l) => ({
          // sRGB hex ("#rrggbb") — mod parses directly to ARGB without a palette table.
          colorHex: findColor(l.colorName).hex,
          // World meters — mod uses this verbatim; no slider-index mapping needed mod-side.
          widthM: LINE_WIDTH_METERS[l.width],
          // Flat [x0, y0, x1, y1, ...] — maps to ref array<float> in Enfusion's JsonApiStruct.
          points: l.points.flat(),
        })),
      };
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { code: string };
      setSavedCode(data.code);
      setPushedModalOpen(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // Build renderable markers for the map. Placed markers are interactive;
  // imported markers render with readOnly=true so MapClient skips selection,
  // drag, and event handlers for them.
  function toRenderable(m: PlacedMarker, readOnly: boolean): RenderableMarker {
    const base = {
      id: m.id,
      worldX: m.worldX,
      worldY: m.worldY,
      rotation: m.rotation,
      selected: !readOnly && m.id === selectedId,
      readOnly,
    };
    if (m.kind === "military") {
      return {
        ...base,
        kind: "military",
        iconUrl: militaryIconUrl(m.faction, m.type),
        label: m.text.trim(),
      };
    }
    const ic = findIcon(m.iconCategory, m.iconQuad);
    const co = findColor(m.colorName);
    return {
      ...base,
      kind: "custom",
      icon: ic,
      color: co.hex,
      label: m.text.trim(),
    };
  }

  // Imported first so placed markers render on top when positions collide.
  // In replay mode the plan overlay (when toggled on) must be non-interactive,
  // so placed markers are forced read-only — defense in depth alongside the
  // markersInteractive prop gate below.
  const planReadOnly = mode === "replay";
  const renderable: RenderableMarker[] = [
    ...importedMarkers.map((m) => toRenderable(m, true)),
    ...markers.map((m) => toRenderable(m, planReadOnly)),
  ];

  const renderablePolygons: RenderablePolygon[] = importedPolygons.map((p) => ({
    id: p.id,
    points: p.points,
    fillColor: p.fillColor,
    fillOpacity: p.fillOpacity,
    strokeColor: p.strokeColor,
    strokeOpacity: p.strokeOpacity,
    strokeWidth: p.strokeWidth,
    fillOutside: p.fillOutside,
  }));

  // Renderable lines for the map: append in-progress draft rubber-band if drafting.
  const renderableLines: RenderableLine[] = lines.map((l) => ({
    id: l.id,
    color: findColor(l.colorName).hex,
    widthMeters: LINE_WIDTH_METERS[l.width],
    points: l.points,
    selected: l.id === selectedLineId,
  }));
  const draftRender =
    tool === "line" && draftPoints.length > 0
      ? {
          color: tLineColor.hex,
          widthMeters: LINE_WIDTH_METERS[tLineWidth],
          points:
            cursor && draftPoints.length > 0
              ? ([...draftPoints, cursor] as [number, number][])
              : draftPoints,
        }
      : null;

  // Ruler render: live preview uses cursor while end is unset (desktop's
  // mousemove); on mobile `cursor` stays null between taps, so `end` may be
  // null until the second click. MapClient still shows a start-dot anchor in
  // that case.
  const rulerLiveEnd = rulerEnd ?? cursor;
  const rulerRender =
    tool === "ruler" && rulerStart
      ? {
          start: rulerStart,
          end: rulerLiveEnd,
          pending: rulerEnd === null,
        }
      : null;

  const losResult = useMemo(() => {
    if (tool !== "ruler" || rulerMode !== "line") return null;
    if (!rulerStart || !rulerLiveEnd || !losSampler) return null;
    const dx = rulerLiveEnd[0] - rulerStart[0];
    const dy = rulerLiveEnd[1] - rulerStart[1];
    if (Math.hypot(dx, dy) < 1) return null;
    return computeLineOfSight(losSampler, rulerStart, rulerLiveEnd);
  }, [tool, rulerMode, rulerStart, rulerLiveEnd, losSampler]);

  // Radial mask: computed only on commit (both endpoints locked). During the
  // preview phase we show only the outline circle — the compute is too heavy
  // to run on every mousemove and the mask would flicker anyway.
  useEffect(() => {
    if (
      tool !== "ruler" ||
      rulerMode !== "radial" ||
      !rulerStart ||
      !rulerEnd ||
      !losSampler
    ) {
      setRadial(null);
      return;
    }
    const dx = rulerEnd[0] - rulerStart[0];
    const dy = rulerEnd[1] - rulerStart[1];
    const radiusM = Math.hypot(dx, dy);
    if (radiusM < 1) {
      setRadial(null);
      return;
    }
    // Defer to next frame so React can paint the committed circle outline
    // before we block the main thread on the ~50-150ms compute.
    const handle = requestAnimationFrame(() => {
      setRadial(computeRadialLos(losSampler, rulerStart, radiusM));
    });
    return () => cancelAnimationFrame(handle);
  }, [tool, rulerMode, rulerStart, rulerEnd, losSampler]);

  function setRulerModeAndReset(next: "line" | "radial") {
    if (next === rulerMode) return;
    setRulerMode(next);
    setRulerStart(null);
    setRulerEnd(null);
    setRadial(null);
  }

  // Replay index — built once per loaded replay, queried at every RAF tick.
  const replayIdx: ReplayIndex | null = useMemo(
    () => (replay ? indexReplay(replay) : null),
    [replay],
  );

  // Effective map config in replay mode:
  //   1. manual override (set via the dropdown), if any — works even before
  //      a replay is loaded so the user can pre-select the terrain
  //   2. auto-detected from replay.meta.terrainResource, if a replay is loaded
  //   3. fall through to plan-mode mapConfig (preserves whatever map the
  //      user had open before switching to replay mode)
  // Plan mode just uses mapConfig — replay state is ignored.
  const effectiveMapConfig = useMemo(() => {
    if (mode === "replay") {
      if (replayMapOverride) return findMap(replayMapOverride);
      if (replay) return resolveReplayMap(replay);
      return mapConfig;
    }
    return mapConfig;
  }, [mode, replay, replayMapOverride, mapConfig]);

  // Auto-detected map key for the loaded replay (null = couldn't resolve).
  // Used to display "auto-detected" vs "manual" in the replay panel.
  const replayAutoMapKey = useMemo(
    () => (replay ? resolveReplayMapKey(replay) : null),
    [replay],
  );

  // RAF playback loop. Drives playbackTime forward at `playbackSpeed × wallclock`.
  // The updater stays pure (just advance + clamp) — pausing at end-of-session
  // lives in a separate effect below. Cross-setter side effects inside a
  // useState updater are an anti-pattern: React 19 strict-mode runs updaters
  // twice to surface impurity, which manifested as "Maximum update depth
  // exceeded" when scrubbing near the end of the timeline.
  useEffect(() => {
    if (mode !== "replay") return;
    if (!playbackPlaying) return;
    if (!replayIdx) return;
    let raf = 0;
    let lastWall = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = now - lastWall;
      lastWall = now;
      setPlaybackTime((t) =>
        Math.min(replayIdx.durationMs, t + dt * playbackSpeed),
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, playbackPlaying, playbackSpeed, replayIdx]);

  // Auto-pause when playback reaches the end of the session. Runs whenever
  // playbackTime crosses durationMs — both from the RAF tick clamping and
  // from a manual scrub to the end. One-shot per crossing because the
  // setter only fires while playbackPlaying is still true.
  useEffect(() => {
    if (!playbackPlaying || !replayIdx) return;
    if (playbackTime >= replayIdx.durationMs) {
      setPlaybackPlaying(false);
    }
  }, [playbackPlaying, replayIdx, playbackTime]);

  // Reset playback when a new replay loads. Override clearing is conditional:
  // only clear if auto-detection succeeded, so a user's pre-load map pick
  // survives loading a modded-world replay where the registry can't resolve
  // the map. If auto succeeds it wins (override clears, panel shows "auto").
  useEffect(() => {
    if (replay) {
      setPlaybackTime(0);
      setPlaybackPlaying(false);
      const autoKey = resolveReplayMapKey(replay);
      if (autoKey) setReplayMapOverride(null);
      // Pre-fill the plan-overlay code input with the mod-stamped plan code
      // when present (forward-compat — see ReplayMeta.planCode docs). Falls
      // back to empty so the user can paste a code manually on legacy
      // replays / sessions where /syncplan never ran.
      const stampedCode = replay.meta?.planCode ?? "";
      setReplayPlanCodeInput(stampedCode);
      setReplayPlanCodeError(null);
      // Auto-load the stamped plan so toggling "Plan" on immediately shows
      // the commander's pushed plan without a manual paste. Today the mod
      // doesn't yet stamp planCode so this branch is a no-op; the input
      // path remains the only way to load a plan in the replay panel.
      if (stampedCode) void handleLoadReplayPlanCode(stampedCode);
    }
    // handleLoadReplayPlanCode is referentially stable enough; including
    // it would force every render to retrigger the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay]);

  // Renderable replay-char triangles at the current playback time.
  // playbackTime is display time (0..durationMs); shift by firstT to query the
  // index, which stores raw mod-side timestamps.
  const replayChars: ReplayCharRenderable[] = useMemo(() => {
    if (mode !== "replay" || !replayIdx) return [];
    const queryT = playbackTime + replayIdx.firstT;
    const states = getStateAt(replayIdx, queryT);
    const friendlyKey = replayIdx.data.meta.friendlyFactionKey;
    // Suppress chars currently inside any vehicle — their triangle would
    // pile up on the vehicle's marker (engine reports their origin as the
    // vehicle's). The vehicle marker carries a player-count badge instead.
    const inVehicle = charsInVehiclesAt(replayIdx, queryT);
    return states
      .filter((s) => !inVehicle.has(s.charId))
      .map((s) => {
        // Grey on either incap (INTERMEDIARY) or dead (DESTROYED) — both
        // are "out of action" from the playback POV. The event log
        // separately distinguishes "down" vs "killed" via the same state
        // values; this branch is purely about marker color.
        const isDestroyed = s.damageState >= DAMAGE_INTERMEDIARY;
        const color = resolveCharHex(s.charId, replayIdx, friendlyKey, isDestroyed);
        // Skull replaces the triangle for dead players only — incap players
        // and dead AI keep the grey triangle (the latter would flood the
        // map with skulls during long ops).
        const isDeadPlayer =
          s.isPlayerControlled && s.damageState >= DAMAGE_DESTROYED;
        return {
          charId: s.charId,
          worldX: s.x,
          worldY: s.z, // engine z is horizontal, maps to worldY in our schema
          yaw: s.yaw,
          color,
          label: showNames ? s.playerName : null,
          // Hover label only fires when the permanent label is off —
          // otherwise the hover would duplicate the always-visible name.
          // Lets a viewer probe identity on demand without committing to
          // the full-time overlay.
          hoverLabel: showNames ? null : s.playerName,
          opacity: s.opacity,
          isDeadPlayer,
        };
      });
  }, [mode, replayIdx, playbackTime, showNames]);

  const replayVehicles: ReplayVehicleRenderable[] = useMemo(() => {
    if (mode !== "replay" || !replayIdx) return [];
    const queryT = playbackTime + replayIdx.firstT;
    const states = getVehicleStateAt(replayIdx, queryT);
    const deadSuffix = t("replay.vehicle.deadSuffix");
    return states.map((v) => {
      const occupants = namedPlayerOccupantNames(v, replayIdx, queryT);
      // Dead occupants get a localized suffix so the hover list distinguishes
      // casualties from live riders. Badge count includes both — viewer can
      // still see "1 player in this vehicle" even if the player is dead;
      // color (resolveVehicleHex) handles the live/dead distinction visually.
      const occupantNames = occupants.map((o) =>
        o.dead ? `${o.name} ${deadSuffix}` : o.name,
      );
      return {
        vehicleId: v.vehicleId,
        worldX: v.x,
        worldY: v.z,
        yaw: v.yaw,
        color: resolveVehicleHex(v, replayIdx, queryT),
        name: v.name,
        kind: v.kind,
        playerBadge: occupantNames.length,
        occupantNames,
      };
    });
  }, [mode, replayIdx, playbackTime, t]);

  // Active shots within the fade window. Computed every frame the playback
  // clock ticks; cost is O(visible-shots) thanks to the indexer's binary
  // search. Origin/hit are in engine (x, z); the renderer maps them onto
  // CRS.Simple's (lat=worldY=engineZ, lng=worldX=engineX) the same way
  // replayChars do.
  const replayShots: ReplayShotRenderable[] = useMemo(() => {
    if (mode !== "replay" || !replayIdx) return [];
    const friendlyKey = replayIdx.data.meta.friendlyFactionKey;
    const active = activeShotsAt(replayIdx, playbackTime + replayIdx.firstT, friendlyKey);
    return active.map((s) => ({
      key: String(s.t),
      originX: s.originX,
      originZ: s.originZ,
      hitX: s.hitX,
      hitZ: s.hitZ,
      opacity: s.opacity,
      isExplosion: s.isExplosion,
      hasLine: s.hasLine,
      isHeavy: s.isHeavy,
      color: s.color,
      age: 1 - s.opacity, // opacity = 1 - age/fadeMs ⇒ age-fraction = 1 - opacity
    }));
  }, [mode, replayIdx, playbackTime]);

  // Single source of truth for mode-swap side effects. Called from the
  // top-level Plan/Replay toggle and from any URL-driven mode change.
  const switchMode = useCallback(
    (next: "plan" | "replay") => {
      if (next === mode) return;
      setMode(next);
      if (next === "replay") {
        setSelectedId(null);
        setSelectedLineId(null);
        setDraftPoints([]);
        setRulerStart(null);
        setRulerEnd(null);
      } else {
        setPlaybackPlaying(false);
      }
    },
    [mode],
  );

  // Reflect the loaded replay's code in the URL so the page is shareable
  // (`?replay=CODE`). Also clears the param when the replay is unloaded.
  // Gated on `mountProcessedRef` so the auto-load effect (declared below)
  // can read the inbound URL before this effect overwrites it. Without the
  // gate, the initial render's `replay=null` would race-clear the param
  // before auto-load saw it.
  const mountProcessedRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!mountProcessedRef.current) return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get("replay");
    if (replay && current !== replay.code) {
      url.searchParams.set("replay", replay.code);
      window.history.replaceState(null, "", url.toString());
    } else if (!replay && current) {
      url.searchParams.delete("replay");
      window.history.replaceState(null, "", url.toString());
    }
  }, [replay]);

  async function handleLoadReplay(codeOverride?: string) {
    const code = (codeOverride ?? replayCodeInput).trim().toUpperCase();
    if (!code) return;
    setReplayLoading(true);
    setReplayError(null);
    setReplayLoadProgress({ loaded: 0, total: -1 });
    try {
      const data = await loadReplay(code, (loaded, total) => {
        setReplayLoadProgress({ loaded, total });
      });
      setReplay(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setReplayError(msg === "not_found" ? "notFound" : "failed");
    } finally {
      setReplayLoading(false);
      setReplayLoadProgress(null);
    }
  }

  // Replay-side plan loader: fetches a plan by code and applies it via the
  // same handleLoadPlan that the Import-by-code dialog uses. Used by the
  // input next to the Plan toggle in the replay panel. Quiet on success;
  // surfaces a short error message on 404 / network failure so the user
  // can correct the code without a modal.
  /** Latest move position of a char at-or-before the given mod-side time.
   *  Used by the event log's click handler to pan the map onto whoever
   *  just connected / went down. Returns null when the char has no move
   *  events yet at that time (e.g. clicked a connect event for a player
   *  who hadn't possessed a body yet). */
  function resolveCharPositionAt(
    idx: ReplayIndex,
    charId: number,
    modT: number,
  ): [number, number] | null {
    const moves = idx.movesByChar.get(charId);
    if (!moves || moves.length === 0) return null;
    if (moves[0].t > modT) return null;
    let lo = 0;
    let hi = moves.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (moves[mid].t <= modT) lo = mid;
      else hi = mid - 1;
    }
    return [moves[lo].x, moves[lo].z];
  }

  /** Event log click handler. Lands the playhead 2 seconds BEFORE the
   *  picked event so the viewer can watch the lead-up rather than the
   *  aftermath; additionally bumps `mapFocus` to fly the camera to the
   *  relevant char at max zoom (Leaflet zoom 2 = 4x native). When the
   *  char has no known position at the seek moment, the seek still
   *  happens; the map just stays where it was. */
  function handleEventLogPick(localT: number, charId: number | null) {
    const seekLocalT = Math.max(0, localT - EVENT_LOG_PREROLL_MS);
    setPlaybackTime(seekLocalT);
    if (charId === null || !replayIdx) return;
    const modT = seekLocalT + replayIdx.firstT;
    const pos = resolveCharPositionAt(replayIdx, charId, modT);
    if (!pos) return;
    setMapFocus({
      worldX: pos[0],
      worldY: pos[1],
      zoom: 2,
      // Date.now() so re-clicking the same entry still re-flies.
      key: Date.now(),
    });
  }

  async function handleLoadReplayPlanCode(rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    if (!code) {
      setReplayPlanCodeError(null);
      return;
    }
    setReplayPlanCodeError(null);
    try {
      const res = await fetch(`/api/plans/${encodeURIComponent(code)}`);
      if (res.status === 404) {
        setReplayPlanCodeError("notFound");
        return;
      }
      if (!res.ok) {
        setReplayPlanCodeError("failed");
        return;
      }
      const raw = await res.json();
      handleLoadPlan(normalizePlan(raw, code));
    } catch {
      setReplayPlanCodeError("failed");
    }
  }

  // Auto-load on mount when ?replay=CODE is in the URL. Switches into
  // replay mode at the same time. Runs once — and crucially, sets
  // `mountProcessedRef` regardless of whether a code was found, so the
  // URL-sync effect above unblocks for any future replay state changes.
  useEffect(() => {
    if (mountProcessedRef.current) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("replay");
    mountProcessedRef.current = true;
    if (!code) return;
    setReplayCodeInput(code.toUpperCase());
    switchMode("replay");
    void handleLoadReplay(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the recent-replays list whenever we enter replay mode without a
  // loaded replay (and refetch when unloading one). Refetch on unload picks
  // up sessions recorded after the page loaded. We don't need to retry on
  // failure — the dropdown gracefully falls back to "manual code entry only".
  useEffect(() => {
    if (mode !== "replay") return;
    if (replay) return;
    let cancelled = false;
    setRecentReplaysError(false);
    listRecentReplays(10)
      .then((items) => {
        if (!cancelled) setRecentReplays(items);
      })
      .catch(() => {
        if (!cancelled) setRecentReplaysError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, replay]);

  function formatDurationMs(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  }

  const isLinePanel = (tool === "line" || selectedLine) && !selected;
  const headerCategoryIcon = isLinePanel
    ? "/icons/figma/highlighter-small.svg"
    : "/icons/figma/marker-small.svg";
  const headerCategoryLabel = isLinePanel
    ? t("category.lines")
    : t("category.markers");
  const headerCount = isLinePanel
    ? `${lines.length} ${tp("count.line", lines.length)}`
    : `${markers.length} ${tp("count.marker", markers.length)}`;
  const headerH1 = selectedLine
    ? t("header.editLine")
    : selected
      ? t("header.editMarker")
      : tool === "line"
        ? t("header.newLine")
        : t("header.newMarker");
  const isEditing = Boolean(selected || selectedLine);
  // Pushing an empty canvas is valid — it wipes the backend plan, which is
  // the only way to make /syncplan remove markers/lines from the game after
  // Clear All. Only gate on the in-flight request.
  const canPublish = !saving;

  // Panel bodies are rendered in two places (desktop sidebar, mobile bottom
  // sheet), so hoist the JSX here and let each wrapper supply its own
  // positioning classes.
  const markerLinePanelBody = (tool === "marker" || tool === "line") ? (
    <>
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <MaskIcon
              src={headerCategoryIcon}
              size={16}
              color="#f4db50"
            />
            <span className="text-[14px] leading-[20px] text-white/60 truncate">
              {headerCategoryLabel}
            </span>
          </div>
          {isEditing ? (
            <button
              type="button"
              onClick={deleteSelected}
              className="flex items-center gap-2 text-[#f26f63] hover:text-[#f58a80] transition-colors"
              title={t("action.deleteKey")}
            >
              <MaskIcon src="/icons/figma/trash.svg" size={16} color="#f26f63" />
              <span className="text-[14px] leading-[20px] font-medium">
                {t("action.delete")}
              </span>
            </button>
          ) : (
            <span className="text-[14px] leading-[20px] text-white/30">
              {headerCount}
            </span>
          )}
        </div>
        <h1 className="font-slab text-[20px] leading-normal text-white font-medium">
          {headerH1}
        </h1>
      </div>

      {/* Tabs (marker only) */}
      {!isLinePanel && (
        <div className="bg-[#14181a] rounded-[8px] h-[40px] flex items-center w-full">
          {TABS.map((tab_) => {
            const active = tab === tab_.key;
            const label = t(tab_.labelKey);
            return (
              <button
                key={tab_.key}
                type="button"
                onClick={() => handleTabClick(tab_.key)}
                title={label}
                aria-label={label}
                className={`flex-1 h-full rounded-[6px] py-[10px] flex items-center justify-center text-[12px] leading-[20px] font-medium transition-colors ${
                  active
                    ? "bg-[#f4db50] text-[#202427]"
                    : "text-white hover:text-white/80"
                }`}
              >
                {tab_.icon === "star" ? (
                  <StarIcon
                    size={16}
                    color={active ? "#202427" : "#ffffff"}
                  />
                ) : (
                  label
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Form body */}
      <div className="flex flex-col gap-3">
        {/* Military */}
        {!isLinePanel && tab === "military" && (
          <>
            <FieldLabel label={t("field.faction")}>
              <FakeSelectButton
                label={
                  FACTIONS.find((f) => f.key === faction)?.label ?? faction
                }
                previewUrl={militaryIconUrl(faction, milType)}
              >
                <select
                  aria-label={t("field.faction")}
                  value={faction}
                  onChange={(e) => setFaction(e.target.value as Faction)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                >
                  {FACTIONS.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </FakeSelectButton>
            </FieldLabel>
            <FieldLabel label={t("field.type")}>
              <FakeSelectButton
                label={
                  MILITARY_TYPES.find((mt) => mt.key === milType)?.label ??
                  milType
                }
                previewUrl={militaryIconUrl(faction, milType)}
              >
                <select
                  aria-label={t("field.type")}
                  value={milType}
                  onChange={(e) => setMilType(e.target.value as MilitaryType)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                >
                  {MILITARY_TYPES.map((mt) => (
                    <option key={mt.key} value={mt.key}>
                      {mt.label}
                    </option>
                  ))}
                </select>
              </FakeSelectButton>
            </FieldLabel>
            <FieldLabel label={t("field.text")}>
              <DarkInput
                value={text}
                onChange={setText}
                onBlur={handleTextBlur}
                placeholder={t("placeholder.empty")}
              />
              <p className="mt-1 text-[11px] leading-[16px] text-white/40">
                {t("markerText.hint")}
              </p>
            </FieldLabel>
          </>
        )}

        {/* Custom / TS / Favorites */}
        {!isLinePanel && tab !== "military" && (
          <>
            <FieldLabel label={t("field.marker")}>
              {tab === "favorites" ? (
                <FavoritesGrid current={icon} onPick={setIcon} />
              ) : (
                <button
                  type="button"
                  onClick={() => setIconPickerOpen(true)}
                  className="bg-[#14181a] border border-[#2e3439] hover:border-[#3d4550] rounded-[4px] h-[44px] flex items-center gap-2 p-3 w-full transition-colors"
                >
                  <AtlasPreview icon={icon} size={32} />
                  <span className="flex-1 text-left text-[14px] leading-[20px] text-[#fafafa] truncate">
                    {icon.label}
                  </span>
                  <ChevronDown />
                </button>
              )}
            </FieldLabel>
            <FieldLabel label={t("field.color")}>
              <ColorGrid current={color} onChange={setColor} />
            </FieldLabel>
            <FieldLabel label={t("field.text")}>
              <DarkInput
                value={text}
                onChange={setText}
                onBlur={handleTextBlur}
                placeholder={t("placeholder.empty")}
              />
              <p className="mt-1 text-[11px] leading-[16px] text-white/40">
                {t("markerText.hint")}
              </p>
            </FieldLabel>
            <FieldLabel label={t("field.rotation")}>
              <div className="flex items-center gap-4 w-full">
                <input
                  type="range"
                  min={0}
                  max={359}
                  step={1}
                  value={rotation}
                  onChange={(e) => setRotation(Number(e.target.value))}
                  style={sliderProgressStyle(rotation, 0, 359)}
                  className="ts-slider flex-1"
                />
                <input
                  type="number"
                  min={0}
                  max={359}
                  value={rotation}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) setRotation(n);
                  }}
                  className="w-16 bg-[#14181a] border border-[#2e3439] rounded-[4px] h-[44px] px-3 text-[14px] text-[#fafafa] focus:outline-none focus:border-[#f4db50]"
                />
              </div>
            </FieldLabel>
          </>
        )}

        {/* Line */}
        {isLinePanel && (
          <>
            <FieldLabel label={t("field.thickness")}>
              <div className="bg-[#14181a] rounded-[8px] h-[44px] flex items-center w-full">
                {LINE_WIDTHS.map((w) => {
                  const active = lineWidth === w;
                  const strokePx = 2 + (w - 1) * 2;
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setLineWidth(w)}
                      className={`flex-1 h-full rounded-[6px] flex items-center justify-center transition-colors ${
                        active
                          ? "bg-[rgba(244,219,80,0.16)] border-2 border-[#f4db50]"
                          : "border-2 border-transparent hover:bg-white/5"
                      }`}
                      title={`${LINE_WIDTH_METERS[w]} m`}
                    >
                      <div
                        className="bg-[#f4db50] rounded-[1px]"
                        style={{ width: strokePx, height: 20 }}
                      />
                    </button>
                  );
                })}
              </div>
            </FieldLabel>
            <FieldLabel label={t("field.color")}>
              <ColorGrid current={lineColor} onChange={setLineColor} />
            </FieldLabel>
          </>
        )}

        {/* Selection coords / vertex count (subtle) */}
        {selected && (
          <p className="text-[11px] font-mono text-white/30">
            worldX{" "}
            <span className="text-white/60">{selected.worldX}</span>
            {"  ·  "}
            worldY{" "}
            <span className="text-white/60">{selected.worldY}</span>
          </p>
        )}
        {selectedLine && (
          <p className="text-[11px] font-mono text-white/30">
            {selectedLine.points.length}{" "}
            {tp("count.vertex", selectedLine.points.length)}
          </p>
        )}

        {saveError && (
          <div className="rounded-[8px] bg-red-900/40 border border-red-700 p-3 text-[12px] text-red-100">
            {t("push.error", { message: saveError })}
          </div>
        )}
      </div>
    </>
  ) : null;

  const rulerPanelBody = tool === "ruler" ? (
    <>
      <div className="flex items-center gap-2">
        <MaskIcon
          src="/icons/figma/ruler-vertical.svg"
          size={16}
          color="#f4db50"
        />
        <span className="text-[14px] leading-[20px] text-white/60">
          {t("ruler.panel.title")}
        </span>
      </div>
      <div className="bg-[#14181a] rounded-[8px] h-[40px] flex items-center w-full">
        {(["line", "radial"] as const).map((m) => {
          const active = rulerMode === m;
          const label =
            m === "line" ? t("ruler.mode.line") : t("ruler.mode.radial");
          return (
            <button
              key={m}
              type="button"
              onClick={() => setRulerModeAndReset(m)}
              title={label}
              aria-label={label}
              aria-pressed={active}
              className={`flex-1 h-full rounded-[6px] py-[10px] flex items-center justify-center text-[12px] leading-[20px] font-medium transition-colors ${
                active
                  ? "bg-[#f4db50] text-[#202427]"
                  : "text-white hover:text-white/80"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </>
  ) : null;

  // Replay mode with a loaded replay never fully collapses on mobile —
  // playback controls (timeline + play + speed) stay visible so a viewer
  // can scrub without re-opening the sheet. Collapse only hides peripheral
  // controls (title, world dropdown, toggles, close).
  const replayMobilePartialActive = mode === "replay" && !!replay && !!replayIdx;
  // True when the sheet should translate fully off-screen on collapse.
  // False when partial-collapse keeps the sheet on-screen at reduced height.
  const sheetTranslateOff = mobileSheetHidden && !replayMobilePartialActive;
  // Hide-class applied to the collapsible wrappers in replayPanelBody.
  // `hidden md:flex` makes mobile drop the section but keeps desktop intact.
  const replayMobileExtrasHidden = replayMobilePartialActive && mobileSheetHidden;
  const replayExtrasClass = replayMobileExtrasHidden
    ? "hidden md:flex flex-col gap-4"
    : "flex flex-col gap-4";

  const closeReplay = () => {
    setReplay(null);
    setReplayCodeInput("");
    setPlaybackPlaying(false);
    setPlaybackTime(0);
    setReplayPlanCodeInput("");
    setReplayPlanCodeError(null);
  };
  // Title format: "{Map} - DD.MM.YYYY" when a map is known (auto-detected or
  // manually overridden), else just the date so unknown-world replays still
  // get a useful subhead before the user picks a map. created_at is ISO; we
  // format DD.MM.YYYY directly to dodge locale ambiguity (en-GB gives slashes,
  // and Intl with manual separators is overkill for fixed format).
  const replayTitleString = (() => {
    if (!replay) return "";
    const d = new Date(replay.created_at);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const date = `${dd}.${mm}.${yyyy}`;
    const hasMap = !!replayAutoMapKey || !!replayMapOverride;
    return hasMap ? `${effectiveMapConfig.label} - ${date}` : date;
  })();

  const replayPanelBody = mode === "replay" ? (
    <>
      <div className={replayExtrasClass}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-4">
            <div className="flex-1 min-w-0 flex items-center gap-2">
              <MaskIcon
                src="/icons/figma/play-circle.svg"
                size={16}
                color="#f4db50"
              />
              <span className="text-[14px] leading-[20px] text-white/60">
                {t("replay.panel.title")}
              </span>
            </div>
            {/* Code chip + close button. Visible only when a replay is
                loaded — the empty-state form doesn't have a code yet, and
                close has nothing to close. The X here replaces the
                standalone Close button at the bottom of the panel. */}
            {replay && (
              <div className="flex items-center gap-2">
                <ReplayCodeChip code={replay.code} />
                <ReplayCopyButton
                  code={replay.code}
                  label={t("replay.copyLink")}
                  copiedLabel={t("replay.copied")}
                />
                <ReplayIconButton
                  iconSrc="/icons/figma/close-x.svg"
                  iconSize={16}
                  iconColor="#DA6B50"
                  onClick={closeReplay}
                  label={t("replay.close")}
                />
              </div>
            )}
          </div>
          {/* Title: map + date, or date only when no map resolved. */}
          {replay && (
            <p className="font-slab font-medium text-[20px] leading-none text-white">
              {replayTitleString}
            </p>
          )}
        </div>
      </div>

      {!replay && replayLoading && (
        // Loading state: replace the form with a spinner + progress info so it's
        // unambiguous that work is happening. The form (recent dropdown, code
        // input, load button) is intentionally not rendered while loading to
        // prevent stale interaction.
        <div className="flex flex-col items-center gap-3 py-6">
          <div
            className="size-8 rounded-full border-2 border-[#2e3439] border-t-[#f4db50] animate-spin"
            aria-label={t("replay.loading")}
            role="status"
          />
          {replayLoadProgress && replayLoadProgress.total > 0 && (
            <div className="flex flex-col gap-1.5 w-full">
              <div className="flex justify-between text-[11px] leading-[14px] text-white/60 font-mono">
                <span>
                  {replayLoadProgress.loaded.toLocaleString()} / {replayLoadProgress.total.toLocaleString()} events
                </span>
                <span>
                  {Math.round((replayLoadProgress.loaded / replayLoadProgress.total) * 100)}%
                </span>
              </div>
              <div className="h-[3px] bg-[#14181a] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#f4db50] transition-[width] duration-150 ease-out"
                  style={{
                    width: `${Math.min(100, (replayLoadProgress.loaded / replayLoadProgress.total) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {!replay && !replayLoading && (
        <>
          {/* Recent replays dropdown — populated from GET /api/replays?recent.
              Each entry shows `CODE · Map name`. Picking one immediately
              kicks off the chunked load via handleLoadReplay; the manual
              code entry below stays available for sharing-by-code flow. */}
          {recentReplays && recentReplays.length > 0 && (
            <FieldLabel label={t("replay.recent.label")}>
              <div className="relative">
                <select
                  aria-label={t("replay.recent.label")}
                  defaultValue=""
                  onChange={(e) => {
                    const code = e.target.value;
                    if (!code) return;
                    setReplayCodeInput(code);
                    void handleLoadReplay(code);
                    // Reset the select so re-picking the same item still
                    // triggers a load (`onChange` only fires on change).
                    e.target.value = "";
                  }}
                  className="appearance-none w-full h-[44px] bg-[#14181a] border border-[#2e3439] rounded-[8px] pl-3 pr-8 text-[13px] text-[#fafafa] focus:outline-none focus:border-[#f4db50]"
                >
                  <option value="" disabled>
                    {t("replay.recent.placeholder")}
                  </option>
                  {recentReplays.map((r) => {
                    const map = resolveReplayMap({
                      code: r.code,
                      world: r.world,
                      meta: r.meta,
                      events: [],
                      created_at: r.created_at,
                    });
                    return (
                      <option key={r.code} value={r.code}>
                        {r.code} · {map.label}
                      </option>
                    );
                  })}
                </select>
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                  <ChevronDown size={12} />
                </span>
              </div>
            </FieldLabel>
          )}
          <FieldLabel label={t("replay.code.label")}>
            <DarkInput
              value={replayCodeInput}
              onChange={(v) => setReplayCodeInput(v.toUpperCase())}
              placeholder={t("replay.code.placeholder")}
            />
          </FieldLabel>
          <button
            type="button"
            onClick={() => handleLoadReplay()}
            disabled={replayCodeInput.trim() === ""}
            className={`h-[44px] rounded-[8px] text-[13px] leading-[20px] font-medium transition-colors ${
              replayCodeInput.trim() === ""
                ? "bg-[#2e3439] text-white/30 cursor-not-allowed"
                : "bg-[#f4db50] text-[#202427] hover:bg-[#f9e278]"
            }`}
          >
            {t("replay.load")}
          </button>
          {replayError && (
            <div className="rounded-[8px] bg-red-900/40 border border-red-700 p-3 text-[12px] text-red-100">
              {replayError === "notFound" ? t("replay.notFound") : t("replay.failed")}
            </div>
          )}
        </>
      )}

      {replay && replayIdx && (
        <>
          {/* World detection: hide entirely when auto-detected (clean panel,
              the timeline already conveys session info). When auto-detection
              failed or the user chose to override, expose a map dropdown so
              the viewer can pick the right map. Duration is now shown only
              by the timeline component below, not in a duplicate string.
              Wrapped in the collapsible group so it disappears alongside the
              title on a mobile partial-collapse. */}
          {(!replayAutoMapKey || replayMapOverride) && (
            <div className={replayExtrasClass}>
              <FieldLabel label={t("replay.world")}>
                <select
                  value={effectiveMapConfig.key}
                  onChange={(e) => setReplayMapOverride(e.target.value)}
                  className="h-[36px] bg-[#14181a] border border-[#2e3439] rounded-[8px] px-3 text-[13px] text-[#fafafa] focus:outline-none focus:border-[#f4db50]"
                >
                  {MAPS.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </FieldLabel>
            </div>
          )}

          {/* Timer row: current-time input + total duration + ±10s skip
              buttons on the right. The input is masked digit-only (M:SS),
              committing on Enter/blur seeks playback. */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <MaskedTimeInput
                valueMs={playbackTime}
                maxMs={replayIdx.durationMs}
                onCommit={setPlaybackTime}
                ariaLabel={t("replay.currentTime")}
              />
              <span className="text-[12px] leading-none text-white/60">/</span>
              <span className="text-[12px] leading-none text-white">
                {formatDurationMs(replayIdx.durationMs)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <SkipButton
                label="-10s"
                ariaLabel={t("replay.skipBack")}
                onClick={() =>
                  setPlaybackTime((t) => Math.max(0, t - 10_000))
                }
              />
              <SkipButton
                label="+10s"
                ariaLabel={t("replay.skipForward")}
                onClick={() =>
                  setPlaybackTime((t) =>
                    Math.min(replayIdx.durationMs, t + 10_000),
                  )
                }
              />
            </div>
          </div>

          {/* Progress scrubber */}
          <input
            type="range"
            min={0}
            max={Math.max(1, replayIdx.durationMs)}
            step={1}
            value={Math.min(playbackTime, replayIdx.durationMs)}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) setPlaybackTime(v);
            }}
            aria-label={t("replay.currentTime")}
            style={sliderProgressStyle(
              Math.min(playbackTime, replayIdx.durationMs),
              0,
              Math.max(1, replayIdx.durationMs),
            )}
            className="ts-slider w-full"
          />

          {/* Play/pause + segmented speed selector */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (!replayIdx) return;
                if (playbackTime >= replayIdx.durationMs) setPlaybackTime(0);
                setPlaybackPlaying((v) => !v);
              }}
              className="flex-1 h-[44px] rounded-[6px] bg-[#f4db50] text-[#202427] text-[12px] leading-[20px] font-medium hover:bg-[#f9e278] transition-colors"
            >
              {playbackPlaying ? t("replay.pause") : t("replay.play")}
            </button>
            <SegmentedSpeed
              speeds={REPLAY_SPEEDS}
              current={playbackSpeed}
              onPick={setPlaybackSpeed}
              ariaLabel={t("replay.speed")}
            />
          </div>

          {/* Toggles — collapsible group. Hidden on mobile partial-collapse
              so only the playback controls (above) remain visible. Always
              visible on desktop. */}
          <div className={replayExtrasClass}>
            {/* Toggle stack: every row is fixed at 32px so showPlan turning
                on (which surfaces the opacity slider + code input) doesn't
                shift the row taller. Rows stack at 4px gap; the parent
                section gap (16px) still separates this group from the
                controls above. */}
            <div className="flex flex-col gap-1">
              <div className="h-[32px] flex items-center gap-2">
                <Toggle
                  checked={showNames}
                  onChange={setShowNames}
                  ariaLabel={t("replay.showNames")}
                />
                <span className="text-[12px] leading-[20px] font-medium text-white">
                  {t("replay.showNames")}
                </span>
              </div>

              {/* Plan row: toggle + opacity slider + plan code input. The
                  plan code is pre-filled from `replay.meta.planCode` when
                  the mod stamped one (future feature — see
                  ReplayMeta.planCode); today it's empty and the user
                  pastes a code to load a plan as overlay. Markers/lines
                  render via the existing `mode === "plan" || showPlan`
                  gate around `renderable*`.
                  Hidden in 3D — the 3D viewport intentionally suppresses
                  plan markers/lines/polygons to avoid the 2D-vs-3D
                  rotation / billboard weirdness. */}
              {!view3D && (
              <>
              <div className="h-[32px] flex items-center gap-4">
                <div className="flex items-center gap-2 shrink-0">
                  <Toggle
                    checked={showPlan}
                    onChange={setShowPlan}
                    ariaLabel={t("replay.showPlan")}
                  />
                  <span className="text-[12px] leading-[20px] font-medium text-white">
                    {t("replay.showPlan")}
                  </span>
                </div>
                {/* Opacity slider + code input only surface when the
                    overlay is active. Hidden controls are removed from
                    flow; the parent row stays at h-[32px] regardless. */}
                {showPlan && (
                  <>
                    <input
                      type="range"
                      min={20}
                      max={100}
                      step={1}
                      value={Math.round(planOpacity * 100)}
                      onChange={(e) =>
                        setPlanOpacity(Number(e.target.value) / 100)
                      }
                      aria-label={t("replay.opacity")}
                      title={`${Math.round(planOpacity * 100)}%`}
                      style={sliderProgressStyle(
                        Math.round(planOpacity * 100),
                        20,
                        100,
                      )}
                      className="ts-slider flex-1 min-w-0"
                    />
                    <input
                      type="text"
                      value={replayPlanCodeInput}
                      onChange={(e) =>
                        setReplayPlanCodeInput(e.target.value.toUpperCase())
                      }
                      onBlur={() =>
                        handleLoadReplayPlanCode(replayPlanCodeInput)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      placeholder={t("replay.planCode.placeholder")}
                      maxLength={16}
                      aria-label={t("replay.showPlan")}
                      className="h-[32px] w-[72px] bg-[#14181a] border border-[#2e3439] rounded-[4px] px-3 text-center text-[12px] leading-none text-white/60 font-mono focus:outline-none focus:border-[#f4db50] placeholder:text-white/30"
                    />
                  </>
                )}
              </div>
              {showPlan && replayPlanCodeError && (
                <p className="text-[11px] leading-[14px] text-red-300">
                  {replayPlanCodeError === "notFound"
                    ? t("replay.notFound")
                    : t("replay.failed")}
                </p>
              )}
              </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  ) : null;

  const currentPanelBody =
    mode === "replay"
      ? replayPanelBody
      : (rulerPanelBody ?? markerLinePanelBody);

  // Measure the mobile sheet's actual rendered height so the map container
  // can shrink to exactly "screen minus sheet". Sheet height is content-driven
  // (up to max-h 424px) — a fixed number would either waste space (ruler) or
  // cause scroll (military, before 424).
  const sheetRef = useRef<HTMLDivElement>(null);
  const [mobileSheetPx, setMobileSheetPx] = useState(0);
  // Mount detection collapsed to a boolean: the previous dep used the raw
  // currentPanelBody JSX, which is a fresh React node on every render — so
  // the effect tore down + rebuilt the ResizeObserver every frame, and
  // sub-pixel layout shifts from the per-frame replay clock could turn that
  // into "Maximum update depth exceeded" warnings cascading through the
  // tick + scrubber siblings. ResizeObserver itself reports size changes
  // continuously, so we only need to re-attach when the sheet appears or
  // disappears.
  const hasPanelBody = !!currentPanelBody;
  useEffect(() => {
    const el = sheetRef.current;
    // When the sheet is fully translated off, drive the map container to
    // fullscreen via a 0 offset. In partial-collapse (replay mode, replay
    // loaded), the sheet remains visible at a reduced height — measure as
    // usual; the ResizeObserver picks up the size change automatically when
    // the collapsible inner sections toggle their display.
    if (!el || sheetTranslateOff) {
      setMobileSheetPx(0);
      return;
    }
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      // Bail out on no-op updates so React doesn't see a setState call on
      // every observer firing — keeps the render loop cool when the time
      // text reflows by sub-pixel amounts each frame.
      setMobileSheetPx((prev) => (prev === h ? prev : h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasPanelBody, sheetTranslateOff]);

  // Tight, decisive easing for the sheet — ease-out-quint. Avoids bounce/elastic
  // curves which feel dated on a functional panel like this.
  const SHEET_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
  const SHEET_MS = 280;

  return (
    <main
      className="relative flex-1 w-full bg-slate-900"
      style={
        { "--mobile-sheet-h": `${mobileSheetPx}px` } as React.CSSProperties
      }
    >
      <div
        className="absolute top-0 left-0 right-0 bottom-0 md:bottom-0 motion-reduce:transition-none"
        style={{
          bottom: mobileSheetPx,
          transition: `bottom ${SHEET_MS}ms ${SHEET_EASE}`,
        }}
      >
        {view3D && mode === "replay" ? (
          <MapClient3D
            mapConfig={effectiveMapConfig}
            replayChars={replayChars}
            replayShots={replayShots}
            replayVehicles={replayVehicles}
            mapFocus={mapFocus}
          />
        ) : (
        <MapClient
          mapConfig={effectiveMapConfig}
          labelColor={labelColor}
          markers={mode === "plan" || showPlan ? renderable : []}
          lines={mode === "plan" || showPlan ? renderableLines : []}
          polygons={mode === "plan" || showPlan ? renderablePolygons : []}
          planOpacity={mode === "replay" && showPlan ? planOpacity : 1}
          mapFocus={mapFocus}
          showCursorHint={mode !== "replay"}
          replayChars={replayChars}
          replayShots={replayShots}
          replayVehicles={replayVehicles}
          draft={mode === "replay" ? null : draftRender}
          ruler={rulerRender}
          rulerMode={rulerMode}
          radial={radial}
          cursorMode={
            mode === "replay"
              ? tool === "ruler"
                ? "aggressive"
                : "off"
              : tool === "line" || tool === "ruler"
                ? "aggressive"
                : tool === "marker"
                  ? "container"
                  : "off"
          }
          linesInteractive={mode !== "replay" && tool !== "line" && tool !== "ruler"}
          markersInteractive={mode !== "replay" && tool === "marker"}
          onMapClick={handleMapClick}
          onMapDoubleClick={handleMapDoubleClick}
          onMapMouseMove={handleMapMouseMove}
          onMapContextMenu={handleMapContextMenu}
          onMarkerClick={handleMarkerClick}
          onMarkerDrag={handleMarkerDrag}
          onLineClick={handleLineClick}
          onDuplicateMarker={duplicateSelected}
          onDeleteMarker={deleteSelected}
          onRotateMarker={setRotation}
          onHeightmapChange={setLosSampler}
        />
        )}

      </div>
      {rulerMode === "line" && losResult && <LineOfSightPanel result={losResult} />}

      <div
        className="pointer-events-none absolute top-2 left-2 right-2 md:left-4 md:top-4 md:bottom-4 md:right-auto md:w-[360px] z-[1500] flex flex-col gap-4"
      >
        {/* Tool switcher — buttons float individually (no container panel). */}
        <div className="pointer-events-auto flex items-center gap-[10px] shrink-0">
          {/* Desktop-only top-level mode toggle. Mobile hides this — the
              tool row is too narrow to fit a segmented toggle alongside the
              tool buttons and the menu — and instead exposes Mode inside
              the ••• menu (see md:hidden block in MenuDropdown). */}
          <div className="hidden md:block">
            <ModeToggle
              current={mode}
              labels={{ plan: t("mode.plan"), replay: t("mode.replay") }}
              onPick={switchMode}
            />
          </div>
          <div className="flex-1 flex gap-2 items-center">
            {/* Marker / Line / Ruler are all plan-mode only — replay viewing
                doesn't have a place for any of them. The whole tool row is
                empty in replay; the mode toggle and the ••• menu are the
                only interactive bits up here. */}
            {mode === "plan" && (
              <>
                <ToolSquare
                  active={tool === "marker"}
                  onClick={() => switchTool("marker")}
                  iconSrc="/icons/figma/marker-pin.svg"
                  title={t("tool.marker")}
                  hotkey="1"
                />
                <ToolSquare
                  active={tool === "line"}
                  onClick={() => switchTool("line")}
                  iconSrc="/icons/figma/highlighter-line.svg"
                  title={t("tool.line")}
                  hotkey="2"
                />
                <ToolSquare
                  active={tool === "ruler"}
                  onClick={() => switchTool("ruler")}
                  iconSrc="/icons/figma/ruler-vertical.svg"
                  title={t("tool.ruler")}
                  hotkey="3"
                />
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Mobile-only Push pill. Desktop has the big button in the sidebar. */}
            {mode === "plan" && (
              <button
                type="button"
                onClick={save}
                disabled={!canPublish}
                className={`md:hidden h-[40px] rounded-[8px] px-4 text-[12px] leading-[20px] font-medium transition-colors shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] ${
                  canPublish
                    ? "bg-[#f4db50] text-[#202427] hover:bg-[#f9e278]"
                    : "bg-[#2e3439] text-white/30 cursor-not-allowed"
                }`}
              >
                {saving ? t("push.pending") : t("push.button")}
              </button>
            )}
            {/* 2D / 3D viewport toggle — replay-mode only. Same segmented
                style as ModeToggle so the two sit visually consistent.
                Mobile hides it (mobile is 2D-only). */}
            {mode === "replay" && (
              <div className="hidden md:flex h-[40px] rounded-[8px] bg-[#2e3439] p-1 items-center gap-1 shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] shrink-0">
                {([false, true] as const).map((v) => {
                  const active = view3D === v;
                  return (
                    <button
                      key={v ? "3d" : "2d"}
                      type="button"
                      onClick={() => setView3D(v)}
                      className={`h-full px-3 rounded-[6px] text-[12px] leading-[20px] font-medium flex items-center transition-colors ${
                        active
                          ? "bg-[#f4db50] text-[#202427]"
                          : "text-white/60 hover:text-white"
                      }`}
                    >
                      <span>{v ? "3D" : "2D"}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="relative">
              <ToolSquare
                active={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
                iconSrc="/icons/figma/menu-dots.svg"
                title={t("tool.options")}
              />
              {menuOpen && (
                <MenuDropdown
                  onClose={() => setMenuOpen(false)}
                  onClearAll={() => {
                    setMenuOpen(false);
                    clearAll();
                  }}
                  onImport={() => {
                    setMenuOpen(false);
                    setImportOpen(true);
                  }}
                  onImportCode={() => {
                    setMenuOpen(false);
                    setImportCodeOpen(true);
                  }}
                  onHelp={() => {
                    setMenuOpen(false);
                    setHelpOpen(true);
                  }}
                  onOpenMapPicker={() => {
                    setMenuOpen(false);
                    setMenuPicker("map");
                  }}
                  onOpenLanguagePicker={() => {
                    setMenuOpen(false);
                    setMenuPicker("language");
                  }}
                  onOpenModePicker={() => {
                    setMenuOpen(false);
                    setMenuPicker("mode");
                  }}
                  onOpenLabelColorPicker={() => {
                    setMenuOpen(false);
                    setMenuPicker("labelColor");
                  }}
                  onPickLabelColor={(c) => {
                    setMenuOpen(false);
                    setLabelColor(c);
                  }}
                  currentLabelColor={labelColor}
                  onPickMap={(k) => {
                    setMenuOpen(false);
                    if (mode === "replay") {
                      // In replay mode, the dropdown overrides the auto-
                      // detected map without disturbing plan-mode's mapKey.
                      // Selecting the auto-detected map clears the override
                      // (back to auto).
                      setReplayMapOverride(k === replayAutoMapKey ? null : k);
                    } else if (k !== mapKey) {
                      setMapKey(k);
                      setSelectedId(null);
                      setSelectedLineId(null);
                      setDraftPoints([]);
                    }
                  }}
                  onPickMode={(m) => {
                    setMenuOpen(false);
                    if (m !== mode) {
                      setMode(m);
                      // Cancel any plan-mode in-progress state when leaving plan,
                      // and pause replay when leaving replay.
                      if (m === "replay") {
                        setSelectedId(null);
                        setSelectedLineId(null);
                        setDraftPoints([]);
                        setRulerStart(null);
                        setRulerEnd(null);
                      } else {
                        setPlaybackPlaying(false);
                      }
                    }
                  }}
                  disabledClear={
                    markers.length +
                      lines.length +
                      importedMarkers.length +
                      importedPolygons.length ===
                    0
                  }
                  currentMapKey={mode === "replay" ? effectiveMapConfig.key : mapKey}
                  currentMode={mode}
                  isReplayMode={mode === "replay"}
                />
              )}
            </div>
          </div>
        </div>

        {/* Settings panel — desktop sidebar only. Mobile renders the same
            panel body inside a bottom sheet below. */}
        {mode === "plan" && markerLinePanelBody && (
          <div className="hidden md:flex pointer-events-auto bg-[#202427] rounded-[12px] p-5 flex-col gap-4 shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] min-h-0 overflow-y-auto">
            {markerLinePanelBody}
          </div>
        )}

        {mode === "plan" && rulerPanelBody && (
          <div className="hidden md:flex pointer-events-auto bg-[#202427] rounded-[12px] p-5 flex-col gap-4 shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] shrink-0">
            {rulerPanelBody}
          </div>
        )}

        {mode === "replay" && replayPanelBody && (
          <div
            className={`hidden md:flex pointer-events-auto bg-[#202427] rounded-[12px] p-5 flex-col gap-4 shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] ${
              // Allow internal scroll on tiny viewports but don't fight the
              // event log for vertical space when it's expanded.
              eventLogExpanded && replay && replayIdx
                ? "shrink-0 overflow-y-auto max-h-[60vh]"
                : "min-h-0 overflow-y-auto"
            }`}
          >
            {replayPanelBody}
          </div>
        )}

        {/* Event log — desktop only, replay mode with a loaded replay. Its
            own panel chrome so it reads as a separate card under the main
            replay panel. Wrapper sizes itself flex-1 when expanded so the
            scrollable list fills the remaining viewport, shrink-0 when
            collapsed so we don't leave a tall transparent gap below the
            32px header. Mobile defers (the bottom sheet is height-capped
            and the log would crowd the playback controls). */}
        {mode === "replay" && replay && replayIdx && (
          <div
            className={`hidden md:flex pointer-events-auto flex-col ${
              eventLogExpanded ? "flex-1 min-h-0" : "shrink-0"
            }`}
          >
            <ReplayEventLog
              replayIdx={replayIdx}
              playbackTime={playbackTime}
              onPickEvent={handleEventLogPick}
              expanded={eventLogExpanded}
              onToggleExpanded={() => setEventLogExpanded((v) => !v)}
            />
          </div>
        )}

        {/* Push to Reforger — desktop only, plan-mode only. */}
        {mode === "plan" && (
          <button
            type="button"
            onClick={save}
            disabled={!canPublish}
            className={`hidden md:block pointer-events-auto rounded-[12px] py-[24px] text-[16px] leading-[20px] font-medium transition-colors shrink-0 ${
              canPublish
                ? "bg-[#f4db50] text-[#202427] hover:bg-[#f9e278]"
                : "bg-[#2e3439] text-white/30 cursor-not-allowed"
            }`}
            style={
              canPublish
                ? { boxShadow: "0px 16px 32px 0px rgba(191,162,0,0.6)" }
                : undefined
            }
          >
            {saving ? t("push.pending") : t("push.button")}
          </button>
        )}
      </div>

      {/* Mobile bottom sheet + toggle. The chevron button hides or reveals
          the sheet without changing the active tool, so users can get a
          full-screen map while still placing the pre-selected marker /
          drawing a line / measuring with the ruler.
          - Sheet is always mounted when a tool is active; `translateY(100%)`
            slides it below the viewport when hidden.
          - Chevron is separately positioned and tracks the sheet's top edge
            via an inline `bottom` that transitions in sync with the sheet.
          - Map container's inline `bottom` (above) transitions together.
          All three share the same timing/easing for a single orchestrated
          motion. Respects `prefers-reduced-motion`. */}
      {currentPanelBody && (
        <>
          <button
            type="button"
            onClick={() => setMobileSheetHidden((v) => !v)}
            aria-label={
              mobileSheetHidden
                ? t("action.showPanel")
                : t("action.hidePanel")
            }
            title={
              mobileSheetHidden
                ? t("action.showPanel")
                : t("action.hidePanel")
            }
            className="md:hidden absolute right-2 z-[1600] size-[40px] rounded-[8px] bg-[#2e3439] hover:bg-[#3a4249] flex items-center justify-center shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] transition-colors motion-reduce:transition-none"
            style={{
              bottom: mobileSheetPx + 8,
              transition: `bottom ${SHEET_MS}ms ${SHEET_EASE}, background-color 150ms`,
            }}
          >
            <svg
              width="14"
              height="8"
              viewBox="0 0 14 8"
              aria-hidden="true"
              className="motion-reduce:transition-none"
              style={{
                transform: mobileSheetHidden
                  ? "rotate(180deg)"
                  : "rotate(0deg)",
                transition: `transform ${SHEET_MS}ms ${SHEET_EASE}`,
              }}
            >
              <path
                d="M1 1L7 7L13 1"
                stroke="#ffffff"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </button>
          <div
            ref={sheetRef}
            className="md:hidden absolute bottom-0 left-0 right-0 z-[1500] bg-[#202427] rounded-tl-[12px] rounded-tr-[12px] p-5 flex flex-col gap-4 shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] max-h-[424px] overflow-y-auto motion-reduce:transition-none"
            style={{
              transform: sheetTranslateOff
                ? "translateY(100%)"
                : "translateY(0)",
              transition: `transform ${SHEET_MS}ms ${SHEET_EASE}`,
              willChange: "transform",
            }}
          >
            {currentPanelBody}
          </div>
        </>
      )}

      {iconPickerOpen && tab !== "military" && tab !== "favorites" && (
        <IconPickerModal
          atlas={tab}
          current={icon}
          onPick={(i) => {
            setIcon(i);
            setIconPickerOpen(false);
          }}
          onClose={() => setIconPickerOpen(false)}
          color="#ffffff"
        />
      )}

      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onCommit={handleImport}
        />
      )}

      {importCodeOpen && (
        <ImportCodeDialog
          onClose={() => setImportCodeOpen(false)}
          onCommit={handleLoadPlan}
        />
      )}

      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}

      {menuPicker === "map" && (
        <ListPickerDialog
          title={t("menu.map")}
          items={[...MAPS]
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((m) => ({ key: m.key, label: m.label }))}
          selectedKey={mapKey}
          onPick={(k) => {
            setMenuPicker(null);
            if (k !== mapKey) {
              setMapKey(k);
              setSelectedId(null);
              setSelectedLineId(null);
              setDraftPoints([]);
            }
          }}
          onClose={() => setMenuPicker(null)}
        />
      )}
      {menuPicker === "language" && (
        <ListPickerDialog
          title={t("menu.language")}
          items={LOCALES.map((l) => ({ key: l.key, label: l.label }))}
          selectedKey={locale}
          onPick={(k) => {
            setMenuPicker(null);
            setLocale(k as Locale);
          }}
          onClose={() => setMenuPicker(null)}
        />
      )}
      {menuPicker === "labelColor" && (
        <ListPickerDialog
          title={t("menu.labelColor")}
          items={[
            { key: "black", label: t("labelColor.black") },
            { key: "white", label: t("labelColor.white") },
          ]}
          selectedKey={labelColor}
          onPick={(k) => {
            setMenuPicker(null);
            if (k === "black" || k === "white") setLabelColor(k);
          }}
          onClose={() => setMenuPicker(null)}
        />
      )}
      {/* Mode picker modal — opens from the mobile menu only. Desktop uses
          the top-level ModeToggle and never reaches this code path. */}
      {menuPicker === "mode" && (
        <ListPickerDialog
          title={t("menu.mode")}
          items={[
            { key: "plan", label: t("mode.plan") },
            { key: "replay", label: t("mode.replay") },
          ]}
          selectedKey={mode}
          onPick={(k) => {
            setMenuPicker(null);
            switchMode(k as "plan" | "replay");
          }}
          onClose={() => setMenuPicker(null)}
        />
      )}

      {savedCode && pushedModalOpen && (
        <PushedModal
          code={savedCode}
          onClose={() => setPushedModalOpen(false)}
        />
      )}
    </main>
  );
}

/** Inline 5-point star for the Favorites tab. */
function StarIcon({ size = 16, color }: { size?: number; color: string }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
    >
      <path d="M12 2.5l2.9 6.88 7.1.72-5.3 5.16L18 22l-6-3.5L6 22l1.3-6.74L2 10.1l7.1-.72L12 2.5z" />
    </svg>
  );
}

/** 3x4 inline grid of favorite markers shown in the Favorites tab. */
function FavoritesGrid({
  current,
  onPick,
}: {
  current: IconEntry;
  onPick: (i: IconEntry) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-2 w-full">
      {FAVORITES.map((i) => {
        const selected =
          i.atlas === current.atlas &&
          i.category === current.category &&
          i.quad === current.quad;
        return (
          <button
            key={`${i.atlas}/${i.category}/${i.quad}`}
            type="button"
            onClick={() => onPick(i)}
            title={i.label}
            aria-pressed={selected}
            className={`min-h-[76px] rounded-[4px] flex flex-col items-center justify-center gap-1 px-1 py-2 border transition-colors ${
              selected
                ? "bg-[rgba(244,219,80,0.16)] border-[#f4db50]"
                : "bg-[#14181a] border-[#2e3439] hover:border-[#3d4550]"
            }`}
          >
            <AtlasPreview icon={i} size={36} />
            <span className="text-[10px] leading-[12px] font-medium text-white/70 text-center break-words">
              {i.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Inline chevron-down at Figma's proportions (9.33×5.33). */
function ChevronDown({ size = 12 }: { size?: number }) {
  const h = (size * 5.33) / 9.33;
  return (
    <svg
      aria-hidden
      width={size}
      height={h}
      viewBox="0 0 9.33 5.33"
      fill="none"
      className="shrink-0 opacity-60"
    >
      <path
        d="M0.665 0.665L4.665 4.665L8.665 0.665"
        stroke="#fafafa"
        strokeWidth="1.33"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Success popup shown after Push. Surfaces the server-minted code with a
 *  one-click "copy /syncplan <code>" button — commanders paste that directly
 *  into Discord/comms so the admin has no chance to mistype it. */
function PushedModal({ code, onClose }: { code: string; onClose: () => void }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  async function copyCommand() {
    const cmd = `/syncplan ${code}`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API not available — user can still manually copy the text.
    }
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[1900] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[360px] max-w-[92vw] bg-[#202427] rounded-[12px] shadow-[0px_16px_32px_0px_rgba(0,0,0,0.5)] flex flex-col p-5 gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-slab text-[20px] leading-normal text-white font-medium">
            {t("push.success.as")}{" "}
            <span className="font-mono text-[#f4db50]">{code}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("action.close")}
            className="text-white/60 hover:text-white text-[16px] leading-none"
          >
            ✕
          </button>
        </div>
        <button
          type="button"
          onClick={copyCommand}
          className="w-full flex items-center justify-between gap-2 bg-emerald-950/60 hover:bg-emerald-950/80 border border-emerald-800 rounded-[4px] px-3 py-3 transition-colors cursor-pointer"
          title={t("push.success.copyTitle")}
        >
          <code className="font-mono text-[13px] text-emerald-200">
            /syncplan {code}
          </code>
          <span className="text-[12px] text-emerald-300 shrink-0">
            {copied ? t("push.success.copied") : t("push.success.copy")}
          </span>
        </button>
      </div>
    </div>
  );
}

/** Renders an atlas sprite as-is (no mask, no tinting). The vanilla/TS atlases
 *  are already white-on-transparent, so this yields a true white icon on any
 *  dark bg without anti-aliasing artifacts from CSS masking thin strokes. */
function AtlasPreview({ icon, size }: { icon: IconEntry; size: number }) {
  const atlas = ATLASES[icon.atlas];
  const scale = size / icon.w;
  return (
    <div
      aria-hidden
      className="shrink-0"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${atlas.url})`,
        backgroundRepeat: "no-repeat",
        backgroundPosition: `-${icon.x * scale}px -${icon.y * scale}px`,
        backgroundSize: `${atlas.width * scale}px ${atlas.height * scale}px`,
      }}
    />
  );
}

/** Monochrome SVG rendered via CSS mask so we can recolor freely. */
/** 48×48 rounded square tool button. Active = yellow bg + dark icon.
 *  Optional `hotkey` renders a tiny letter badge in the top-right. */
// Inline style for an <input type="range"> that drives the .ts-slider track's
// completed-fill gradient. Maps the input's current value into a 0-100% CSS
// variable the track CSS reads. Honors min/max so sliders that don't start
// at 0 (e.g. plan opacity, min=20) compute fill correctly.
function sliderProgressStyle(
  value: number,
  min: number,
  max: number,
): React.CSSProperties {
  const range = max - min;
  const pct = range > 0 ? ((value - min) / range) * 100 : 0;
  return { ["--ts-slider-pct" as string]: `${Math.max(0, Math.min(100, pct))}%` };
}

// Replay code window. 32px-tall #14181a bezel showing the 6-char code in
// white/60 mono. Copy is a separate sibling button (see ReplayCopyButton)
// rather than nested inside, per Figma node 68:865.
function ReplayCodeChip({ code }: { code: string }) {
  return (
    <div className="h-[32px] flex items-center bg-[#14181a] border border-[#2e3439] rounded-[4px] px-3">
      <span className="font-mono text-[12px] leading-none text-white/60 tracking-wider">
        {code}
      </span>
    </div>
  );
}

// 32×32 copy-share-link button. Briefly swaps the icon to a checkmark to
// confirm the copy. Sibling of ReplayCodeChip in the header.
function ReplayCopyButton({
  code,
  label,
  copiedLabel,
}: {
  code: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      const url =
        typeof window !== "undefined"
          ? `${window.location.origin}/?replay=${encodeURIComponent(code)}`
          : code;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can fail in non-secure contexts. Swallow — the user
      // can still read the code on screen and copy it manually.
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? copiedLabel : label}
      aria-label={copied ? copiedLabel : label}
      className="size-[32px] flex items-center justify-center rounded-[4px] bg-[#2e3439] hover:bg-[#3a4249] transition-colors"
    >
      {copied ? (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <path
            d="M3 8l3.5 3.5L13 5"
            stroke="#f4db50"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <MaskIcon src="/icons/figma/copy.svg" size={16} color="#f4db50" />
      )}
    </button>
  );
}

// 28×16 pill toggle matching Figma (nodes 68:918 off, 68:923 on). Off =
// surface/light track (#2e3439) with a neutral-gray knob (#abaeb0). On =
// translucent brand track (rgba(244,219,80,0.24)) with a brand-yellow knob
// (#f4db50). Knob slides via `translate-x`; track recolor + knob slide
// share a 150ms transition. Keyboard focusable, exposes role=switch.
function Toggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative h-[16px] w-[28px] rounded-full transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#f4db50] focus-visible:ring-offset-2 focus-visible:ring-offset-[#202427] ${
        checked ? "bg-[rgba(244,219,80,0.24)]" : "bg-[#2e3439]"
      }`}
    >
      <span
        aria-hidden
        className={`absolute top-0 left-0 size-[16px] rounded-full transition-[transform,background-color] duration-150 ${
          checked
            ? "translate-x-[12px] bg-[#f4db50]"
            : "translate-x-0 bg-[#abaeb0]"
        }`}
      />
    </button>
  );
}

// Segmented playback-speed selector. Fixed set of options; the active one
// gets the white/60 background per Figma. Track is a #2e3439 pill with 4px
// inner padding so the selected segment "floats" inside.
function SegmentedSpeed({
  speeds,
  current,
  onPick,
  ariaLabel,
}: {
  speeds: readonly number[];
  current: number;
  onPick: (n: number) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="h-[44px] bg-[#14181a] rounded-[6px] p-[4px] flex items-center"
    >
      {speeds.map((s) => {
        const active = s === current;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onPick(s)}
            className={`w-[36px] h-full px-3 py-1.5 rounded-[4px] text-[12px] leading-[20px] font-medium transition-colors flex items-center justify-center ${
              active
                ? "bg-white/60 text-[#202427]"
                : "text-white hover:text-white/80"
            }`}
          >
            {s}x
          </button>
        );
      })}
    </div>
  );
}

// Masked MM:SS input. Display is always formatted as M:SS (or HH:SS for
// longer sessions). User types digits only — the input strips non-digits
// and treats the trailing two digits as seconds, leading digits as minutes
// (e.g. "145" → 1:45, "12345" → 123:45). Commits on Enter/blur, cancels
// on Escape. While editing, the live formatted preview reflects what the
// user typed, not the playback clock.
function MaskedTimeInput({
  valueMs,
  maxMs,
  onCommit,
  ariaLabel,
}: {
  valueMs: number;
  maxMs: number;
  onCommit: (ms: number) => void;
  ariaLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function formatMs(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  function formatDigits(digits: string): string {
    if (!digits) return "0:00";
    const padded = digits.padStart(3, "0");
    const seconds = padded.slice(-2);
    const minutes = String(Number(padded.slice(0, -2)));
    return `${minutes}:${seconds}`;
  }

  const display = editing ? formatDigits(draft) : formatMs(valueMs);

  function commit() {
    if (!editing) return;
    const digits = draft;
    setEditing(false);
    setDraft("");
    if (!digits) return;
    const padded = digits.padStart(3, "0");
    const seconds = Number(padded.slice(-2));
    const minutes = Number(padded.slice(0, -2));
    const ms = Math.min(maxMs, Math.max(0, (minutes * 60 + seconds) * 1000));
    onCommit(ms);
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={display}
      onFocus={(e) => {
        setEditing(true);
        setDraft("");
        // Select-all so a fresh edit starts cleanly without the user having
        // to manually clear the current playback timestamp first.
        requestAnimationFrame(() => e.target.select?.());
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setEditing(false);
          setDraft("");
          e.currentTarget.blur();
        }
      }}
      onChange={(e) => {
        // Strip non-digits, cap at 6 digits (999:59 ceiling — more than enough
        // for any plausible session length; the commit clamps to maxMs anyway).
        const v = e.target.value.replace(/\D/g, "").slice(0, 6);
        setDraft(v);
      }}
      className="h-[32px] w-[64px] bg-[#14181a] border border-[#2e3439] rounded-[4px] px-3 text-center text-[12px] leading-none text-white font-mono focus:outline-none focus:border-[#f4db50]"
    />
  );
}

// Small 32×32 icon button (close, ±10s skip). Uses MaskIcon so the SVG can
// be tinted via CSS. Generic — caller supplies icon + handler + label.
// `iconColor` overrides the variant's default tint (e.g. destructive red
// for the close-x icon, which ships with its own #DA6B50 fill).
function ReplayIconButton({
  iconSrc,
  iconSize,
  iconColor,
  onClick,
  label,
  variant = "neutral",
}: {
  iconSrc?: string;
  iconSize?: number;
  iconColor?: string;
  onClick: () => void;
  label: string;
  variant?: "neutral" | "yellow";
}) {
  const defaultColor = variant === "yellow" ? "#202427" : "#f4db50";
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`size-[32px] flex items-center justify-center rounded-[4px] transition-colors ${
        variant === "yellow"
          ? "bg-[#f4db50] hover:bg-[#f9e278]"
          : "bg-[#2e3439] hover:bg-[#3a4249]"
      }`}
    >
      {iconSrc && (
        <MaskIcon
          src={iconSrc}
          size={iconSize ?? 12}
          color={iconColor ?? defaultColor}
        />
      )}
    </button>
  );
}

// Skip-by-seconds button: wider than the icon variant, text label inside.
function SkipButton({
  label,
  onClick,
  ariaLabel,
}: {
  label: string;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="h-[32px] w-[42px] flex items-center justify-center rounded-[4px] bg-[#2e3439] text-white text-[12px] leading-[20px] font-medium hover:bg-[#3a4249] transition-colors"
    >
      {label}
    </button>
  );
}

// Top-level Plan/Replay segmented toggle. Lives in the tool row at the top
// of the screen; replaces what used to be a hidden submenu under the ••• menu.
// Keeps the chrome shadow/height matched to ToolSquare so the row sits flat.
function ModeToggle({
  current,
  labels,
  onPick,
}: {
  current: "plan" | "replay";
  labels: { plan: string; replay: string };
  onPick: (m: "plan" | "replay") => void;
}) {
  return (
    <div className="h-[40px] rounded-[8px] bg-[#2e3439] p-1 flex items-center gap-1 shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] shrink-0">
      {(["plan", "replay"] as const).map((m) => {
        const active = current === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onPick(m)}
            className={`h-full px-3 rounded-[6px] text-[12px] leading-[20px] font-medium flex items-center transition-colors ${
              active
                ? "bg-[#f4db50] text-[#202427]"
                : "text-white/60 hover:text-white"
            }`}
          >
            <span>{labels[m]}</span>
          </button>
        );
      })}
    </div>
  );
}

function ToolSquare({
  active,
  disabled,
  onClick,
  iconSrc,
  title,
  hotkey,
}: {
  active: boolean;
  disabled?: boolean;
  onClick?: () => void;
  iconSrc: string;
  title: string;
  hotkey?: string;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`relative size-[40px] rounded-[8px] flex items-center justify-center transition-colors shrink-0 shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] ${
        active
          ? "bg-[#f4db50]"
          : "bg-[#2e3439] hover:bg-[#3a4249] disabled:hover:bg-[#2e3439]"
      } ${disabled ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      <MaskIcon
        src={iconSrc}
        size={16}
        color={active ? "#202427" : "#f4db50"}
      />
      {hotkey && (
        <span
          aria-hidden
          className={`absolute hidden md:block top-[2px] right-[4px] text-[10px] leading-none font-semibold tracking-wide pointer-events-none ${
            active ? "text-[#202427]" : "text-white"
          }`}
        >
          {hotkey}
        </span>
      )}
    </button>
  );
}

function MenuDropdown({
  onClose,
  onClearAll,
  onImport,
  onImportCode,
  onHelp,
  onPickMap,
  onPickMode,
  onOpenMapPicker,
  onOpenLanguagePicker,
  onOpenModePicker,
  onOpenLabelColorPicker,
  onPickLabelColor,
  currentLabelColor,
  disabledClear,
  currentMapKey,
  currentMode,
  isReplayMode,
}: {
  onClose: () => void;
  onClearAll: () => void;
  onImport: () => void;
  onImportCode: () => void;
  onHelp: () => void;
  /** Desktop inline submenu pick — closes the dropdown and swaps the map. */
  onPickMap: (key: string) => void;
  /** Desktop inline submenu pick — closes the dropdown and swaps the mode. */
  onPickMode: (mode: "plan" | "replay") => void;
  /** Mobile modal picker — opens a full-screen list. */
  onOpenMapPicker: () => void;
  onOpenLanguagePicker: () => void;
  onOpenModePicker: () => void;
  /** Mobile modal — opens the label-color picker. */
  onOpenLabelColorPicker: () => void;
  /** Desktop inline submenu pick — closes the dropdown and applies the color. */
  onPickLabelColor: (color: "black" | "white") => void;
  currentLabelColor: "black" | "white";
  disabledClear: boolean;
  currentMapKey: string;
  currentMode: "plan" | "replay";
  /** When true, hide plan-mode-only menu items (Import, Import-from-code,
   *  Clear all). The replay viewer doesn't need them. */
  isReplayMode: boolean;
}) {
  const { t, locale, setLocale } = useT();
  const ref = useRef<HTMLDivElement>(null);
  // Desktop hover-submenu state (only used by the md: branch below).
  const [sub, setSub] = useState<null | "map" | "language" | "mode" | "labelColor">(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const currentMapLabel =
    MAPS.find((m) => m.key === currentMapKey)?.label ?? currentMapKey;
  const currentLocaleLabel =
    LOCALES.find((l) => l.key === locale)?.label ?? locale;
  const currentModeLabel =
    currentMode === "replay" ? t("mode.replay") : t("mode.plan");
  const currentLabelColorLabel =
    currentLabelColor === "white" ? t("labelColor.white") : t("labelColor.black");

  return (
    <div
      ref={ref}
      className="absolute right-0 top-[56px] min-w-[220px] bg-[#202427] border border-[#2e3439] rounded-[8px] shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] py-1 z-[1700]"
    >
      {/* Desktop: hover-flyout submenus anchored to the right edge.
          Mode used to be a submenu here too — promoted to a top-level
          ModeToggle next to the tools row, so we don't render it inside
          the dropdown anymore. */}
      <div className="hidden md:block">
        <SubmenuRow
          label={t("menu.map")}
          valueLabel={currentMapLabel}
          open={sub === "map"}
          onEnter={() => setSub("map")}
          onLeave={() => setSub(null)}
        >
          {sub === "map" && (
            <Submenu onLeave={() => setSub(null)}>
              {[...MAPS]
                .sort((a, b) => a.label.localeCompare(b.label))
                .map((m) => {
                  const active = m.key === currentMapKey;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => onPickMap(m.key)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-[14px] leading-[20px] transition-colors ${
                        active
                          ? "text-[#f4db50] bg-[#f4db50]/10"
                          : "text-white hover:bg-[#2e3439]"
                      }`}
                    >
                      <span className="w-4 text-center">
                        {active ? "✓" : ""}
                      </span>
                      <span>{m.label}</span>
                    </button>
                  );
                })}
            </Submenu>
          )}
        </SubmenuRow>

        <SubmenuRow
          label={t("menu.language")}
          valueLabel={currentLocaleLabel}
          open={sub === "language"}
          onEnter={() => setSub("language")}
          onLeave={() => setSub(null)}
        >
          {sub === "language" && (
            <Submenu onLeave={() => setSub(null)}>
              {LOCALES.map((l) => {
                const active = l.key === locale;
                return (
                  <button
                    key={l.key}
                    type="button"
                    onClick={() => {
                      setLocale(l.key as Locale);
                      setSub(null);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-[14px] leading-[20px] transition-colors ${
                      active
                        ? "text-[#f4db50] bg-[#f4db50]/10"
                        : "text-white hover:bg-[#2e3439]"
                    }`}
                  >
                    <span className="w-4 text-center">
                      {active ? "✓" : ""}
                    </span>
                    <span>{l.label}</span>
                  </button>
                );
              })}
            </Submenu>
          )}
        </SubmenuRow>

        <SubmenuRow
          label={t("menu.labelColor")}
          valueLabel={currentLabelColorLabel}
          open={sub === "labelColor"}
          onEnter={() => setSub("labelColor")}
          onLeave={() => setSub(null)}
        >
          {sub === "labelColor" && (
            <Submenu onLeave={() => setSub(null)}>
              {(["black", "white"] as const).map((c) => {
                const active = c === currentLabelColor;
                const label =
                  c === "white" ? t("labelColor.white") : t("labelColor.black");
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onPickLabelColor(c)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-[14px] leading-[20px] transition-colors ${
                      active
                        ? "text-[#f4db50] bg-[#f4db50]/10"
                        : "text-white hover:bg-[#2e3439]"
                    }`}
                  >
                    <span className="w-4 text-center">{active ? "✓" : ""}</span>
                    <span>{label}</span>
                  </button>
                );
              })}
            </Submenu>
          )}
        </SubmenuRow>
      </div>

      {/* Mobile: click-to-open modal picker (flyouts would overflow off-screen).
          The desktop has a top-level ModeToggle, but the mobile tool row is
          too narrow to fit it — Mode comes back into the menu on small
          viewports only. */}
      <div className="md:hidden">
        <MenuRow
          label={t("menu.mode")}
          valueLabel={currentModeLabel}
          onClick={onOpenModePicker}
        />
        <MenuRow
          label={t("menu.map")}
          valueLabel={currentMapLabel}
          onClick={onOpenMapPicker}
        />
        <MenuRow
          label={t("menu.language")}
          valueLabel={currentLocaleLabel}
          onClick={onOpenLanguagePicker}
        />
        <MenuRow
          label={t("menu.labelColor")}
          valueLabel={currentLabelColorLabel}
          onClick={onOpenLabelColorPicker}
        />
      </div>

      {/* Plan-mode-only menu items — hidden in replay mode. */}
      {!isReplayMode && (
        <>
          <div className="my-1 h-px bg-[#2e3439]" />
          <button
            type="button"
            onClick={onImport}
            className="w-full text-left px-3 py-2 text-[14px] leading-[20px] text-white hover:bg-[#2e3439] transition-colors"
          >
            {t("menu.import")}
          </button>
          <button
            type="button"
            onClick={onImportCode}
            className="w-full text-left px-3 py-2 text-[14px] leading-[20px] text-white hover:bg-[#2e3439] transition-colors"
          >
            {t("menu.importCode")}
          </button>
          <button
            type="button"
            onClick={onClearAll}
            disabled={disabledClear}
            className="w-full text-left px-3 py-2 text-[14px] leading-[20px] text-[#f26f63] hover:bg-[#f26f63]/10 disabled:text-[#f26f63]/30 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
          >
            {t("menu.clearAll")}
          </button>
        </>
      )}
      <div className="my-1 h-px bg-[#2e3439]" />
      <button
        type="button"
        onClick={onHelp}
        className="w-full text-left px-3 py-2 text-[14px] leading-[20px] text-white hover:bg-[#2e3439] transition-colors"
      >
        {t("menu.help")}
      </button>
    </div>
  );
}

/** Desktop: parent row that reveals a right-anchored flyout on hover. */
function SubmenuRow({
  label,
  valueLabel,
  open,
  onEnter,
  onLeave,
  children,
}: {
  label: string;
  valueLabel?: string;
  open: boolean;
  onEnter: () => void;
  onLeave: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="relative"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        onClick={onEnter}
        className={`w-full flex items-center gap-2 px-3 py-2 text-[14px] leading-[20px] transition-colors ${
          open ? "bg-[#2e3439] text-white" : "text-white hover:bg-[#2e3439]"
        }`}
      >
        <span className="flex-1 text-left">{label}</span>
        {valueLabel && (
          <span className="text-white/40 text-[13px] truncate max-w-[110px]">
            {valueLabel}
          </span>
        )}
        <span className="text-white/60">›</span>
      </button>
      {children}
    </div>
  );
}

/** Flyout panel that anchors to the right edge of its SubmenuRow parent. */
function Submenu({
  onLeave,
  children,
}: {
  onLeave: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onMouseLeave={onLeave}
      className="absolute left-full top-0 -ml-px min-w-[180px] bg-[#202427] border border-[#2e3439] rounded-[8px] shadow-[0px_16px_32px_0px_rgba(0,0,0,0.4)] py-1 z-[1800]"
    >
      {children}
    </div>
  );
}

/** Mobile: click-to-open row that opens a modal picker (the hover flyout
 *  would overflow off-screen on narrow viewports). */
function MenuRow({
  label,
  valueLabel,
  onClick,
}: {
  label: string;
  valueLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 text-[14px] leading-[20px] text-white hover:bg-[#2e3439] transition-colors"
    >
      <span className="flex-1 text-left">{label}</span>
      {valueLabel && (
        <span className="text-white/40 text-[13px] truncate max-w-[110px]">
          {valueLabel}
        </span>
      )}
      <span className="text-white/60">›</span>
    </button>
  );
}

/** Modal picker for single-select choices. Replaces the off-screen submenu
 *  on mobile and gives desktop a consistent experience. */
function ListPickerDialog({
  title,
  items,
  selectedKey,
  onPick,
  onClose,
}: {
  title: string;
  items: { key: string; label: string }[];
  selectedKey: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[1900] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[360px] max-w-[92vw] max-h-[80vh] bg-[#202427] rounded-[12px] shadow-[0px_16px_32px_0px_rgba(0,0,0,0.5)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 pb-3 shrink-0">
          <h2 className="font-slab text-[20px] leading-normal text-white font-medium">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("action.close")}
            className="text-white/60 hover:text-white text-[16px] leading-none"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto pb-3">
          {items.map((it) => {
            const active = it.key === selectedKey;
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => onPick(it.key)}
                className={`w-full flex items-center gap-2 px-5 py-2 text-[14px] leading-[20px] transition-colors ${
                  active
                    ? "text-[#f4db50] bg-[#f4db50]/10"
                    : "text-white hover:bg-[#2e3439]"
                }`}
              >
                <span className="w-4 text-center">{active ? "✓" : ""}</span>
                <span className="text-left">{it.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FieldLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 w-full">
      <label className="text-[12px] leading-normal text-white">{label}</label>
      {children}
    </div>
  );
}

function DarkInput({
  value,
  onChange,
  onBlur,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  return (
    <div className="bg-[#14181a] border border-[#2e3439] rounded-[4px] h-[44px] flex items-center gap-2 p-3 w-full">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        maxLength={32}
        className="flex-1 min-w-0 bg-transparent text-[14px] leading-[20px] text-[#fafafa] placeholder:text-[#fafafa]/30 focus:outline-none"
      />
      {value && (
        <button
          type="button"
          // onMouseDown instead of onClick: the input's onBlur runs before
          // click, firing substitution on the pre-cleared value. onMouseDown
          // fires first and preventing default keeps focus on the input, so
          // the field clears cleanly without re-substituting.
          onMouseDown={(e) => {
            e.preventDefault();
            onChange("");
          }}
          aria-label="Clear"
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-white/40 hover:text-white/80 hover:bg-white/10 transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M1 1L9 9M9 1L1 9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Visual Figma-styled select: shows a preview image + label + chevron.
 *  Wraps a native <select> (passed as children) that captures pointer events. */
function FakeSelectButton({
  label,
  previewUrl,
  children,
}: {
  label: string;
  previewUrl?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative bg-[#14181a] border border-[#2e3439] rounded-[4px] h-[44px] flex items-center gap-2 p-3 w-full">
      {previewUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt="" width={32} height={32} className="shrink-0" />
      )}
      <span className="flex-1 truncate text-[14px] leading-[20px] text-[#fafafa]">
        {label}
      </span>
      <ChevronDown />
      {children}
    </div>
  );
}

/** Figma 7-column color grid. Flat swatches with 24% white border, 37px high. */
function ColorGrid({
  current,
  onChange,
}: {
  current: ColorEntry;
  onChange: (c: ColorEntry) => void;
}) {
  const row1 = COLORS.slice(0, 7);
  const row2 = COLORS.slice(7, 14);
  const renderRow = (row: ColorEntry[]) => (
    <div className="flex gap-2 items-center w-full">
      {row.map((c) => {
        const selected = c.name === current.name;
        return (
          <button
            key={c.name}
            type="button"
            onClick={() => onChange(c)}
            className="flex-1 h-[37px] rounded-[4px] border border-[rgba(255,255,255,0.24)] relative overflow-hidden transition-transform hover:scale-[1.03]"
            style={{ background: c.hex }}
            title={c.label}
            aria-pressed={selected}
          >
            {selected && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src="/icons/figma/color-check.svg"
                width={24}
                height={24}
                alt=""
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              />
            )}
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="flex flex-col gap-2 w-full">
      {renderRow(row1)}
      {renderRow(row2)}
    </div>
  );
}

function IconPickerModal({
  atlas,
  current,
  onPick,
  onClose,
  color,
}: {
  atlas: AtlasKey;
  current: IconEntry;
  onPick: (i: IconEntry) => void;
  onClose: () => void;
  color: string;
}) {
  const { t } = useT();
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const base = ICONS.filter((i) => i.atlas === atlas);
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.quad.toLowerCase().includes(q) ||
        i.category.toLowerCase().includes(q),
    );
  }, [atlas, search]);

  const totalForAtlas = ICONS.filter((i) => i.atlas === atlas).length;
  const heading =
    atlas === "vanilla"
      ? t("modal.vanillaIcons")
      : t("modal.tsMarkersIcons");

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm"
      onClick={onClose}
      style={{ zoom: 0.8 }}
    >
      <div
        className="bg-slate-800 ring-1 ring-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col text-slate-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-slate-700">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-white">{heading}</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 transition-colors"
              aria-label={t("action.close")}
            >
              ✕
            </button>
          </div>

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("placeholder.search")}
            autoFocus
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-yellow-400"
          />
          <p className="text-xs text-slate-500 mt-2">
            {t("modal.iconsCount", {
              visible: visible.length,
              total: totalForAtlas,
            })}
          </p>
        </div>

        <div className="p-4 overflow-y-auto">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
            {visible.map((i) => {
              const selected =
                i.atlas === current.atlas && i.quad === current.quad;
              return (
                <button
                  key={`${i.atlas}/${i.category}/${i.quad}`}
                  type="button"
                  onClick={() => onPick(i)}
                  className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors ${
                    selected
                      ? "border-yellow-400 bg-yellow-400/10"
                      : "border-slate-700 hover:border-slate-500 hover:bg-slate-700/40"
                  }`}
                  title={`${i.category}/${i.quad}`}
                >
                  <div className="bg-slate-900 ring-1 ring-slate-700 rounded p-1.5">
                    <MarkerIcon icon={i} color={color} size={48} />
                  </div>
                  <span className="font-mono text-[10px] text-slate-300 text-center leading-tight break-all">
                    {i.label}
                  </span>
                </button>
              );
            })}
          </div>
          {visible.length === 0 && (
            <p className="text-center text-slate-500 py-8">
              {t("modal.noIcons", { q: search })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
