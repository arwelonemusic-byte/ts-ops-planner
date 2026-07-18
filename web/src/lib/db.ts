import postgres from "postgres";

// `DATABASE_URL` missing is normal locally when iterating on UI without
// pulling secrets. Routes that don't need the DB shouldn't fail to load
// just because db.ts was imported. Routes that DO hit `sql` get a clear
// runtime error from the stub instead of a confusing module-eval throw —
// and the fixture fallback in the replay routes catches the common case
// before any query runs.
const url = process.env.DATABASE_URL ?? "";

function stub(): never {
  throw new Error("DATABASE_URL is not set");
}

// postgres() pools and reuses connections for the lifetime of the
// long-lived `next start` process; queries connect lazily on first use.
export const sql = url ? postgres(url) : (stub as never);

export const hasDatabase = url.length > 0;
