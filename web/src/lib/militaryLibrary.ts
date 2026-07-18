// Military marker library — pre-rendered PNGs under /icons/military.
// Each icon is a composited (dimension + faction + type) symbol; for now
// dimension is fixed to "land" and we expose faction + type as selectors.

export type Faction = "blufor" | "opfor" | "indfor" | "unknown";

export type MilitaryType =
  | "empty"
  | "infantry"
  | "motorized"
  | "armor"
  | "antiarmor"
  | "mortar"
  | "artillery"
  | "fixedwing"
  | "recon"
  | "supply"
  | "maintenance"
  | "medical";

export const FACTIONS: { key: Faction; label: string }[] = [
  { key: "blufor", label: "BLUFOR" },
  { key: "opfor", label: "OPFOR" },
  { key: "indfor", label: "INDFOR" },
  { key: "unknown", label: "Unknown" },
];

export const MILITARY_TYPES: { key: MilitaryType; label: string }[] = [
  { key: "empty", label: "Empty" },
  { key: "infantry", label: "Infantry" },
  { key: "motorized", label: "Motorized" },
  { key: "armor", label: "Armor" },
  { key: "antiarmor", label: "Anti-Armor" },
  { key: "mortar", label: "Mortar" },
  { key: "artillery", label: "Artillery" },
  { key: "fixedwing", label: "Fixed Wing" },
  { key: "recon", label: "Recon" },
  { key: "supply", label: "Supply" },
  { key: "maintenance", label: "Maintenance" },
  { key: "medical", label: "Medical" },
];

export const DEFAULT_FACTION: Faction = "blufor";
export const DEFAULT_MILITARY_TYPE: MilitaryType = "infantry";

export function militaryIconUrl(faction: Faction, type: MilitaryType): string {
  return `/icons/military/land-${faction}-${type}.png`;
}

export function militaryLabel(faction: Faction, type: MilitaryType): string {
  const f = FACTIONS.find((x) => x.key === faction)?.label ?? faction;
  const t = MILITARY_TYPES.find((x) => x.key === type)?.label ?? type;
  return `${f} ${t}`.toUpperCase();
}
