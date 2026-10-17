import Mailgun from "mailgun.js";
import FormData from "form-data";
import { env } from "@/lib/env";
import { ExternalServiceError, errorMessage } from "@/lib/errors";
import { logWarning } from "@/lib/logger";
import type { ContactRow, SequenceStep } from "@/lib/supabase/db-types";

export interface SenderIdentity {
  name: string;
  title: string;
}

let mgClient: ReturnType<Mailgun["client"]> | null = null;

function mailgunClient() {
  if (!mgClient) {
    const mailgun = new Mailgun(FormData);
    mgClient = mailgun.client({
      username: "api",
      key: env.mailgunApiKey,
      url: env.mailgunBaseUrl,
    });
  }
  return mgClient;
}

// env.mailgunFrom may carry its own display name ("Email Outreach
// <outreach@domain>") — we only want the address portion, since the display
// name itself is now built per-send from the configured sender identity.
function fromAddress(): string {
  const match = env.mailgunFrom.match(/<([^>]+)>/);
  return match ? match[1] : env.mailgunFrom.trim();
}

export function buildFromHeader(sender: SenderIdentity): string {
  const title = sender.title?.trim();
  const displayName = title ? `${sender.name} - ${title}` : sender.name;
  return `${displayName} <${fromAddress()}>`;
}

async function fetchImageAttachment(url: string): Promise<{ filename: string; data: Buffer } | null> {
  // A broken image URL should never block the send itself, but it is logged.
  try {
    const res = await fetch(url);
    if (!res.ok) {
      await logWarning("sending", "ATTACHMENT_FETCH_FAILED", "Universal image could not be fetched; sent without it", {
        details: { url, httpStatus: res.status },
      });
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const filename = url.split("/").pop()?.split("?")[0] || "attachment";
    return { filename, data: buffer };
  } catch (err) {
    await logWarning("sending", "ATTACHMENT_FETCH_FAILED", "Universal image could not be fetched; sent without it", {
      error: err,
      details: { url },
    });
    return null;
  }
}

export interface SendEmailResult {
  providerMessageId: string;
}

// Any error thrown here reflects an immediate rejection from Mailgun's own
// API response (e.g. invalid recipient) — never a webhook. Callers should
// treat it as terminal for this contact, not something to retry.
export async function sendRawEmail(
  to: string,
  subject: string,
  body: string,
  options: { attachments?: { filename: string; data: Buffer }[]; from?: string; html?: string; listUnsubscribe?: string } = {}
): Promise<SendEmailResult> {
  const attachments = options.attachments ?? [];
  try {
    const result = await mailgunClient().messages.create(env.mailgunDomain, {
      from: options.from ?? env.mailgunFrom,
      to: [to],
      subject,
      text: body,
      ...(options.html ? { html: options.html } : {}),
      ...(options.listUnsubscribe
        ? { "h:List-Unsubscribe": `<${options.listUnsubscribe}>`, "h:List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
        : {}),
      ...(attachments.length > 0 ? { attachment: attachments } : {}),
    });

    const messageId = result.id ?? result.message ?? "unknown";
    return { providerMessageId: messageId };
  } catch (err) {
    throw new ExternalServiceError("mailgun", `Mailgun rejected the send: ${errorMessage(err)}`, err);
  }
}

export interface SendEmailOptions {
  sequenceStep: SequenceStep;
  universalImageUrl: string | null;
  sender: SenderIdentity;
  html?: string;
  listUnsubscribe?: string;
}

export async function sendEmail(
  contact: ContactRow,
  subject: string,
  body: string,
  options: SendEmailOptions
): Promise<SendEmailResult> {
  const attachments: { filename: string; data: Buffer }[] = [];

  if (options.sequenceStep === 0 && options.universalImageUrl) {
    const attachment = await fetchImageAttachment(options.universalImageUrl);
    if (attachment) attachments.push(attachment);
  }

  return sendRawEmail(`${contact.name} <${contact.email}>`, subject, body, {
    attachments,
    from: buildFromHeader(options.sender),
    html: options.html,
    listUnsubscribe: options.listUnsubscribe,
  });
}

// Mailgun's own API only confirms it ACCEPTED the message — actual delivery
// happens async and can fail afterward (bounce, ESP block) even though the
// send call itself returned a real message id. This queries the same
// Events API used to diagnose those failures manually, so the Testing tab
// doesn't have to rely on the bounce/complaint webhook (which requires a
// public HTTPS URL Mailgun can reach — never true for local dev, and only
// true in prod once that webhook is actually configured, see SETUP.md).
export type DeliveryStatus = "delivered" | "failed" | "accepted" | "unknown";

export interface DeliveryStatusResult {
  status: DeliveryStatus;
  reason?: string;
}

interface MailgunEventItem {
  event?: string;
  reason?: string;
  message?: { headers?: { "message-id"?: string } };
  "delivery-status"?: { message?: string; description?: string };
}

export async function checkDeliveryStatus(messageId: string, recipient: string): Promise<DeliveryStatusResult> {
  const bareId = messageId.trim().replace(/^<|>$/g, "");
  const auth = "Basic " + Buffer.from(`api:${env.mailgunApiKey}`).toString("base64");
  const url = `${env.mailgunBaseUrl}/v3/${env.mailgunDomain}/events?recipient=${encodeURIComponent(recipient)}&limit=25`;

  let items: MailgunEventItem[];
  try {
    const res = await fetch(url, { headers: { authorization: auth } });
    if (!res.ok) {
      await logWarning("sending", "MAILGUN_EVENTS_UNAVAILABLE", "Mailgun Events API returned an error", {
        details: { httpStatus: res.status, providerBody: (await res.text()).slice(0, 500), messageId: bareId },
      });
      return { status: "unknown" };
    }
    const data = (await res.json()) as { items?: MailgunEventItem[] };
    items = data.items ?? [];
  } catch (err) {
    await logWarning("sending", "MAILGUN_EVENTS_UNAVAILABLE", "Mailgun Events API could not be reached", {
      error: err,
      details: { messageId: bareId },
    });
    return { status: "unknown" };
  }

  const matches = items.filter((e) => e.message?.headers?.["message-id"] === bareId);
  if (matches.some((e) => e.event === "delivered")) return { status: "delivered" };

  const failure = matches.find((e) => e.event === "failed" || e.event === "rejected");
  if (failure) {
    const reason = failure["delivery-status"]?.message || failure["delivery-status"]?.description || failure.reason;
    await logWarning("sending", "MAILGUN_DELIVERY_FAILED", "Test email failed delivery after Mailgun accepted it", {
      details: { messageId: bareId, recipient, reason: reason ?? null, event: failure.event },
    });
    return { status: "failed", reason: reason || "Delivery failed after Mailgun accepted the message" };
  }

  if (matches.some((e) => e.event === "accepted")) return { status: "accepted" };
  return { status: "unknown" };
}
