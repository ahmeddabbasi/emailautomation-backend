import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveGeminiApiKey } from "@/lib/gemini-settings";
import { testGeminiKey } from "@/lib/llm";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  apiKey: z.string().trim().min(20).max(500).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError(400, "That Gemini key is not valid");
    const apiKey = parsed.data.apiKey?.trim() || (await resolveGeminiApiKey());
    if (!apiKey) return jsonError(400, "No Gemini key is saved yet");
    const result = await testGeminiKey(apiKey);
    if (!result.ok) return jsonError(502, result.message);
    return NextResponse.json({ ok: true, message: "Gemini accepted the key" });
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}
