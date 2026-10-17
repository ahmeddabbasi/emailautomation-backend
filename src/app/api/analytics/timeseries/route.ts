import { NextRequest, NextResponse } from "next/server";
import { getSendsTimeseries, scopeFromSearchParams } from "@/lib/analytics";
import { handleRouteError } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const days = Number(params.get("days")) || 30;
    const buckets = await getSendsTimeseries(scopeFromSearchParams(params), days);
    return NextResponse.json({ buckets });
  } catch (err) {
    return handleRouteError(err, "analytics");
  }
}
