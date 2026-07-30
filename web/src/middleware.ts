import { NextRequest, NextResponse } from "next/server";

// Basic Auth gate — recorder endpoints only. The commander-facing surface
// (pages, plan POST, all reads) is deliberately public: a plan's 6-char
// code is the capability token for reading, and plan codes stopped being a
// write capability when client-supplied codes were removed from POST
// /api/plans (server-mint only — nothing to overwrite). The only writers
// that remain privileged are the TS Replay recorder's POSTs, whose secret
// lives in ts_replay.json on the game server — keeping auth there costs no
// user any UX and stops strangers from creating/appending replay rows.

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
  // Reads on the replay endpoints stay public (recent list + by-code).
  if (req.method === "GET") return NextResponse.next();

  const user = process.env.PLANNER_USER;
  const pass = process.env.PLANNER_PASS;
  if (!user || !pass) {
    // Dev convenience: running `next dev` locally without env vars shouldn't
    // require auth. In production, missing vars means the deploy was
    // misconfigured — fail closed on replay writes so we don't silently
    // ship an open recorder endpoint.
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("Planner auth not configured", { status: 503 });
  }

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

export const config = {
  // Only the replay endpoints flow through the auth gate. Pages, plan
  // routes, and static assets are fully public.
  matcher: ["/api/replays", "/api/replays/:path*"],
};
