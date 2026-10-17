import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import type {
  CampaignContactStatus,
  CampaignRow,
  ContactSource,
  LeadListRow,
  SendStatus,
} from "@/lib/supabase/db-types";

export interface CampaignWithCounts extends CampaignRow {
  leadListCount: number;
  contactCount: number;
}

export async function listCampaigns(): Promise<CampaignWithCounts[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("campaigns")
    .select("*, lead_lists(id, campaign_contacts(count))")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list campaigns: ${errorMessage(error)}`);

  interface Joined extends CampaignRow {
    lead_lists: { id: string; campaign_contacts: { count: number }[] }[];
  }

  return ((data ?? []) as unknown as Joined[]).map((row) => {
    const { lead_lists, ...campaign } = row;
    const contactCount = lead_lists.reduce((sum, l) => sum + (l.campaign_contacts?.[0]?.count ?? 0), 0);
    return { ...campaign, leadListCount: lead_lists.length, contactCount };
  });
}

export async function getCampaignById(id: string): Promise<CampaignWithCounts | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("campaigns")
    .select("*, lead_lists(id, campaign_contacts(count))")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load campaign ${id}: ${errorMessage(error)}`);
  if (!data) return null;

  const row = data as unknown as CampaignRow & {
    lead_lists: { id: string; campaign_contacts: { count: number }[] }[];
  };
  const { lead_lists, ...campaign } = row;
  const contactCount = lead_lists.reduce((sum, l) => sum + (l.campaign_contacts?.[0]?.count ?? 0), 0);
  return { ...campaign, leadListCount: lead_lists.length, contactCount };
}

export interface CampaignInput {
  name: string;
  status: "active" | "paused";
  companyDescription: string;
  valueProps: string;
  scheduleStartAt?: string | null;
}

function campaignToRow(input: Partial<CampaignInput>) {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.status !== undefined) row.status = input.status;
  if (input.companyDescription !== undefined) row.company_description = input.companyDescription;
  if (input.valueProps !== undefined) row.value_props = input.valueProps;
  if (input.scheduleStartAt !== undefined) row.schedule_start_at = input.scheduleStartAt;
  return row;
}

export async function createCampaign(input: CampaignInput): Promise<CampaignRow> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("campaigns").insert(campaignToRow(input)).select("*").single();
  if (error) throw new Error(`Failed to create campaign: ${errorMessage(error)}`);
  return data;
}

export async function updateCampaign(id: string, input: Partial<CampaignInput>): Promise<CampaignRow> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("campaigns").update(campaignToRow(input)).eq("id", id).select("*").single();
  if (error) throw new Error(`Failed to update campaign ${id}: ${errorMessage(error)}`);
  return data;
}

export interface LeadListWithCount extends LeadListRow {
  contactCount: number;
}

export async function listLeadLists(campaignId: string): Promise<LeadListWithCount[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("lead_lists")
    .select("*, campaign_contacts(count)")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list lead lists for campaign ${campaignId}: ${errorMessage(error)}`);

  return ((data ?? []) as unknown as (LeadListRow & { campaign_contacts: { count: number }[] })[]).map((row) => {
    const { campaign_contacts, ...list } = row;
    return { ...list, contactCount: campaign_contacts?.[0]?.count ?? 0 };
  });
}

export async function getLeadListById(id: string): Promise<LeadListWithCount | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("lead_lists")
    .select("*, campaign_contacts(count)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load lead list ${id}: ${errorMessage(error)}`);
  if (!data) return null;

  const row = data as unknown as LeadListRow & { campaign_contacts: { count: number }[] };
  const { campaign_contacts, ...list } = row;
  return { ...list, contactCount: campaign_contacts?.[0]?.count ?? 0 };
}

export interface LeadListInput {
  name: string;
  source: ContactSource;
  industry: string;
  targetAudience: string;
  senderName: string;
  senderTitle: string;
  rawSubjectStructure: string;
  rawEmailStructure: string;
  ctaLink: string;
  earlyBirdLine: string;
  otherRequiredElements: string[];
  bannedPhrases: string[];
  universalImageUrl: string | null;
  followupDay3Guidance: string;
  followupDay7Guidance: string;
  followupDay14Guidance: string;
  followupOffsetsDays: number[];
  timezone: string;
  dailyCap: number;
  windowStartMinutes: number;
  windowEndMinutes: number;
  dripBatchSize: number;
  dripIntervalMinutes: number;
  activeDays: number[];
  status: "active" | "paused";
  testMode: boolean;
}

function leadListToRow(input: Partial<LeadListInput>) {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.source !== undefined) row.source = input.source;
  if (input.industry !== undefined) row.industry = input.industry;
  if (input.targetAudience !== undefined) row.target_audience = input.targetAudience;
  if (input.senderName !== undefined) row.sender_name = input.senderName;
  if (input.senderTitle !== undefined) row.sender_title = input.senderTitle;
  if (input.rawSubjectStructure !== undefined) row.raw_subject_structure = input.rawSubjectStructure;
  if (input.rawEmailStructure !== undefined) row.raw_email_structure = input.rawEmailStructure;
  if (input.ctaLink !== undefined) row.cta_link = input.ctaLink;
  if (input.earlyBirdLine !== undefined) row.early_bird_line = input.earlyBirdLine;
  if (input.otherRequiredElements !== undefined) row.other_required_elements = input.otherRequiredElements;
  if (input.bannedPhrases !== undefined) row.banned_phrases = input.bannedPhrases;
  if (input.universalImageUrl !== undefined) row.universal_image_url = input.universalImageUrl;
  if (input.followupDay3Guidance !== undefined) row.followup_day3_guidance = input.followupDay3Guidance;
  if (input.followupDay7Guidance !== undefined) row.followup_day7_guidance = input.followupDay7Guidance;
  if (input.followupDay14Guidance !== undefined) row.followup_day14_guidance = input.followupDay14Guidance;
  if (input.followupOffsetsDays !== undefined) row.followup_offsets_days = input.followupOffsetsDays;
  if (input.timezone !== undefined) row.timezone = input.timezone;
  if (input.dailyCap !== undefined) row.daily_cap = input.dailyCap;
  if (input.windowStartMinutes !== undefined) row.window_start_minutes = input.windowStartMinutes;
  if (input.windowEndMinutes !== undefined) row.window_end_minutes = input.windowEndMinutes;
  if (input.dripBatchSize !== undefined) row.drip_batch_size = input.dripBatchSize;
  if (input.dripIntervalMinutes !== undefined) row.drip_interval_minutes = input.dripIntervalMinutes;
  if (input.activeDays !== undefined) row.active_days = input.activeDays;
  if (input.status !== undefined) row.status = input.status;
  if (input.testMode !== undefined) row.test_mode = input.testMode;
  return row;
}

export async function createLeadList(campaignId: string | null, input: LeadListInput): Promise<LeadListRow> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("lead_lists")
    .insert({ campaign_id: campaignId, ...leadListToRow(input) })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create lead list: ${errorMessage(error)}`);
  return data;
}

export async function updateLeadList(id: string, input: Partial<LeadListInput>): Promise<LeadListRow> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("lead_lists").update(leadListToRow(input)).eq("id", id).select("*").single();
  if (error) throw new Error(`Failed to update lead list ${id}: ${errorMessage(error)}`);
  return data;
}

export interface ContactListItem {
  id: string;
  contactId: string;
  leadListId: string;
  leadListName: string;
  leadListTestMode: boolean;
  campaignId: string;
  campaignName: string;
  name: string;
  email: string;
  company: string;
  title: string;
  bio: string;
  source: ContactSource;
  sequenceStep: number;
  status: CampaignContactStatus;
  nextSendAt: string | null;
  createdAt: string;
}

export interface ListContactsFilters {
  leadListId?: string;
  campaignId?: string;
  status?: CampaignContactStatus;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface ListContactsResult {
  items: ContactListItem[];
  total: number;
}

export async function listContacts(filters: ListContactsFilters = {}): Promise<ListContactsResult> {
  const db = supabaseAdmin();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 500;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = db
    .from("campaign_contacts")
    .select(
      "*, contacts!inner(*), lead_lists!inner(id, name, campaign_id, test_mode, campaigns!inner(id, name))",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.leadListId) query = query.eq("lead_list_id", filters.leadListId);
  if (filters.campaignId) query = query.eq("lead_lists.campaign_id", filters.campaignId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.q) {
    query = query.or(
      `name.ilike.%${filters.q}%,email.ilike.%${filters.q}%,company.ilike.%${filters.q}%`,
      { foreignTable: "contacts" }
    );
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`Failed to list contacts: ${errorMessage(error)}`);

  interface Joined {
    id: string;
    lead_list_id: string;
    contact_id: string;
    status: CampaignContactStatus;
    sequence_step: number;
    next_send_at: string;
    created_at: string;
    contacts: { name: string; email: string; company: string; title: string; company_bio: string; source: ContactSource };
    lead_lists: { id: string; name: string; campaign_id: string; test_mode: boolean; campaigns: { id: string; name: string } };
  }

  const items = ((data ?? []) as unknown as Joined[]).map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    leadListId: row.lead_list_id,
    leadListName: row.lead_lists.name,
    leadListTestMode: row.lead_lists.test_mode,
    campaignId: row.lead_lists.campaign_id,
    campaignName: row.lead_lists.campaigns.name,
    name: row.contacts.name,
    email: row.contacts.email,
    company: row.contacts.company,
    title: row.contacts.title,
    bio: row.contacts.company_bio,
    source: row.contacts.source,
    sequenceStep: row.sequence_step,
    status: row.status,
    nextSendAt: row.status === "pending" ? row.next_send_at : null,
    createdAt: row.created_at,
  }));

  return { items, total: count ?? items.length };
}

// Returns false if the transition isn't allowed from the contact's current
// state. Putting a contact back into the sequence (pending/queued) is only
// a retry after a generation failure — never a way to resume someone who
// bounced, complained, replied, or was stopped.
export async function updateContactStatus(
  campaignContactId: string,
  status: "stopped" | "invalid" | "pending" | "queued"
): Promise<boolean> {
  const db = supabaseAdmin();
  const update: Record<string, unknown> = { status, locked_at: null };
  if (status === "pending") update.next_send_at = new Date().toISOString();

  let query = db.from("campaign_contacts").update(update).eq("id", campaignContactId);
  query =
    status === "pending" || status === "queued"
      ? query.eq("status", "generation_failed")
      : query.in("status", ["queued", "pending", "generation_failed"]);

  const { data, error } = await query.select("id, lead_list_id");
  if (error) throw new Error(`Failed to update contact status: ${errorMessage(error)}`);
  const updated = data?.[0];
  if (!updated) return false;

  // A requeued initial draft only gets picked up by the generation job if
  // its list is marked as having work left.
  if (status === "queued") {
    const { data: list } = await db
      .from("lead_lists")
      .select("generation_failed_count")
      .eq("id", updated.lead_list_id)
      .single();
    await db
      .from("lead_lists")
      .update({
        generation_status: "running",
        generation_failed_count: Math.max(0, (list?.generation_failed_count ?? 1) - 1),
      })
      .eq("id", updated.lead_list_id);
  }
  return true;
}

export interface SendListItem {
  id: string;
  campaignContactId: string | null;
  contactName: string;
  contactEmail: string;
  company: string;
  campaignId: string | null;
  campaignName: string | null;
  leadListName: string | null;
  sequenceStep: number;
  status: SendStatus;
  subject: string | null;
  body: string | null;
  errorMessage: string | null;
  deliveryFailedAt: string | null;
  provider: "gemini" | "groq" | null;
  testMode: boolean;
  isTest: boolean;
  createdAt: string;
}

export interface ListSendsFilters {
  campaignId?: string;
  leadListId?: string;
  status?: SendStatus;
  from?: string;
  to?: string;
  q?: string;
  includeTest?: boolean;
  page?: number;
  pageSize?: number;
}

export interface ListSendsResult {
  items: SendListItem[];
  total: number;
}

export async function listSends(filters: ListSendsFilters = {}): Promise<ListSendsResult> {
  const db = supabaseAdmin();
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 50;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Non-inner embeds don't reliably apply dotted-path filters as row
  // restrictions in PostgREST (confirmed live: an .eq() on a left-joined
  // column was silently ignored). Real (non-test) sends always have a
  // campaign_contact_id, so !inner is safe whenever test rows are excluded
  // — which is every case that actually filters by list/campaign/search.
  const needsInnerJoin = !filters.includeTest || Boolean(filters.leadListId || filters.campaignId || filters.q);
  const embed = needsInnerJoin
    ? "*, campaign_contacts!inner(lead_list_id, contacts!inner(name, email, company), lead_lists!inner(name, campaign_id, campaigns!inner(name)))"
    : "*, campaign_contacts(lead_list_id, contacts(name, email, company), lead_lists(name, campaign_id, campaigns(name)))";

  let query = db.from("sends").select(embed, { count: "exact" }).order("created_at", { ascending: false }).range(from, to);

  if (!filters.includeTest) query = query.eq("is_test", false);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lte("created_at", filters.to);
  if (filters.leadListId) query = query.eq("campaign_contacts.lead_list_id", filters.leadListId);
  if (filters.campaignId) query = query.eq("campaign_contacts.lead_lists.campaign_id", filters.campaignId);
  if (filters.q) {
    query = query.or(`name.ilike.%${filters.q}%,company.ilike.%${filters.q}%`, {
      foreignTable: "campaign_contacts.contacts",
    });
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`Failed to list sends: ${errorMessage(error)}`);

  interface Joined {
    id: string;
    sequence_step: number;
    status: SendStatus;
    subject: string | null;
    body: string | null;
    error_message: string | null;
    delivery_failed_at: string | null;
    provider: "gemini" | "groq" | null;
    test_mode: boolean;
    is_test: boolean;
    test_recipient_email: string | null;
    created_at: string;
    campaign_contacts: {
      lead_list_id: string;
      contacts: { name: string; email: string; company: string };
      lead_lists: { name: string; campaign_id: string; campaigns: { name: string } };
    } | null;
  }

  const items = ((data ?? []) as unknown as Joined[]).map((row) => ({
    id: row.id,
    campaignContactId: row.campaign_contacts ? row.id : null,
    contactName: row.campaign_contacts?.contacts.name ?? "(test send)",
    contactEmail: row.campaign_contacts?.contacts.email ?? row.test_recipient_email ?? "",
    company: row.campaign_contacts?.contacts.company ?? "",
    campaignId: row.campaign_contacts?.lead_lists.campaign_id ?? null,
    campaignName: row.campaign_contacts?.lead_lists.campaigns.name ?? null,
    leadListName: row.campaign_contacts?.lead_lists.name ?? null,
    sequenceStep: row.sequence_step,
    status: row.status,
    subject: row.subject,
    body: row.body,
    errorMessage: row.error_message,
    deliveryFailedAt: row.delivery_failed_at,
    provider: row.provider,
    testMode: row.test_mode,
    isTest: row.is_test,
    createdAt: row.created_at,
  }));

  return { items, total: count ?? items.length };
}

export async function getRecentActivity(limit = 15, campaignId?: string): Promise<SendListItem[]> {
  const { items } = await listSends({ pageSize: limit, page: 1, campaignId });
  return items;
}
