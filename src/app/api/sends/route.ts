import { NextRequest, NextResponse } from "next/server";
import { listSends } from "@/lib/queries";
import { handleRouteError } from "@/lib/api-helpers";
import type { SendStatus } from "@/lib/supabase/db-types";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const result = await listSends({
      campaignId: searchParams.get("campaignId") ?? undefined,
      leadListId: searchParams.get("leadListId") ?? undefined,
      status: status === "sent" || status === "failed" ? (status as SendStatus) : undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      q: searchParams.get("q") ?? undefined,
      page: searchParams.get("page") ? Number(searchParams.get("page")) : undefined,
      pageSize: searchParams.get("pageSize") ? Number(searchParams.get("pageSize")) : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleRouteError(err);
  }
}
