import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveOpenAiApiKey } from "@/lib/openai-settings";
import { OpenAiRequestError, requestOpenAiDraft } from "@/lib/openai";
import { ExternalServiceError } from "@/lib/errors";
import { draftRateLimit } from "@/lib/draft-rate-limit";
import { env } from "@/lib/env";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  instructions: z.string().trim().min(1).max(4000),
  senderName: z.string().trim().min(1).max(120),
  senderTitle: z.string().trim().max(120).optional().default(""),
  tone: z.enum(["professional", "friendly", "direct"]).optional().default("professional"),
  rawStructure: z.string().trim().max(4000).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Add instructions and a sender name before generating.");
    if (!draftRateLimit.allow("workspace")) {
      return jsonError(429, "Too many draft requests. Wait a minute and try again.");
    }
    const apiKey = await resolveOpenAiApiKey();
    if (!apiKey) {
      return jsonError(400, "No OpenAI key is saved. Add one in Settings, or generate without it.");
    }
    const draft = await requestOpenAiDraft({
      apiKey,
      model: env.openaiModel,
      input: parsed.data,
    });
    return NextResponse.json(draft);
  } catch (err) {
    if (err instanceof OpenAiRequestError) return handleRouteError(new ExternalServiceError("openai", err.message), "generation");
    return handleRouteError(err, "generation");
  }
}
