# Master Hustle Engine

A Node.js/Express backend that runs cold outbound end to end: ingest a lead,
qualify it, generate a tailored pitch, send it, run the follow-up sequence, and
stop the moment someone replies. State lives in SQLite on a Render persistent
disk. Text generation goes through Gemini with automatic failover to other
providers.

This is the engine behind the **White-Label Agency AI Infrastructure** offer —
see `CLAUDE.md` for positioning and pricing.

## What it does

1. **Lead ingestion**
   - `POST /webhook/lead` (alias `POST /api/ingest`) — the path Gumloop posts to.
   - `POST /admin/leads` for bulk import.
   - Required fields, aliases, and the exact payload contract are documented in
     `GUMLOOP-SETUP-FOR-ANTIGRAVITY.md`. A payload missing `company_name` or
     `website` returns 400 and the lead is **dropped, not queued**.

2. **Qualification and quality screening**
   - Industry filter against `TARGET_INDUSTRIES` (agency verticals only).
   - Quality screen rejects free email providers unless `ALLOW_FREEMAIL=true`,
     and rejects domains on the committed blocklist (`config/blocklist.json`).
   - Do-not-contact check before every send.

3. **Outbound dispatch**
   - Gated by `OUTBOUND_PAUSED`, which **defaults to paused** — see
     [Pausing outbound](#pausing-outbound).
   - Step 1 sends immediately; later steps are queued into `follow_ups` and
     dispatched by the hourly scheduler.
   - `DAILY_SEND_CAP` (default **4**) is enforced on every send path — the batch
     loop, the webhook, and the follow-up scheduler. Leads over the cap are
     queued, never dropped.
   - Any reply halts the sequence.

4. **Inbound calls**
   - `POST /webhook/openphone` (alias `POST /api/inbound`) handles missed-call
     events and runs the call classifier.

5. **Model failover**
   - `agent.skills/intelligent-router.js` retries across providers
     (Gemini → OpenAI → Anthropic) on rate limits and transient errors.
   - This is a **reliability** feature, not a token reducer. It fires only after
     a failure, so it does not run on the happy path. Failover events are logged
     and surfaced in the daily digest.

6. **Reporting**
   - `GET /admin/status` — queue depth, sends today, cap, suppression size.
   - `GET /admin/status-report` and a daily email digest.
   - `GET /health` — machine-readable feature/degradation report.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /webhook/lead` · `POST /api/ingest` | Lead intake |
| `POST /webhook/openphone` · `POST /api/inbound` | Inbound call events |
| `POST /admin/leads` | Bulk lead import |
| `POST /admin/run-now` | Process the next batch immediately |
| `GET /admin/status` | Queue, sends today, cap, suppression count |
| `GET /admin/do-not-contact` | View / add / remove suppressions |
| `GET /health` | Feature and degradation report |
| `POST /api/stripe-webhook` | License purchase → notify + welcome email |

> The nine legacy micro-SaaS niche endpoints (`/api/vintage`, `/api/voice`,
> `/api/contractor-proposal`, …) and the 8am niche rotation cron were **removed**
> in PR #78. `orchestrator.py` still contains those skills, but `render.yaml`
> does not deploy it. Do not sell them.

---

## Pausing outbound

Cold sending is behind a kill switch, and the switch **defaults to on (paused)**.
Cold pitches and follow-ups go out only when `OUTBOUND_PAUSED` is set to an
explicit `false`. A forgotten or mistyped value fails safe: nothing sends.

What a pause stops:

- Cold pitch emails and every queued follow-up step, blocked inside
  `sendPitchEmail()` — the one function every cold send routes through.
- The lead-batch scheduler and the hourly follow-up scheduler (both idle).
- The Gumloop scraper auto-trigger — no point collecting leads nobody may email.
- `POST /admin/bulk-pitch`, which returns **409** instead of half-sending a batch.

What keeps running:

- Lead intake. `POST /webhook/lead` still validates, qualifies, screens, and
  **queues** — it returns `{"status":"QUEUED","paused":true}` rather than
  sending. Nothing is lost; the queue drains when sending resumes.
- Stripe webhooks, purchase notifications, and the buyer welcome email.
- Admin alerts, `/health`, `/admin/status`, and the daily status digest.

Pending leads and pending follow-ups are never marked failed by a pause — they
stay pending and are picked up exactly where they left off.

```bash
OUTBOUND_PAUSED=true                       # paused (also the default when unset)
OUTBOUND_PAUSE_REASON="Reputation hold."   # optional; shown in /health and the digest
OUTBOUND_PAUSED=false                      # resume sending
```

The state is visible without reading logs — `GET /health` and `GET /admin/status`
both report an `outbound` block, `/admin/pitch` shows a banner with its send
button disabled, and the daily digest carries a paused banner so a row of zeros
reads as the switch working rather than a broken engine.

---

## Local Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
Create a `.env` file in the root directory (`.env` is gitignored; never commit a
real key):
```env
PORT=3005
GEMINI_API_KEY=your_google_gemini_key

# SMTP Credentials
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password_here

# Sender identity (FROM_NAME defaults to "Jack Bockholdt")
FROM_EMAIL=
FROM_NAME=Jack Bockholdt

# Admin alert receiver
ADMIN_EMAIL=you@example.com

# Outbound pacing — keep this low while warming a sending account
DAILY_SEND_CAP=4
```

See `.env.example` for the full list.

### 3. Start
```bash
npm run dev
```

---

## Render Deployment

Deployment is defined by `render.yaml` — use the blueprint rather than
configuring by hand, so the plan and disk stay in source control.

Two settings are load-bearing:

- **`plan: starter`**, not free. The free tier spins down after ~15 minutes idle,
  which kills the in-process `setInterval` schedulers (lead batch, follow-ups,
  Gumloop trigger) long before their 6-hour timers elapse.
- **A persistent disk mounted at `/data`.** `pickDataDir()` (`server.js`) probes
  `/data` first. Without the disk, SQLite lands on the container filesystem and
  send history, the lead queue, pending follow-ups, and the runtime
  do-not-contact table are wiped on every restart and redeploy — and a wiped DNC
  table means re-mailing people who already opted out.

**Verify after deploying.** The boot log prints:

```
[SQLite] Database path: /data/my_database.db (persistent disk)
```

If it says `(EPHEMERAL — no persistent disk found)`, the disk did not mount and
state will not survive a restart.
