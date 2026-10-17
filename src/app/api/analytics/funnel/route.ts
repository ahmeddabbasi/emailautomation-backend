import { NextRequest, NextResponse } from "next/server";
import { getSequenceFunnel, scopeFromSearchParams } from "@/lib/analytics";
import { handleRouteError } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  try {
    const funnel = await getSequenceFunnel(scopeFromSearchParams(request.nextUrl.searchParams));
    return NextResponse.json({ funnel });
  } catch (err) {
    return handleRouteError(err, "analytics");
  }
}
