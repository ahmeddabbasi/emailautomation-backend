import { NextRequest, NextResponse } from "next/server";
import { verifyMailgunSignature } from "@/lib/webhooks/mailgun-signature";
import { handleBounce, handleComplaint } from "@/lib/webhooks/handlers";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import { logWarning } from "@/lib/logger";

interface MailgunEventPayload {
  signature?: { timestamp?: string; token?: string; signature?: string };
  "event-data"?: {
    event?: string;
    recipient?: string;
    severity?: string;
    reason?: string;
    "delivery-status"?: { code?: number; message?: string; description?: string };
    message?: { headers?: { "message-id"?: string } };
  };
}

// Mailgun's tracking-event webhooks (permanent failure, complaint) —
// configured in the Mailgun dashboard against this URL, see SETUP.md. Only a
// permanent failure halts the sequence; a temporary one (mailbox full,
// greylisting) is left alone because Mailgun keeps retrying it.
export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json().catch(() => null)) as MailgunEventPayload | null;
    const sig = payload?.signature;
    const signatureProblem = !sig?.timestamp || !sig?.token || !sig?.signature
      ? "Signature fields missing"
      : !verifyMailgunSignature(sig.timestamp, sig.token, sig.signature)
        ? "Signature did not verify"
        : null;
    if (signatureProblem) {
      logWarning("webhook", "WEBHOOK_BAD_SIGNATURE", "Rejected Mailgun event webhook with an invalid signature", {
        details: { webhook: "mailgun-events", reason: signatureProblem, event: payload?.["event-data"]?.event ?? null },
      });
      return jsonError(401, "Invalid webhook signature");
    }

    const eventData = payload?.["event-data"];
    const recipient = eventData?.recipient;
    if (!recipient) {
      logWarning("webhook", "WEBHOOK_MISSING_FIELD", "Mailgun event webhook had no recipient", {
        details: { webhook: "mailgun-events", event: eventData?.event ?? null },
      });
      return jsonError(400, "Missing recipient");
    }

    if (eventData.event === "failed" && eventData.severity === "permanent") {
      const status = eventData["delivery-status"];
      const messageId = eventData.message?.headers?.["message-id"] ?? null;
      const reason = [status?.code, status?.description || status?.message || eventData.reason].filter(Boolean).join(" ") || null;
      const result = await handleBounce({ recipient, messageId, reason });
      logWarning("sending", "MAILGUN_BOUNCE", "Email bounced permanently after Mailgun accepted it", {
        details: { recipient, messageId, reason, haltedEnrollments: result.halted, sendFlagged: result.sendFlagged },
      });
      return NextResponse.json({ ok: true, action: "bounce", haltedEnrollments: result.halted.length, sendFlagged: result.sendFlagged });
    }

    if (eventData.event === "complained") {
      const halted = await handleComplaint(recipient);
      logWarning("sending", "MAILGUN_COMPLAINT", "Recipient marked an email as spam", {
        details: { recipient, haltedEnrollments: halted },
      });
      return NextResponse.json({ ok: true, action: "complaint", haltedEnrollments: halted.length });
    }

    return NextResponse.json({ ok: true, action: "ignored", event: eventData.event ?? null, severity: eventData.severity ?? null });
  } catch (err) {
    return handleRouteError(err, "webhook");
  }
}
