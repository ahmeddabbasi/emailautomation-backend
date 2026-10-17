# Setup

Steps that happen outside the codebase — do these once per environment (local, and again for production).

## 1. Environment variables

Copy `.env.example` to `.env.local` and fill in every value. See that file for what each one is and where to find it. A few are worth calling out:

- **`GEMINI_MODEL`** — defaults to `gemini-flash-latest`. Google has already deprecated models mid-project once; if generation starts failing with a 404/quota error, check `GET https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY` for what's currently available to your key and pin a specific model via this env var. A `503 UNAVAILABLE "experiencing high demand"` error is different — that's a transient Gemini-side outage, not a config problem; the app already retries it a few times before giving up.
- **`AUTH_USERNAME`** / **`AUTH_PASSWORD`** — the single shared login. Change these before deploying anywhere reachable from the internet.
- **`AUTH_SECRET`** — signs session cookies. Generate with `openssl rand -hex 32` (or similar). Rotating it logs everyone out.
- **`DEFAULT_SENDER_NAME`** / **`DEFAULT_SENDER_TITLE`**: see [Sender identity](#6-sender-identity) below.
- **`GROQ_API_KEY`** / **`GROQ_MODEL`**: optional fallback. When Gemini is rate limited, out of quota, or unavailable after its retries, generation switches to Groq for 5 minutes. Both must be set; the model has no default, so pick one from Groq's model list. Every fallback is logged as a warning in Error Logs.
- **`NEXT_PUBLIC_OPERATOR_TIMEZONE`**: defaults to `Asia/Karachi`. Defines "today", "this week" and "this month" on the dashboard and the times shown everywhere.

## 2. Mailgun — sending

Already required from the prior version: a verified sending domain, `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`.

**If you're using a Mailgun sandbox domain, expect intermittent silent-looking delivery failures to Gmail, and don't ship to production on it.** This was diagnosed directly during this fixes pass (see the item 1 write-up in the PR/commit this shipped in): Mailgun's API accepts the send and returns a real message id — that part isn't broken — but Gmail then rejects a fraction of those messages downstream with `550 5.7.40`, "the From: header isn't aligned with either the authenticated SPF or DKIM organizational domain." A shared `sandboxXXXX.mailgun.org` domain can't pass Gmail's DMARC-alignment requirement (in effect since Feb 2024 for bulk senders) no matter what you put in the From display name, because you don't control DNS for that domain. This shows up as: Mailgun accepts it, "sent" looks successful, and the email never arrives — with no error anywhere in the app.

To fix this for real, verify your own sending domain in Mailgun (Sending → Domains → Add domain) and add the SPF, DKIM, and (recommended) DMARC records it gives you to your DNS provider. Once `MAILGUN_DOMAIN` points at a domain you've verified this way, alignment passes and deliveries stop being probabilistic. Sandbox domains are fine for confirming the send pipeline works at all, but not for judging real deliverability — a sandbox failure doesn't mean the code is broken, and a sandbox success doesn't mean production will behave the same.

If Mailgun only delivers to some addresses in testing, it's because sandbox domains also gate delivery by **Authorized Recipients** (Sending → your sandbox domain) — the API accepts the send either way, but delivery silently depends on the recipient being on that list, on top of the DMARC issue above.

**Checking what actually happened to a send**: the Testing tab now polls Mailgun's real delivery status a few seconds after every send and shows Delivered / Failed (with Mailgun's reason) / Not yet confirmed — it no longer just shows "Sent" from the API-accept response. To check any other message by hand, query Mailgun's Events API directly:
```
curl -s -u "api:$MAILGUN_API_KEY" \
  "https://api.mailgun.net/v3/$MAILGUN_DOMAIN/events?recipient=<address>&limit=25"
```

## 3. Mailgun — inbound routing (reply detection)

This is what lets a lead's reply automatically stop their sequence.

1. In the Mailgun dashboard: **Receiving → Routes → Create route**.
2. Match: **Catch All** (or a specific pattern if you only want replies to a particular subdomain/address).
3. Action: **Forward** to `https://<your-domain>/api/webhooks/inbound`.
4. Priority: doesn't matter unless you have other routes.

For this to receive real replies, the address leads reply *to* needs to resolve through Mailgun's MX records — i.e. the domain in `MAILGUN_FROM` / your sending domain needs Mailgun configured to receive mail, not just send it. See Mailgun's "Receiving Messages" docs for the MX setup if replies aren't reaching the route.

## 4. Mailgun — webhook signing key (required for both webhook endpoints)

1. Mailgun dashboard → **Sending → Webhooks → HTTP webhook signing key**.
2. Copy it into `MAILGUN_WEBHOOK_SIGNING_KEY`. This is **not** the same value as `MAILGUN_API_KEY` — both the inbound route and the tracking-event webhook (bounces/complaints) verify against this key, and requests with an invalid/missing signature are rejected with 401.

**This key is currently unset in `.env.local`.** Without it, `/api/webhooks/mailgun` still runs but rejects every event (no signature can verify against an empty key), so bounces/complaints silently stop halting sequences. Set it before relying on that webhook. Separately: that webhook also only works once Mailgun has a public HTTPS URL to POST to (step 5) — it can never fire against `localhost`, which is why local testing relies on the Testing tab's direct Events API check instead (see the callout in section 2).

## 5. Mailgun — bounce/complaint webhooks

1. Mailgun dashboard → **Sending → Webhooks**.
2. Add a webhook for **Permanent Failure** (hard bounce) pointing to `https://<your-domain>/api/webhooks/mailgun`.
3. Add a webhook for **Complaint** pointing to the same URL.

A hard bounce marks that contact `invalid` and halts their sequence everywhere; a complaint marks them `complained` and does the same. Temporary failures are left alone (they're usually transient and resolve on their own).

## 6. Sender identity

Every AI-generated email (campaign sends, follow-ups, and the Testing tab's AI-assisted send) is signed in code with a configured sender name — the model is told not to write its own sign-off, and anything it writes anyway is stripped before the real signature is appended. **If no sender name is configured, sending is blocked with a clear error rather than letting the model invent one.**

Two levels, in priority order:
1. **Per lead list** — set on the list's edit page (Targeting section: "Sender name" / "Sender title"). Lets different lists send as different people.
2. **`DEFAULT_SENDER_NAME`** / **`DEFAULT_SENDER_TITLE`** env vars — the fallback used when a list hasn't set its own, and the value that pre-fills a new list's sender fields and the Testing tab's AI-assisted send form.

The Mailgun From header is built the same way: `"<sender name> - <sender title>" <address>` (or `"<sender name>" <address>` if no title is specified), so the header and the in-body signature always match. The raw manual send in the Testing tab is unaffected — it sends exactly what you type, sender identity and all, since there's no AI involved there.

## 7. Vercel Cron — dispatch frequency

Vercel's **free Hobby plan only allows daily cron**, and daily cron can't honor intra-day drip pacing. `vercel.json` reflects that limit — it schedules `/api/cron/dispatch` once a day (`0 0 * * *`) purely as a fallback in case the real trigger below stalls. Do not add a more frequent entry there on Hobby; the deploy will simply fail. (If you're on a paid Vercel plan that allows more frequent cron, you can drop the Supabase-side trigger below entirely and just tighten this schedule instead.)

### The real trigger: Supabase pg_cron + pg_net

This calls the dispatch route every 15 minutes for free, from inside Supabase, regardless of your Vercel plan. `runDispatchTick` (`src/lib/dispatch.ts`) is safe to call this often — it checks each list's active-day/send-window/daily-cap/drip-pace before doing any real work and returns immediately once nothing is due, so an empty tick is cheap.

**Run this once you have a real production URL and have set `CRON_SECRET` in Vercel** (steps below need both — that's why this isn't a migration file, it would fail today). Run it in the Supabase SQL editor for your project:

```sql
-- 1) Store the URL and auth header as Vault secrets — not hardcoded here,
--    and not visible in cron.job's stored command text either.
select vault.create_secret(
  'https://<your-production-domain>/api/cron/dispatch',
  'cron_dispatch_url'
);
select vault.create_secret(
  'Bearer <same value as CRON_SECRET in your Vercel project env vars>',
  'cron_dispatch_auth_header'
);

-- 2) Enable the extensions (idempotent, safe to re-run).
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- 3) Schedule the tick every 15 minutes. net.http_get queues the request
--    and returns immediately (it's async), so this is cheap to schedule
--    this tightly even though a busy tick can take a few seconds to run.
select cron.schedule(
  'dispatch-tick',
  '*/15 * * * *',
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'cron_dispatch_url'),
    headers := jsonb_build_object(
      'Authorization', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_dispatch_auth_header')
    )
  );
  $$
);
```

To change the URL/secret later (e.g. a custom domain replacing the `*.vercel.app` one), update the two secrets with `select vault.update_secret(id, 'new value') from vault.decrypted_secrets where name = '...';` — no need to touch the cron job itself.

To remove the schedule: `select cron.unschedule('dispatch-tick');`

### Verifying it's actually running

Two independent ways to check, from opposite ends:

- **From Supabase** — confirms pg_cron is firing at all:
  ```sql
  select * from cron.job_run_details
  where jobid = (select jobid from cron.job where jobname = 'dispatch-tick')
  order by start_time desc limit 20;
  ```
  Each row's `status` should be `succeeded` (pg_net queued the HTTP request successfully — this doesn't confirm the app responded 200, just that the request was sent).

- **From the app** — confirms the app is actually being reached and doing work: every hit to `/api/cron/dispatch`, cron or manual, inserts a row into `cron_runs` (`started_at`, `finished_at`, `processed`, `sent`, `failed`, `error_message`). `select * from cron_runs order by started_at desc limit 10;` should show a new row roughly every 15 minutes.

- **From the app's UI** — the sidebar's system-health indicator (`src/components/layout/health-indicator.tsx`) polls `/api/analytics/health`, which reads the most recent `cron_runs` row. It shows green ("Last run Nm ago") when the last run started under 45 minutes ago, amber past 45 minutes, and red ("Cron hasn't run in Nm") past 90 minutes — so if the Supabase schedule silently stops firing, this flips to amber then red on its own within the app, without needing to check Supabase directly day to day.

## 8. Custom domain DNS

Two independent DNS setups, for two different purposes:

- **Mailgun sending domain** (`MAILGUN_DOMAIN`) — verify it in Mailgun (Sending → Domains) and add the SPF, DKIM, and (recommended) DMARC records Mailgun gives you. This is what section 2 above depends on — without it you're stuck on the sandbox domain and its DMARC-alignment delivery failures.
- **App domain** (where Vercel serves the app) — if you're using a custom domain instead of the default `*.vercel.app` one, add it in Vercel (Project → Settings → Domains) and follow the CNAME/A record instructions Vercel gives you. This is also the URL you use for the Mailgun webhook endpoints (sections 3 and 5) and the pg_cron `cron_dispatch_url` secret (section 7) — set those up after the domain is live so you don't have to redo them.

## 9. Vercel environment variables

Set every var from `.env.example` in the Vercel project (Project → Settings → Environment Variables), not just the ones that were required before this pass:

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (legacy service_role or new secret key; never `SUPABASE_DB_URL`), `GEMINI_API_KEY`, `GEMINI_MODEL` (optional), `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM` (optional), `MAILGUN_BASE_URL` (optional), `MAILGUN_WEBHOOK_SIGNING_KEY`, `DEFAULT_SENDER_NAME`, `DEFAULT_SENDER_TITLE`, `GROQ_API_KEY` (optional), `GROQ_MODEL` (optional), `NEXT_PUBLIC_OPERATOR_TIMEZONE` (optional), `CRON_SECRET`, `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_SECRET`.

`CRON_SECRET` is the one to double check — it must match exactly what you put in the pg_cron Vault secret (`cron_dispatch_auth_header`, section 7) and what Vercel sends automatically on its own daily fallback cron hit.

## 10. Company knowledge base (Settings)

Upload real company documents (PDF, DOCX, TXT, MD), add important links, and type any company facts on the Settings page. A concise company brief is generated from the enabled content and is the only source of company facts the AI may use in emails; until something is added, emails rely on the campaign description and lead list settings alone. The `knowledge-base` storage bucket (private) is created by the `providers_and_knowledge_base` migration.

## 11. Supabase

The migrations in `supabase/migrations/` are applied in order. If you're setting up a fresh project rather than continuing an existing one, run them via the Supabase CLI or dashboard SQL editor in filename order. A `campaign-assets` storage bucket (public) is also required — for a fresh project, create it manually (Storage → New bucket → `campaign-assets`, public) since the migrations only cover `public` schema tables.

## What's *not* covered here

There is no queue/worker service in this stack. Bulk initial-email generation runs as a client-driven loop of small batched requests (each one fast enough to stay well under Vercel's function timeout), plus the cron tick opportunistically advances any list with ungenerated contacts left — so generation keeps progressing even if nobody has the page open, without needing separate infrastructure.

## Move to a new Supabase project

1. Create the project, then in `.env.local` set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Settings, API Keys: the legacy service_role key, or the secret key if there is no legacy tab) and `SUPABASE_DB_URL` (Connect, Session pooler string, with the database password filled in and percent-encoded; direct connections may need IPv6).
2. `npm run db:push -- --dry-run`, then `npm run db:push`. This applies every file in `supabase/migrations`, including both storage buckets and the default CTA link and early-bird line.
3. Log in and open `/api/health`: it lists any table, function or bucket the app needs that the project is missing.
4. Update the same Supabase variables in Vercel (not `SUPABASE_DB_URL`).
