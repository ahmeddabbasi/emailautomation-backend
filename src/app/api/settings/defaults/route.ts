import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAppDefaults, saveAppDefaults } from "@/lib/app-settings";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  ctaLink: z.string().trim().max(500),
  earlyBirdLine: z.string().trim().max(1000),
});

export async function GET() {
  try {
    return NextResponse.json(await getAppDefaults());
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}

export async function PUT(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid defaults", { issues: parsed.error.issues });
    await saveAppDefaults(parsed.data);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}
