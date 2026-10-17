import crypto from "node:crypto";
import { env } from "@/lib/env";

export function verifyMailgunSignature(timestamp: string, token: string, signature: string): boolean {
  const expected = crypto.createHmac("sha256", env.mailgunWebhookSigningKey).update(timestamp + token).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const givenBuf = Buffer.from(signature);
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}
