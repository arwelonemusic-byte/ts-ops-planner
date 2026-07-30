import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { generateCode } from "@/lib/code";

const MAX_RETRIES = 5;

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
  // sql.json() is required for JSON params: the postgres driver JSON-
  // stringifies plain-string params again, so `${string}::jsonb` stores a
  // double-encoded jsonb *string* instead of the object (neon parsed it).
  const payload = sql.json(data as never);

  // Server-mint only. Client-supplied codes (upsert semantics) were removed
  // when this endpoint went unauthenticated: with them, any plan code that
  // leaked (Discord screenshot, replay meta.planCode) was a WRITE capability
  // — one curl could replace a commander's plan before /syncplan. A `code`
  // field in the body is ignored; the response carries the minted code.

  for (let i = 0; i < MAX_RETRIES; i++) {
    const candidate = generateCode();
    const result = await sql`
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
