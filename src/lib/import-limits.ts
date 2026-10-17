export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 10_000;
export const CSV_PREVIEW_ROWS = 10;
export const CSV_SYNC_ROW_LIMIT = 200;
export const CSV_IMPORT_BATCH = 100;

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(normalizeEmail(value));
}

export function displayName(parts: { name?: string; firstName?: string; lastName?: string; email: string }): string {
  const combined = [parts.firstName?.trim(), parts.lastName?.trim()].filter(Boolean).join(" ");
  const named = (parts.name?.trim() || combined).trim();
  if (named) return named;
  const local = normalizeEmail(parts.email).split("@")[0] ?? "";
  return local || "there";
}

export function customFieldsForRow(row: Record<string, string>, mappedHeaders: Array<string | null>): Record<string, string> {
  const used = new Set(mappedHeaders.filter((header): header is string => Boolean(header)));
  const fields: Record<string, string> = {};
  for (const [header, value] of Object.entries(row)) {
    if (used.has(header)) continue;
    const trimmed = value?.trim() ?? "";
    if (trimmed) fields[header] = trimmed;
  }
  return fields;
}

export function rejectedToCsv(rows: { row: Record<string, string>; reason: string }[]): string {
  const headers = new Set<string>(["reason"]);
  for (const item of rows) Object.keys(item.row).forEach((key) => headers.add(key));
  const columns = [...headers];
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [columns.map(escape).join(",")];
  for (const item of rows) {
    lines.push(columns.map((column) => escape(column === "reason" ? item.reason : (item.row[column] ?? ""))).join(","));
  }
  return lines.join("\n");
}
