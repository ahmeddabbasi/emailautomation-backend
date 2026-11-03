import { NextResponse } from "next/server";
import { geminiKeyHint, geminiKeySource, resolveGeminiApiKey } from "@/lib/gemini-settings";
import { geminiRuntimeStatus, resumeGemini } from "@/lib/llm";
import { handleRouteError } from "@/lib/api-helpers";
import { logWarning } from "@/lib/logger";

export async function POST() {
  try {
    resumeGemini();
    await logWarning("generation", "GEMINI_RESUMED", "Gemini is the writer again. Groq will only be used if Gemini is rate limited.", {
      details: geminiRuntimeStatus(),
    });
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
