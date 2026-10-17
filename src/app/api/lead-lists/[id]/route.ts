import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getLeadListById, updateLeadList } from "@/lib/queries";
import { supabaseAdmin } from "@/lib/supabase/server";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import { rescheduleFollowups } from "@/lib/dispatch";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const leadList = await getLeadListById(id);
    if (!leadList) return jsonError(404, "Lead list not found");
    return NextResponse.json({ leadList });
  } catch (err) {
    return handleRouteError(err);
  }
}

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  industry: z.string().optional(),
  targetAudience: z.string().optional(),
  senderName: z.string().optional(),
  senderTitle: z.string().optional(),
  rawSubjectStructure: z.string().optional(),
  rawEmailStructure: z.string().optional(),
  ctaLink: z.string().optional(),
  earlyBirdLine: z.string().optional(),
  otherRequiredElements: z.array(z.string()).optional(),
  bannedPhrases: z.array(z.string()).optional(),
  universalImageUrl: z.string().nullable().optional(),
  followupDay3Guidance: z.string().optional(),
  followupDay7Guidance: z.string().optional(),
  followupDay14Guidance: z.string().optional(),
  followupOffsetsDays: z.array(z.number().int().positive()).length(3).optional(),
  timezone: z.string().optional(),
  dailyCap: z.number().int().positive().optional(),
  windowStartMinutes: z.number().int().min(0).max(1439).optional(),
  windowEndMinutes: z.number().int().min(1).max(1440).optional(),
  dripBatchSize: z.number().int().positive().optional(),
  dripIntervalMinutes: z.number().int().positive().optional(),
  activeDays: z.array(z.number().int().min(0).max(6)).optional(),
  status: z.enum(["active", "paused"]).optional(),
  testMode: z.boolean().optional(),
  campaignId: z.string().uuid().nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const existing = await getLeadListById(id);
    if (!existing) return jsonError(404, "Lead list not found");

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, "Invalid lead list payload", { issues: parsed.error.issues });

    const windowStart = parsed.data.windowStartMinutes ?? existing.window_start_minutes;
    const windowEnd = parsed.data.windowEndMinutes ?? existing.window_end_minutes;
    if (windowEnd <= windowStart) return jsonError(400, "Window end must be after window start");

    if (parsed.data.campaignId !== undefined) {
      const { error } = await supabaseAdmin().from("lead_lists").update({ campaign_id: parsed.data.campaignId }).eq("id", id);
      if (error) return jsonError(400, "Could not update the campaign link");
    }
    const { campaignId: _ignored, ...rest } = parsed.data;
    const hasOtherFields = Object.values(rest).some((value) => value !== undefined);
    const leadList = hasOtherFields ? await updateLeadList(id, rest) : await getLeadListById(id);
    if (!leadList) return jsonError(404, "Lead list not found");
    const rescheduled =
      parsed.data.testMode !== undefined && parsed.data.testMode !== existing.test_mode ? await rescheduleFollowups(leadList) : 0;
    return NextResponse.json({ leadList, rescheduled });
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}
