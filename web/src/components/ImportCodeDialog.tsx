"use client";

import { useEffect, useRef, useState } from "react";
import {
  COLORS,
  DEFAULT_COLOR,
  DEFAULT_ICON,
  ICONS,
  type ColorEntry,
} from "@/lib/markerLibrary";
import {
  DEFAULT_FACTION,
  DEFAULT_MILITARY_TYPE,
  FACTIONS,
  MILITARY_TYPES,
  type Faction,
  type MilitaryType,
} from "@/lib/militaryLibrary";
import { useT } from "@/components/LanguageProvider";

export type LoadedMarker =
  | {
      kind: "custom";
      worldX: number;
      worldY: number;
      iconCategory: string;
      iconQuad: string;
      colorName: string;
      text: string;
      rotation: number;
    }
  | {
      kind: "military";
      worldX: number;
      worldY: number;
      faction: Faction;
      type: MilitaryType;
      text: string;
      rotation: number;
    };

export type LoadedLine = {
  colorName: string;
  widthIndex: 1 | 2 | 3 | 4 | 5;
  points: [number, number][];
};

export type LoadedPlan = {
  code: string;
  markers: LoadedMarker[];
  lines: LoadedLine[];
};

// Width slider index → world meters (must match LINE_WIDTH_METERS in page.tsx).
const WIDTH_METERS: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 2,
  2: 4,
  3: 8,
  4: 12,
  5: 16,
};

function colorByEngineName(engine: string): ColorEntry {
  const lower = String(engine).toLowerCase();
  return COLORS.find((c) => c.engine.toLowerCase() === lower) ?? DEFAULT_COLOR;
}

function colorByHex(hex: string): ColorEntry {
  const lower = String(hex).toLowerCase();
  return COLORS.find((c) => c.hex.toLowerCase() === lower) ?? DEFAULT_COLOR;
}

function metersToWidthIndex(m: number): 1 | 2 | 3 | 4 | 5 {
  let bestIdx: 1 | 2 | 3 | 4 | 5 = 3;
  let bestDelta = Infinity;
  for (const k of [1, 2, 3, 4, 5] as const) {
    const d = Math.abs(WIDTH_METERS[k] - m);
    if (d < bestDelta) {
      bestDelta = d;
      bestIdx = k;
    }
  }
  return bestIdx;
}

function isValidFaction(x: unknown): x is Faction {
  return typeof x === "string" && FACTIONS.some((f) => f.key === x);
}

function isValidMilitaryType(x: unknown): x is MilitaryType {
  return typeof x === "string" && MILITARY_TYPES.some((t) => t.key === x);
}

function iconExists(category: string, quad: string): boolean {
  return ICONS.some((i) => i.category === category && i.quad === quad);
}

export function normalizePlan(raw: unknown, code: string): LoadedPlan {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawMarkers = Array.isArray(r.markers) ? r.markers : [];
  const rawLines = Array.isArray(r.lines) ? r.lines : [];

  const markers: LoadedMarker[] = [];
  for (const mm of rawMarkers) {
    if (!mm || typeof mm !== "object") continue;
    const m = mm as Record<string, unknown>;
    const worldX = Number(m.worldX ?? 0);
    const worldY = Number(m.worldY ?? 0);
    const text = typeof m.text === "string" ? m.text : "";
    const rotation = Number(m.rotation ?? 0);
    if (m.kind === "military") {
      markers.push({
        kind: "military",
        worldX,
        worldY,
        faction: isValidFaction(m.faction) ? m.faction : DEFAULT_FACTION,
        type: isValidMilitaryType(m.type) ? m.type : DEFAULT_MILITARY_TYPE,
        text,
        rotation,
      });
    } else {
      const category = String(m.iconCategory ?? DEFAULT_ICON.category);
      const quad = String(m.iconQuad ?? DEFAULT_ICON.quad);
      const iconOk = iconExists(category, quad);
      markers.push({
        kind: "custom",
        worldX,
        worldY,
        iconCategory: iconOk ? category : DEFAULT_ICON.category,
        iconQuad: iconOk ? quad : DEFAULT_ICON.quad,
        colorName: colorByEngineName(String(m.color ?? "")).name,
        text,
        rotation,
      });
    }
  }

  const lines: LoadedLine[] = [];
  for (const ll of rawLines) {
    if (!ll || typeof ll !== "object") continue;
    const l = ll as Record<string, unknown>;
    const flat = Array.isArray(l.points) ? l.points : [];
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      pts.push([Number(flat[i]), Number(flat[i + 1])]);
    }
    if (pts.length < 2) continue;
    lines.push({
      colorName: colorByHex(String(l.colorHex ?? "")).name,
      widthIndex: metersToWidthIndex(Number(l.widthM ?? 8)),
      points: pts,
    });
  }

  return { code, markers, lines };
}

type Stage =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; plan: LoadedPlan }
  | { kind: "error"; message: string };

export function ImportCodeDialog({
  onClose,
  onCommit,
}: {
  onClose: () => void;
  onCommit: (plan: LoadedPlan) => void;
}) {
  const { t, tp } = useT();
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const normalizedCode = code.trim().toUpperCase();
  const canLoad =
    /^[A-Z0-9]{1,16}$/.test(normalizedCode) && stage.kind !== "loading";

  async function load() {
    if (!canLoad) return;
    setStage({ kind: "loading" });
    try {
      const res = await fetch(`/api/plans/${encodeURIComponent(normalizedCode)}`);
      if (res.status === 404) {
        setStage({ kind: "error", message: t("importCode.notFound") });
        return;
      }
      if (!res.ok) {
        setStage({ kind: "error", message: `HTTP ${res.status}` });
        return;
      }
      const raw = await res.json();
      const plan = normalizePlan(raw, normalizedCode);
      setStage({ kind: "loaded", plan });
    } catch (e) {
      setStage({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const loadedCounts =
    stage.kind === "loaded"
      ? {
          markers: stage.plan.markers.length,
          lines: stage.plan.lines.length,
          total: stage.plan.markers.length + stage.plan.lines.length,
        }
      : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[1800] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[92vw] bg-[#202427] rounded-[12px] shadow-[0px_16px_32px_0px_rgba(0,0,0,0.5)] p-6 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-slab text-[20px] leading-[24px] text-white font-medium">
            {t("importCode.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-white/60 hover:text-white text-[14px] leading-[20px]"
            aria-label={t("action.close")}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="import-code-input"
            className="text-[12px] leading-[16px] text-white/60"
          >
            {t("importCode.label")}{" "}
            <span className="text-white/40">{t("importCode.hint")}</span>
          </label>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              id="import-code-input"
              type="text"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (stage.kind === "error" || stage.kind === "loaded") {
                  setStage({ kind: "idle" });
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  load();
                }
              }}
              placeholder="ABC123"
              maxLength={16}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 bg-[#14181a] border border-[#2e3439] rounded-[4px] h-[40px] px-3 text-[14px] leading-[20px] text-white placeholder:text-white/30 font-mono tracking-widest uppercase focus:outline-none focus:border-[#f4db50]/60"
            />
            <button
              type="button"
              onClick={load}
              disabled={!canLoad}
              className="px-4 h-[40px] rounded-[4px] bg-[#f4db50] text-[#202427] text-[14px] leading-[20px] font-medium hover:bg-[#f4db50]/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {stage.kind === "loading"
                ? t("importCode.loading")
                : t("importCode.load")}
            </button>
          </div>
        </div>

        {stage.kind === "error" && (
          <div className="rounded-[4px] bg-[#f26f63]/10 border border-[#f26f63]/40 p-3">
            <div className="text-[14px] leading-[20px] text-[#f26f63] font-medium">
              {t("importCode.failed")}
            </div>
            <div className="text-[12px] leading-[16px] text-white/60 mt-1">
              {stage.message}
            </div>
          </div>
        )}

        {stage.kind === "loaded" && loadedCounts && (
          <div className="flex flex-col gap-3">
            <div className="rounded-[4px] bg-[#14181a] border border-[#2e3439] p-3 flex flex-col gap-1">
              <div className="text-[14px] leading-[20px] text-white">
                {t("importCode.found", {
                  code: stage.plan.code,
                })}
              </div>
              <div className="text-[12px] leading-[16px] text-white/60">
                {t("importCode.breakdown", {
                  markers: loadedCounts.markers,
                  mw: tp("count.marker", loadedCounts.markers),
                  lines: loadedCounts.lines,
                  lw: tp("count.line", loadedCounts.lines),
                })}
              </div>
            </div>

            <div className="rounded-[4px] bg-[#f4db50]/10 border border-[#f4db50]/30 p-3 text-[12px] leading-[16px] text-white/80">
              {t("importCode.replaceWarning")}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStage({ kind: "idle" })}
                className="px-3 py-2 text-[14px] leading-[20px] text-white/70 hover:text-white"
              >
                {t("importCode.cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  onCommit(stage.plan);
                  onClose();
                }}
                disabled={loadedCounts.total === 0}
                className="px-4 py-2 rounded-[4px] bg-[#f4db50] text-[#202427] text-[14px] leading-[20px] font-medium hover:bg-[#f4db50]/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t("importCode.replace")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
