export type CampaignStatus = "active" | "paused";
export type LeadListStatus = "active" | "paused";
export type GenerationStatus = "pending" | "running" | "completed";
export type CampaignContactStatus =
  | "queued"
  | "pending"
  | "stopped"
  | "invalid"
  | "completed"
  | "generation_failed"
  | "replied"
  | "complained"
  | "unsubscribed";
export type ContactSource = "apollo" | "manual";
export type SendStatus = "sent" | "failed";
export type SequenceStep = 0 | 1 | 2 | 3;
export type GenerationProvider = "gemini" | "groq";

export interface CampaignRow {
  id: string;
  name: string;
  status: CampaignStatus;
  company_description: string;
  value_props: string;
  schedule_start_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadListRow {
  id: string;
  campaign_id: string | null;
  name: string;
  source: ContactSource;
  status: LeadListStatus;

  industry: string;
  target_audience: string;
  sender_name: string;
  sender_title: string;
  raw_subject_structure: string;
  raw_email_structure: string;
  cta_link: string;
  early_bird_line: string;
  other_required_elements: string[];
  banned_phrases: string[];
  universal_image_url: string | null;
  followup_day3_guidance: string;
  followup_day7_guidance: string;
  followup_day14_guidance: string;
  followup_offsets_days: number[];

  timezone: string;
  daily_cap: number;
  window_start_minutes: number;
  window_end_minutes: number;
  drip_batch_size: number;
  drip_interval_minutes: number;
  active_days: number[];

  generation_status: GenerationStatus;
  generation_total: number;
  generation_completed: number;
  generation_failed_count: number;

  test_mode: boolean;

  created_at: string;
  updated_at: string;
}

export interface ContactRow {
  id: string;
  name: string;
  email: string;
  company: string;
  title: string;
  company_bio: string;
  first_name: string;
  last_name: string;
  custom_fields: Record<string, string>;
  source: ContactSource;
  created_at: string;
}

export interface CampaignContactRow {
  id: string;
  lead_list_id: string;
  contact_id: string;
  status: CampaignContactStatus;
  sequence_step: SequenceStep;
  next_send_at: string;
  last_sent_at: string | null;
  locked_at: string | null;
  initial_subject: string | null;
  initial_body: string | null;
  initial_provider: GenerationProvider | null;
  created_at: string;
}

export interface SendRow {
  id: string;
  campaign_contact_id: string | null;
  sequence_step: SequenceStep;
  subject: string | null;
  body: string | null;
  status: SendStatus;
  provider_message_id: string | null;
  error_message: string | null;
  is_test: boolean;
  test_recipient_email: string | null;
  test_mode: boolean;
  provider: GenerationProvider | null;
  delivery_failed_at: string | null;
  created_at: string;
}

export interface ReplyRow {
  id: string;
  campaign_contact_id: string;
  received_at: string;
  subject: string | null;
  body_snippet: string | null;
  created_at: string;
}

export interface CronRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  processed: number;
  sent: number;
  failed: number;
  generation_failed: number;
  error_message: string | null;
  details: unknown;
}
