import { NextRequest, NextResponse } from "next/server";
import { getCampaignComparison } from "@/lib/analytics";
import { handleRouteError } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  try {
    const campaigns = await getCampaignComparison(request.nextUrl.searchParams.get("excludeTestMode") === "1");
    return NextResponse.json({ campaigns });
  } catch (err) {
    return handleRouteError(err, "analytics");
  }
}
