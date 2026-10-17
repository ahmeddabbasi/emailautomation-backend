import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { startOfDay, addDays, addMinutes, getDay, differenceInMinutes } from "date-fns";

export interface SchedulingConfig {
  timezone: string;
  daily_cap: number;
  window_start_minutes: number;
  window_end_minutes: number;
  drip_batch_size: number;
  drip_interval_minutes: number;
  active_days: number[];
}

export function isActiveDay(nowUtc: Date, config: SchedulingConfig): boolean {
  return config.active_days.includes(getDay(toZonedTime(nowUtc, config.timezone)));
}

function localMinutesSinceMidnight(utcDate: Date, timezone: string): number {
  const zoned = toZonedTime(utcDate, timezone);
  return zoned.getHours() * 60 + zoned.getMinutes();
}

export function isWithinSendWindow(nowUtc: Date, config: SchedulingConfig): boolean {
  const minutes = localMinutesSinceMidnight(nowUtc, config.timezone);
  return minutes >= config.window_start_minutes && minutes < config.window_end_minutes;
}

function windowStartTodayUtc(nowUtc: Date, config: SchedulingConfig): Date {
  const zonedMidnight = startOfDay(toZonedTime(nowUtc, config.timezone));
  return fromZonedTime(addMinutes(zonedMidnight, config.window_start_minutes), config.timezone);
}

// A follow-up lands at the start of the send window N calendar days after the
// original send, in the list's timezone — not "N * 24h later" — so it slots
// naturally into that future day's drip/cap allocation and self-corrects
// across a DST transition (addDays operates on wall-clock date components,
// fromZonedTime then applies whatever UTC offset is correct for that date).
export function computeFollowupSendAtUtc(
  originalSentAtUtc: Date,
  offsetDays: number,
  config: SchedulingConfig
): Date {
  const zonedTargetMidnight = startOfDay(addDays(toZonedTime(originalSentAtUtc, config.timezone), offsetDays));
  return fromZonedTime(addMinutes(zonedTargetMidnight, config.window_start_minutes), config.timezone);
}

// Test mode compresses the sequence for live demos: follow-up N goes out this
// many minutes after the previous send, ignoring window, days, cap and drip.
export const TEST_MODE_FOLLOWUP_MINUTES = [5, 10, 15];

export interface FollowupConfig extends SchedulingConfig {
  test_mode: boolean;
  followup_offsets_days: number[];
}

// When the follow-up after `sentStep` is due. Offsets are configured as days
// after the ORIGINAL send (3, 7, 14), but only the previous send's time is
// stored, so the gap is the difference between consecutive offsets.
export function nextFollowupSendAtUtc(previousSentAtUtc: Date, sentStep: number, config: FollowupConfig): Date {
  if (config.test_mode) {
    return addMinutes(previousSentAtUtc, TEST_MODE_FOLLOWUP_MINUTES[sentStep] ?? TEST_MODE_FOLLOWUP_MINUTES.at(-1)!);
  }
  const offsets = config.followup_offsets_days;
  const current = offsets[sentStep] ?? [3, 7, 14][sentStep];
  const previous = sentStep > 0 ? offsets[sentStep - 1] ?? [3, 7, 14][sentStep - 1] : 0;
  return computeFollowupSendAtUtc(previousSentAtUtc, Math.max(current - previous, 1), config);
}

// [start, end) of "today" in the list's local timezone, expressed as UTC
// instants — used to count today's sends against the daily cap by local
// calendar day, not UTC calendar day.
export function localDayRangeUtc(nowUtc: Date, timezone: string): { start: Date; end: Date } {
  const zonedMidnight = startOfDay(toZonedTime(nowUtc, timezone));
  return {
    start: fromZonedTime(zonedMidnight, timezone),
    end: fromZonedTime(addDays(zonedMidnight, 1), timezone),
  };
}

// How many sends should have gone out by now, given the drip batch/interval
// pace since the window opened today, capped at the daily cap. The dispatch
// loop subtracts today's actual send count from this to get how many are
// due on this tick — recomputing from real counts each tick (rather than
// pre-scheduling exact timestamps) is what makes catch-up-after-downtime
// self-correct without a backlog dump: a list that missed a day just starts
// today's allowance from zero, same pace as any other day.
export function computeDripAllowanceByNow(nowUtc: Date, config: SchedulingConfig): number {
  const windowStart = windowStartTodayUtc(nowUtc, config);
  if (nowUtc < windowStart) return 0;
  const elapsedMinutes = differenceInMinutes(nowUtc, windowStart);
  const batchesElapsed = Math.floor(elapsedMinutes / config.drip_interval_minutes) + 1;
  return Math.min(batchesElapsed * config.drip_batch_size, config.daily_cap);
}
