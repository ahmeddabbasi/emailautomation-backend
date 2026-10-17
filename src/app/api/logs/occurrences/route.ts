import { NextRequest, NextResponse } from "next/server";
import { listOccurrences } from "@/lib/error-logs";
import { filtersFromSearchParams } from "@/lib/error-log-filters";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const fingerprint = params.get("fingerprint");
    if (!fingerprint) return jsonError(400, "fingerprint is required");
    const occurrences = await listOccurrences(fingerprint, filtersFromSearchParams(params));
    return NextResponse.json({ occurrences });
  } catch (err) {
    return handleRouteError(err, "api");
  }
}
