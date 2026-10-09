import { promises as fs } from "node:fs";
import path from "node:path";
import { hasDatabase } from "@/lib/db";

// Stand-in for the `plans` table on a dev machine without DATABASE_URL, so
// pushes (and the TS Hub hand-off) work locally. One JSON file in web/,
// gitignored. Never used in production — there a missing DATABASE_URL still
// fails loudly through the db.ts stub.

export const DEV_PLAN_STORE = !hasDatabase && process.env.NODE_ENV !== "production";

const FILE = path.join(process.cwd(), ".dev-plans.json");

type Row = {
  code: string;
  data: Record<string, unknown>;
  lineage: string | null;
  createdAt: string;
};

async function readAll(): Promise<Row[]> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Row[];
  } catch {
    return [];
  }
}

/** false when the code is taken (caller retries with a fresh one). */
export async function devInsertPlan(
  code: string,
  data: Record<string, unknown>,
  lineage: string | null,
): Promise<boolean> {
  const rows = await readAll();
  if (rows.some((r) => r.code === code)) return false;
  rows.push({ code, data, lineage, createdAt: new Date().toISOString() });
  await fs.writeFile(FILE, JSON.stringify(rows, null, 1));
  return true;
}

export async function devGetPlan(code: string): Promise<Record<string, unknown> | null> {
  return (await readAll()).find((r) => r.code === code)?.data ?? null;
}

export async function devListLineages(
  hashes: string[],
): Promise<{ code: string; lineage: string; created_at: string }[]> {
  const set = new Set(hashes);
  return (await readAll())
    .filter((r) => r.lineage && set.has(r.lineage))
    .map((r) => ({ code: r.code, lineage: r.lineage!, created_at: r.createdAt }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
