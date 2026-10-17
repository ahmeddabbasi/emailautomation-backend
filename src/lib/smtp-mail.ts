import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

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
  const info = await transport(config).sendMail({
    from: `"${message.fromName.replace(/"/g, "")}" <${message.fromEmail}>`,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    replyTo: message.replyTo || undefined,
    headers: message.listUnsubscribe
      ? { "List-Unsubscribe": `<${message.listUnsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
      : undefined,
  });
  return info.messageId || "unknown";
}
