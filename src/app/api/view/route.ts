import { NextRequest, NextResponse } from "next/server";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import {
  getCampaign,
  getCampaigns,
  getContacts,
  getLeadList,
  getLeadLists,
  getSendLogs,
  getUiDefaults,
} from "@/lib/data";

// Page-shaped reads for the Vercel frontend. The dashboard server components
// call this instead of holding the Supabase service role key.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const resource = params.get("resource");

  try {
    switch (resource) {
      case "campaigns":
        return NextResponse.json(await getCampaigns());
      case "campaign": {
        const id = params.get("id");
        if (!id) return jsonError(400, "id is required");
        const campaign = await getCampaign(id);
        if (!campaign) return jsonError(404, "Campaign not found");
        return NextResponse.json(campaign);
      }
      case "lead-lists": {
        const campaignId = params.get("campaignId");
        if (!campaignId) return jsonError(400, "campaignId is required");
        return NextResponse.json(await getLeadLists(campaignId));
      }
      case "lead-list": {
        const id = params.get("id");
        if (!id) return jsonError(400, "id is required");
        const list = await getLeadList(id);
        if (!list) return jsonError(404, "Lead list not found");
        return NextResponse.json(list);
      }
      case "contacts":
        return NextResponse.json(
          await getContacts({
            leadListId: params.get("leadListId") || undefined,
            campaignId: params.get("campaignId") || undefined,
          })
        );
      case "sends":
        return NextResponse.json(await getSendLogs());
      case "defaults":
        return NextResponse.json(await getUiDefaults());
      default:
        return jsonError(400, "Unknown resource");
    }
  } catch (err) {
    return handleRouteError(err);
  }
}
