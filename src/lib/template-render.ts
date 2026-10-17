const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)(?:\|([^}]*))?\s*\}\}/g;

export function renderTemplate(input: string, vars: Record<string, string | undefined>): string {
  return input.replace(VARIABLE, (_match, key: string, fallback: string | undefined) => {
    const value = vars[key]?.trim();
    if (value) return value;
    return (fallback ?? "").trim();
  });
}

export function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript\s*:/gi, "");
}

export function htmlToPlainText(html: string): string {
  return sanitizeEmailHtml(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function templateVariables(contact: {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  company?: string;
  title?: string;
  customFields?: Record<string, string>;
}): Record<string, string> {
  const first = contact.firstName?.trim() || contact.name?.trim().split(/\s+/)[0] || "";
  const last = contact.lastName?.trim() || "";
  const vars: Record<string, string> = {
    first_name: first,
    last_name: last,
    name: contact.name?.trim() || [first, last].filter(Boolean).join(" "),
    email: contact.email?.trim() || "",
    company: contact.company?.trim() || "",
    title: contact.title?.trim() || "",
  };
  for (const [key, value] of Object.entries(contact.customFields ?? {})) {
    const slug = key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (slug && value.trim()) vars[slug] = value.trim();
  }
  return vars;
}
