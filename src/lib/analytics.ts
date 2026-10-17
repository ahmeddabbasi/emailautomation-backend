import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import { periodStarts, localDateKey, recentLocalDateKeys } from "@/lib/timezone";
import type { CampaignContactStatus, SequenceStep } from "@/lib/supabase/db-types";

// Every send-derived metric (volumes, failures, funnel, reply rate) is
// computed over this window; contact-state counts are always current state.
export const LOOKBACK_DAYS = 90;
const PAGE_SIZE = 1000;

interface SendRecord {
  id: string;
  created_at: string;
  sequence_step: SequenceStep;
  campaign_contact_id: string;
  delivery_failed_at: string | null;
}

const delivered = (s: SendRecord) => s.delivery_failed_at === null;

interface ContactRecord {
  id: string;
  status: CampaignContactStatus;
}

interface ReplyRecord {
  received_at: string;
  campaign_contact_id: string;
}

// PostgREST caps every response at 1000 rows, so a plain select silently
// undercounts once there's more data than that.
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
  what: string
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to load ${what}: ${errorMessage(error)}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export interface AnalyticsScope {
  campaignId?: string;
  excludeTestMode?: boolean;
}

export function scopeFromSearchParams(params: URLSearchParams): AnalyticsScope {
  return {
    campaignId: params.get("campaignId") || undefined,
    excludeTestMode: params.get("excludeTestMode") === "1",
  };
}

async function fetchScopedData({ campaignId, excludeTestMode }: AnalyticsScope) {
  const db = supabaseAdmin();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();

  let listIds: string[] | null = null;
  if (campaignId) {
    const { data: lists, error } = await db.from("lead_lists").select("id").eq("campaign_id", campaignId);
    if (error) throw new Error(`Failed to scope lead lists: ${errorMessage(error)}`);
    listIds = (lists ?? []).map((l) => l.id);
    if (listIds.length === 0) return { sends: [], failures: [], contacts: [], replies: [], activeDailyCap: 0 };
  }

  const contacts = await fetchAll<ContactRecord>((from, to) => {
    let q = db.from("campaign_contacts").select("id, status").order("id").range(from, to);
    if (listIds) q = q.in("lead_list_id", listIds);
    return q;
  }, "contacts");
  const contactIds = new Set(contacts.map((c) => c.id));
  const inScope = (id: string | null) => id !== null && (!listIds || contactIds.has(id));

  const allSends = await fetchAll<SendRecord & { status: string; test_mode: boolean }>((from, to) => {
    let q = db
      .from("sends")
      .select("id, created_at, sequence_step, campaign_contact_id, delivery_failed_at, status, test_mode")
      .eq("is_test", false)
      .gte("created_at", since)
      .not("campaign_contact_id", "is", null)
      .order("id")
      .range(from, to);
    if (excludeTestMode) q = q.eq("test_mode", false);
    return q;
  }, "sends");
  const scoped = allSends.filter((s) => inScope(s.campaign_contact_id));
  const sends = scoped.filter((s) => s.status === "sent");
  const failures = scoped.filter((s) => s.status === "failed" || s.delivery_failed_at !== null);

  const replies = (
    await fetchAll<ReplyRecord>(
      (from, to) => db.from("replies").select("received_at, campaign_contact_id").order("id").range(from, to),
      "replies"
    )
  ).filter((r) => inScope(r.campaign_contact_id));

  let capsQuery = db
    .from("lead_lists")
    .select("daily_cap, campaigns!inner(status)")
    .eq("status", "active")
    .eq("campaigns.status", "active");
  if (listIds) capsQuery = capsQuery.in("id", listIds);
  const { data: capsData, error: capsErr } = await capsQuery;
  if (capsErr) throw new Error(`Failed to load daily caps: ${errorMessage(capsErr)}`);
  const activeDailyCap = (capsData ?? []).reduce((sum, l) => sum + l.daily_cap, 0);

  return { sends, failures, contacts, replies, activeDailyCap };
}

const isOnOrAfter = (iso: string, boundary: Date) => new Date(iso) >= boundary;

export interface AnalyticsOverview {
  sentToday: number;
  sentThisWeek: number;
  sentThisMonth: number;
  initialSent: number;
  followupSent: number;
  followupByStep: { day3: number; day7: number; day14: number };
  activeContacts: number;
  completedContacts: number;
  stoppedOrInvalid: number;
  complained: number;
  generationFailures: number;
  sendFailures: number;
  repliedContacts: number;
  replyRate: number | null;
  sentTodayVsCapacity: { sent: number; capacity: number };
  avgTimeToReplyHours: number | null;
  repliesByStep: { initial: number; day3: number; day7: number; day14: number };
}

export async function getAnalyticsOverview(scope: AnalyticsScope = {}): Promise<AnalyticsOverview> {
  const { sends, failures, contacts, replies, activeDailyCap } = await fetchScopedData(scope);
  const { today, week, month } = periodStarts(new Date());

  const sentToday = sends.filter((s) => isOnOrAfter(s.created_at, today)).length;
  const countStatus = (...statuses: CampaignContactStatus[]) => contacts.filter((c) => statuses.includes(c.status)).length;

  const contactsWithInitialSend = new Set(
    sends.filter((s) => s.sequence_step === 0 && delivered(s)).map((s) => s.campaign_contact_id)
  );
  const repliedIds = new Set(contacts.filter((c) => c.status === "replied").map((c) => c.id));
  const repliedAfterInitial = [...contactsWithInitialSend].filter((id) => repliedIds.has(id)).length;

  return {
    sentToday,
    sentThisWeek: sends.filter((s) => isOnOrAfter(s.created_at, week)).length,
    sentThisMonth: sends.filter((s) => isOnOrAfter(s.created_at, month)).length,
    initialSent: sends.filter((s) => s.sequence_step === 0).length,
    followupSent: sends.filter((s) => s.sequence_step !== 0).length,
    followupByStep: {
      day3: sends.filter((s) => s.sequence_step === 1).length,
      day7: sends.filter((s) => s.sequence_step === 2).length,
      day14: sends.filter((s) => s.sequence_step === 3).length,
    },
    activeContacts: countStatus("pending"),
    completedContacts: countStatus("completed"),
    stoppedOrInvalid: countStatus("stopped", "invalid"),
    complained: countStatus("complained"),
    generationFailures: countStatus("generation_failed"),
    sendFailures: failures.length,
    repliedContacts: repliedIds.size,
    replyRate: contactsWithInitialSend.size > 0 ? repliedAfterInitial / contactsWithInitialSend.size : null,
    sentTodayVsCapacity: { sent: sentToday, capacity: activeDailyCap },
    ...correlateReplies(replies, sends),
  };
}

function correlateReplies(replies: ReplyRecord[], sends: SendRecord[]) {
  const sendsByContact = new Map<string, SendRecord[]>();
  for (const s of sends) {
    const list = sendsByContact.get(s.campaign_contact_id) ?? [];
    list.push(s);
    sendsByContact.set(s.campaign_contact_id, list);
  }

  const repliesByStep = { initial: 0, day3: 0, day7: 0, day14: 0 };
  const stepKeys: (keyof typeof repliesByStep)[] = ["initial", "day3", "day7", "day14"];
  const deltasHours: number[] = [];

  for (const reply of replies) {
    const triggeringSend = (sendsByContact.get(reply.campaign_contact_id) ?? [])
      .filter((s) => new Date(s.created_at) <= new Date(reply.received_at))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (!triggeringSend) continue;

    repliesByStep[stepKeys[triggeringSend.sequence_step]]++;
    deltasHours.push((new Date(reply.received_at).getTime() - new Date(triggeringSend.created_at).getTime()) / 3600000);
  }

  const avgTimeToReplyHours = deltasHours.length > 0 ? deltasHours.reduce((a, b) => a + b, 0) / deltasHours.length : null;
  return { avgTimeToReplyHours, repliesByStep };
}

export interface DailySendBucket {
  date: string;
  initial: number;
  followup: number;
  replies: number;
}

export async function getSendsTimeseries(scope: AnalyticsScope = {}, days = 30): Promise<DailySendBucket[]> {
  const { sends, replies } = await fetchScopedData(scope);
  const buckets = new Map<string, DailySendBucket>(
    recentLocalDateKeys(Math.min(Math.max(days, 1), LOOKBACK_DAYS)).map((key) => [
      key,
      { date: key, initial: 0, followup: 0, replies: 0 },
    ])
  );

  for (const s of sends) {
    const bucket = buckets.get(localDateKey(s.created_at));
    if (!bucket) continue;
    if (s.sequence_step === 0) bucket.initial++;
    else bucket.followup++;
  }
  for (const r of replies) {
    const bucket = buckets.get(localDateKey(r.received_at));
    if (bucket) bucket.replies++;
  }

  return Array.from(buckets.values());
}

export interface FunnelStep {
  step: number;
  label: string;
  count: number;
}

export async function getSequenceFunnel(scope: AnalyticsScope = {}): Promise<FunnelStep[]> {
  const { sends } = await fetchScopedData(scope);
  const labels = ["Initial", "Follow-up 1", "Follow-up 2", "Follow-up 3"];

  return [0, 1, 2, 3].map((step) => ({
    step,
    label: labels[step],
    count: new Set(sends.filter((s) => s.sequence_step === step && delivered(s)).map((s) => s.campaign_contact_id)).size,
  }));
}

export interface CampaignComparisonRow {
  campaignId: string;
  campaignName: string;
  sent: number;
  replied: number;
  replyRate: number | null;
  sendFailures: number;
}

export async function getCampaignComparison(excludeTestMode = false): Promise<CampaignComparisonRow[]> {
  const db = supabaseAdmin();
  const { data: campaigns, error } = await db.from("campaigns").select("id, name");
  if (error) throw new Error(`Failed to load campaigns for comparison: ${errorMessage(error)}`);

  const rows = await Promise.all(
    (campaigns ?? []).map(async (c) => {
      const overview = await getAnalyticsOverview({ campaignId: c.id, excludeTestMode });
      return {
        campaignId: c.id,
        campaignName: c.name,
        sent: overview.initialSent + overview.followupSent,
        replied: overview.repliedContacts,
        replyRate: overview.replyRate,
        sendFailures: overview.sendFailures,
      };
    })
  );

  return rows.sort((a, b) => (b.replyRate ?? -1) - (a.replyRate ?? -1) || b.sent - a.sent);
}
