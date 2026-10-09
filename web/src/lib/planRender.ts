// Plan content → what MapClient draws. Shared by the planner page and the
// read-only embed (app/embed), so both draw markers, lines and Markers.layer
// zones the same way.

import type { RenderableMarker, RenderablePolygon } from "@/components/MapClient";
import type { ImportedPolygon } from "@/lib/layerImport";
import { COLORS, DEFAULT_COLOR, DEFAULT_ICON, ICONS, type ColorEntry, type IconEntry } from "@/lib/markerLibrary";
import { militaryIconUrl, type Faction, type MilitaryType } from "@/lib/militaryLibrary";

/** Line width slider index → world meters (the plan schema's `widthM`). */
export const LINE_WIDTH_METERS: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 2,
  2: 4,
  3: 8,
  4: 12,
  5: 16,
};

export function findIcon(category: string, quad: string): IconEntry {
  return ICONS.find((i) => i.category === category && i.quad === quad) ?? DEFAULT_ICON;
}

export function findColor(name: string): ColorEntry {
  return COLORS.find((c) => c.name === name) ?? DEFAULT_COLOR;
}

/** A placed, loaded or imported marker: they all share this shape. */
export type PlanMarker = { id: string; worldX: number; worldY: number; text: string; rotation: number } & (
  | { kind: "custom"; iconCategory: string; iconQuad: string; colorName: string }
  | { kind: "military"; faction: Faction; type: MilitaryType }
);

export function markerRenderable(m: PlanMarker, readOnly: boolean, selected = false): RenderableMarker {
  const base = { id: m.id, worldX: m.worldX, worldY: m.worldY, rotation: m.rotation, selected, readOnly };
  if (m.kind === "military") {
    return { ...base, kind: "military", iconUrl: militaryIconUrl(m.faction, m.type), label: m.text.trim() };
  }
  return { ...base, kind: "custom", icon: findIcon(m.iconCategory, m.iconQuad), color: findColor(m.colorName).hex, label: m.text.trim() };
}

export function polygonRenderable(p: ImportedPolygon): RenderablePolygon {
  return {
    id: p.id,
    points: p.points,
    fillColor: p.fillColor,
    fillOpacity: p.fillOpacity,
    strokeColor: p.strokeColor,
    strokeOpacity: p.strokeOpacity,
    strokeWidth: p.strokeWidth,
    fillOutside: p.fillOutside,
  };
}
