import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { isValidCode } from "@/lib/code";

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

  const result = await sql`
    SELECT data FROM plans WHERE code = ${code}
  `;

  if (result.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(result[0].data);
}
