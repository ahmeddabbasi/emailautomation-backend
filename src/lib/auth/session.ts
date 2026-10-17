// Signed session tokens, built on Web Crypto (not Node's `crypto` module) so
// the exact same code verifies sessions in both Edge middleware and Node API
// routes. Format: base64url(payload json) + "." + base64url(HMAC-SHA256).

export const SESSION_COOKIE = "email_automation_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

interface SessionPayload {
  exp: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createSessionToken(secret: string): Promise<string> {
  const payload: SessionPayload = { exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return `${toBase64Url(payloadBytes)}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payloadPart, signaturePart] = parts;

  try {
    const payloadBytes = fromBase64Url(payloadPart);
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64Url(signaturePart), payloadBytes);
    if (!valid) return false;

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
    return typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export const SESSION_MAX_AGE = SESSION_TTL_SECONDS;
