import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  startAt: z.string().datetime(),
  timezone: z.string().min(1),
  windowStartMinutes: z.number().int().min(0).max(1439),
  windowEndMinutes: z.number().int().min(1).max(1440),
  activeDays: z.array(z.number().int().min(0).max(6)).min(1),
  action: z.enum(["schedule", "pause", "resume", "stop"]),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = schema.partial({ startAt: true, timezone: true, windowStartMinutes: true, windowEndMinutes: true, activeDays: true }).safeParse(await request.json());
    if (!parsed.success || !parsed.data.action) return jsonError(400, "Invalid schedule");
    const db = supabaseAdmin();
    const { count: lists } = await db.from("lead_lists").select("id", { count: "exact", head: true }).eq("campaign_id", id);
    if (!lists) return jsonError(400, "Link a lead list before scheduling this campaign.");

    if (parsed.data.action === "pause") {
      await db.from("campaigns").update({ status: "paused" }).eq("id", id);
    } else if (parsed.data.action === "stop") {
      await db.from("campaigns").update({ status: "paused" }).eq("id", id);
      await db.from("lead_lists").update({ status: "paused" }).eq("campaign_id", id);
    } else if (parsed.data.action === "resume") {
      await db.from("campaigns").update({ status: "active" }).eq("id", id);
      await db.from("lead_lists").update({ status: "active" }).eq("campaign_id", id);
    } else {
      const { startAt, timezone, windowStartMinutes, windowEndMinutes, activeDays } = parsed.data;
      if (!startAt || !timezone || windowStartMinutes === undefined || windowEndMinutes === undefined || !activeDays) {
        return jsonError(400, "Start time, timezone, window, and weekdays are required");
      }
      if (windowEndMinutes <= windowStartMinutes) return jsonError(400, "Window end must be after window start");
      await db.from("campaigns").update({ status: "active", schedule_start_at: startAt }).eq("id", id);
      await db
        .from("lead_lists")
        .update({
          timezone,
          window_start_minutes: windowStartMinutes,
          window_end_minutes: windowEndMinutes,
          active_days: activeDays,
          status: "active",
        })
        .eq("campaign_id", id);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "dispatch");
  }
}
