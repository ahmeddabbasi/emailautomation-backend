export type OpenAiFailure = "invalid_key" | "rate_limit" | "quota" | "timeout" | "network" | "unavailable" | "bad_response";

export class OpenAiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiRequestError";
  }
}

export interface DraftInput {
  instructions: string;
  senderName: string;
  senderTitle: string;
  tone: "professional" | "friendly" | "direct";
  rawStructure?: string;
}

export interface OpenAiDraft {
  subject: string;
  body: string;
}

const SYSTEM_PROMPT = [
  "You write one cold email draft.",
  "Use only the facts in the user message. Do not invent pricing, customers, metrics, or product details.",
  "Return JSON with keys subject and body.",
  "subject is one line under 70 characters.",
  "body is plain text in short paragraphs, with no image and no extra links.",
  "Do not add a sign-off name unless the user message includes one.",
].join(" ");

const RETRYABLE = new Set<OpenAiFailure>(["rate_limit", "timeout", "network", "unavailable"]);

export function maskOpenAiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length < 4) return "";
  const tail = trimmed.slice(-4);
  return trimmed.startsWith("sk-") ? `sk-••••${tail}` : `••••${tail}`;
}

export function forcedWriterError(configured: boolean): string | null {
  if (!configured) return "Save an OpenAI key before using it for generation.";
  return null;
}

export function validateOpenAiKey(apiKey: string): string | null {
  const trimmed = apiKey.trim();
  if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(trimmed) || trimmed.length > 300) {
    return "Paste an OpenAI key that starts with sk-";
  }
  return null;
}

export function friendlyOpenAiMessage(failure: OpenAiFailure): string {
  switch (failure) {
    case "invalid_key":
      return "OpenAI rejected this key. Check it in Settings and save it again.";
    case "rate_limit":
      return "OpenAI is rate limited right now. Wait a minute and try again.";
    case "quota":
      return "OpenAI quota is used up. Check billing, or remove the key to keep using the existing writer.";
    case "timeout":
      return "OpenAI took too long. Try again.";
    case "network":
      return "Could not reach OpenAI. Check the connection and try again.";
    case "unavailable":
      return "OpenAI is unavailable right now. Try again in a few minutes.";
    default:
      return "OpenAI did not return a usable draft. Try again.";
  }
}

export function classifyOpenAiFailure(input: { status?: number; body?: string; timedOut?: boolean; network?: boolean }): OpenAiFailure {
  if (input.timedOut) return "timeout";
  if (input.network) return "network";
  const body = input.body ?? "";
  const status = input.status;
  if (status === 401 || status === 403) return "invalid_key";
  if (/insufficient_quota|exceeded your current quota|billing_hard_limit/i.test(body)) return "quota";
  if (status === 429 || /rate.?limit/i.test(body)) return "rate_limit";
  if (status === 408) return "timeout";
  if (status !== undefined && status >= 500) return "unavailable";
  return "bad_response";
}

export function parseDraftContent(content: string): OpenAiDraft | null {
  const trimmed = content.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(trimmed.slice(start, end + 1)) as { subject?: unknown; body?: unknown };
    if (typeof value.subject !== "string" || typeof value.body !== "string") return null;
    const subject = value.subject.replace(/\s+/g, " ").trim();
    const body = value.body.trim();
    if (!subject || !body || subject.length > 200 || body.length > 8000) return null;
    return { subject, body };
  } catch {
    return null;
  }
}

function userPrompt(input: DraftInput): string {
  return [
    `Tone: ${input.tone}.`,
    `Sender name: ${input.senderName}.`,
    input.senderTitle ? `Sender title: ${input.senderTitle}.` : "",
    "Instructions:",
    input.instructions,
    input.rawStructure ? `Structure to follow:\n${input.rawStructure}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function contentFrom(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}

interface ChatResult {
  status?: number;
  text: string;
  timedOut?: boolean;
  network?: boolean;
}

async function postChat(
  apiKey: string,
  model: string,
  input: DraftInput,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<ChatResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt(input) },
        ],
      }),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { text: "", timedOut: true };
    return { text: "", network: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function requestOpenAiDraft(options: {
  apiKey: string;
  model: string;
  input: DraftInput;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}): Promise<OpenAiDraft> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 2;
  let lastFailure: OpenAiFailure = "bad_response";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await postChat(options.apiKey, options.model, options.input, fetchImpl, timeoutMs);
    if (!result.timedOut && !result.network && result.status !== undefined && result.status < 400) {
      const draft = parseDraftContent(contentFrom(result.text));
      if (draft) return draft;
      lastFailure = "bad_response";
    } else {
      lastFailure = classifyOpenAiFailure(result);
    }
    const again = attempt < maxAttempts && RETRYABLE.has(lastFailure);
    if (!again) break;
    await sleep(400 * attempt);
  }

  throw new OpenAiRequestError(friendlyOpenAiMessage(lastFailure));
}

export async function testOpenAiKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (response.ok) return;
    const body = await response.text();
    throw new OpenAiRequestError(friendlyOpenAiMessage(classifyOpenAiFailure({ status: response.status, body })));
  } catch (err) {
    if (err instanceof OpenAiRequestError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new OpenAiRequestError(friendlyOpenAiMessage("timeout"));
    }
    throw new OpenAiRequestError(friendlyOpenAiMessage("network"));
  } finally {
    clearTimeout(timer);
  }
}
