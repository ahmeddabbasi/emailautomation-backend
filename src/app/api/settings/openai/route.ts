import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clearOpenAiApiKey, openAiKeySource, resolveOpenAiApiKey, saveOpenAiApiKey, setWriterPreference, writerPreference } from "@/lib/openai-settings";
import { forcedWriterError, maskOpenAiKey, validateOpenAiKey } from "@/lib/openai";
import { env } from "@/lib/env";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  apiKey: z.string().trim().min(20).max(300).optional(),
  force: z.boolean().optional(),
});

async function status() {
  const apiKey = await resolveOpenAiApiKey();
  return {
    configured: Boolean(apiKey),
    keyHint: maskOpenAiKey(apiKey),
    source: await openAiKeySource(),
    model: env.openaiModel,
    forced: (await writerPreference()) === "openai",
  };
}

export async function GET() {
  try {
    return NextResponse.json(await status());
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}

export async function PUT(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || (parsed.data.apiKey === undefined && parsed.data.force === undefined)) {
      return jsonError(400, "Paste an OpenAI key that starts with sk-");
    }
    if (parsed.data.apiKey) {
      const invalid = validateOpenAiKey(parsed.data.apiKey);
      if (invalid) return jsonError(400, invalid);
      await saveOpenAiApiKey(parsed.data.apiKey);
    }
    if (parsed.data.force !== undefined) {
      if (parsed.data.force) {
        const blocked = forcedWriterError(Boolean(await resolveOpenAiApiKey()));
        if (blocked) return jsonError(400, blocked);
      }
      await setWriterPreference(parsed.data.force ? "openai" : "auto");
    }
    return NextResponse.json({ ok: true, ...(await status()) });
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}

export async function DELETE() {
  try {
    await clearOpenAiApiKey();
    return NextResponse.json({ ok: true, ...(await status()) });
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}
