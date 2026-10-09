import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { generateCode } from "@/lib/code";
import { DEV_PLAN_STORE, devInsertPlan, devListLineages } from "@/lib/devPlans";
import { isLineage, isPlanKey, lineageOf } from "@/lib/planLineage";

const MAX_RETRIES = 5;
const MAX_LINEAGES = 100;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Body must be a JSON object" },
      { status: 400 },
    );
  }

  const data = body as Record<string, unknown>;
  // A TS Hub plan key groups this push with the plan's earlier versions.
  // Only its hash is stored, in its own column — never in `data`, which
  // GET /api/plans/[code] returns to anyone (see lib/planLineage.ts).
  const planKey = data.planKey;
  delete data.planKey;
  const lineage = isPlanKey(planKey) ? lineageOf(planKey) : null;
  // sql.json() is required for JSON params: the postgres driver JSON-
  // stringifies plain-string params again, so `${string}::jsonb` stores a
  // double-encoded jsonb *string* instead of the object (neon parsed it).
  // (The dev store has no `sql` at all, hence the guard.)
  const payload = DEV_PLAN_STORE ? null : sql.json(data as never);

  // Server-mint only. Client-supplied codes (upsert semantics) were removed
  // when this endpoint went unauthenticated: with them, any plan code that
  // leaked (Discord screenshot, replay meta.planCode) was a WRITE capability
  // — one curl could replace a commander's plan before /syncplan. A `code`
  // field in the body is ignored; the response carries the minted code.

  for (let i = 0; i < MAX_RETRIES; i++) {
    const candidate = generateCode();
    if (DEV_PLAN_STORE) {
      if (await devInsertPlan(candidate, data, lineage)) {
        return NextResponse.json({ code: candidate });
      }
      continue;
    }
    // Untagged pushes keep the original statement, so the planner works
    // against a database that hasn't had the `lineage` column added yet.
    const result = lineage
      ? await sql`
          INSERT INTO plans (code, data, lineage)
          VALUES (${candidate}, ${payload}::jsonb, ${lineage})
          ON CONFLICT (code) DO NOTHING
          RETURNING code
        `
      : await sql`
          INSERT INTO plans (code, data)
          VALUES (${candidate}, ${payload}::jsonb)
          ON CONFLICT (code) DO NOTHING
          RETURNING code
        `;
    if (result.length > 0) {
      return NextResponse.json({ code: candidate });
    }
  }

  return NextResponse.json(
    { error: "Failed to generate unique code" },
    { status: 500 },
  );
}

/**
 * Versions of TS Hub plans: `GET /api/plans?lineage=<sha256>,<sha256>` →
 * `{ lineages: { <sha256>: [{ code, createdAt }, …newest first] } }`.
 * The hub computes the hashes from the keys it minted.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("lineage") ?? "";
  const hashes = [...new Set(raw.split(",").filter(isLineage))].slice(0, MAX_LINEAGES);
  if (hashes.length === 0) {
    return NextResponse.json({ error: "lineage required" }, { status: 400 });
  }

  const rows = DEV_PLAN_STORE
    ? await devListLineages(hashes)
    : await sql<{ code: string; lineage: string; created_at: Date }[]>`
        SELECT code, lineage, created_at FROM plans
        WHERE lineage IN ${sql(hashes)}
        ORDER BY created_at DESC
      `;

  const lineages: Record<string, { code: string; createdAt: string }[]> = {};
  for (const h of hashes) lineages[h] = [];
  for (const r of rows) {
    lineages[r.lineage].push({
      code: r.code,
      createdAt: new Date(r.created_at).toISOString(),
    });
  }
  return NextResponse.json({ lineages });
}
