import { addDays, format } from "date-fns";
import { localDateStartUtc } from "@/lib/timezone";
import type { ErrorLogFilters } from "@/lib/error-logs";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

// Query params from the Error Logs tab. Dates are calendar days in the
// operator's timezone; "to" is inclusive, so it becomes the next day's start.
export function filtersFromSearchParams(params: URLSearchParams): ErrorLogFilters {
  const level = params.get("level");
  const resolved = params.get("resolved");
  const from = params.get("from");
  const to = params.get("to");
  return {
    level: level === "error" || level === "warning" ? level : undefined,
    source: params.get("source") || undefined,
    code: params.get("code") || undefined,
    resolved: resolved === "true" ? true : resolved === "false" ? false : undefined,
    from: from && DATE_KEY.test(from) ? localDateStartUtc(from).toISOString() : undefined,
    to: to && DATE_KEY.test(to) ? localDateStartUtc(format(addDays(new Date(`${to}T12:00:00`), 1), "yyyy-MM-dd")).toISOString() : undefined,
    q: params.get("q") || undefined,
  };
}
