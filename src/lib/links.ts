// Example and local hosts are form placeholders. They must not be stored as a
// real call-to-action, because generation pastes the link into the email.

export function isPlaceholderLink(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const host = new URL(trimmed).hostname.toLowerCase().replace(/^www\./, "");
    return host === "example.com" || host === "example.org" || host === "localhost" || host.endsWith(".example");
  } catch {
    return false;
  }
}

export function cleanCtaLink(value: string): string {
  const trimmed = value.trim();
  return isPlaceholderLink(trimmed) ? "" : trimmed;
}
