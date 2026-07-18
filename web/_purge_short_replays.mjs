// One-off cleanup: list (and optionally delete) replays shorter than
// 10 minutes. Reads DATABASE_URL from .env.production.tmp.
//
// Replay duration is derived from the last event's `t` field (mod-side
// time in seconds from session start). The recorder appends events
// chronologically, so the last entry has the largest t.
//
// Usage:
//   node _purge_short_replays.mjs           # dry run (lists candidates)
//   node _purge_short_replays.mjs --delete  # actually deletes them

import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const envText = readFileSync(".env.production.tmp", "utf8");
const dbLine = envText
  .split(/\r?\n/)
  .find((l) => l.startsWith("DATABASE_URL="));
if (!dbLine) {
  console.error("DATABASE_URL not found in .env.production.tmp");
  process.exit(1);
}
const dbUrl = dbLine.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, "");
const sql = neon(dbUrl);

const THRESHOLD_S = 10 * 60;

// Last event's t. jsonb_array_length is 1-indexed via -> with array length.
// jsonb_array_elements would scan all 373k entries per row — slow at scale.
// Direct index access via -> with the computed last index is O(1).
const rows = await sql`
  SELECT
    code,
    world,
    created_at,
    jsonb_array_length(events) AS event_count,
    (events->(jsonb_array_length(events) - 1)->>'t')::float AS last_t
  FROM replays
  WHERE jsonb_array_length(events) > 0
  ORDER BY created_at DESC
`;

const candidates = rows.filter((r) => r.last_t !== null && r.last_t < THRESHOLD_S);
const empty = await sql`
  SELECT code, world, created_at FROM replays WHERE jsonb_array_length(events) = 0
`;

console.log(`Total replays scanned: ${rows.length + empty.length}`);
console.log(`Empty (zero-event) replays: ${empty.length}`);
console.log(`Replays under ${THRESHOLD_S}s (${THRESHOLD_S / 60} min): ${candidates.length}`);
console.log("");
console.log("Candidates (code | world | duration | events | created):");
for (const r of candidates) {
  const mins = (r.last_t / 60).toFixed(1);
  console.log(
    `  ${r.code}  ${r.world.padEnd(20)}  ${mins.padStart(5)}m  ${String(r.event_count).padStart(7)}  ${r.created_at}`,
  );
}
for (const r of empty) {
  console.log(
    `  ${r.code}  ${r.world.padEnd(20)}  EMPTY  ${"0".padStart(7)}  ${r.created_at}`,
  );
}

if (process.argv.includes("--delete")) {
  const allCodes = [...candidates.map((r) => r.code), ...empty.map((r) => r.code)];
  if (allCodes.length === 0) {
    console.log("\nNothing to delete.");
    process.exit(0);
  }
  console.log(`\nDeleting ${allCodes.length} replay(s)...`);
  const result = await sql`DELETE FROM replays WHERE code = ANY(${allCodes}) RETURNING code`;
  console.log(`Deleted ${result.length} row(s).`);
} else {
  console.log("\n(dry run — pass --delete to actually remove)");
}
