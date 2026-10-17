import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCampaignById, listLeadLists, createLeadList } from "@/lib/queries";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const leadLists = await listLeadLists(id);
    return NextResponse.json({ leadLists });
  } catch (err) {
    return handleRouteError(err);
  }
}

const createSchema = z.object({
  name: z.string().min(1, "Name is required"),
  source: z.enum(["apollo", "manual"]),
  industry: z.string().default(""),
  targetAudience: z.string().default(""),
  senderName: z.string().default(""),
  senderTitle: z.string().default(""),
  rawSubjectStructure: z.string().default(""),
  rawEmailStructure: z.string().default(""),
  ctaLink: z.string().default(""),
  earlyBirdLine: z.string().default(""),
  otherRequiredElements: z.array(z.string()).default([]),
  bannedPhrases: z.array(z.string()).default([]),
  universalImageUrl: z.string().nullable().default(null),
  followupDay3Guidance: z.string().default(""),
  followupDay7Guidance: z.string().default(""),
  followupDay14Guidance: z.string().default(""),
  followupOffsetsDays: z.array(z.number().int().positive()).length(3).default([3, 7, 14]),
  timezone: z.string().default("UTC"),
  dailyCap: z.number().int().positive().default(20),
  windowStartMinutes: z.number().int().min(0).max(1439).default(540),
  windowEndMinutes: z.number().int().min(1).max(1440).default(1080),
  dripBatchSize: z.number().int().positive().default(5),
  dripIntervalMinutes: z.number().int().positive().default(180),
  activeDays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  status: z.enum(["active", "paused"]).default("active"),
  testMode: z.boolean().default(false),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const campaign = await getCampaignById(id);
    if (!campaign) return jsonError(404, "Campaign not found");

    const body = await request.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, "Invalid lead list payload", { issues: parsed.error.issues });
    if (parsed.data.windowEndMinutes <= parsed.data.windowStartMinutes) {
      return jsonError(400, "Window end must be after window start");
    }

    const leadList = await createLeadList(id, parsed.data);
    return NextResponse.json({ leadList }, { status: 201 });
  } catch (err) {
    return handleRouteError(err);
  }
}
