import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { geminiKeyHint, geminiKeySource, resolveGeminiApiKey, saveGeminiApiKey } from "@/lib/gemini-settings";
import { geminiRuntimeStatus, resetGeminiClient, resumeGemini } from "@/lib/llm";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  apiKey: z.string().trim().min(20).max(500),
});

export async function GET() {
  try {
    const apiKey = await resolveGeminiApiKey();
    return NextResponse.json({
      ...geminiRuntimeStatus(),
      configured: Boolean(apiKey),
      keyHint: geminiKeyHint(apiKey),
      source: await geminiKeySource(),
    });
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}

export async function PUT(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Paste a Gemini API key");
    await saveGeminiApiKey(parsed.data.apiKey);
    resetGeminiClient();
    resumeGemini();
    const apiKey = await resolveGeminiApiKey();
    return NextResponse.json({
      ok: true,
      ...geminiRuntimeStatus(),
      configured: Boolean(apiKey),
      keyHint: geminiKeyHint(apiKey),
      source: await geminiKeySource(),
    });
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}
