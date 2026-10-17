import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listCampaigns, createCampaign } from "@/lib/queries";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

export async function GET() {
  try {
    const campaigns = await listCampaigns();
    return NextResponse.json({ campaigns });
  } catch (err) {
    return handleRouteError(err);
  }
}

const createSchema = z.object({
  name: z.string().min(1, "Name is required"),
  status: z.enum(["active", "paused"]).default("active"),
  companyDescription: z.string().default(""),
  valueProps: z.string().default(""),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, "Invalid campaign payload", { issues: parsed.error.issues });

    const campaign = await createCampaign(parsed.data);
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (err) {
    return handleRouteError(err);
  }
}
