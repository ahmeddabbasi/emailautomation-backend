// Strict DMARC (aspf=s; adkim=s) requires the visible From domain to be the
// domain the mailbox authenticated as. An alias on that same domain is fine.
// Any other domain falls back to the login address.
export function alignedMailboxAddress(username: string, fromEmail: string): string {
  const login = username.trim().toLowerCase();
  const from = fromEmail.trim().toLowerCase();
  const loginDomain = login.split("@")[1] ?? "";
  const fromDomain = from.split("@")[1] ?? "";
  if (loginDomain && fromDomain === loginDomain) return from;
  return login;
}
