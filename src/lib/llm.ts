import "server-only";
import { GoogleGenAI, Type } from "@google/genai";
import { env } from "@/lib/env";
import { resolveGeminiApiKey } from "@/lib/gemini-settings";
import { resolveOpenAiApiKey, writerPreference } from "@/lib/openai-settings";
import { classifyOpenAiFailure, friendlyOpenAiMessage, parseDraftContent, type OpenAiFailure } from "@/lib/openai";
import { ExternalServiceError, alreadyLogged, errorMessage } from "@/lib/errors";
import { logError, logWarning } from "@/lib/logger";
import type { GenerationProvider } from "@/lib/supabase/db-types";

export interface EmailJson {
  subject: string;
  body: string;
}

// Identifies what a model call was for, so every log entry it produces can be
// traced back to the campaign, list and contact involved.
export interface LlmContext {
  purpose: "email" | "test_email" | "company_brief";
  campaignId?: string;
  leadListId?: string;
  contactId?: string;
  campaignContactId?: string;
  sequenceStep?: number;
}

type FailureKind = "rate_limit" | "unavailable" | "deadline" | "server_error" | "auth" | "bad_request" | "bad_response" | "other";

const KIND_CODE: Record<FailureKind, string> = {
  rate_limit: "RATE_LIMIT",
  unavailable: "UNAVAILABLE",
  deadline: "DEADLINE",
  server_error: "SERVER_ERROR",
  auth: "AUTH_FAILED",
  bad_request: "BAD_REQUEST",
  bad_response: "BAD_RESPONSE",
  other: "REQUEST_FAILED",
};

const MAX_ATTEMPTS = 2;
const BACKOFF_MS = [1000, 3000];
// Short enough that one draft (Gemini, one retry, then Groq) returns before
// the Vercel proxy closes the request at 60 seconds.
const REQUEST_TIMEOUT_MS = 15000;
// Once Gemini is rate limited or down, skip it for a while instead of paying
// three failed attempts per contact for the rest of a batch.
const GEMINI_COOLDOWN_MS = 5 * 60 * 1000;
// Free tier for the pinned Gemini model allows 5 generateContent calls a minute.
export const GEMINI_REQUESTS_PER_MINUTE = 5;
let geminiCooldownUntil = 0;
let geminiRequestTimes: number[] = [];
let quotaWarnedAt = 0;

class ProviderError extends Error {
  constructor(
    public readonly provider: GenerationProvider,
    public readonly kind: FailureKind,
    message: string,
    public readonly httpStatus?: number,
    public readonly providerBody?: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function classify(status: number | undefined, text: string): FailureKind {
  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(text)) return "rate_limit";
  if (status === 504 || /DEADLINE_EXCEEDED|Deadline expired/i.test(text)) return "deadline";
  if (status === 503 || /UNAVAILABLE|overloaded|high demand/i.test(text)) return "unavailable";
  if (status === 401 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED|invalid api key/i.test(text)) return "auth";
  if (status !== undefined && status >= 500) return "server_error";
  if (status === 400 || status === 404 || status === 422 || /INVALID_ARGUMENT/.test(text)) return "bad_request";
  return "other";
}

// A quota stop or a provider deadline will not succeed on an immediate retry,
// and those retries are what pushed the browser request past the proxy limit.
const retryable = (kind: FailureKind) => kind === "unavailable" || kind === "server_error";
const fallbackEligible = (kind: FailureKind) => kind === "rate_limit" || kind === "unavailable" || kind === "deadline";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Groq's token limit clears in a few seconds. Gemini's does not, so only Groq
// gets this short wait. Anything longer is left to the fallback path.
function shortRetryMs(err: ProviderError): number | null {
  const match = `${err.message} ${err.providerBody ?? ""}`.match(/try again in ([0-9.]+)s/i);
  if (!match) return null;
  const ms = Math.ceil(Number(match[1]) * 1000) + 400;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 8000) return null;
  return ms;
}

function parseEmailJson(provider: GenerationProvider, text: string | null | undefined): EmailJson {
  if (!text) throw new ProviderError(provider, "bad_response", "Model returned an empty response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError(provider, "bad_response", "Model response was not valid JSON", undefined, text.slice(0, 500));
  }
  const candidate = parsed as Partial<EmailJson>;
  if (typeof candidate.subject !== "string" || typeof candidate.body !== "string") {
    throw new ProviderError(provider, "bad_response", "Model response was missing subject/body fields", undefined, text.slice(0, 500));
  }
  return { subject: candidate.subject, body: candidate.body };
}

let geminiClient: GoogleGenAI | null = null;
let geminiClientKey = "";

export function resetGeminiClient(): void {
  geminiClient = null;
  geminiClientKey = "";
}

export function resumeGemini(): void {
  geminiCooldownUntil = 0;
}

const groqConfigured = () => Boolean(env.groqApiKey && env.groqModel);

export function geminiRuntimeStatus() {
  const now = Date.now();
  const quotaUsed = geminiRequestTimes.filter((time) => now - time < 60_000).length;
  const coolingDown = now < geminiCooldownUntil;
  return {
    model: env.geminiModel,
    quotaUsed,
    quotaLimit: GEMINI_REQUESTS_PER_MINUTE,
    activeProvider: coolingDown && groqConfigured() ? ("groq" as const) : ("gemini" as const),
    cooldownUntil: coolingDown ? new Date(geminiCooldownUntil).toISOString() : null,
    groqConfigured: groqConfigured(),
    groqModel: env.groqModel,
  };
}

async function recordGeminiRequest(): Promise<void> {
  const now = Date.now();
  geminiRequestTimes = geminiRequestTimes.filter((time) => now - time < 60_000);
  geminiRequestTimes.push(now);
  if (geminiRequestTimes.length === GEMINI_REQUESTS_PER_MINUTE - 1 && now - quotaWarnedAt > 60_000) {
    quotaWarnedAt = now;
    await logWarning(
      "generation",
      "GEMINI_QUOTA_LOW",
      `Gemini is about to hit its free limit: ${geminiRequestTimes.length} of ${GEMINI_REQUESTS_PER_MINUTE} requests in the last minute. One more limit switches writing to Groq.`,
      { details: { quotaUsed: geminiRequestTimes.length, quotaLimit: GEMINI_REQUESTS_PER_MINUTE, model: env.geminiModel } }
    );
  }
}

async function callGemini(prompt: string, mode: "email" | "text"): Promise<string> {
  const apiKey = await resolveGeminiApiKey();
  if (!apiKey) throw new ProviderError("gemini", "auth", "Gemini API key is not configured");
  if (!geminiClient || geminiClientKey !== apiKey) {
    geminiClient = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
    geminiClientKey = apiKey;
  }
  await recordGeminiRequest();
  try {
    const response = await geminiClient.models.generateContent({
      model: env.geminiModel,
      contents: prompt,
      config:
        mode === "email"
          ? {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: { subject: { type: Type.STRING }, body: { type: Type.STRING } },
                required: ["subject", "body"],
              },
              temperature: 0.8,
            }
          : { temperature: 0.3 },
    });
    if (!response.text) throw new ProviderError("gemini", "bad_response", "Gemini returned an empty response");
    return response.text;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const status = (err as { status?: number }).status;
    const message = errorMessage(err);
    throw new ProviderError("gemini", classify(status, message), message, status, message.slice(0, 1000));
  }
}

const GROQ_JSON_INSTRUCTION =
  'Respond with only a JSON object of the form {"subject": "...", "body": "..."} and nothing else.';

const GROQ_EMAIL_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "outreach_email",
    strict: true,
    schema: {
      type: "object",
      properties: { subject: { type: "string" }, body: { type: "string" } },
      required: ["subject", "body"],
      additionalProperties: false,
    },
  },
};

function groqMessageText(message: { content?: string | null; reasoning?: string | null } | undefined): string | undefined {
  const content = message?.content?.trim();
  if (content) return content;
  const reasoning = message?.reasoning?.trim();
  if (!reasoning) return undefined;
  const start = reasoning.indexOf("{");
  const end = reasoning.lastIndexOf("}");
  if (start >= 0 && end > start) return reasoning.slice(start, end + 1);
  return undefined;
}

async function postGroq(apiKey: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; raw: string; text?: string }> {
  let res: Response;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError("groq", "unavailable", `Groq could not be reached: ${errorMessage(err)}`);
  }
  const raw = await res.text();
  if (!res.ok) return { ok: false, status: res.status, raw };
  let text: string | undefined;
  try {
    text = groqMessageText((JSON.parse(raw) as { choices?: { message?: { content?: string | null; reasoning?: string | null } }[] }).choices?.[0]?.message);
  } catch {
    throw new ProviderError("groq", "bad_response", "Groq response was not valid JSON", res.status, raw.slice(0, 500));
  }
  return { ok: true, status: res.status, raw, text };
}

async function callGroq(prompt: string, mode: "email" | "text"): Promise<string> {
  const apiKey = env.groqApiKey;
  const model = env.groqModel;
  if (!apiKey || !model) throw new ProviderError("groq", "other", "Groq is not configured");

  // gpt-oss spends its token budget on hidden reasoning first. The default
  // effort leaves content empty, and Groq then rejects the call as invalid JSON.
  const reasoning = /gpt-oss/i.test(model) ? { reasoning_effort: "low" } : {};
  const messages =
    mode === "email"
      ? [
          { role: "system", content: GROQ_JSON_INSTRUCTION },
          { role: "user", content: prompt },
        ]
      : [{ role: "user", content: prompt }];
  const base = { model, temperature: mode === "email" ? 0.8 : 0.3, max_completion_tokens: 4096, ...reasoning, messages };

  const first = await postGroq(apiKey, mode === "email" ? { ...base, response_format: GROQ_EMAIL_FORMAT } : base);
  const result =
    first.ok || mode !== "email" || first.status !== 400
      ? first
      : await postGroq(apiKey, base);

  if (!result.ok) {
    throw new ProviderError("groq", classify(result.status, result.raw), `Groq returned HTTP ${result.status}`, result.status, result.raw.slice(0, 1000));
  }
  if (!result.text) throw new ProviderError("groq", "bad_response", "Groq returned an empty response", result.status, result.raw.slice(0, 500));
  return result.text;
}

function failureDetails(err: ProviderError, ctx: LlmContext, attempt: number, maxAttempts: number) {
  return {
    provider: err.provider,
    model: err.provider === "gemini" ? env.geminiModel : err.provider === "openai" ? env.openaiModel : env.groqModel,
    httpStatus: err.httpStatus ?? null,
    providerBody: err.providerBody ?? null,
    attempt,
    maxAttempts,
    ...ctx,
  };
}

const PROVIDER_NAME: Record<GenerationProvider, string> = { gemini: "Gemini", groq: "Groq", openai: "OpenAI" };

// Runs one provider with retry/backoff on transient failures. Every failed
// attempt is logged as a warning; the caller decides whether the final
// failure is an error or a reason to fall back.
async function withRetries(
  provider: GenerationProvider,
  run: () => Promise<string>,
  ctx: LlmContext
): Promise<string> {
  let last: ProviderError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (err) {
      last = err instanceof ProviderError ? err : new ProviderError(provider, "other", errorMessage(err));
      const pause = provider === "groq" && last.kind === "rate_limit" ? shortRetryMs(last) : null;
      const willRetry = attempt < MAX_ATTEMPTS && (retryable(last.kind) || pause !== null);
      if (willRetry) {
        await logWarning("generation", `${provider.toUpperCase()}_${KIND_CODE[last.kind]}`, `${PROVIDER_NAME[provider]} request failed, retrying: ${last.message}`, {
          details: failureDetails(last, ctx, attempt, MAX_ATTEMPTS),
        });
        await sleep(pause ?? BACKOFF_MS[attempt - 1] ?? 3000);
        continue;
      }
      throw Object.assign(last, { attempt });
    }
  }
  throw last;
}

function openAiKind(failure: OpenAiFailure): FailureKind {
  if (failure === "quota" || failure === "rate_limit") return "rate_limit";
  if (failure === "timeout") return "deadline";
  if (failure === "invalid_key") return "auth";
  if (failure === "network" || failure === "unavailable") return "unavailable";
  return "bad_response";
}

async function callOpenAi(prompt: string, mode: "email" | "text"): Promise<string> {
  const apiKey = await resolveOpenAiApiKey();
  if (!apiKey) throw new ProviderError("openai", "auth", "No OpenAI key is saved.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.openaiModel,
        temperature: mode === "email" ? 0.8 : 0.3,
        max_tokens: mode === "email" ? 900 : 2000,
        ...(mode === "email" ? { response_format: { type: "json_object" } } : {}),
        messages: [
          {
            role: "system",
            content: mode === "email"
              ? "Return only JSON with keys subject and body. Use only facts in the user message."
              : "Follow the user message. Do not invent facts.",
          },
          { role: "user", content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      const failure = classifyOpenAiFailure({ status: response.status, body: raw });
      throw new ProviderError("openai", openAiKind(failure), friendlyOpenAiMessage(failure), response.status);
    }
    let content = "";
    try {
      const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
      const value = parsed.choices?.[0]?.message?.content;
      content = typeof value === "string" ? value.trim() : "";
    } catch {
      throw new ProviderError("openai", "bad_response", friendlyOpenAiMessage("bad_response"), response.status);
    }
    if (!content) throw new ProviderError("openai", "bad_response", friendlyOpenAiMessage("bad_response"), response.status);
    if (mode === "text") return content;
    const draft = parseDraftContent(content);
    if (!draft) throw new ProviderError("openai", "bad_response", friendlyOpenAiMessage("bad_response"), response.status);
    return JSON.stringify(draft);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === "AbortError") throw new ProviderError("openai", "deadline", friendlyOpenAiMessage("timeout"));
    throw new ProviderError("openai", "unavailable", friendlyOpenAiMessage("network"));
  } finally {
    clearTimeout(timer);
  }
}

async function complete(prompt: string, mode: "email" | "text", ctx: LlmContext): Promise<{ text: string; provider: GenerationProvider }> {
  if ((await writerPreference()) === "openai") {
    try {
      return { text: await withRetries("openai", () => callOpenAi(prompt, mode), ctx), provider: "openai" };
    } catch (err) {
      const openAiErr = err instanceof ProviderError ? err : new ProviderError("openai", "other", errorMessage(err));
      await logError("generation", `OPENAI_${KIND_CODE[openAiErr.kind]}`, openAiErr.message, {
        error: openAiErr,
        details: failureDetails(openAiErr, ctx, (openAiErr as ProviderError & { attempt?: number }).attempt ?? MAX_ATTEMPTS, MAX_ATTEMPTS),
      });
      throw alreadyLogged(new ExternalServiceError("openai", openAiErr.message, openAiErr));
    }
  }

  const geminiCoolingDown = Date.now() < geminiCooldownUntil;

  if (geminiCoolingDown && groqConfigured()) {
    try {
      return { text: await withRetries("groq", () => callGroq(prompt, mode), ctx), provider: "groq" };
    } catch (err) {
      const groqErr = err as ProviderError & { attempt?: number };
      await logWarning("generation", `GROQ_${KIND_CODE[groqErr.kind]}`, `Groq failed during the Gemini cooldown, retrying on Gemini: ${groqErr.message}`, {
        details: failureDetails(groqErr, ctx, groqErr.attempt ?? MAX_ATTEMPTS, MAX_ATTEMPTS),
      });
    }
  }

  let geminiErr: ProviderError & { attempt?: number };
  try {
    const text = await withRetries("gemini", () => callGemini(prompt, mode), ctx);
    geminiCooldownUntil = 0;
    return { text, provider: "gemini" };
  } catch (err) {
    geminiErr = err as ProviderError & { attempt?: number };
  }

  const geminiCode = `GEMINI_${KIND_CODE[geminiErr.kind]}`;
  const geminiDetails = failureDetails(geminiErr, ctx, geminiErr.attempt ?? MAX_ATTEMPTS, MAX_ATTEMPTS);

  if (!fallbackEligible(geminiErr.kind)) {
    await logError("generation", geminiCode, `Gemini request failed: ${geminiErr.message}`, { error: geminiErr, details: geminiDetails });
    throw alreadyLogged(new ExternalServiceError("gemini", `Gemini request failed: ${geminiErr.message}`, geminiErr));
  }

  geminiCooldownUntil = Date.now() + GEMINI_COOLDOWN_MS;

  if (!groqConfigured()) {
    await logWarning("generation", "GROQ_NOT_CONFIGURED", "Gemini is rate limited or unavailable and no Groq fallback is configured (set GROQ_API_KEY and GROQ_MODEL)", {
      details: geminiDetails,
    });
    await logError("generation", geminiCode, `Gemini request failed: ${geminiErr.message}`, { error: geminiErr, details: geminiDetails });
    throw alreadyLogged(new ExternalServiceError("gemini", `Gemini request failed: ${geminiErr.message}`, geminiErr));
  }

  await logWarning(
    "generation",
    "GENERATION_FALLBACK_TO_GROQ",
    `Gemini ${geminiErr.kind === "rate_limit" ? "hit its quota" : geminiErr.kind === "deadline" ? "timed out" : "is unavailable"}. Writing has switched to Groq${env.groqModel ? ` (${env.groqModel})` : ""} for the next ${GEMINI_COOLDOWN_MS / 60000} minutes.`,
    { details: geminiDetails }
  );

  try {
    return { text: await withRetries("groq", () => callGroq(prompt, mode), ctx), provider: "groq" };
  } catch (err) {
    const groqErr = err as ProviderError & { attempt?: number };
    const message = `Both providers failed. Gemini: ${geminiErr.message}. Groq: ${groqErr.message}`;
    await logError("generation", "GENERATION_ALL_PROVIDERS_FAILED", message, {
      error: groqErr,
      details: { gemini: geminiDetails, groq: failureDetails(groqErr, ctx, groqErr.attempt ?? MAX_ATTEMPTS, MAX_ATTEMPTS) },
    });
    throw alreadyLogged(new ExternalServiceError("groq", message, groqErr));
  }
}

// Bad JSON from a model is a transient quirk, not a provider outage: one
// fresh call is worth it before giving up on the contact.
export async function completeEmailJson(prompt: string, ctx: LlmContext): Promise<EmailJson & { provider: GenerationProvider }> {
  for (let attempt = 1; ; attempt++) {
    const { text, provider } = await complete(prompt, "email", ctx);
    try {
      return { ...parseEmailJson(provider, text), provider };
    } catch (err) {
      const parseErr = err as ProviderError;
      if (attempt >= 2) {
        await logError("generation", `${provider.toUpperCase()}_BAD_RESPONSE`, parseErr.message, {
          details: failureDetails(parseErr, ctx, attempt, 2),
        });
        throw alreadyLogged(new ExternalServiceError(provider, parseErr.message, parseErr));
      }
      await logWarning("generation", `${provider.toUpperCase()}_BAD_RESPONSE`, `${parseErr.message}; retrying once`, {
        details: failureDetails(parseErr, ctx, attempt, 2),
      });
    }
  }
}

export async function completeText(prompt: string, ctx: LlmContext): Promise<{ text: string; provider: GenerationProvider }> {
  return complete(prompt, "text", ctx);
}

export async function testGeminiKey(apiKey: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 20000 } });
    const response = await ai.models.generateContent({
      model: env.geminiModel,
      contents: "Reply with the single word ok.",
    });
    if (!response.text?.trim()) return { ok: false, message: "Gemini returned an empty response" };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: errorMessage(err).slice(0, 300) };
  }
}
