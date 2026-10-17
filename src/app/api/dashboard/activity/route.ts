import { NextRequest, NextResponse } from "next/server";
import { getRecentActivity } from "@/lib/data";
import { handleRouteError } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const limit = Math.min(Number(params.get("limit")) || 15, 100);
    const activity = await getRecentActivity(limit, params.get("campaignId") || undefined);
    return NextResponse.json({ activity });
  } catch (err) {
    return handleRouteError(err, "analytics");
  }
}
