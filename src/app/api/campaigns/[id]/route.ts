import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCampaignById, updateCampaign } from "@/lib/queries";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const campaign = await getCampaignById(id);
    if (!campaign) return jsonError(404, "Campaign not found");
    return NextResponse.json({ campaign });
  } catch (err) {
    return handleRouteError(err);
  }
}

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(["active", "paused"]).optional(),
  companyDescription: z.string().optional(),
  valueProps: z.string().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const existing = await getCampaignById(id);
    if (!existing) return jsonError(404, "Campaign not found");

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, "Invalid campaign payload", { issues: parsed.error.issues });

    const campaign = await updateCampaign(id, parsed.data);
    return NextResponse.json({ campaign });
  } catch (err) {
    return handleRouteError(err);
  }
}
