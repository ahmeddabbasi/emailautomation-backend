import { ImapFlow } from "imapflow";
import { supabaseAdmin } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { decryptSecret } from "@/lib/secret-box";
import { handleBounce, handleInboundReply } from "@/lib/webhooks/handlers";
import { errorMessage } from "@/lib/errors";
import { logWarning } from "@/lib/logger";

function looksLikeBounce(from: string, subject: string): boolean {
  return /mailer-daemon|postmaster|delivery status notification|undeliverable|mail delivery failed/i.test(`${from} ${subject}`);
}

function emailIn(text: string): string | null {
  return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
}

// Optional reply/bounce sweep for mailboxes that configured IMAP. Mailgun
// webhooks keep doing this for Mailgun sends. Failures here never stop a tick.
export async function pollMailboxReplies(maxMailboxes = 3): Promise<void> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("mailboxes")
    .select("id, imap_host, imap_port, username, password_ciphertext")
    .eq("status", "active")
    .not("imap_host", "is", null)
    .limit(maxMailboxes);
  if (error || !data) return;

  for (const mailbox of data) {
    const client = new ImapFlow({
      host: mailbox.imap_host!,
      port: mailbox.imap_port ?? 993,
      secure: true,
      auth: { user: mailbox.username, pass: decryptSecret(mailbox.password_ciphertext, env.authSecret) },
      logger: false,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        let scanned = 0;
        for await (const message of client.fetch({ since, seen: false }, { envelope: true }, { uid: true })) {
          if (scanned++ > 25) break;
          const from = message.envelope?.from?.[0]?.address ?? "";
          const subject = message.envelope?.subject ?? "";
          if (looksLikeBounce(from, subject)) {
            const recipient = emailIn(subject);
            if (recipient) await handleBounce({ recipient, messageId: null, reason: subject || "IMAP bounce" });
            continue;
          }
          if (!from) continue;
          await handleInboundReply({ sender: from, subject, bodyPlain: null, inReplyTo: null, references: null });
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (err) {
      await logWarning("sending", "IMAP_POLL_FAILED", `IMAP poll failed: ${errorMessage(err)}`, {
        details: { mailboxId: mailbox.id },
      });
    }
  }
}
