import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createLeadList } from "@/lib/queries";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  name: z.string().min(1),
  source: z.enum(["apollo", "manual"]).default("manual"),
  campaignId: z.string().uuid().nullable().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "Name is required");
    const leadList = await createLeadList(parsed.data.campaignId ?? null, {
      name: parsed.data.name,
      source: parsed.data.source,
      industry: "",
      targetAudience: "",
      senderName: "",
      senderTitle: "",
      rawSubjectStructure: "",
      rawEmailStructure: "",
      ctaLink: "",
      earlyBirdLine: "",
      otherRequiredElements: [],
      bannedPhrases: [],
      universalImageUrl: null,
      followupDay3Guidance: "",
      followupDay7Guidance: "",
      followupDay14Guidance: "",
      followupOffsetsDays: [3, 7, 14],
      timezone: "UTC",
      dailyCap: 20,
      windowStartMinutes: 540,
      windowEndMinutes: 1080,
      dripBatchSize: 5,
      dripIntervalMinutes: 180,
      activeDays: [1, 2, 3, 4, 5],
      status: "active",
      testMode: false,
    });
    return NextResponse.json({ leadList }, { status: 201 });
  } catch (err) {
    return handleRouteError(err, "ingestion");
  }
}
