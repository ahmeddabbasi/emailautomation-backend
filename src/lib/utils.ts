import { clsx, type ClassValue } from "clsx";
import { OPERATOR_TIMEZONE } from "@/lib/timezone";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWeek = Math.round(diffDay / 7);
  if (diffWeek < 5) return `${diffWeek}w ago`;
  return formatDate(iso);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: OPERATOR_TIMEZONE,
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: OPERATOR_TIMEZONE,
  });
}

export function formatDueDate(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffDay = Math.round(diffMs / 86400000);
  if (diffDay === 0) return "Today";
  if (diffDay === 1) return "Tomorrow";
  if (diffDay < 0) return `${Math.abs(diffDay)}d overdue`;
  return `in ${diffDay}d`;
}
