import { createHash } from "node:crypto";

// TS Hub plan keys. The hub mints a random secret per hub plan and opens the
// planner with it; every push made under that key is stored with the key's
// SHA-256 ("lineage"), never the key itself. The hub (which knows the key)
// lists a plan's versions by that hash, while anyone holding a leaked plan
// code still can't push a fake "new version" of it — the hash isn't in any
// GET response and the key can't be derived from it.

export function isPlanKey(k: unknown): k is string {
  return typeof k === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(k);
}

export function lineageOf(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function isLineage(h: string): boolean {
  return /^[0-9a-f]{64}$/.test(h);
}
