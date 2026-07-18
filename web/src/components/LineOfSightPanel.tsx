"use client";

import { useT } from "@/components/LanguageProvider";
import type { LosResult } from "@/lib/los";

type Props = { result: LosResult };

const VIEW_W = 1000;
const VIEW_H = 80;
const PAD_LEFT = 16;
const PAD_RIGHT = 16;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;
const GREEN = "#22c55e";
const RED = "#f26f63";
const GRAPH_HEIGHT_PX = 83;

export default function LineOfSightPanel({ result }: Props) {
  const { t } = useT();
  const { samples, aElev, bElev, totalDistance, obstructionIdx } = result;

  const eye = 1.7;
  const terrainMin = samples.reduce((m, s) => Math.min(m, s.elev), Infinity);
  const terrainMax = samples.reduce((m, s) => Math.max(m, s.elev), -Infinity);
  const sightMax = Math.max(aElev + eye, bElev + eye);
  const yMin = terrainMin;
  const yMax = Math.max(terrainMax, sightMax);
  const yPad = Math.max(5, (yMax - yMin) * 0.1);
  const yLo = yMin - yPad * 0.2;
  const yHi = yMax + yPad;

  const plotW = VIEW_W - PAD_LEFT - PAD_RIGHT;
  const plotH = VIEW_H - PAD_TOP - PAD_BOTTOM;

  const xOf = (d: number) => PAD_LEFT + (d / totalDistance) * plotW;
  const yOf = (elev: number) =>
    PAD_TOP + plotH - ((elev - yLo) / (yHi - yLo)) * plotH;

  const terrainPath = samples
    .map((s, i) => `${i === 0 ? "M" : "L"}${xOf(s.d).toFixed(2)},${yOf(s.elev).toFixed(2)}`)
    .join(" ");
  const baseline = PAD_TOP + plotH;
  const terrainFill =
    terrainPath +
    ` L${xOf(totalDistance).toFixed(2)},${baseline.toFixed(2)}` +
    ` L${xOf(0).toFixed(2)},${baseline.toFixed(2)} Z`;

  const aX = xOf(0);
  const aY = yOf(aElev + eye);
  const bX = xOf(totalDistance);
  const bY = yOf(bElev + eye);

  const blocked = obstructionIdx !== null;
  const sightColor = blocked ? RED : GREEN;

  const obstructionPoint =
    obstructionIdx !== null
      ? {
          x: xOf(samples[obstructionIdx].d),
          y: yOf(samples[obstructionIdx].elev),
        }
      : null;

  const statusLabel = blocked
    ? t("los.blockedAt", { dist: Math.round(result.obstructionDist ?? 0) })
    : t("los.visible");

  return (
    <div
      // Mobile: sit above the bottom sheet + close-button row (the
      // --mobile-sheet-h var tracks the sheet's actual rendered height,
      // set on <main>). Desktop: anchor to the map's bottom edge.
      className="fixed left-1/2 -translate-x-1/2 bottom-[calc(var(--mobile-sheet-h,0px)+60px)] md:bottom-4 p-4 rounded-[12px] bg-[rgba(32,36,39,0.95)] backdrop-blur-[4.65px] shadow-[0_16px_32px_rgba(0,0,0,0.5)] text-white pointer-events-none z-[1000]"
      style={{
        width: "min(960px, calc(100vw - 48px))",
        fontFamily: "var(--font-roboto), ui-sans-serif, system-ui",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 6,
          fontSize: 12,
        }}
      >
        <span style={{ color: "rgba(255,255,255,0.6)" }}>{t("los.title")}</span>
        <span style={{ color: blocked ? RED : GREEN }}>{statusLabel}</span>
      </div>
      {/* Elevation labels — HTML so they're not subject to the SVG's
          preserveAspectRatio="none" stretching (which squishes glyphs). */}
      <div className="flex justify-between text-[11px] leading-none text-white/60 mb-1">
        <span>{`${Math.round(aElev)}m`}</span>
        <span>{`${Math.round(bElev)}m`}</span>
      </div>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        style={{ display: "block", width: "100%", height: GRAPH_HEIGHT_PX }}
      >
        <defs>
          <linearGradient id="losTerrainFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.25)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.02)" />
          </linearGradient>
        </defs>

        <path d={terrainFill} fill="url(#losTerrainFill)" stroke="none" />
        <path
          d={terrainPath}
          fill="none"
          stroke="#ffffff"
          strokeWidth={1}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        <line
          x1={PAD_LEFT}
          x2={VIEW_W - PAD_RIGHT}
          y1={baseline}
          y2={baseline}
          stroke="rgba(255,255,255,0.5)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        <line
          x1={aX}
          y1={aY}
          x2={bX}
          y2={bY}
          stroke={sightColor}
          strokeWidth={1.25}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />

        {obstructionPoint && (
          <g
            stroke={RED}
            strokeWidth={1.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          >
            <line
              x1={obstructionPoint.x - 6}
              y1={obstructionPoint.y - 6}
              x2={obstructionPoint.x + 6}
              y2={obstructionPoint.y + 6}
            />
            <line
              x1={obstructionPoint.x - 6}
              y1={obstructionPoint.y + 6}
              x2={obstructionPoint.x + 6}
              y2={obstructionPoint.y - 6}
            />
          </g>
        )}
      </svg>
      {/* A / B labels — also HTML for the same reason as elevations. */}
      <div className="flex justify-between text-[12px] leading-none text-white mt-1">
        <span>A</span>
        <span>B</span>
      </div>
    </div>
  );
}
