// Dev-only fallback: when `DATABASE_URL` is empty (typical for local UI
// iteration without pulling Vercel secrets), serve replays from static JSON
// fixtures in `public/dev-fixtures/`. Production builds with a real DB
// never touch this path because `hasDatabase` is true.
//
// The fixture file shape mirrors what the `[code]` route returns for the
// full-payload case (events array inlined) so the same client code paths
// work without modification.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReplayEvent, ReplayMeta } from "./replay";

type FixtureFile = {
  code: string;
  world: string;
  meta: ReplayMeta;
  created_at: string;
  totalEvents: number;
  events: ReplayEvent[];
};

const FIXTURES_DIR = path.join(process.cwd(), "public", "dev-fixtures");

let cache: Map<string, FixtureFile> | null = null;

async function loadAll(): Promise<Map<string, FixtureFile>> {
  if (cache) return cache;
  const map = new Map<string, FixtureFile>();
  try {
    const entries = await fs.readdir(FIXTURES_DIR);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(FIXTURES_DIR, name), "utf8");
      const parsed = JSON.parse(raw) as FixtureFile;
      map.set(parsed.code, parsed);
    }
  } catch {
    // Missing fixtures dir is fine — fixture mode just yields zero replays.
  }
  cache = map;
  return map;
}

export async function listFixtureReplays(): Promise<
  Array<{ code: string; world: string; meta: ReplayMeta; created_at: string }>
> {
  const map = await loadAll();
  return Array.from(map.values())
    .map(({ code, world, meta, created_at }) => ({ code, world, meta, created_at }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getFixtureReplay(
  code: string,
  offset: number | null,
  limit: number | null,
): Promise<{
  code: string;
  world: string;
  meta: ReplayMeta;
  events: ReplayEvent[];
  created_at: string;
  totalEvents: number;
  offset?: number;
  limit?: number;
} | null> {
  const map = await loadAll();
  const fixture = map.get(code);
  if (!fixture) return null;
  if (offset !== null && limit !== null) {
    return {
      code: fixture.code,
      world: fixture.world,
      meta: fixture.meta,
      events: fixture.events.slice(offset, offset + limit),
      created_at: fixture.created_at,
      totalEvents: fixture.totalEvents,
      offset,
      limit,
    };
  }
  return {
    code: fixture.code,
    world: fixture.world,
    meta: fixture.meta,
    events: fixture.events,
    created_at: fixture.created_at,
    totalEvents: fixture.totalEvents,
  };
}
