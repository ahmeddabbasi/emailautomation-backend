import "server-only";
import * as queries from "@/lib/queries";
import { env } from "@/lib/env";
import { getAppDefaults } from "@/lib/app-settings";
import type { Campaign, Contact, LeadList, SendLog, SequenceStep } from "@/lib/types";

export interface UiDefaults {
  defaultSenderName: string;
  defaultSenderTitle: string;
  ctaLink: string;
  earlyBirdLine: string;
}

function toCampaign(row: queries.CampaignWithCounts): Campaign {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    companyDescription: row.company_description,
    valueProps: row.value_props,
    createdAt: row.created_at,
    leadListCount: row.leadListCount,
    contactCount: row.contactCount,
  };
}

function toLeadList(row: queries.LeadListWithCount): LeadList {
  return {
    id: row.id,
    campaignId: row.campaign_id ?? "",
    name: row.name,
    source: row.source,
    status: row.status,
    industry: row.industry,
    targetAudience: row.target_audience,
    senderName: row.sender_name,
    senderTitle: row.sender_title,
    rawSubjectStructure: row.raw_subject_structure,
    rawEmailStructure: row.raw_email_structure,
    ctaLink: row.cta_link,
    earlyBirdLine: row.early_bird_line,
    otherRequiredElements: row.other_required_elements,
    bannedPhrases: row.banned_phrases,
    universalImageUrl: row.universal_image_url,
    followupDay3Guidance: row.followup_day3_guidance,
    followupDay7Guidance: row.followup_day7_guidance,
    followupDay14Guidance: row.followup_day14_guidance,
    followupOffsetsDays: row.followup_offsets_days,
    timezone: row.timezone,
    dailyCap: row.daily_cap,
    windowStartMinutes: row.window_start_minutes,
    windowEndMinutes: row.window_end_minutes,
    dripBatchSize: row.drip_batch_size,
    dripIntervalMinutes: row.drip_interval_minutes,
    activeDays: row.active_days,
    generationStatus: row.generation_status,
    generationTotal: row.generation_total,
    generationCompleted: row.generation_completed,
    generationFailedCount: row.generation_failed_count,
    testMode: row.test_mode,
    createdAt: row.created_at,
    contactCount: row.contactCount,
  };
}

function toContact(item: queries.ContactListItem): Contact {
  return {
    id: item.id,
    contactId: item.contactId,
    leadListId: item.leadListId,
    leadListName: item.leadListName,
    leadListTestMode: item.leadListTestMode,
    campaignId: item.campaignId,
    campaignName: item.campaignName,
    name: item.name,
    email: item.email,
    company: item.company,
    title: item.title,
    bio: item.bio,
    source: item.source,
    sequenceStep: item.sequenceStep as SequenceStep,
    status: item.status,
    nextSendAt: item.nextSendAt,
    createdAt: item.createdAt,
  };
}

function toSendLog(item: queries.SendListItem): SendLog {
  return {
    id: item.id,
    campaignContactId: item.campaignContactId,
    contactName: item.contactName,
    contactEmail: item.contactEmail,
    company: item.company,
    campaignId: item.campaignId,
    campaignName: item.campaignName,
    leadListName: item.leadListName,
    sequenceStep: item.sequenceStep as SequenceStep,
    status: item.status,
    subject: item.subject,
    body: item.body,
    errorMessage: item.errorMessage,
    deliveryFailedAt: item.deliveryFailedAt,
    provider: item.provider,
    testMode: item.testMode,
    isTest: item.isTest,
    createdAt: item.createdAt,
  };
}

export async function getCampaigns(): Promise<Campaign[]> {
  const rows = await queries.listCampaigns();
  return rows.map(toCampaign);
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const row = await queries.getCampaignById(id);
  return row ? toCampaign(row) : null;
}

export async function getLeadLists(campaignId: string): Promise<LeadList[]> {
  const rows = await queries.listLeadLists(campaignId);
  return rows.map(toLeadList);
}

export async function getLeadList(id: string): Promise<LeadList | null> {
  const row = await queries.getLeadListById(id);
  return row ? toLeadList(row) : null;
}

export async function getContacts(filters: { leadListId?: string; campaignId?: string } = {}): Promise<Contact[]> {
  const { items } = await queries.listContacts({ ...filters, pageSize: 1000 });
  return items.map(toContact);
}

export async function getSendLogs(): Promise<SendLog[]> {
  const { items } = await queries.listSends({ pageSize: 500 });
  return items.map(toSendLog);
}

export async function getRecentActivity(limit = 15, campaignId?: string): Promise<SendLog[]> {
  const items = await queries.getRecentActivity(limit, campaignId);
  return items.map(toSendLog);
}

export async function getUiDefaults(): Promise<UiDefaults> {
  const defaults = await getAppDefaults();
  return {
    defaultSenderName: env.defaultSenderName,
    defaultSenderTitle: env.defaultSenderTitle,
    ctaLink: defaults.ctaLink,
    earlyBirdLine: defaults.earlyBirdLine,
  };
}
