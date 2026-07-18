import { NextRequest, NextResponse } from "next/server";

// Basic Auth gate. Protects the commander-facing surface (pages + POST to
// /api/plans) behind a single shared secret configured via env vars. Reads
// are left public — a plan's 6-char code is itself the capability token,
// and the mod-side RestApi call therefore needs no credentials (and ships
// no secret). Browser Basic Auth prompts the commander once; credentials
// stay in the browser's credential cache afterwards.

const PROTECTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="TS Ops Planner", charset="UTF-8"',
    },
  });
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function middleware(req: NextRequest) {
  const user = process.env.PLANNER_USER;
  const pass = process.env.PLANNER_PASS;
  if (!user || !pass) {
    // Dev convenience: running `next dev` locally without env vars shouldn't
    // require auth. In production (Vercel), missing vars means the deploy
    // was misconfigured — fail closed on writes/pages so we don't silently
    // ship without auth. Reads stay public regardless.
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    if (isPublicRead(req)) return NextResponse.next();
    return new NextResponse("Planner auth not configured", { status: 503 });
  }

  if (isPublicRead(req)) return NextResponse.next();

  const header = req.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("basic ")) {
    return unauthorized();
  }
  let decoded = "";
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return unauthorized();
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return unauthorized();
  const u = decoded.slice(0, sep);
  const p = decoded.slice(sep + 1);
  if (!constantTimeEq(u, user) || !constantTimeEq(p, pass)) {
    return unauthorized();
  }
  return NextResponse.next();
}

/** GETs against the share-by-code endpoints are the only public surface —
 *  the 6-char code is itself the capability token, so a viewer needs no
 *  credentials to load a plan or replay. Also includes the bare
 *  `/api/replays` listing endpoint (`?recent=N`) — replay codes aren't
 *  considered sensitive in this deployment, so the empty-state replay
 *  panel can populate a recent-list dropdown for one-tap loading.
 *  Everything else (pages, write APIs) requires Basic Auth. */
function isPublicRead(req: NextRequest): boolean {
  if (req.method !== "GET") return false;
  const path = req.nextUrl.pathname;
  return (
    path.startsWith("/api/plans/") ||
    path.startsWith("/api/replays/") ||
    path === "/api/replays"
  );
}

export const config = {
  // Skip Next internals and common static assets. Anything else flows
  // through the middleware — including page routes and /api/plans POST.
  matcher: ["/((?!_next/|favicon\\.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|bin|json)$).*)"],
};
