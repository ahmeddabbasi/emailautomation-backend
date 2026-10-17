import { NextRequest, NextResponse } from "next/server";
import { runDispatchTick } from "@/lib/dispatch";
import { env } from "@/lib/env";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import { logWarning } from "@/lib/logger";

export const maxDuration = 300;

// The real trigger is Supabase pg_cron + pg_net calling this every 15
// minutes with an Authorization: Bearer <CRON_SECRET> header (see SETUP.md)
// — Vercel's Hobby plan only allows daily cron, which can't honor intra-day
// drip pacing, so vercel.json's entry is just a once-a-day fallback in case
// the Supabase schedule stalls. No session cookie required — this must work
// machine-to-machine, and it's safe to call this route as often as needed:
// it does no work and returns fast when nothing is due (see runDispatchTick).
function isAuthorized(request: NextRequest): boolean {
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${env.cronSecret}`;
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    logWarning("cron", "CRON_UNAUTHORIZED", "Dispatch endpoint called without a valid cron secret", {
      details: { hasAuthorizationHeader: request.headers.has("authorization") },
    });
    return jsonError(401, "Unauthorized");
  }
  try {
    const summary = await runDispatchTick();
    console.log(
      `[cron/dispatch] processed=${summary.processed} sent=${summary.sent} failed=${summary.failed} generationFailed=${summary.generationFailed}`
    );
    return NextResponse.json(summary);
  } catch (err) {
    return handleRouteError(err, "cron");
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
