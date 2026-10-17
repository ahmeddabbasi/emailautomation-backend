import { NextResponse } from "next/server";

// Public liveness check for Render. It does not touch the database or secrets.
export async function GET() {
  return NextResponse.json({ ok: true });
}
