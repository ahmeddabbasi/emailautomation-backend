import { supabaseAdmin } from "@/lib/supabase/server";
import { generateEmail, validateGeneratedEmail, resolveSenderIdentity } from "@/lib/generation";
import { sendEmail } from "@/lib/sending";
import { chooseCampaignMailbox, sendWithMailbox } from "@/lib/mailboxes";
import { isPublicHttpsUrl } from "@/lib/public-url";
import { isSuppressed, unsubscribeUrl } from "@/lib/suppression";
import { htmlToPlainText, renderTemplate, sanitizeEmailHtml, templateVariables } from "@/lib/template-render";
import { advancePendingImports } from "@/lib/import-jobs";
import { pollMailboxReplies } from "@/lib/imap-poll";
import { processStalledGeneration } from "@/lib/bulk-generation";
import { errorMessage } from "@/lib/errors";
import { logError, logWarning, purgeOldErrorLogs } from "@/lib/logger";
import {
  isActiveDay,
  isWithinSendWindow,
  localDayRangeUtc,
  computeDripAllowanceByNow,
  nextFollowupSendAtUtc,
  type FollowupConfig,
} from "@/lib/scheduling";
import type {
  CampaignContactStatus,
  CampaignRow,
  ContactRow,
  GenerationProvider,
  LeadListRow,
  SequenceStep,
} from "@/lib/supabase/db-types";

const HARD_CAP_PER_TICK = 50;
const SEND_PACE_MS = 3000;
const STALE_LOCK_MINUTES = 10;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toFollowupConfig(list: LeadListRow): FollowupConfig {
  return {
    timezone: list.timezone,
    daily_cap: list.daily_cap,
    window_start_minutes: list.window_start_minutes,
    window_end_minutes: list.window_end_minutes,
    drip_batch_size: list.drip_batch_size,
    drip_interval_minutes: list.drip_interval_minutes,
    active_days: list.active_days,
    test_mode: list.test_mode,
    followup_offsets_days: list.followup_offsets_days,
  };
}

interface ListWithCampaign {
  list: LeadListRow;
  campaign: CampaignRow;
}

async function fetchActiveLeadLists(): Promise<ListWithCampaign[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("lead_lists")
    .select("*, campaigns!inner(*)")
    .eq("status", "active")
    .eq("campaigns.status", "active");
  if (error) throw new Error(`Failed to load active lead lists: ${errorMessage(error)}`);

  return ((data ?? []) as unknown as (LeadListRow & { campaigns: CampaignRow })[]).map((row) => {
    const { campaigns: campaign, ...list } = row;
    return { list, campaign };
  });
}

async function countTodaysSends(listId: string, start: Date, end: Date): Promise<number> {
  const db = supabaseAdmin();
  const { count, error } = await db
    .from("sends")
    .select("id, campaign_contacts!inner(lead_list_id)", { count: "exact", head: true })
    .eq("campaign_contacts.lead_list_id", listId)
    .eq("status", "sent")
    .eq("is_test", false)
    .gte("created_at", start.toISOString())
    .lt("created_at", end.toISOString());
  if (error) throw new Error(`Failed to count today's sends for list ${listId}: ${errorMessage(error)}`);
  return count ?? 0;
}

interface EligibleRow {
  id: string;
  lead_list_id: string;
  contact_id: string;
  sequence_step: SequenceStep;
  initial_subject: string | null;
  initial_body: string | null;
  initial_provider: GenerationProvider | null;
  contacts: ContactRow;
}

const ELIGIBLE_COLUMNS = "id, lead_list_id, contact_id, sequence_step, initial_subject, initial_body, initial_provider";

async function fetchEligibleForList(listId: string, limit: number): Promise<EligibleRow[]> {
  if (limit <= 0) return [];
  const db = supabaseAdmin();
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("campaign_contacts")
    .select(`${ELIGIBLE_COLUMNS}, contacts!inner(*)`)
    .eq("lead_list_id", listId)
    .eq("status", "pending")
    .or(`sequence_step.eq.0,next_send_at.lte.${nowIso}`)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Failed to load eligible contacts for list ${listId}: ${errorMessage(error)}`);
  return (data ?? []) as unknown as EligibleRow[];
}

async function releaseStaleLocks(): Promise<void> {
  const db = supabaseAdmin();
  const threshold = new Date(Date.now() - STALE_LOCK_MINUTES * 60000).toISOString();
  const { error } = await db.from("campaign_contacts").update({ locked_at: null }).lt("locked_at", threshold);
  if (error) await logError("dispatch", "DB_QUERY_FAILED", `Failed to release stale send locks: ${errorMessage(error)}`, { error });
}

// Race resolution between overlapping ticks: the claim is the ONLY thing
// that prevents a duplicate email; the unique index on sends cannot, because
// by the time it rejects a row Mailgun has already accepted the message.
//
// The claim is a single conditional UPDATE, so Postgres serialises competing
// claims on the row lock and re-evaluates the WHERE against the latest
// committed version. It pins the exact state this tick fetched (same
// sequence_step, still due). Without that pin, a tick holding a stale
// snapshot could claim after a sibling finished (the sibling's advance puts
// the row back to status='pending', locked_at=null) and resend the old step
// (reproduced live before this fix: two Mailgun accepts, one sends row).
// The loser gets zero rows back and skips; it is not an error. The claimed
// row is returned so the send uses post-claim data, never the fetch snapshot.
async function claimRow(row: EligibleRow): Promise<EligibleRow | null> {
  const db = supabaseAdmin();
  const nowIso = new Date().toISOString();
  let query = db
    .from("campaign_contacts")
    .update({ locked_at: nowIso })
    .eq("id", row.id)
    .eq("status", "pending")
    .eq("sequence_step", row.sequence_step)
    .is("locked_at", null);
  if (row.sequence_step !== 0) query = query.lte("next_send_at", nowIso);

  const { data, error } = await query.select(ELIGIBLE_COLUMNS);
  if (error) {
    await logError("dispatch", "DISPATCH_CLAIM_FAILED", `Failed to claim a contact for sending: ${errorMessage(error)}`, {
      error,
      details: { campaignContactId: row.id, leadListId: row.lead_list_id, sequenceStep: row.sequence_step },
    });
    return null;
  }
  const claimed = data?.[0] as Omit<EligibleRow, "contacts"> | undefined;
  return claimed ? { ...claimed, contacts: row.contacts } : null;
}

async function hasSuccessfulSend(campaignContactId: string, step: SequenceStep): Promise<boolean> {
  const db = supabaseAdmin();
  const { count, error } = await db
    .from("sends")
    .select("id", { count: "exact", head: true })
    .eq("campaign_contact_id", campaignContactId)
    .eq("sequence_step", step)
    .eq("status", "sent")
    .eq("is_test", false);
  if (error) throw new Error(`Failed to check prior sends for ${campaignContactId}: ${errorMessage(error)}`);
  return (count ?? 0) > 0;
}

interface SendFields {
  subject?: string | null;
  body?: string | null;
  providerMessageId?: string;
  errorMessage?: string;
  provider?: GenerationProvider | null;
  mailboxId?: string | null;
  html?: string | null;
}

async function logSend(
  campaignContactId: string,
  sequenceStep: SequenceStep,
  status: "sent" | "failed",
  list: LeadListRow,
  fields: SendFields
) {
  const db = supabaseAdmin();
  const { error } = await db.from("sends").insert({
    campaign_contact_id: campaignContactId,
    sequence_step: sequenceStep,
    subject: fields.subject ?? null,
    body: fields.body ?? null,
    status,
    provider_message_id: fields.providerMessageId ?? null,
    error_message: fields.errorMessage ?? null,
    provider: fields.provider ?? null,
    test_mode: list.test_mode,
    mailbox_id: fields.mailboxId ?? null,
  });
  if (!error) return;
  const details = { campaignContactId, leadListId: list.id, sequenceStep, providerMessageId: fields.providerMessageId ?? null };
  if (error.code === "23505") {
    // The unique index only fires after Mailgun accepted this message, so
    // reaching here means the recipient received a duplicate: a claim
    // failure, not a benign skip.
    await logError("dispatch", "DUPLICATE_SEND", "Duplicate email sent: a second successful send was recorded for the same step", {
      error,
      details,
    });
    return;
  }
  await logError("dispatch", "DB_QUERY_FAILED", `Failed to record a send: ${errorMessage(error)}`, { error, details });
}

async function requeueForGeneration(id: string, leadListId: string) {
  const db = supabaseAdmin();
  const { error } = await db.from("campaign_contacts").update({ status: "queued", locked_at: null }).eq("id", id);
  if (error) {
    await logError("dispatch", "DB_QUERY_FAILED", `Failed to requeue a contact for generation: ${errorMessage(error)}`, {
      error,
      details: { campaignContactId: id, leadListId },
    });
    return;
  }
  // The row was counted as generated without having a draft (v2 migration
  // backfill), so take it back out of the completed count.
  const { data: list } = await db.from("lead_lists").select("generation_completed").eq("id", leadListId).single();
  await db
    .from("lead_lists")
    .update({ generation_status: "running", generation_completed: Math.max(0, (list?.generation_completed ?? 1) - 1) })
    .eq("id", leadListId);
}

async function markStatus(id: string, status: CampaignContactStatus) {
  const db = supabaseAdmin();
  const { error } = await db.from("campaign_contacts").update({ status, locked_at: null }).eq("id", id);
  if (error) {
    await logError("dispatch", "DB_QUERY_FAILED", `Failed to mark a contact as ${status}: ${errorMessage(error)}`, {
      error,
      details: { campaignContactId: id, status },
    });
  }
}

async function advanceCampaignContact(id: string, currentStep: SequenceStep, sentAt: Date, list: LeadListRow) {
  const db = supabaseAdmin();
  const isFinal = currentStep === 3;
  const nextStep = (isFinal ? 3 : currentStep + 1) as SequenceStep;
  const status: CampaignContactStatus = isFinal ? "completed" : "pending";
  const nextSendAt = isFinal ? undefined : nextFollowupSendAtUtc(sentAt, currentStep, toFollowupConfig(list)).toISOString();

  const { error } = await db
    .from("campaign_contacts")
    .update({
      status,
      sequence_step: nextStep,
      last_sent_at: sentAt.toISOString(),
      locked_at: null,
      ...(nextSendAt ? { next_send_at: nextSendAt } : {}),
    })
    .eq("id", id);
  if (error) throw new Error(`Failed to advance campaign_contact ${id}: ${errorMessage(error)}`);
}

export interface TickResultItem {
  campaignContactId: string;
  contactName: string;
  leadListId: string;
  campaignName: string;
  sequenceStep: SequenceStep;
  outcome: "sent" | "failed" | "generation_failed" | "already_sent" | "requeued";
  error?: string;
}

export interface TickSummary {
  processed: number;
  sent: number;
  failed: number;
  generationFailed: number;
  results: TickResultItem[];
}

async function processOne(
  row: EligibleRow,
  campaign: CampaignRow,
  list: LeadListRow,
  summary: TickSummary
): Promise<void> {
  const contact = row.contacts;
  const step = row.sequence_step;
  const base = {
    campaignContactId: row.id,
    contactName: contact.name,
    leadListId: row.lead_list_id,
    campaignName: campaign.name,
    sequenceStep: step,
  };
  const logDetails = {
    campaignId: campaign.id,
    leadListId: list.id,
    contactId: contact.id,
    campaignContactId: row.id,
    sequenceStep: step,
    testMode: list.test_mode,
  };

  // A prior tick got a Mailgun accept for this step but died before
  // advancing the row (then the stale-lock sweep released it). Repair the
  // state instead of sending again.
  if (await hasSuccessfulSend(row.id, step)) {
    await advanceCampaignContact(row.id, step, new Date(), list);
    summary.results.push({ ...base, outcome: "already_sent" });
    return;
  }

  if (await isSuppressed(contact.email)) {
    await markStatus(row.id, "unsubscribed");
    summary.results.push({ ...base, outcome: "requeued", error: "Lead is suppressed" });
    return;
  }

  const route = await chooseCampaignMailbox(campaign.id, list.timezone);
  if (route.channel === "hold") {
    await supabaseAdmin().from("campaign_contacts").update({ locked_at: null }).eq("id", row.id);
    summary.results.push({ ...base, outcome: "requeued", error: route.reason });
    return;
  }

  const sender = resolveSenderIdentity(list);
  const template = await supabaseAdmin()
    .from("email_templates")
    .select("subject, html_body, text_body")
    .eq("campaign_id", campaign.id)
    .eq("sequence_step", step)
    .maybeSingle();

  let subject: string;
  let body: string;
  let html: string | undefined;
  let provider: GenerationProvider | null = null;

  if (template.data?.html_body) {
    const contactFields = contact as ContactRow & { first_name?: string; last_name?: string; custom_fields?: Record<string, string> };
    const vars = templateVariables({
      firstName: contactFields.first_name,
      lastName: contactFields.last_name,
      name: contact.name,
      email: contact.email,
      company: contact.company,
      title: contact.title,
      customFields: contactFields.custom_fields,
    });
    subject = renderTemplate(template.data.subject, vars);
    html = sanitizeEmailHtml(renderTemplate(template.data.html_body, vars));
    body = template.data.text_body?.trim() ? renderTemplate(template.data.text_body, vars) : htmlToPlainText(html);
  } else if (!sender) {
    const message = "No sender name is configured for this list. Set one before sending.";
    summary.generationFailed++;
    summary.results.push({ ...base, outcome: "generation_failed", error: message });
    await logError("generation", "GENERATION_NO_SENDER", message, { details: logDetails });
    await logSend(row.id, step, "failed", list, { errorMessage: message });
    await markStatus(row.id, "generation_failed");
    return;
  } else if (step === 0) {
    if (!row.initial_subject || !row.initial_body) {
      await requeueForGeneration(row.id, list.id);
      await logWarning("dispatch", "DRAFT_MISSING_REQUEUED", "Initial draft missing at send time; contact requeued for generation", {
        details: logDetails,
      });
      summary.results.push({ ...base, outcome: "requeued", error: "Initial draft missing, requeued for generation" });
      return;
    }
    subject = row.initial_subject;
    body = row.initial_body;
    provider = row.initial_provider;
  } else {
    let generated;
    try {
      generated = await generateEmail(contact, campaign, list, step, sender, row.id);
    } catch (err) {
      // The provider layer already logged the underlying failure in detail.
      summary.generationFailed++;
      summary.results.push({ ...base, outcome: "generation_failed", error: errorMessage(err) });
      await logSend(row.id, step, "failed", list, { errorMessage: `Generation failed: ${errorMessage(err)}` });
      await markStatus(row.id, "generation_failed");
      return;
    }

    const validation = validateGeneratedEmail(generated.subject, generated.body, list);
    if (!validation.pass) {
      summary.generationFailed++;
      summary.results.push({ ...base, outcome: "generation_failed", error: `Validation failed: ${validation.reason}` });
      await logWarning("generation", "GENERATION_VALIDATION_FAILED", `Generated follow-up failed validation: ${validation.reason}`, {
        details: { ...logDetails, provider: generated.provider, subject: generated.subject },
      });
      await logSend(row.id, step, "failed", list, {
        subject: generated.subject,
        body: generated.body,
        provider: generated.provider,
        errorMessage: `Validation failed: ${validation.reason}`,
      });
      await markStatus(row.id, "generation_failed");
      return;
    }

    subject = generated.subject;
    body = generated.body;
    provider = generated.provider;
  }

  if (route.channel !== "mailbox" && !sender) {
    const message = "No sender name is configured for this list. Set one before sending.";
    summary.generationFailed++;
    summary.results.push({ ...base, outcome: "generation_failed", error: message });
    await markStatus(row.id, "generation_failed");
    return;
  }

  const appUrl = process.env.APP_URL;
  const listUnsubscribe = appUrl && isPublicHttpsUrl(appUrl) ? unsubscribeUrl(appUrl, contact.email) : undefined;
  if (html && listUnsubscribe) {
    html += `<p style="margin-top:24px;font-size:12px;"><a href="${listUnsubscribe}">Unsubscribe</a></p>`;
    body += `\n\nUnsubscribe: ${listUnsubscribe}`;
  }

  try {
    const result = route.channel === "mailbox"
      ? { providerMessageId: await sendWithMailbox(route.mailboxId, { to: contact.email, subject, text: body, html, listUnsubscribe }) }
      : await sendEmail(contact, subject, body, {
          sequenceStep: step,
          universalImageUrl: list.universal_image_url,
          sender: sender!,
          html,
          listUnsubscribe: html ? listUnsubscribe : undefined,
        });
    const sentAt = new Date();
    await logSend(row.id, step, "sent", list, {
      subject,
      body,
      provider,
      providerMessageId: result.providerMessageId,
      mailboxId: route.channel === "mailbox" ? route.mailboxId : null,
    });
    await advanceCampaignContact(row.id, step, sentAt, list);
    summary.sent++;
    summary.results.push({ ...base, outcome: "sent" });
  } catch (err) {
    summary.failed++;
    summary.results.push({ ...base, outcome: "failed", error: errorMessage(err) });
    const providerName = route.channel === "mailbox" ? "mailbox" : "Mailgun";
    await logError("sending", route.channel === "mailbox" ? "SMTP_REJECTED" : "MAILGUN_REJECTED", `${providerName} rejected the send to ${contact.email}: ${errorMessage(err)}`, {
      error: err,
      details: { ...logDetails, recipient: contact.email },
    });
    await logSend(row.id, step, "failed", list, { subject, body, provider, errorMessage: errorMessage(err) });
    await markStatus(row.id, "invalid");
  }
}

async function startCronRun(): Promise<string> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("cron_runs")
    .insert({ started_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to start cron_runs row: ${errorMessage(error)}`);
  return data.id;
}

async function finishCronRun(id: string, summary: TickSummary, errorMsg?: string): Promise<void> {
  const db = supabaseAdmin();
  const { error } = await db
    .from("cron_runs")
    .update({
      finished_at: new Date().toISOString(),
      processed: summary.processed,
      sent: summary.sent,
      failed: summary.failed,
      generation_failed: summary.generationFailed,
      error_message: errorMsg ?? null,
      details: summary.results,
    })
    .eq("id", id);
  if (error) await logError("dispatch", "DB_QUERY_FAILED", `Failed to record the dispatch run: ${errorMessage(error)}`, { error });
}

// Re-times every follow-up already waiting in this list after test mode is
// switched, from each contact's last actual send: turning it on pulls
// follow-ups days away into minutes, turning it off pushes them back out to
// the list's normal day offsets.
export async function rescheduleFollowups(list: LeadListRow): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("campaign_contacts")
    .select("id, sequence_step, last_sent_at")
    .eq("lead_list_id", list.id)
    .eq("status", "pending")
    .gt("sequence_step", 0)
    .not("last_sent_at", "is", null);
  if (error) throw new Error(`Failed to load follow-ups to reschedule: ${errorMessage(error)}`);

  const config = toFollowupConfig(list);
  let updated = 0;
  for (const row of data ?? []) {
    const nextSendAt = nextFollowupSendAtUtc(new Date(row.last_sent_at!), row.sequence_step - 1, config).toISOString();
    const { error: updateError } = await db.from("campaign_contacts").update({ next_send_at: nextSendAt }).eq("id", row.id).eq("status", "pending");
    if (updateError) {
      await logError("dispatch", "DB_QUERY_FAILED", `Failed to reschedule a follow-up: ${errorMessage(updateError)}`, {
        error: updateError,
        details: { campaignContactId: row.id, leadListId: list.id },
      });
      continue;
    }
    updated++;
  }
  return updated;
}

// How many of this list's due contacts may go out on this tick. Test mode
// skips the window, active days, daily cap and drip pacing entirely.
async function dueThisTick(list: LeadListRow, budget: number): Promise<number> {
  if (list.test_mode) return budget;

  const nowUtc = new Date();
  const config = toFollowupConfig(list);
  if (!isActiveDay(nowUtc, config)) return 0;
  if (!isWithinSendWindow(nowUtc, config)) return 0;

  const { start, end } = localDayRangeUtc(nowUtc, list.timezone);
  const sentToday = await countTodaysSends(list.id, start, end);
  if (sentToday >= config.daily_cap) return 0;

  const allowanceByNow = computeDripAllowanceByNow(nowUtc, config);
  return Math.min(Math.max(0, allowanceByNow - sentToday), config.daily_cap - sentToday, budget);
}

// The single entry point the cron endpoint (and the manual "Run dispatch
// now" button) calls. Recomputes eligibility, window, cap, and drip pace
// fresh every call from real DB state: there is no separate "scheduled job
// list" to drift out of sync with reality.
export async function runDispatchTick(options?: { campaignId?: string }): Promise<TickSummary> {
  const cronRunId = await startCronRun();
  const summary: TickSummary = { processed: 0, sent: 0, failed: 0, generationFailed: 0, results: [] };

  try {
    await releaseStaleLocks();
    const activeLists = await fetchActiveLeadLists();
    let budget = HARD_CAP_PER_TICK;

    for (const { list, campaign } of activeLists) {
      if (budget <= 0) break;
      if (options?.campaignId && campaign.id !== options.campaignId) continue;
      if (campaign.schedule_start_at && new Date(campaign.schedule_start_at) > new Date()) continue;

      const due = await dueThisTick(list, budget);
      if (due <= 0) continue;

      const eligible = await fetchEligibleForList(list.id, due);

      for (const row of eligible) {
        if (budget <= 0) break;
        const claimed = await claimRow(row);
        if (!claimed) continue;

        budget--;
        summary.processed++;

        try {
          await processOne(claimed, campaign, list, summary);
        } catch (unexpected) {
          summary.failed++;
          summary.results.push({
            campaignContactId: row.id,
            contactName: row.contacts.name,
            leadListId: list.id,
            campaignName: campaign.name,
            sequenceStep: row.sequence_step,
            outcome: "failed",
            error: errorMessage(unexpected),
          });
          await logError("dispatch", "DISPATCH_UNEXPECTED_FAILURE", `Unexpected failure while sending: ${errorMessage(unexpected)}`, {
            error: unexpected,
            details: { campaignId: campaign.id, leadListId: list.id, campaignContactId: row.id, sequenceStep: row.sequence_step },
          });
        }

        await sleep(SEND_PACE_MS);
      }
    }

    await advancePendingImports();
    await pollMailboxReplies();
    await processStalledGeneration();
    await purgeOldErrorLogs();
    await finishCronRun(cronRunId, summary);
  } catch (err) {
    await logError("dispatch", "DISPATCH_TICK_FAILED", `Dispatch run failed: ${errorMessage(err)}`, {
      error: err,
      details: { processed: summary.processed, sent: summary.sent, failed: summary.failed },
    });
    await finishCronRun(cronRunId, summary, errorMessage(err));
    throw err;
  }

  return summary;
}
