import { NextRequest, NextResponse } from "next/server";
import { checkDeliveryStatus } from "@/lib/sending";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

// Polled by the Testing tab a few seconds after a send "succeeds" (i.e.
// Mailgun accepted it) to find out what actually happened — see the comment
// on /api/testing/raw-send for why this can't just wait on the webhook.
export async function GET(request: NextRequest) {
  try {
    const messageId = request.nextUrl.searchParams.get("messageId");
    const to = request.nextUrl.searchParams.get("to");
    if (!messageId || !to) return jsonError(400, "messageId and to are required");

    const result = await checkDeliveryStatus(messageId, to);
    return NextResponse.json(result);
  } catch (err) {
    return handleRouteError(err, "sending");
  }
}
