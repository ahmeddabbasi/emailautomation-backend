import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sendRawEmail, buildFromHeader } from "@/lib/sending";
import { supabaseAdmin } from "@/lib/supabase/server";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import { errorMessage } from "@/lib/errors";
import { logError } from "@/lib/logger";

const schema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  senderName: z.string().optional(),
  senderTitle: z.string().optional(),
});

// Used by both Testing tab sections: raw manual send, and the final send
// step after an AI-assisted draft has been reviewed/edited. Either way, it
// sends exactly the subject/body given — no generation happens here. Logged
// to `sends` with is_test=true so analytics excludes it entirely.
//
// "sent" here only means Mailgun's API ACCEPTED the message — delivery is
// async and can still fail afterward (bounce, ESP block). The frontend
// polls /api/testing/delivery-status with the returned message id to find
// out what actually happened, since the bounce/complaint webhook needs a
// public HTTPS URL Mailgun can reach and isn't usable from local dev.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return jsonError(400, "Invalid payload", { issues: parsed.error.issues });

    const db = supabaseAdmin();
    const { to, subject, body: emailBody, senderName, senderTitle } = parsed.data;
    const from = senderName ? buildFromHeader({ name: senderName, title: senderTitle ?? "" }) : undefined;

    try {
      const result = await sendRawEmail(to, subject, emailBody, { from });
      await db.from("sends").insert({
        campaign_contact_id: null,
        sequence_step: 0,
        subject,
        body: emailBody,
        status: "sent",
        provider_message_id: result.providerMessageId,
        is_test: true,
        test_recipient_email: to,
      });
      return NextResponse.json({ ok: true, providerMessageId: result.providerMessageId });
    } catch (sendErr) {
      await db.from("sends").insert({
        campaign_contact_id: null,
        sequence_step: 0,
        subject,
        body: emailBody,
        status: "failed",
        error_message: errorMessage(sendErr),
        is_test: true,
        test_recipient_email: to,
      });
      logError("sending", "MAILGUN_REJECTED", `Test send rejected by Mailgun: ${errorMessage(sendErr)}`, {
        error: sendErr,
        details: { recipient: to, testSend: true, subject },
      });
      return jsonError(502, `Send failed: ${errorMessage(sendErr)}`);
    }
  } catch (err) {
    return handleRouteError(err, "sending");
  }
}
