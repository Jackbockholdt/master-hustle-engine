# Antigravity 2.0 — Current State

## What This Is
A live AI sales engine that scrapes leads, qualifies them, and auto-sends pitch emails for Jack Bockholdt's **White-Label AI Infrastructure License** ($1,500/month). Buyers white-label the 9-skill engine and resell it to their own clients.

**Two qualified buyer types (both live as of 2026-07-06):**
1. Digital marketing / lead-gen agency owners — resell to their local business clients
2. Tech startups / SaaS / software / digital service companies — resell to their own customers

**This supersedes all earlier offers.** Do not pitch plumbers, HVAC, or other end-business owners directly — the buyer white-labels and resells, they are never the end client. Full playbook: `marketing/GTM-BLUEPRINT.md` (cold call script + scraper targeting) and `marketing/FOLLOWUP-EMAIL-SEQUENCE.md` (3-email follow-up).

## Live URLs
- **Unified backend:** https://master-hustle-engine.onrender.com (single service — Python orchestrator eliminated)
- **GitHub:** Jackbockholdt/master-hustle-engine (main branch)

## Everything That Is Already Working — DO NOT TOUCH
- `server.js` — unified Node.js engine, all 9 skills + B2B outreach engine, deployed on Render
- Stripe webhook live at master-hustle-engine.onrender.com/api/stripe-webhook (STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET set in Render)
- Lead intake endpoint: POST /webhook/lead (tested and working, accepts `email` or `contact_email`)
- Pitch emails route through Gmail HTTPS relay (GMAIL_HTTP_URL env var) — do not touch SMTP directly
- OpenPhone webhook: POST /webhook/openphone
- Day 5 / Day 10 follow-up sequences: automatic, run hourly
- B2B outreach batch: runs every 6 hours

## Gumloop Scraper — LIVE as of 2026-07-18
The scraper is ON and pushing leads to the endpoint below. Both campaigns are live: leads without a `campaign` field get the AI-personalized white-label pitch; leads with `"campaign": "antigravity-saas"` get the fixed template sequence. One known failure mode already hit and fixed: duplicating a Gumloop flow breaks its variable references (the HTTP node then sends literal `${...}` strings) — the engine now rejects those payloads with a 400 naming the field, so a broken flow shows up as failed requests in Gumloop's run history. If sends stop, check there first.

**Gumloop HTTP node config (reference):**
- URL: https://master-hustle-engine.onrender.com/webhook/lead
- Method: POST
- Header: Content-Type: application/json
- Body:
```json
{
  "company_name": "{{company_name}}",
  "contact_email": "{{email}}",
  "website": "{{website}}",
  "industry": "{{industry}}"
}
```

**Scraper targeting — job titles (any of):** Founder, Co-Founder, CEO, Owner, Managing Director, Head of Growth, Agency Owner

**Scraper targeting — industry keywords (any of, case-insensitive substring match):**
```
digital marketing agency, lead generation agency, marketing agency, seo agency,
ppc agency, social media agency, growth agency, advertising agency,
startup, saas, software company, tech startup, online startup,
digital services, digital agency, web development agency, software agency, tech company
```
This exact list lives in the `TARGET_INDUSTRIES` env var on the `master-hustle-engine` Render service — anything outside it gets auto-disqualified with no email sent. To add more categories, update that env var, then **trigger a fresh deploy** (env var changes alone do not restart the running process on this account's Render config — confirmed by testing, not just theory).

- Company size: 1–50 employees
- Must have: real contact email (not `info@`/`hello@`), working website

## Second Campaign — `antigravity-saas` (fixed templates, no AI copy)
A template-based 3-email sequence pitching the **Antigravity AI Engine pilot** (honest capability pitch, no invented track record): initial send → day-3 follow-up → day-7 breakup. Templates live in `TEMPLATE_CAMPAIGNS` in `server.js`; merge fields `{{first_name}}` (falls back to "there") and `{{company_name}}`. Uses the same qualification filter and the same hourly follow-up scheduler as the main campaign.

**To route a lead into it,** add two fields to the `/webhook/lead` Gumloop body:
```json
{ "campaign": "antigravity-saas", "first_name": "{{first_name}}" }
```
Leads without a `campaign` field keep getting the AI-personalized white-label pitch as before.

**Shared daily send cap:** `DAILY_SEND_CAP` env var (default 50) caps total outbound pitch + follow-up emails per UTC day **across all campaigns combined** — adding this campaign does not double volume. Leads over the cap are queued (`status: QUEUED`) and go out on later batch runs; due follow-ups stay pending until the next hourly run. Current count visible at `/admin/status` under `sends`.

## Do-Not-Contact List (opt-out suppression)
When a prospect replies "stop"/"unsubscribe", add them here — enforced before **every** outbound pitch and follow-up send, on every campaign, and adding an email immediately cancels its pending follow-ups and queued leads (mid-sequence stop works). Emails are normalized to lowercase.
```bash
# Add (also accepts {"emails": [...]} for bulk; optional "reason")
curl -X POST https://master-hustle-engine.onrender.com/admin/do-not-contact \
  -H "Content-Type: application/json" -d '{"email":"prospect@example.com","reason":"replied stop"}'
# List
curl https://master-hustle-engine.onrender.com/admin/do-not-contact
# Remove
curl -X DELETE https://master-hustle-engine.onrender.com/admin/do-not-contact \
  -H "Content-Type: application/json" -d '{"email":"prospect@example.com"}'
```
Suppressed sends show up as `status: 'suppressed'` in `leads_queue`/`follow_ups`; list size is in `/admin/status` under `do_not_contact`. Nothing automated adds entries — reading replies stays a human job.

## Persistent Database (added 2026-07-20)
SQLite lives on the Render persistent disk: **`/data/my_database.db`** (disk `data_storage`; `/data` is the primary mount point, and `/var/data` is auto-detected as an alternate). A mount only wins if it exists and is writable, so a bad mount degrades to the repo-local `transactions.sqlite` fallback instead of crashing; the boot log prints the chosen path and whether it's persistent. The suppression list, lead queue, follow-ups, and send counts survive deploys. Overrides: `DB_PATH` (full file path) or `DATA_DIR` (mount dir) env vars. Before this, every deploy silently wiped the database — never move the DB back inside the repo directory.

## Change Control — ALL changes go through GitHub PRs
No direct pushes to `main`, no dashboard-only tweaks that code depends on. Every agent working this repo (there may be more than one) opens a PR, and coordinates with other agents via PR comments. Jack merges. This is what keeps two agents from breaking production on top of each other.

## Custom Sender Identity (optional)
`FROM_EMAIL` / `FROM_NAME` env vars: when set, the Gmail relay payload carries `from`/`fromName` (the Apps Script must pass them to `GmailApp.sendEmail`, and `FROM_EMAIL` must be a verified "Send mail as" alias on the relay account). Unset = sends from the relay account's own address, exactly as before.

## Lead Quality Screen (added 2026-07-20)
Beyond syntax validation, every intake path runs `screenLeadQuality()` and disqualifies (with a named reason, `status: DISQUALIFIED`) leads that would waste a send:
- **Generic mailboxes** — `info@`, `hello@`, `sales@`, `noreply@`, etc. A real person's address is required.
- **Free email providers** — gmail/yahoo/hotmail/outlook/etc. Set `ALLOW_FREEMAIL=true` env var to allow them.
- **Wrong-company contacts** — if the email's domain and the lead's `website` domain are both corporate but don't match (e.g. a `92y.org` address pitched "for IRONPAPER"), the lead is rejected as a mis-scraped contact.
- **Oversized companies** — if the payload includes `employee_count` or `company_size` (number or range like `"51-200"`; range uses the lower bound), anything over `MAX_EMPLOYEE_COUNT` (env, default 50) is rejected. Add these fields to the Gumloop body to enforce the 1–50 rule server-side.
- **Blocked domains** — `BLOCKED_DOMAINS` env var (comma-separated, e.g. `edelman.com,jcdecaux.com`) hard-rejects known too-big-to-buy companies.

`/admin/bulk-pitch` skips the screen when `override_email` is explicitly provided (deliberate human choice). Env var changes need a fresh deploy, same as `TARGET_INDUSTRIES`.

## Lead Payload Validation
Every intake path (`/webhook/lead`, `/admin/leads`, `/admin/bulk-pitch`, batch runs) rejects leads whose `contact_email` isn't a syntactically valid address or whose fields contain unresolved template placeholders (`${...}` / `{{...}}` — e.g. a mis-wired Gumloop variable like `${Valid Emails__NODE_ID__:...}`). Webhook returns `400` with `status: INVALID` and the offending field named, so a broken Gumloop node shows up as a visible failure in Gumloop's run history instead of burning a Gemini call and an admin alert per lead.

## Offer Details
- Product: White-Label AI Infrastructure License
- Price: $1,500/month license fee
- Buyer: Agency owners OR tech/SaaS/digital-service founders (1–50 employees) who resell to their own customers
- Proof URL: `PROOF_URL` env var (default: https://master-hustle-engine.onrender.com/pitch — the engine's own sales one-pager)
- Payment link: https://buy.stripe.com/3cI14m9hOcPh6Gbcx10000D
- Pitch tone: Peer-to-peer, math-driven ("resell to 3 clients at $500/mo and you're already break-even")
- NEVER mention: SHOVL, shovel, invention, patent licensing

## Render Service IDs
- master-hustle-engine (Node.js, the live unified service): srv-d8thrho0697c73clcvtg
- antigravity-orchestrator (Python, srv-d910i40k1i2s73822a5g): **legacy — SUSPENDED as of 2026-07-18.** Its functionality was fully ported into `server.js` above. Do not resurrect it; the unified Node service is the only live backend.

## Test The Engine
```bash
# Agency lead
curl -X POST https://master-hustle-engine.onrender.com/webhook/lead \
  -H "Content-Type: application/json" \
  -d '{"company_name":"Test Agency","contact_email":"jackbockholdt88@gmail.com","website":"https://test.com","industry":"digital marketing agency"}'

# Tech/SaaS lead
curl -X POST https://master-hustle-engine.onrender.com/webhook/lead \
  -H "Content-Type: application/json" \
  -d '{"company_name":"Test SaaS Co","contact_email":"jackbockholdt88@gmail.com","website":"https://test.com","industry":"saas startup"}'
```
Both confirmed working end-to-end (qualified → pitch generated → email sent) as of 2026-07-13, on the unified `master-hustle-engine` service, after fixing a deprecated Gemini model reference (`gemini-2.5-flash` → `gemini-flash-latest`). Gemini's `gemini-flash-latest` is currently intermittently returning `503 high demand` errors — a temporary, Google-side capacity issue tied to a recent model launch, not a bug here.

## Check Queue / Follow-Up Status
```bash
curl https://master-hustle-engine.onrender.com/admin/status
```

## Check Logs
https://master-hustle-engine.onrender.com/logs
