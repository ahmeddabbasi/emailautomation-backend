import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { runDispatchTick } from "@/lib/dispatch";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

export const maxDuration = 300;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = supabaseAdmin();
    const { count: lists } = await db.from("lead_lists").select("id", { count: "exact", head: true }).eq("campaign_id", id);
    if (!lists) return jsonError(400, "Link a lead list before running this campaign.");

    const { data: links } = await db.from("campaign_mailboxes").select("mailbox_id, mailboxes!inner(status)").eq("campaign_id", id);
    const mailboxRows = (links ?? []) as unknown as { mailboxes: { status: string } }[];
    if (mailboxRows.length > 0 && !mailboxRows.some((row) => row.mailboxes.status === "active")) {
      return jsonError(400, "A mailbox is linked, but none of them are active. Test the connection or unlink it.");
    }

    await db.from("campaigns").update({ status: "active" }).eq("id", id);
    const summary = await runDispatchTick({ campaignId: id });
    return NextResponse.json({
      summary,
      warnings: [
        mailboxRows.length === 0 ? "No Zoho mailbox is linked, so sends use Mailgun." : null,
      ].filter(Boolean),
    });
  } catch (err) {
    return handleRouteError(err, "dispatch");
  }
}
