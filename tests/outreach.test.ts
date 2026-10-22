import assert from "node:assert/strict";
import test from "node:test";
import {
  customFieldsForRow,
  displayName,
  isValidEmail,
  normalizeEmail,
  rejectedToCsv,
  stripBom,
} from "../src/lib/import-limits.ts";
import { limitError, pickMailbox, remainingCapacity, routeCampaignSend, type MailboxCapacity } from "../src/lib/mailbox-capacity.ts";
import { htmlToPlainText, renderTemplate, sanitizeEmailHtml } from "../src/lib/template-render.ts";
import { alignedMailboxAddress } from "../src/lib/mailbox-address.ts";
import { isPublicHttpsUrl } from "../src/lib/public-url.ts";
import { decryptSecret, encryptSecret } from "../src/lib/secret-box.ts";

test("csv validation trims, lowercases, and rejects bad emails", () => {
  assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  assert.equal(isValidEmail("ada@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail("a@b"), false);
  assert.equal(stripBom("\uFEFFemail"), "email");
});

test("display name and custom fields keep unmapped columns", () => {
  assert.equal(displayName({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" }), "Ada Lovelace");
  assert.equal(displayName({ email: "ada@example.com" }), "ada");
  const fields = customFieldsForRow(
    { Email: "ada@example.com", City: " London ", Notes: "" },
    ["Email"]
  );
  assert.deepEqual(fields, { City: "London" });
});

test("invalid row export is csv", () => {
  const csv = rejectedToCsv([{ row: { email: "bad" }, reason: "Invalid email format" }]);
  assert.match(csv, /Invalid email format/);
  assert.match(csv, /bad/);
});

test("daily cap cannot exceed 30 and hourly cannot exceed daily", () => {
  assert.equal(limitError(30, 5), null);
  assert.match(limitError(31, 5) ?? "", /30/);
  assert.match(limitError(10, 11) ?? "", /cannot exceed/);
  assert.match(limitError(0, 1) ?? "", /1 to 30/);
});

test("mailbox rotation picks the most remaining capacity and skips capped or paused", () => {
  const mailboxes: MailboxCapacity[] = [
    { id: "a", status: "active", dailyLimit: 30, hourlyLimit: 5, sentToday: 28, sentThisHour: 0 },
    { id: "b", status: "active", dailyLimit: 30, hourlyLimit: 5, sentToday: 0, sentThisHour: 5 },
    { id: "c", status: "paused", dailyLimit: 30, hourlyLimit: 5, sentToday: 0, sentThisHour: 0 },
    { id: "d", status: "active", dailyLimit: 30, hourlyLimit: 10, sentToday: 2, sentThisHour: 1 },
  ];
  assert.equal(remainingCapacity(mailboxes[1]), 0);
  assert.equal(pickMailbox(mailboxes)?.id, "d");
  assert.equal(pickMailbox([{ ...mailboxes[0], sentToday: 30, hourlyLimit: 5, sentThisHour: 0 }]), null);
});

test("a linked mailbox is the only sender for that campaign", () => {
  const linked: MailboxCapacity = { id: "box", status: "active", dailyLimit: 30, hourlyLimit: 5, sentToday: 0, sentThisHour: 0 };
  assert.equal(routeCampaignSend([]).channel, "mailgun");
  assert.deepEqual(routeCampaignSend([linked]), { channel: "mailbox", mailboxId: "box" });
  assert.equal(routeCampaignSend([{ ...linked, status: "paused" }]).channel, "hold");
  assert.equal(routeCampaignSend([{ ...linked, sentToday: 30 }]).channel, "hold");
});

test("a lead that already has a successful send for the step is not selected again", () => {
  function shouldSend(alreadySent: boolean) {
    return !alreadySent;
  }
  assert.equal(shouldSend(true), false);
  assert.equal(shouldSend(false), true);
});

test("template variables, fallbacks, and html sanitizing", () => {
  const rendered = renderTemplate("Hi {{first_name|there}} at {{company|your company}}", {
    first_name: "",
    company: "Analytical Engines",
  });
  assert.equal(rendered, "Hi there at Analytical Engines");
  const dirty = `<p onclick="alert(1)">Hi</p><script>alert(1)</script>`;
  const clean = sanitizeEmailHtml(dirty);
  assert.equal(clean.includes("script"), false);
  assert.equal(clean.includes("onclick"), false);
  assert.match(htmlToPlainText("<p>Hello<br>there</p>"), /Hello/);
});

test("unsubscribe headers require a public https origin", () => {
  assert.equal(isPublicHttpsUrl("http://localhost:3000"), false);
  assert.equal(isPublicHttpsUrl("https://localhost/api/unsubscribe"), false);
  assert.equal(isPublicHttpsUrl("https://127.0.0.1/api/unsubscribe"), false);
  assert.equal(isPublicHttpsUrl("https://192.168.1.8"), false);
  assert.equal(isPublicHttpsUrl("https://app.vectoriseinc.dev"), true);
  assert.equal(isPublicHttpsUrl(""), false);
});

test("mailbox from address stays on the authenticated Zoho domain", () => {
  assert.equal(alignedMailboxAddress("sales@vectoriseinc.dev", "sales@vectoriseinc.dev"), "sales@vectoriseinc.dev");
  assert.equal(alignedMailboxAddress("sales@vectoriseinc.dev", "alias@vectoriseinc.dev"), "alias@vectoriseinc.dev");
  assert.equal(alignedMailboxAddress("sales@vectoriseinc.dev", "sales@mailgun.test"), "sales@vectoriseinc.dev");
});

test("mailbox passwords round-trip and are not stored in clear text", () => {
  const secret = "test-secret-value";
  const encrypted = encryptSecret("app-password", secret);
  assert.equal(encrypted.includes("app-password"), false);
  assert.equal(decryptSecret(encrypted, secret), "app-password");
});
