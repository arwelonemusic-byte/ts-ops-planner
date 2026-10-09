"use client";

// Read-only plan view for framing on other sites (TS Hub shows a game's attached plan with it):
//   /embed?plan=<code>[&map=<maps.ts key>][&mission=<TS Hub mission id>]
// The plan, plus the mission's Markers.layer when `mission` is given; pan and zoom only.
// The map is `map`, else the plan's own `mapKey`, else the hub mission's. It never reads
// or writes the planner's saved canvas (localStorage), so an open planner tab is unaffected.

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import type { MapApi, RenderableLine, RenderableMarker, RenderablePolygon } from "@/components/MapClient";
import { normalizePlan } from "@/components/ImportCodeDialog";
import { useT } from "@/components/LanguageProvider";
import { fetchHubMission } from "@/lib/hubLink";
import { parseMarkersLayer } from "@/lib/layerImport";
import { findMap, MAPS } from "@/lib/maps";
import { findColor, LINE_WIDTH_METERS, markerRenderable, polygonRenderable } from "@/lib/planRender";

const MapClient = dynamic(() => import("@/components/MapClient"), { ssr: false });

type Content = {
  mapKey: string;
  markers: RenderableMarker[];
  lines: RenderableLine[];
  polygons: RenderablePolygon[];
  /** World box of the plan's markers and lines: the view opens on it. */
  area: [number, number, number, number] | null;
};

/** Plans smaller than this (meters) open at this size, so a lone marker isn't shown at max zoom. */
const MIN_AREA_M = 600;

const noop = () => {};

async function load(code: string, mapParam: string | null, missionId: string | null): Promise<Content | "notFound"> {
  const res = await fetch(`/api/plans/${encodeURIComponent(code)}`);
  if (!res.ok) return "notFound";
  const raw = await res.json();
  const plan = normalizePlan(raw, code);

  // The mission's Markers.layer comes from TS Hub; without it the plan still shows.
  const mission = missionId ? await fetchHubMission(missionId).catch(() => null) : null;
  const layer = mission?.layer ? parseMarkersLayer(mission.layer) : null;

  const known = (k: unknown): k is string => typeof k === "string" && MAPS.some((m) => m.key === k);
  const mapKey = [mapParam, raw?.mapKey, mission?.mapKey].find(known) ?? findMap(null).key;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const m of plan.markers) {
    xs.push(m.worldX);
    ys.push(m.worldY);
  }
  for (const l of plan.lines) {
    for (const [x, y] of l.points) {
      xs.push(x);
      ys.push(y);
    }
  }
  let area: Content["area"] = null;
  if (xs.length) {
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const hw = Math.max(Math.max(...xs) - Math.min(...xs), MIN_AREA_M) / 2;
    const hh = Math.max(Math.max(...ys) - Math.min(...ys), MIN_AREA_M) / 2;
    area = [cx - hw, cy - hh, cx + hw, cy + hh];
  }

  return {
    mapKey,
    // Imported first so the plan's markers render on top, as in the planner.
    markers: [
      ...(layer?.markers ?? []).map((m) => markerRenderable(m, true)),
      ...plan.markers.map((m, i) => markerRenderable({ ...m, id: `plan-${i}` }, true)),
    ],
    lines: plan.lines.map((l, i) => ({
      id: `line-${i}`,
      color: findColor(l.colorName).hex,
      widthMeters: LINE_WIDTH_METERS[l.widthIndex],
      points: l.points,
      selected: false,
    })),
    polygons: (layer?.polygons ?? []).map(polygonRenderable),
    area,
  };
}

export default function EmbedPage() {
  const { t } = useT();
  const [content, setContent] = useState<Content | null>(null);
  /** The plan code that couldn't be loaded. */
  const [missing, setMissing] = useState<string | null>(null);
  const [api, setApi] = useState<MapApi | null>(null);
  const [sat, setSat] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const code = (q.get("plan") ?? "").trim().toUpperCase();
    let cancelled = false;
    load(code, q.get("map"), q.get("mission"))
      .then((c) => {
        if (cancelled) return;
        if (c === "notFound") setMissing(code);
        else setContent(c);
      })
      .catch(() => !cancelled && setMissing(code));
    return () => {
      cancelled = true;
    };
  }, []);

  const mapConfig = useMemo(() => (content ? findMap(content.mapKey) : null), [content]);

  // Open on the plan once both the map and the plan are there.
  useEffect(() => {
    if (api && content?.area) api.fitArea?.(...content.area);
  }, [api, content]);

  return (
    <div className="relative h-screen w-full bg-[#14181a]">
      {missing !== null ? (
        <div className="flex h-full items-center justify-center text-[14px] text-white/60">
          {t("hub.error.plan", { code: missing })}
        </div>
      ) : content && mapConfig ? (
        <MapClient
          mapConfig={mapConfig}
          markers={content.markers}
          lines={content.lines}
          polygons={content.polygons}
          draft={null}
          ruler={null}
          cursorMode="off"
          linesInteractive={false}
          markersInteractive={false}
          showCursorHint={false}
          onMapClick={noop}
          onMarkerClick={noop}
          onMarkerDrag={noop}
          onLineClick={noop}
          onApi={setApi}
          showControls
          satLayer={sat}
          onToggleSat={() => setSat((v) => !v)}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-[14px] text-white/60">{t("map.loading")}</div>
      )}
    </div>
  );
}
