import { NextRequest, NextResponse } from "next/server";
import { hasDatabase, sql } from "@/lib/db";
import { isValidCode } from "@/lib/code";
import { getFixtureReplay } from "@/lib/replayFixtures";

// Hard ceiling on a single chunk fetch. Each event is ~95 bytes raw, so 25k
// events ~= 2.4 MB JSON — well under Vercel's 4.5 MB serverless body cap
// while still letting clients pull a meaningful slice per round-trip.
const MAX_LIMIT = 25000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;

  if (!isValidCode(code)) {
    return NextResponse.json(
      { error: "Invalid code format" },
      { status: 400 },
    );
  }

  // Parse offset/limit query params. Both must be present and valid for
  // the chunked path; otherwise we fall through to the full-payload path,
  // which preserves the pre-pagination behavior for small replays / direct
  // curl users.
  const offsetRaw = req.nextUrl.searchParams.get("offset");
  const limitRaw = req.nextUrl.searchParams.get("limit");
  let offset: number | null = null;
  let limit: number | null = null;
  if (offsetRaw !== null && limitRaw !== null) {
    offset = Number.parseInt(offsetRaw, 10);
    limit = Number.parseInt(limitRaw, 10);
    if (
      !Number.isFinite(offset) ||
      !Number.isFinite(limit) ||
      offset < 0 ||
      limit <= 0
    ) {
      return NextResponse.json(
        { error: "offset must be >= 0 and limit must be > 0" },
        { status: 400 },
      );
    }
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  }

  // Dev fixture fallback — see lib/replayFixtures.ts.
  if (!hasDatabase) {
    const payload = await getFixtureReplay(code, offset, limit);
    if (!payload) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(payload);
  }

  // Chunked path: SQL-side slice so the function never holds the full events
  // array in memory. jsonb_array_elements expands the array set-wise; the
  // outer subquery applies LIMIT/OFFSET on the rows before reaggregating
  // with jsonb_agg. ORDER BY ordinality preserves the original event order.
  if (offset !== null && limit !== null) {
    const result = await sql`
      SELECT
        code,
        world,
        meta,
        created_at,
        jsonb_array_length(events) AS total_events,
        COALESCE(
          (SELECT jsonb_agg(elem ORDER BY ord)
           FROM (
             SELECT elem, ord
             FROM jsonb_array_elements(events) WITH ORDINALITY AS x(elem, ord)
             ORDER BY ord
             OFFSET ${offset}
             LIMIT ${limit}
           ) AS sliced),
          '[]'::jsonb
        ) AS events_slice
      FROM replays
      WHERE code = ${code}
    `;
    if (result.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const row = result[0];
    return NextResponse.json({
      code: row.code,
      world: row.world,
      meta: row.meta,
      events: row.events_slice,
      created_at: row.created_at,
      totalEvents: row.total_events,
      offset,
      limit,
    });
  }

  // Full-payload path (backward compat). Adds totalEvents to the response so
  // a caller can detect "this is the whole thing" by comparing events.length
  // === totalEvents.
  const result = await sql`
    SELECT code, world, meta, events, created_at,
           jsonb_array_length(events) AS total_events
    FROM replays
    WHERE code = ${code}
  `;
  if (result.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const row = result[0];
  return NextResponse.json({
    code: row.code,
    world: row.world,
    meta: row.meta,
    events: row.events,
    created_at: row.created_at,
    totalEvents: row.total_events,
  });
}
