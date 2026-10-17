import { NextRequest, NextResponse } from "next/server";
import { verifyMailgunSignature } from "@/lib/webhooks/mailgun-signature";
import { handleInboundReply } from "@/lib/webhooks/handlers";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import { logWarning } from "@/lib/logger";

function badSignature(reason: string) {
  logWarning("webhook", "WEBHOOK_BAD_SIGNATURE", "Rejected inbound webhook with an invalid signature", {
    details: { webhook: "inbound", reason },
  });
  return jsonError(401, "Invalid webhook signature");
}

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Mailgun inbound route target — configured in the Mailgun dashboard, not in
// code (see SETUP.md). No session cookie: this is called machine-to-machine
// and is exempted in middleware, so the signature check below is the only
// gate.
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData().catch(() => null);
    if (!form) return badSignature("Body was not form data");
    const timestamp = field(form, "timestamp");
    const token = field(form, "token");
    const signature = field(form, "signature");

    if (!timestamp || !token || !signature) return badSignature("Signature fields missing");
    if (!verifyMailgunSignature(timestamp, token, signature)) return badSignature("Signature did not verify");

    const sender = field(form, "sender");
    if (!sender) {
      logWarning("webhook", "WEBHOOK_MISSING_FIELD", "Inbound webhook had no sender", { details: { webhook: "inbound" } });
      return jsonError(400, "Missing sender");
    }

    const result = await handleInboundReply({
      sender,
      subject: field(form, "subject"),
      bodyPlain: field(form, "stripped-text") ?? field(form, "body-plain"),
      inReplyTo: field(form, "In-Reply-To"),
      references: field(form, "References"),
    });

    if (!result.matched) {
      logWarning("webhook", "INBOUND_REPLY_UNMATCHED", "Inbound reply did not match any sent email or active contact", {
        details: { sender, subject: field(form, "subject") },
      });
    }
    return NextResponse.json({ ok: true, matched: result.matched });
  } catch (err) {
    return handleRouteError(err, "webhook");
  }
}
