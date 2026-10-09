// TS Hub hand-off. The hub's «Нарисовать план» buttons open the planner with
//   ?mission=<id>[&plan=<code>][&key=<secret>][&event=<id>]
// mission — the hub serves its map key and Markers.layer (GET below);
// plan    — a pushed version to load (continuing a plan, or viewing one);
// key     — the hub plan's secret: pushes carrying it become new versions of
//           that plan (see lib/planLineage.ts). Absent on view-only links;
// event   — the plan is that game's plan (only used for the back link).

export const HUB_URL =
  process.env.NEXT_PUBLIC_HUB_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://hub.tacticalshift.ru"
    : "http://localhost:3010");

/** Where pushes go, persisted with the rest of the canvas. */
export type HubContext = {
  missionId: string;
  missionName: string;
  eventId: string | null;
  /** null = opened view-only: pushes stay out of the hub. */
  key: string | null;
};

export type HubMission = {
  id: string;
  name: string;
  /** Planner map key (lib/maps.ts). */
  mapKey: string;
  /** Markers.layer text, null when the mission has none. */
  layer: string | null;
};

export async function fetchHubMission(id: string): Promise<HubMission> {
  const res = await fetch(
    `${HUB_URL}/api/missions/${encodeURIComponent(id)}/planner`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as HubMission;
}

export function hubPageUrl(ctx: HubContext): string {
  return ctx.eventId
    ? `${HUB_URL}/events/${encodeURIComponent(ctx.eventId)}`
    : `${HUB_URL}/missions/${encodeURIComponent(ctx.missionId)}`;
}

export function normalizeHubContext(raw: unknown): HubContext | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.missionId !== "string" || typeof r.missionName !== "string") return null;
  return {
    missionId: r.missionId,
    missionName: r.missionName,
    eventId: typeof r.eventId === "string" ? r.eventId : null,
    key: typeof r.key === "string" ? r.key : null,
  };
}
