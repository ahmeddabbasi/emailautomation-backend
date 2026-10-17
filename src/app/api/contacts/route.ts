import { NextRequest, NextResponse } from "next/server";
import { listContacts } from "@/lib/queries";
import { handleRouteError } from "@/lib/api-helpers";
import type { CampaignContactStatus } from "@/lib/supabase/db-types";

const VALID_STATUSES: CampaignContactStatus[] = [
  "queued",
  "pending",
  "stopped",
  "invalid",
  "completed",
  "generation_failed",
  "replied",
  "complained",
];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const result = await listContacts({
      leadListId: searchParams.get("leadListId") ?? undefined,
      campaignId: searchParams.get("campaignId") ?? undefined,
      status: status && VALID_STATUSES.includes(status as CampaignContactStatus)
        ? (status as CampaignContactStatus)
        : undefined,
      q: searchParams.get("q") ?? undefined,
      page: searchParams.get("page") ? Number(searchParams.get("page")) : undefined,
      pageSize: searchParams.get("pageSize") ? Number(searchParams.get("pageSize")) : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
