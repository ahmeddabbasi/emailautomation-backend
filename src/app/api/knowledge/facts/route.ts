import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { saveFacts, regenerateBriefQuietly } from "@/lib/knowledge";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({ text: z.string().max(20000, "Company facts can be at most 20,000 characters") });

export async function PUT(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid company facts");
    await saveFacts(parsed.data.text);
    after(() => regenerateBriefQuietly("editing company facts"));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "knowledge");
  }
}
