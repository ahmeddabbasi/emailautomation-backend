import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { supabaseAdmin } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { errorMessage } from "@/lib/errors";
import { encryptSecret, decryptSecret } from "@/lib/secret-box";
import { limitError, routeCampaignSend, type MailboxCapacity, type SendRoute } from "@/lib/mailbox-capacity";
import { localDayRangeUtc } from "@/lib/scheduling";
import { sendSmtp, verifySmtp, type SmtpSecurity } from "@/lib/smtp-mail";

const AUTH_FAILURE_LIMIT = 3;

export interface MailboxInput {
  displayName: string;
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  username: string;
  password?: string;
  imapHost?: string | null;
  imapPort?: number | null;
  replyTo?: string | null;
  signatureHtml?: string;
  dailyLimit: number;
  hourlyLimit: number;
}

export interface MailboxPublic {
  id: string;
  displayName: string;
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  username: string;
  imapHost: string | null;
  imapPort: number | null;
  replyTo: string | null;
  signatureHtml: string;
  dailyLimit: number;
  hourlyLimit: number;
  status: "active" | "paused" | "error";
  lastError: string | null;
  campaignId: string | null;
  campaignName: string | null;
}

interface MailboxRow {
  id: string;
  display_name: string;
  email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_security: SmtpSecurity;
  username: string;
  password_ciphertext: string;
  imap_host: string | null;
  imap_port: number | null;
  reply_to: string | null;
  signature_html: string;
  daily_limit: number;
  hourly_limit: number;
  status: "active" | "paused" | "error";
  last_error: string | null;
  auth_failure_count: number;
  campaign_mailboxes?: { campaign_id: string; campaigns?: { name: string } | null }[] | { campaign_id: string; campaigns?: { name: string } | null } | null;
}

function toPublic(row: MailboxRow): MailboxPublic {
  const link = Array.isArray(row.campaign_mailboxes) ? row.campaign_mailboxes[0] : row.campaign_mailboxes;
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecurity: row.smtp_security,
    username: row.username,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    replyTo: row.reply_to,
    signatureHtml: row.signature_html,
    dailyLimit: row.daily_limit,
    hourlyLimit: row.hourly_limit,
    status: row.status,
    lastError: row.last_error,
    campaignId: link?.campaign_id ?? null,
    campaignName: link?.campaigns?.name ?? null,
  };
}

function validate(input: MailboxInput, requirePassword: boolean): string | null {
  if (!input.displayName.trim()) return "Display name is required";
  if (!input.email.includes("@")) return "A valid From email is required";
  if (!input.smtpHost.trim()) return "SMTP host is required";
  if (!input.username.trim()) return "SMTP username is required";
  if (requirePassword && !input.password) return "Password is required";
  return limitError(input.dailyLimit, input.hourlyLimit);
}

export async function listMailboxes(): Promise<MailboxPublic[]> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("mailboxes").select("*, campaign_mailboxes(campaign_id, campaigns(name))").order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list mailboxes: ${errorMessage(error)}`);
  return ((data ?? []) as MailboxRow[]).map(toPublic);
}

export async function createMailbox(input: MailboxInput): Promise<MailboxPublic> {
  const problem = validate(input, true);
  if (problem) throw new Error(problem);
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("mailboxes")
    .insert({
      display_name: input.displayName.trim(),
      email: input.email.trim().toLowerCase(),
      smtp_host: input.smtpHost.trim(),
      smtp_port: input.smtpPort,
      smtp_security: input.smtpSecurity,
      username: input.username.trim(),
      password_ciphertext: encryptSecret(input.password!, env.authSecret),
      imap_host: input.imapHost?.trim() || null,
      imap_port: input.imapPort ?? null,
      reply_to: input.replyTo?.trim() || null,
      signature_html: input.signatureHtml ?? "",
      daily_limit: input.dailyLimit,
      hourly_limit: input.hourlyLimit,
      status: "paused",
    })
    .select("*, campaign_mailboxes(campaign_id, campaigns(name))")
    .single();
  if (error || !data) throw new Error(`Failed to create mailbox: ${errorMessage(error)}`);
  return toPublic(data as MailboxRow);
}

export async function updateMailbox(id: string, input: Partial<MailboxInput> & { status?: "active" | "paused" }): Promise<MailboxPublic> {
  const db = supabaseAdmin();
  const { data: existing, error: loadError } = await db.from("mailboxes").select("*").eq("id", id).maybeSingle();
  if (loadError || !existing) throw new Error("Mailbox not found");
  const nextDaily = input.dailyLimit ?? existing.daily_limit;
  const nextHourly = input.hourlyLimit ?? existing.hourly_limit;
  const problem = limitError(nextDaily, nextHourly);
  if (problem) throw new Error(problem);
  if (input.status === "active" && existing.status !== "active") {
    throw new Error("Run Test connection before marking a mailbox active");
  }

  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined) patch.display_name = input.displayName.trim();
  if (input.email !== undefined) patch.email = input.email.trim().toLowerCase();
  if (input.smtpHost !== undefined) patch.smtp_host = input.smtpHost.trim();
  if (input.smtpPort !== undefined) patch.smtp_port = input.smtpPort;
  if (input.smtpSecurity !== undefined) patch.smtp_security = input.smtpSecurity;
  if (input.username !== undefined) patch.username = input.username.trim();
  if (input.password) patch.password_ciphertext = encryptSecret(input.password, env.authSecret);
  if (input.imapHost !== undefined) patch.imap_host = input.imapHost?.trim() || null;
  if (input.imapPort !== undefined) patch.imap_port = input.imapPort;
  if (input.replyTo !== undefined) patch.reply_to = input.replyTo?.trim() || null;
  if (input.signatureHtml !== undefined) patch.signature_html = input.signatureHtml;
  if (input.dailyLimit !== undefined) patch.daily_limit = input.dailyLimit;
  if (input.hourlyLimit !== undefined) patch.hourly_limit = input.hourlyLimit;
  if (input.status === "paused") patch.status = "paused";

  const { data, error } = await db.from("mailboxes").update(patch).eq("id", id).select("*, campaign_mailboxes(campaign_id, campaigns(name))").single();
  if (error || !data) throw new Error(`Failed to update mailbox: ${errorMessage(error)}`);
  return toPublic(data as MailboxRow);
}

export async function deleteMailbox(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("mailboxes").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete mailbox: ${errorMessage(error)}`);
}

async function loadSecret(id: string) {
  const { data, error } = await supabaseAdmin().from("mailboxes").select("*").eq("id", id).maybeSingle();
  if (error || !data) throw new Error("Mailbox not found");
  return { row: data as MailboxRow, password: decryptSecret(data.password_ciphertext, env.authSecret) };
}

export async function testMailbox(id: string, sendTo?: string): Promise<MailboxPublic> {
  const { row, password } = await loadSecret(id);
  try {
    const config = {
      host: row.smtp_host,
      port: row.smtp_port,
      security: row.smtp_security,
      username: row.username,
      password,
    };
    await verifySmtp(config);
    if (sendTo) {
      await sendSmtp(config, {
        fromName: row.display_name,
        fromEmail: row.email,
        to: sendTo,
        subject: "Mailbox connection test",
        text: "This mailbox authenticated and can send.",
      });
    }
    const { data, error } = await supabaseAdmin()
      .from("mailboxes")
      .update({ status: "active", last_error: null, auth_failure_count: 0 })
      .eq("id", id)
      .select("*, campaign_mailboxes(campaign_id, campaigns(name))")
      .single();
    if (error || !data) throw new Error(errorMessage(error));
    return toPublic(data as MailboxRow);
  } catch (err) {
    const message = errorMessage(err).slice(0, 500);
    await supabaseAdmin().from("mailboxes").update({ status: "paused", last_error: message }).eq("id", id);
    throw new Error(message);
  }
}

export async function linkMailbox(mailboxId: string, campaignId: string | null): Promise<void> {
  const db = supabaseAdmin();
  const { error: clearError } = await db.from("campaign_mailboxes").delete().eq("mailbox_id", mailboxId);
  if (clearError) throw new Error(`Failed to unlink mailbox: ${errorMessage(clearError)}`);
  if (!campaignId) return;
  const { error } = await db.from("campaign_mailboxes").insert({ campaign_id: campaignId, mailbox_id: mailboxId });
  if (error) throw new Error(`Failed to link mailbox: ${errorMessage(error)}`);
  // Linking means this campaign sends through the mailbox. A paused mailbox
  // (the state before the first test) is armed here. An error mailbox stays
  // in error until the connection test succeeds.
  const { data: mailbox } = await db.from("mailboxes").select("status").eq("id", mailboxId).maybeSingle();
  if (mailbox?.status === "paused") {
    await db.from("mailboxes").update({ status: "active", last_error: null }).eq("id", mailboxId);
  }
}

function hourStartUtc(now: Date, timezone: string): Date {
  const zoned = toZonedTime(now, timezone);
  return fromZonedTime(new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate(), zoned.getHours(), 0, 0, 0), timezone);
}

async function countSince(mailboxId: string, start: Date): Promise<number> {
  const { count, error } = await supabaseAdmin()
    .from("mailbox_sends")
    .select("id", { count: "exact", head: true })
    .eq("mailbox_id", mailboxId)
    .gte("sent_at", start.toISOString());
  if (error) throw new Error(errorMessage(error));
  return count ?? 0;
}

export async function chooseCampaignMailbox(campaignId: string, timezone: string, now = new Date()): Promise<SendRoute> {
  const db = supabaseAdmin();
  const { data: links, error } = await db.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", campaignId);
  if (error) throw new Error(`Failed to load campaign mailboxes: ${errorMessage(error)}`);
  const ids = (links ?? []).map((link) => link.mailbox_id);
  if (ids.length === 0) return { channel: "mailgun" };

  const { data: mailboxRows, error: mailboxError } = await db
    .from("mailboxes")
    .select("id, status, daily_limit, hourly_limit")
    .in("id", ids);
  if (mailboxError) throw new Error(`Failed to load linked mailboxes: ${errorMessage(mailboxError)}`);

  const day = localDayRangeUtc(now, timezone);
  const hour = hourStartUtc(now, timezone);
  const capacities: MailboxCapacity[] = [];
  for (const mailbox of mailboxRows ?? []) {
    capacities.push({
      id: mailbox.id,
      status: mailbox.status,
      dailyLimit: mailbox.daily_limit,
      hourlyLimit: mailbox.hourly_limit,
      sentToday: await countSince(mailbox.id, day.start),
      sentThisHour: await countSince(mailbox.id, hour),
    });
  }
  return routeCampaignSend(capacities);
}

export async function campaignHasMailboxes(campaignId: string): Promise<boolean> {
  const { count } = await supabaseAdmin()
    .from("campaign_mailboxes")
    .select("mailbox_id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  return (count ?? 0) > 0;
}

export async function sendWithMailbox(
  mailboxId: string,
  message: { to: string; subject: string; text: string; html?: string; listUnsubscribe?: string }
): Promise<string> {
  const { row, password } = await loadSecret(mailboxId);
  const html = message.html
    ? `${message.html}${row.signature_html ? `<br><br>${row.signature_html}` : ""}`
    : undefined;
  const text = row.signature_html ? `${message.text}\n\n${row.signature_html.replace(/<[^>]+>/g, "")}` : message.text;
  try {
    const messageId = await sendSmtp(
      {
        host: row.smtp_host,
        port: row.smtp_port,
        security: row.smtp_security,
        username: row.username,
        password,
      },
      {
        fromName: row.display_name,
        fromEmail: row.email,
        to: message.to,
        subject: message.subject,
        text,
        html,
        replyTo: row.reply_to,
        listUnsubscribe: message.listUnsubscribe,
      }
    );
    await supabaseAdmin().from("mailbox_sends").insert({ mailbox_id: mailboxId });
    await supabaseAdmin().from("mailboxes").update({ auth_failure_count: 0, last_error: null }).eq("id", mailboxId);
    return messageId;
  } catch (err) {
    const messageText = errorMessage(err).slice(0, 500);
    const authLike = /auth|invalid login|535|534|password/i.test(messageText);
    const failures = authLike ? row.auth_failure_count + 1 : row.auth_failure_count;
    await supabaseAdmin()
      .from("mailboxes")
      .update({
        auth_failure_count: failures,
        last_error: messageText,
        ...(failures >= AUTH_FAILURE_LIMIT ? { status: "error" } : {}),
      })
      .eq("id", mailboxId);
    throw err;
  }
}
