import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveOpenAiApiKey } from "@/lib/openai-settings";
import { OpenAiRequestError, testOpenAiKey, validateOpenAiKey } from "@/lib/openai";
import { ExternalServiceError } from "@/lib/errors";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  apiKey: z.string().trim().min(20).max(300).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError(400, "That OpenAI key is not valid");
    const apiKey = parsed.data.apiKey?.trim() || (await resolveOpenAiApiKey());
    if (!apiKey) return jsonError(400, "No OpenAI key is saved yet");
    const invalid = parsed.data.apiKey ? validateOpenAiKey(apiKey) : null;
    if (invalid) return jsonError(400, invalid);
    await testOpenAiKey(apiKey);
    return NextResponse.json({ ok: true, message: "OpenAI accepted the key" });
  } catch (err) {
    if (err instanceof OpenAiRequestError) return handleRouteError(new ExternalServiceError("openai", err.message), "settings");
    return handleRouteError(err, "settings");
  }
}
