export type CampaignStatus = "active" | "paused";
export type LeadListStatus = "active" | "paused";
export type GenerationStatus = "pending" | "running" | "completed";
export type SequenceStep = 0 | 1 | 2 | 3;
export type ContactStatus =
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

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  companyDescription: string;
  valueProps: string;
  createdAt: string;
  leadListCount: number;
  contactCount: number;
}

export interface LeadList {
  id: string;
  campaignId: string;
  name: string;
  source: ContactSource;
  status: LeadListStatus;
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
  generationStatus: GenerationStatus;
  generationTotal: number;
  generationCompleted: number;
  generationFailedCount: number;
  testMode: boolean;
  createdAt: string;
  contactCount: number;
}

export interface Contact {
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
  sequenceStep: SequenceStep;
  status: ContactStatus;
  nextSendAt: string | null;
  createdAt: string;
}

export interface SendLog {
  id: string;
  campaignContactId: string | null;
  contactName: string;
  contactEmail: string;
  company: string;
  campaignId: string | null;
  campaignName: string | null;
  leadListName: string | null;
  sequenceStep: SequenceStep;
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
