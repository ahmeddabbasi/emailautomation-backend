export const ZOHO_SMTP_HOSTS = [
  { host: "smtp.zoho.com", label: "Zoho (global)" },
  { host: "smtp.zoho.eu", label: "Zoho EU" },
  { host: "smtp.zoho.in", label: "Zoho India" },
  { host: "smtp.zoho.com.au", label: "Zoho Australia" },
  { host: "smtp.zoho.jp", label: "Zoho Japan" },
  { host: "smtppro.zoho.com", label: "Zoho Workplace / custom domain" },
] as const;

export function defaultImapHost(smtpHost: string): string {
  if (smtpHost.includes(".eu")) return "imap.zoho.eu";
  if (smtpHost.endsWith(".in")) return "imap.zoho.in";
  if (smtpHost.endsWith(".com.au")) return "imap.zoho.com.au";
  if (smtpHost.endsWith(".jp")) return "imap.zoho.jp";
  return "imap.zoho.com";
}
