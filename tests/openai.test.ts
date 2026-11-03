import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "../src/lib/draft-rate-limit.ts";
import { decryptSecret, encryptSecret } from "../src/lib/secret-box.ts";
import {
  classifyOpenAiFailure,
  friendlyOpenAiMessage,
  forcedWriterError,
  maskOpenAiKey,
  parseDraftContent,
  requestOpenAiDraft,
  validateOpenAiKey,
} from "../src/lib/openai.ts";

test("generation cannot be forced onto OpenAI without a saved key", () => {
  assert.equal(forcedWriterError(false), "Save an OpenAI key before using it for generation.");
  assert.equal(forcedWriterError(true), null);
});

test("openai key mask keeps only the last four characters", () => {
  assert.equal(maskOpenAiKey("sk-proj-abcdefghijklmnopqrstuv1234"), "sk-••••1234");
  assert.equal(maskOpenAiKey("sk-abcdefghijklmnopqrstuv1234").includes("abcdefghijklmnop"), false);
  assert.equal(validateOpenAiKey("sk-short"), "Paste an OpenAI key that starts with sk-");
  assert.equal(validateOpenAiKey("sk-abcdefghijklmnopqrstuv"), null);
});

test("saved openai key round-trips through the existing secret box and is not stored in plain text", () => {
  const secret = "test-auth-secret";
  const key = "sk-abcdefghijklmnopqrstuv1234";
  const encrypted = encryptSecret(key, secret);
  assert.equal(encrypted.includes(key), false);
  assert.equal(decryptSecret(encrypted, secret), key);
});

test("openai failures become friendly messages without the provider body", () => {
  assert.equal(classifyOpenAiFailure({ status: 401, body: "Incorrect API key sk-secretvalue" }), "invalid_key");
  assert.equal(classifyOpenAiFailure({ status: 429, body: "rate limit" }), "rate_limit");
  assert.equal(classifyOpenAiFailure({ status: 429, body: "insufficient_quota" }), "quota");
  assert.equal(classifyOpenAiFailure({ timedOut: true }), "timeout");
  assert.equal(classifyOpenAiFailure({ network: true }), "network");
  assert.match(friendlyOpenAiMessage("invalid_key"), /rejected this key/);
  assert.equal(friendlyOpenAiMessage("quota").includes("insufficient_quota"), false);
});

test("draft parser accepts a json object and rejects an empty subject", () => {
  assert.deepEqual(parseDraftContent('{"subject":"Hello","body":"A short note."}'), {
    subject: "Hello",
    body: "A short note.",
  });
  assert.equal(parseDraftContent('{"subject":"","body":"A short note."}'), null);
});

test("generate uses the injected client and does not send when the key is rejected", async () => {
  let calls = 0;
  const draft = await requestOpenAiDraft({
    apiKey: "sk-test-key-value-not-real",
    model: "gpt-4o-mini",
    input: { instructions: "Say hello", senderName: "Ada", senderTitle: "", tone: "professional" },
    maxAttempts: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"subject":"Hello","body":"A short note."}' } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(draft.subject, "Hello");
  assert.equal(calls, 1);

  await assert.rejects(
    requestOpenAiDraft({
      apiKey: "sk-test-key-value-not-real",
      model: "gpt-4o-mini",
      input: { instructions: "Say hello", senderName: "Ada", senderTitle: "", tone: "direct" },
      maxAttempts: 1,
      fetchImpl: async () => new Response("Incorrect API key", { status: 401 }),
    }),
    /rejected this key/
  );
});

test("draft rate limit blocks the ninth call inside the window", () => {
  let now = 1_000_000;
  const limit = createRateLimiter(8, 60_000, () => now);
  for (let i = 0; i < 8; i += 1) assert.equal(limit.allow("workspace"), true);
  assert.equal(limit.allow("workspace"), false);
  now += 60_001;
  assert.equal(limit.allow("workspace"), true);
});
