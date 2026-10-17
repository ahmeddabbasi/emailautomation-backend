import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsOverview, scopeFromSearchParams } from "@/lib/analytics";
import { handleRouteError } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  try {
    const overview = await getAnalyticsOverview(scopeFromSearchParams(request.nextUrl.searchParams));
    return NextResponse.json(overview);
  } catch (err) {
    return handleRouteError(err, "analytics");
  }
}
