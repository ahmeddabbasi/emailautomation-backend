# Email Automation API

This repository is the backend. Deploy it on Render. The dashboard lives in [emailautomation-frontend](https://github.com/ahmeddabbasi/emailautomation-frontend) and is deployed on Vercel.

The browser never calls Render directly. Vercel proxies `/api/*` to this service and keeps the session cookie on the Vercel host. Supabase, Mailgun, Gemini, and mailbox passwords stay in this service only.

## Deploy on Render

1. Push this repo, then in Render choose **New** → **Blueprint** and point it at this repository. `render.yaml` creates a web service and a dispatch cron.
2. Use a plan that does not spin down. A sleeping instance misses the 15-minute send window and drops SMTP connections.
3. Fill every environment variable Render marks as required. Copy the names from `.env.example`. Do not commit values.
4. `AUTH_SECRET` must be the same string you set on Vercel.
5. After the first deploy, set `APP_URL` to the Render URL (for example `https://emailautomation-backend.onrender.com`) and redeploy. Unsubscribe links in sent mail use that origin.
6. On the cron service, set `BACKEND_URL` to that same Render URL and set `CRON_SECRET` to the same value as the web service. The cron calls `POST /api/cron/dispatch` every 15 minutes.
7. Point Mailgun at this host, not at Vercel:
   - Inbound route: `https://<render-host>/api/webhooks/inbound`
   - Permanent failure and spam complaint: `https://<render-host>/api/webhooks/mailgun`
8. Open `https://<render-host>/api/health/live`. It should return `{"ok":true}`. The authenticated schema check is `GET /api/health` with a logged-in session.

The database for this project is already migrated. Run `npm run db:push` from a machine that has `SUPABASE_DB_URL` only if you create a new Supabase project. The running service does not need `SUPABASE_DB_URL`.

Local API only:

```bash
npm install
npm run dev
```

## Product behavior

An internal, AI-powered cold email outreach and sequence automation platform built with Next.js 16, Supabase, Google Gemini, and Mailgun.

Designed for automated, high-deliverability cold email campaigns with intelligent personalization, timezone-aware drip scheduling, automated reply detection, and delivery monitoring.

---

## 🚀 What Has Been Implemented

### 1. Multi-Step Drip Sequence & Dispatch Engine
- **Automated Sequences**: Supports initial cold outreach (Step 0) followed by multi-step follow-ups (Step 1 at Day 3, Step 2 at Day 7, Step 3 at Day 14, with customizable offsets).
- **Timezone-Aware Delivery Windows**: Sends emails strictly within working hours (e.g. 09:00 to 18:00) in each lead list's local timezone.
- **Drip Batch Pacing**: Batches dispatches (e.g., 5 emails every 3 hours) and enforces daily send caps to protect domain sender reputation.
- **Race-Condition Protection**: Concurrency locking (`locked_at`) and database-level unique constraints prevent double-sending during overlapping cron ticks.

### 2. AI Copywriting & Quality Guardrails
- **Dual LLM Architecture**: Primary copy generation via **Google Gemini** (`@google/genai`) with automatic failover to **Groq** during quota limits or outages.
- **Anti-AI Formatting Filters**: Automatically strips em/en dashes and robotic AI phrasing.
- **Hallucination Prevention**: Deterministically removes AI-invented sign-offs (`stripSignOff`) and appends only configured real sender identities (`sender_name`, `sender_title`).
- **Pre-Generation Pipeline**: Pre-generates initial drafts upon lead upload and generates follow-ups dynamically based on context.

### 3. Inbound Reply Detection & Bounce Handling
- **Automated Reply Halting**: Webhook endpoint at `/api/webhooks/inbound` parses incoming replies via Mailgun routes and immediately marks contacts as `replied`, preventing subsequent follow-ups.
- **Deliverability Protection**: Webhook endpoint at `/api/webhooks/mailgun` processes hard bounces (marks `invalid`) and spam complaints (marks `complained`), halting further sending automatically.

### 4. Company Knowledge Base (RAG)
- **Multi-Format Extraction**: Parses company documents (PDF via `unpdf`, DOCX via `mammoth`, plain text) and website links with built-in SSRF protection against private IP ranges.
- **Active Company Brief**: Condenses uploaded documents, facts, and links into a concise company brief injected into every email generation prompt.

### 5. Testing & Verification Suite
- **Direct Testing UI** (`/testing`): AI-assisted test draft generator and manual raw sender.
- **Live Delivery Verification**: Polls the Mailgun Events API to show real-time delivery status (`Delivered`, `Failed` with error message, or `Pending`).

### 6. Analytics, Health & Error Logging
- **Visual Analytics** (`/dashboard`): Daily send volumes, step breakdown, and funnel conversion tracking (Queued → Sent → Delivered → Replied).
- **Observability** (`/error-logs`): Deduplicated error logging with error fingerprinting, stack traces, and resolution status.
- **Health Indicator**: Real-time monitoring of cron dispatches, generation failures, and unresolved errors.

### 7. Security & Authentication
- **Session Authentication**: Lightweight Web Crypto HMAC-SHA256 signed session cookies (Edge middleware and Node runtime compatible).
- **Rate-Limited Login**: Postgres-backed login attempt rate limiting to prevent brute-force attacks.
- **Row Level Security (RLS)**: Direct browser access to database tables is denied; all operations run through backend server functions using the Supabase service role.

---

## 🛠️ What Needs to Be Configured to Run

Since you are setting up this system for your own usage, you will need to provide your own service credentials.

### 1. Environment Configuration
Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```

Fill in the required values:

| Variable | Description | Where to Get It |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Supabase Project URL | Supabase Dashboard → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role Secret Key | Supabase Dashboard → Settings → API Keys |
| `SUPABASE_DB_URL` | Postgres Connection String (Session pooler) | Supabase Dashboard → Connect → Session pooler |
| `GEMINI_API_KEY` | Google Gemini API Key | [Google AI Studio](https://aistudio.google.com/apikey) |
| `MAILGUN_API_KEY` | Mailgun API Key | Mailgun Dashboard → Settings → API Keys |
| `MAILGUN_DOMAIN` | Verified Sending Domain (e.g. `mg.yourdomain.com`) | Mailgun Dashboard → Sending → Domains |
| `MAILGUN_WEBHOOK_SIGNING_KEY`| Mailgun Webhook Signing Key | Mailgun Dashboard → Sending → Webhooks |
| `AUTH_USERNAME` | Admin login username | Any username of your choice |
| `AUTH_PASSWORD` | Admin login password | Any secure password |
| `AUTH_SECRET` | 32-byte secret for session cookies | Generate via `openssl rand -hex 32` |
| `CRON_SECRET` | Shared secret to authorize dispatch cron | Any random string |
| `NEXT_PUBLIC_OPERATOR_TIMEZONE` | Dashboard timezone (e.g. `UTC`, `America/New_York`) | Your timezone identifier |

*Optional fallbacks:*
- `GROQ_API_KEY` & `GROQ_MODEL`: Set if you want automated backup generation when Gemini is unavailable.

### 2. Database Migration Setup
Initialize your database tables and storage buckets:
```bash
npm install
npm run db:push
```

### 3. Mailgun Webhook Configuration
To enable reply and bounce detection:
1. **Reply Route**: In Mailgun, go to **Receiving → Routes → Create Route**.
   - Match: `Catch All`
   - Action: `Forward to https://<your-domain>/api/webhooks/inbound`
2. **Bounce / Complaint Webhook**: In Mailgun, go to **Sending → Webhooks**.
   - Permanent Failure → `https://<your-domain>/api/webhooks/mailgun`
   - Spam Complaint → `https://<your-domain>/api/webhooks/mailgun`

### 4. Background Dispatch Cron
To run automated email dispatching every 15 minutes, execute the SQL script in [`SETUP.md`](file:///home/ahmed/Downloads/linkedkraftautomationsystem/SETUP.md#L78-L109) inside the Supabase SQL editor (`pg_cron` + `pg_net`), or configure a scheduled HTTP GET call from your hosting provider to `/api/cron/dispatch` with header `Authorization: Bearer <CRON_SECRET>`.

---

## 🔌 Customizing & Extending the System

This codebase is structured modularly so you can adapt it to any service or workflow:

### Alternative Mailing Providers & Mailboxes
The sending layer is isolated in [`src/lib/sending.ts`](file:///home/ahmed/Downloads/linkedkraftautomationsystem/src/lib/sending.ts). You can swap or extend Mailgun with:
- **Zoho Mail / Google Workspace / Outlook (SMTP/IMAP)**: Use `nodemailer` inside `src/lib/sending.ts` to send directly through personal or business inboxes, and an IMAP listener for replies.
- **SendGrid / Postmark / AWS SES / Resend**: Replace the `mailgunClient().messages.create` call in `sendEmail()` with the corresponding SDK.
- **Multi-Inbox Rotation**: Add multiple mailbox credentials to distribute volume across multiple sending accounts.

### Lead Sourcing & CRM Integrations
- **CSV Import (Built-in)**: Upload any CSV lead file on the `/leads` page; auto-detects name, email, company, title, and bio columns.
- **Apollo / Lead Scrapers**: In [`src/app/api/contacts/route.ts`](file:///home/ahmed/Downloads/linkedkraftautomationsystem/src/app/api/contacts/route.ts), you can connect Apollo's search API or webhooks to import enriched leads directly into the `contacts` table.
- **CRM Sync**: Push replies or status changes (`replied`, `completed`) to HubSpot, Salesforce, or Pipedrive from [`src/lib/webhooks/handlers.ts`](file:///home/ahmed/Downloads/linkedkraftautomationsystem/src/lib/webhooks/handlers.ts).

---

## 🏃 Local Development

Run the development server locally:
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with your configured `AUTH_USERNAME` and `AUTH_PASSWORD`.
