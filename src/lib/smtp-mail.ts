import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { alignedMailboxAddress } from "./mailbox-address";
import { isPublicHttpsUrl } from "./public-url";

export type SmtpSecurity = "ssl" | "starttls";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
}

export interface OutboundMessage {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string | null;
  listUnsubscribe?: string;
}

function transport(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === "ssl",
    auth: { user: config.username, pass: config.password },
  });
}

export async function verifySmtp(config: SmtpConfig): Promise<void> {
  await transport(config).verify();
}

export async function sendSmtp(config: SmtpConfig, message: OutboundMessage): Promise<string> {
  const fromEmail = alignedMailboxAddress(config.username, message.fromEmail);
  const unsubscribe = message.listUnsubscribe && isPublicHttpsUrl(message.listUnsubscribe) ? message.listUnsubscribe : undefined;
  const info = await transport(config).sendMail({
    from: `"${message.fromName.replace(/"/g, "")}" <${fromEmail}>`,
    envelope: { from: config.username.trim(), to: message.to },
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    replyTo: message.replyTo || undefined,
    headers: unsubscribe
      ? { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
      : undefined,
  });
  return info.messageId || "unknown";
}
