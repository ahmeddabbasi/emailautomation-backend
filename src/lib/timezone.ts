import { toZonedTime, fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { startOfDay, startOfWeek, startOfMonth, subDays, format } from "date-fns";

// NEXT_PUBLIC_ so the same value is inlined into client bundles: dates must
// render identically on the server (UTC on Vercel) and in the browser.
export const OPERATOR_TIMEZONE = process.env.NEXT_PUBLIC_OPERATOR_TIMEZONE || "Asia/Karachi";

export function periodStarts(now: Date, tz = OPERATOR_TIMEZONE) {
  const local = toZonedTime(now, tz);
  return {
    today: fromZonedTime(startOfDay(local), tz),
    week: fromZonedTime(startOfWeek(local, { weekStartsOn: 1 }), tz),
    month: fromZonedTime(startOfMonth(local), tz),
  };
}

export function localDateKey(date: Date | string, tz = OPERATOR_TIMEZONE): string {
  return formatInTimeZone(date, tz, "yyyy-MM-dd");
}

// "yyyy-MM-dd" in the operator's timezone to the UTC instant that day starts.
export function localDateStartUtc(dateKey: string, tz = OPERATOR_TIMEZONE): Date {
  return fromZonedTime(`${dateKey}T00:00:00`, tz);
}

// The last `days` calendar days in the operator's timezone, oldest first,
// ending with today.
export function recentLocalDateKeys(days: number, now = new Date(), tz = OPERATOR_TIMEZONE): string[] {
  const today = startOfDay(toZonedTime(now, tz));
  return Array.from({ length: days }, (_, i) => format(subDays(today, days - 1 - i), "yyyy-MM-dd"));
}
