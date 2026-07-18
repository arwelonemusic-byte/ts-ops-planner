import { NextRequest, NextResponse } from "next/server";
import { hasDatabase, sql } from "@/lib/db";
import { generateCode } from "@/lib/code";
import { listFixtureReplays } from "@/lib/replayFixtures";

const MAX_RETRIES = 5;

// One-time schema bootstrap. CREATE TABLE IF NOT EXISTS is idempotent and
// near-free if the table already exists, so cost-on-every-POST is fine. The
// alternative is a manual psql session against the exact DATABASE_URL Vercel
// resolves to, which we burned an hour debugging when it didn't match the
// Neon SQL Editor's session.
let schemaInitPromise: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaInitPromise) {
    schemaInitPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS replays (
          code        TEXT PRIMARY KEY,
          world       TEXT NOT NULL,
          meta        JSONB NOT NULL,
          events      JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at  TIMESTAMPTZ DEFAULT NOW()
        )
      `;
    })().catch((e) => {
      // Reset on failure so the next request can retry instead of being
      // stuck on a poisoned promise.
      schemaInitPromise = null;
      throw e;
    });
  }
  return schemaInitPromise;
}

// GET /api/replays?recent=N — list metadata for the N most recent replays.
// Public (matches the current "code IS the secret" model — anyone on the
// internet who knows a code can already view via /[code]). Returned shape
// is intentionally narrow: code, world, meta (so the renderer can resolve
// the auto-detected map name), and created_at. Events are NOT included —
// callers need to fetch a specific replay to see them.
//
// Caps recent at 50 to keep the response bounded; defaults to 10 if the
// query param is missing or malformed. No pagination beyond `recent` —
// for "browse historical replays" we'd want a different design (offset/
// cursor + filtering), and that's not what this endpoint is for.
const MAX_RECENT = 50;
const DEFAULT_RECENT = 10;

export async function GET(req: NextRequest) {
  const recentRaw = req.nextUrl.searchParams.get("recent");
  if (recentRaw === null) {
    return NextResponse.json(
      { error: "Missing 'recent' query param" },
      { status: 400 },
    );
  }
  let recent = Number.parseInt(recentRaw, 10);
  if (!Number.isFinite(recent) || recent <= 0) recent = DEFAULT_RECENT;
  if (recent > MAX_RECENT) recent = MAX_RECENT;

  // Dev fixture fallback — see lib/replayFixtures.ts.
  if (!hasDatabase) {
    const replays = (await listFixtureReplays()).slice(0, recent);
    return NextResponse.json({ replays });
  }

  try {
    await ensureSchema();
    const rows = await sql`
      SELECT code, world, meta, created_at
      FROM replays
      ORDER BY created_at DESC
      LIMIT ${recent}
    `;
    return NextResponse.json({ replays: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "DB error", detail: msg },
      { status: 500 },
    );
  }
}

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
  const world = typeof data.world === "string" ? data.world : null;
  if (!world) {
    return NextResponse.json(
      { error: "Missing or invalid 'world' field" },
      { status: 400 },
    );
  }

  const meta = {
    schemaVersion: typeof data.schemaVersion === "number" ? data.schemaVersion : 1,
    startedAt: typeof data.startedAt === "number" ? data.startedAt : Date.now(),
    friendlyFactionKey:
      typeof data.friendlyFactionKey === "string" ? data.friendlyFactionKey : "",
    // The mission-author-named world file (renameable, not stable for map
    // detection — see terrainResource below).
    worldFileName: world,
    // Stable terrain identifier from a tile-supertexture resource path. The
    // path's second segment is the stock-world directory name (e.g.
    // "worlds/Arland/Terrain/.Data/Terrain_0_supertexture.edds" → Arland).
    // Empty string if the mod couldn't resolve it. Web side parses + maps.
    terrainResource:
      typeof data.terrainResource === "string" ? data.terrainResource : "",
  };
  const metaJson = JSON.stringify(meta);

  try {
    await ensureSchema();
    for (let i = 0; i < MAX_RETRIES; i++) {
      const candidate = generateCode();
      const result = await sql`
        INSERT INTO replays (code, world, meta)
        VALUES (${candidate}, ${world}, ${metaJson}::jsonb)
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
  } catch (e) {
    // Surface the underlying error so the mod / curl tester can see what
    // actually went wrong instead of a bare 500.
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "DB error", detail: msg },
      { status: 500 },
    );
  }
}
