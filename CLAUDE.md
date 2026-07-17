# Antigravity 2.0 — Current State

## What This Is
A live AI sales engine that scrapes leads, qualifies them, and auto-sends pitch emails for Jack Bockholdt's **White-Label AI Infrastructure License** ($1,500/month). Buyers white-label the 9-skill engine and resell it to their own clients.

**Two qualified buyer types (both live as of 2026-07-06):**
1. Digital marketing / lead-gen agency owners — resell to their local business clients
2. Tech startups / SaaS / software / digital service companies — resell to their own customers

**This supersedes the old contractor/missed-call offer.** Do not pitch plumbers, HVAC, or other end-business owners directly — the buyer white-labels and resells, they are never the end client. Full playbook: `marketing/GTM-BLUEPRINT.md` (cold call script + scraper targeting) and `marketing/FOLLOWUP-EMAIL-SEQUENCE.md` (3-email follow-up).

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

## The ONE Thing Left To Do
**Turn the Gumloop scraper on** — the engine is fully built, tested, and waiting. Nothing will happen until Gumloop actually starts pushing leads to the endpoint below.

**Gumloop HTTP node config:**
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

## Offer Details
- Product: White-Label AI Infrastructure License
- Price: $1,500/month license fee
- Buyer: Agency owners OR tech/SaaS/digital-service founders (1–50 employees) who resell to their own customers
- Proof URL: https://missedcallproject.com
- Payment link: https://buy.stripe.com/3cI14m9hOcPh6Gbcx10000D
- Pitch tone: Peer-to-peer, math-driven ("resell to 3 clients at $500/mo and you're already break-even")
- NEVER mention: SHOVL, shovel, invention, patent licensing

## Render Service IDs
- master-hustle-engine (Node.js, the live unified service): srv-d8thrho0697c73clcvtg
- antigravity-orchestrator (Python, srv-d910i40k1i2s73822a5g): **legacy, redundant, still running and costing money.** Its functionality was fully ported into `server.js` above. Not suspended yet as of 2026-07-13 — worth shutting down to stop paying for duplicate infrastructure, pending an explicit go-ahead.

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

## Unrelated Project — Do Not Confuse With This One
There is a **separate, local** repo `C:\Users\jack\missed-call-agent` (Vapi + OpenPhone/Quo backend, its own `CLAUDE.md`) with one outstanding task: a `GOOGLE_PLACES_API_KEY` for Google Cloud project `491932772151`. That work is not part of this repo and has no bearing on the orchestrator or Gumloop setup described above.
