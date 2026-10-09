import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { isValidCode } from "@/lib/code";
import { DEV_PLAN_STORE, devGetPlan } from "@/lib/devPlans";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;

  if (!isValidCode(code)) {
    return NextResponse.json(
      { error: "Invalid code format" },
      { status: 400 },
    );
  }

  const result = DEV_PLAN_STORE
    ? [await devGetPlan(code)].filter(Boolean).map((data) => ({ data }))
    : await sql`
        SELECT data FROM plans WHERE code = ${code}
      `;

  if (result.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Echo the row's code into the body. The mod stamps the active replay
  // (meta.planCode) only when the fetched plan carries `code`, and since the
  // POST went server-mint the stored data no longer has one — without this,
  // every /syncplan silently skipped the stamp. Placed last so it wins over
  // any stale `code` an old client left in `data`.
  return NextResponse.json({ ...result[0].data, code });
}
