import { NextRequest, NextResponse } from "next/server";
import { listErrorLogGroups, listFacets } from "@/lib/error-logs";
import { filtersFromSearchParams } from "@/lib/error-log-filters";
import { handleRouteError } from "@/lib/api-helpers";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const page = Math.max(Number(params.get("page")) || 1, 1);
    const [{ groups, total }, facets] = await Promise.all([
      listErrorLogGroups(filtersFromSearchParams(params), page),
      listFacets(),
    ]);
    return NextResponse.json({ groups, total, page, facets });
  } catch (err) {
    return handleRouteError(err, "api");
  }
}
