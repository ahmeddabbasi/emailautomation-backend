import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

function keyFrom(secret: string): Buffer {
  return scryptSync(secret, "email-automation-mailbox", 32);
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(payload: string, secret: string): string {
  const [iv, tag, data] = payload.split(".");
  if (!iv || !tag || !data) throw new Error("Mailbox credential payload is invalid");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
