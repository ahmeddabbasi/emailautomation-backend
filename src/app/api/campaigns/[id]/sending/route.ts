import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { localDayRangeUtc } from "@/lib/scheduling";
import { handleRouteError } from "@/lib/api-helpers";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = supabaseAdmin();
    const { data: campaign } = await db.from("campaigns").select("status, schedule_start_at").eq("id", id).maybeSingle();
    const { data: lists } = await db.from("lead_lists").select("id, timezone").eq("campaign_id", id);
    const { count: templates } = await db.from("email_templates").select("id", { count: "exact", head: true }).eq("campaign_id", id).eq("sequence_step", 0);
    const listIds = (lists ?? []).map((list) => list.id);
    const timezone = lists?.[0]?.timezone || "UTC";

    let pending = 0;
    let replied = 0;
    let bounced = 0;
    if (listIds.length) {
      const countStatus = async (status: string) => {
        const { count } = await db.from("campaign_contacts").select("id", { count: "exact", head: true }).in("lead_list_id", listIds).eq("status", status);
        return count ?? 0;
      };
      pending = (await countStatus("pending")) + (await countStatus("queued"));
      replied = await countStatus("replied");
      bounced = await countStatus("invalid");
    }

    const { count: sent } = await db
      .from("sends")
      .select("id, campaign_contacts!inner(lead_list_id)", { count: "exact", head: true })
      .in("campaign_contacts.lead_list_id", listIds.length ? listIds : ["00000000-0000-0000-0000-000000000000"])
      .eq("status", "sent")
      .eq("is_test", false);
    const { count: failed } = await db
      .from("sends")
      .select("id, campaign_contacts!inner(lead_list_id)", { count: "exact", head: true })
      .in("campaign_contacts.lead_list_id", listIds.length ? listIds : ["00000000-0000-0000-0000-000000000000"])
      .eq("status", "failed")
      .eq("is_test", false);

    const { data: links } = await db.from("campaign_mailboxes").select("mailbox_id, mailboxes!inner(id, display_name, status, daily_limit)").eq("campaign_id", id);
    const day = localDayRangeUtc(new Date(), timezone);
    const mailboxUsage = [];
    for (const link of (links ?? []) as unknown as { mailboxes: { id: string; display_name: string; status: string; daily_limit: number } }[]) {
      const { count } = await db
        .from("mailbox_sends")
        .select("id", { count: "exact", head: true })
        .eq("mailbox_id", link.mailboxes.id)
        .gte("sent_at", day.start.toISOString());
      mailboxUsage.push({
        id: link.mailboxes.id,
        name: link.mailboxes.display_name,
        status: link.mailboxes.status,
        dailyLimit: link.mailboxes.daily_limit,
        sentToday: count ?? 0,
      });
    }

    const scheduled = campaign?.status === "active" && campaign.schedule_start_at && new Date(campaign.schedule_start_at) > new Date();
    const badge = !lists?.length ? "draft" : campaign?.status === "paused" ? "paused" : scheduled ? "scheduled" : pending === 0 && (sent ?? 0) > 0 ? "completed" : "running";

    return NextResponse.json({
      badge,
      listCount: lists?.length ?? 0,
      hasStepZeroTemplate: (templates ?? 0) > 0,
      activeMailboxes: mailboxUsage.filter((mailbox) => mailbox.status === "active").length,
      linkedMailboxes: mailboxUsage.length,
      stats: { sent: sent ?? 0, pending, failed: failed ?? 0, bounced, replied },
      mailboxUsage,
    });
  } catch (err) {
    return handleRouteError(err, "dispatch");
  }
}
