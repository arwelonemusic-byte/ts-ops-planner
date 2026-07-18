import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { isValidCode } from "@/lib/code";

export async function POST(
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
  if (!Array.isArray(data.events)) {
    return NextResponse.json(
      { error: "Body must contain an 'events' array" },
      { status: 400 },
    );
  }

  // Optional plan code stamped by the mod when /syncplan fires during the
  // session (see TS_ReplayRecorder.SetPlanCode). Last-wins — every flush
  // re-asserts the current code, so a second /syncplan overwrites the prior.
  // Empty / missing leaves meta.planCode untouched (so empty flushes from a
  // session that never ran /syncplan don't clobber a previously stamped code).
  const planCode =
    typeof data.planCode === "string" && data.planCode.length > 0
      ? data.planCode
      : null;

  try {
    // Two-branch query so we don't run jsonb_set with a null when no plan
    // code is provided. Both branches share the same events append.
    // sql.json() is required for JSON params: the postgres driver JSON-
    // stringifies plain-string params again, so `${string}::jsonb` stores a
    // double-encoded jsonb *string* instead of the array (neon parsed it).
    const result = planCode
      ? await sql`
          UPDATE replays
          SET
            events = events || ${sql.json(data.events as never)}::jsonb,
            meta = jsonb_set(meta, '{planCode}', to_jsonb(${planCode}::text))
          WHERE code = ${code}
          RETURNING jsonb_array_length(events) AS event_count
        `
      : await sql`
          UPDATE replays
          SET events = events || ${sql.json(data.events as never)}::jsonb
          WHERE code = ${code}
          RETURNING jsonb_array_length(events) AS event_count
        `;
    if (result.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, eventCount: result[0].event_count });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "DB error", detail: msg },
      { status: 500 },
    );
  }
}
