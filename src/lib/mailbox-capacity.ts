export const MAX_MAILBOX_DAILY = 30;

export interface MailboxCapacity {
  id: string;
  status: "active" | "paused" | "error";
  dailyLimit: number;
  hourlyLimit: number;
  sentToday: number;
  sentThisHour: number;
}

export function limitError(dailyLimit: number, hourlyLimit: number): string | null {
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > MAX_MAILBOX_DAILY) {
    return `Daily send limit must be a whole number from 1 to ${MAX_MAILBOX_DAILY}`;
  }
  if (!Number.isInteger(hourlyLimit) || hourlyLimit < 1) {
    return "Hourly send limit must be a whole number of at least 1";
  }
  if (hourlyLimit > dailyLimit) return "Hourly send limit cannot exceed the daily send limit";
  return null;
}

export function enforcedDailyLimit(dailyLimit: number): number {
  return Math.min(dailyLimit, MAX_MAILBOX_DAILY);
}

export function remainingCapacity(mailbox: MailboxCapacity): number {
  const dailyLeft = Math.max(0, enforcedDailyLimit(mailbox.dailyLimit) - mailbox.sentToday);
  const hourlyLeft = Math.max(0, mailbox.hourlyLimit - mailbox.sentThisHour);
  return Math.min(dailyLeft, hourlyLeft);
}

export type SendRoute =
  | { channel: "mailgun" }
  | { channel: "mailbox"; mailboxId: string }
  | { channel: "hold"; reason: string };

// A campaign with any linked mailbox never falls through to Mailgun.
// Mailgun is only for campaigns that have no mailbox linked.
export function routeCampaignSend(linked: MailboxCapacity[]): SendRoute {
  if (linked.length === 0) return { channel: "mailgun" };
  const picked = pickMailbox(linked);
  if (picked) return { channel: "mailbox", mailboxId: picked.id };
  if (linked.some((mailbox) => mailbox.status === "active")) {
    return { channel: "hold", reason: "The linked mailbox has hit its hourly or daily send limit. Remaining leads stay queued." };
  }
  if (linked.some((mailbox) => mailbox.status === "error")) {
    return { channel: "hold", reason: "The linked mailbox is in an error state, so this campaign will not send through another provider." };
  }
  return { channel: "hold", reason: "The linked mailbox is paused. Resume it to send. This campaign will not use another provider while a mailbox is linked." };
}

// Prefer the mailbox with the most room left. Ties break by id so two
// workers pick the same mailbox instead of racing an arbitrary order.
export function pickMailbox(mailboxes: MailboxCapacity[]): MailboxCapacity | null {
  const ranked = mailboxes
    .filter((mailbox) => mailbox.status === "active")
    .map((mailbox) => ({ mailbox, left: remainingCapacity(mailbox) }))
    .filter((entry) => entry.left > 0)
    .sort((a, b) => b.left - a.left || a.mailbox.id.localeCompare(b.mailbox.id));
  return ranked[0]?.mailbox ?? null;
}

export function jitterDelayMs(random: () => number = Math.random): number {
  return 2000 + Math.floor(random() * 6000);
}
