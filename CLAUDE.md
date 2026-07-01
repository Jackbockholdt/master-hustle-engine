# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

This repo contains **two independent backend services** deployed separately on Render, plus a `skills/` spec directory and a `marketing/` playbook. They are not layers of one app — they are two generations of the same idea (an autonomous AI micro-SaaS engine) built with different stacks, and both are currently live.

1. **`server.js`** — the original Node/Express "Autopilot Niche Engine": 9 generic micro-SaaS content endpoints (vintage appraisal, KDP books, inventor pitches, voice prompts, review replies, local SEO, marketplace ads, faceless video scripts, contractor proposals) plus a daily cron rotation and a Stripe purchase webhook.
2. **`orchestrator.py`** — the active B2B sales engine, "Antigravity 2.0": a FastAPI router that dispatches Gumloop/Vapi/OpenPhone webhooks to 9 skill handlers (call-catcher, vintage-appraiser, file-mixup-catcher, web-page-creator, kdp-book-publisher, email-handler, vapi-voice-agent, hemp-review-generator, invention-outreach), with a SQLite audit trail and a self-driving lead queue.

**`orchestrator.py` is the live product being sold right now** (see "Current Business State" below) — a white-label AI infrastructure license pitched to marketing/lead-gen agency owners. `server.js` is a separate, older product and is not part of that sales motion.

## Commands

There is no build step, linter, or test suite in this repo — treat any change as verified by manually exercising the relevant HTTP endpoint.

```bash
# Node service (server.js)
npm install
npm run dev          # nodemon server.js — auto-restarts on change, reads .env
npm start             # node server.js — production mode

# Python service (orchestrator.py)
pip install -r requirements.txt
uvicorn orchestrator:app --reload --port 8000     # local dev with auto-reload
uvicorn orchestrator:app --host 0.0.0.0 --port $PORT   # production (Render start command)
```

Manual smoke test for the orchestrator (mirrors what Gumloop sends):

```bash
curl -X POST https://antigravity-orchestrator-kz94.onrender.com/webhook/lead \
  -H "Content-Type: application/json" \
  -d '{"company_name":"Test Agency","contact_email":"jackbockholdt88@gmail.com","website":"https://test.com","industry":"digital marketing agency"}'
```

Any `/skill/{skill_name}` route on the orchestrator can be hit directly to test a single skill in isolation without going through webhook payload resolution (see Architecture below).

## Architecture

### `orchestrator.py` (FastAPI) — the live sales engine

- **Skill dispatch pattern.** Every capability is an `async def skill_x(payload: dict) -> dict` function registered in `SKILL_MAP` (orchestrator.py:957). Webhook routes don't know which skill they're calling in advance — `resolve_skill()` (orchestrator.py:991) inspects the payload's `skill`/`skill_name`/`intent`/`niche`/`type`/`event` fields (or Vapi's nested `message.type`, or Gumloop/Stripe-style nested `metadata`/`data`/`payload`) against `SKILL_MAP` and the `_ALIASES` keyword table to decide. When adding a new skill: write the handler, register it in `SKILL_MAP`, add its trigger keywords to `_ALIASES`, and add a matching `skills/NN-name.SKILL.md` spec file.
- **`skills/*.SKILL.md` are the spec, not documentation-after-the-fact.** Each file's frontmatter (name/version/description/changelog) and `Intent`/`Trigger` sections describe the contract a handler must implement. `load_skill_md()` (orchestrator.py:292) reads these at runtime for the `/skills` endpoint. Keep a `.SKILL.md` file and its handler in `orchestrator.py` in sync when either changes.
- **Escape hatch convention.** Every skill handler validates required inputs early and either raises with an `ERR_*`-prefixed message (caught by `_run()`, written to the audit log as a FAIL, and re-raised as a 500) or calls `save_to_review()` to persist the payload to `manual_review/{skill_name}/` for a human to pick up. Guardrails follow the same "fail loud or park for a human, never silently ship garbage" rule — e.g. rejecting placeholder LLM copy in `skill_web_page_creator`, forcing low-confidence appraisals to an "ESTIMATED — INSUFFICIENT DATA" label in `skill_vintage_appraiser`, auto-escalating low-confidence email classification to `ESCALATE` in `skill_email_handler`. Preserve this pattern in new skills.
- **`key_decisions` is the audit contract.** Every skill return value includes a `key_decisions` dict summarizing what the handler decided (not the full output) — this is what gets written to `audit_log` and is queryable via `GET /logs`. Any new skill must populate it.
- **Two persistent SQLite tables** (`init_db()`, orchestrator.py:75): `audit_log` (every skill execution, success or fail, with timing) and `leads_queue` (the B2B lead pipeline: pending → sent/disqualified/failed). `DB_PATH` is set via env var in `render.yaml` to a path outside the ephemeral build dir.
- **Self-driving lead pipeline.** `webhook_lead` and `POST /admin/leads` insert rows into `leads_queue`. A background asyncio task (`_scheduler_loop()`, orchestrator.py:1055, armed in the FastAPI `lifespan`) wakes every `BATCH_INTERVAL_HOURS` and calls `_process_lead_queue()`, which qualifies each lead against `QUALIFIED_INDUSTRIES` (via `_qualify_lead()`) and — if qualified — runs `skill_invention_outreach` and marks the row `sent`/`disqualified`/`failed`. `POST /admin/run-now` triggers a batch immediately without waiting for the interval; `GET /admin/status` returns queue counts.
- **Everything about the offer (fee, proof URL, target industries, payment link, deployer identity) is env-var driven**, not hardcoded, so pivoting the pitch (as happened once already — see git history around `ad08ad0`/`dc881d2`) doesn't require code changes, only Render env var updates.

### `server.js` (Express) — the legacy niche engine

- **One `callGemini(prompt, systemInstruction, nicheKey)` wrapper** (server.js:148) does all LLM calls: forces `responseMimeType: 'application/json'`, parses the result, and validates it against the required keys for that niche in `EXPECTED_KEYS` (server.js:135), retrying once on failure/malformed output.
- **Manual endpoints and the cron rotation share logic but not code.** The 9 `/api/*` routes (server.js:413+) and `triggerDailyNicheHustle()` (server.js:645, cron-scheduled for 8:00 AM via `node-cron`) each independently build a `systemInstruction`/`prompt` per niche and call `callGemini`. The cron path additionally rotates through `NICHES_ROTATION` by checking `logs` for the last-run niche, and pulls a random example from the 5-per-niche `NICHES_DICTIONARY`. A third path, `processNicheForBuyer()` (server.js:774, invoked from the Stripe webhook), does the same thing again keyed off Stripe custom-field names. If you change a niche's prompt or output schema, all three call sites need updating.
- **Every generated result is wrapped in the same HTML email template** via `getPremiumEmailHtml()` + `renderJsonToHtml()` (server.js:307/374) and sent through a single Nodemailer transporter, logged to the `logs` table in `transactions.sqlite`.
- **Stripe webhook → fulfillment.** `POST /api/stripe-webhook` verifies the signature, reads `niche` and custom fields off `session.metadata`/`session.custom_fields`, and calls `processNicheForBuyer()` to generate and email the purchased asset.
- A global Express error-handling middleware (server.js:935) and a `sendAdminAlert()` helper (server.js:105) email the full stack trace to `ADMIN_EMAIL` on any uncaught failure.

### Shared conventions across both services

- Both services are stateless HTTP processes backed by a local SQLite file (`transactions.sqlite` for Node, whatever `DB_PATH` points to for Python) and both **assume Render's disk is ephemeral** — see the persistent-disk notes in `README.md` and `render.yaml`.
- Both treat SMTP/Gemini/admin-alert failures as non-fatal to the request where reasonable, but always surface them via an admin email alert — never fail silently.
- All secrets are env vars only (`.env` locally, Render dashboard in production); `.env.example` documents the Node service's vars, `render.yaml` documents both services'.

## Current Business State

**Live product being actively sold:** White-Label AI Infrastructure License ($1,500/month), pitched to digital marketing / lead-gen agency owners (5–50 employees) who white-label the 9-skill `orchestrator.py` engine and resell it to their own local business clients. **This is not `server.js`'s niche engine** — that's a separate, older product.

Full GTM playbook: `marketing/GTM-BLUEPRINT.md` (cold call script + Gumloop scraper targeting params) and `marketing/FOLLOWUP-EMAIL-SEQUENCE.md` (3-email follow-up sequence).

**Never pitch plumbers, HVAC, or other end-business owners directly** — the buyer is the agency, not the end client. **Never mention:** SHOVL, shovel, invention, patent licensing (remnants of an earlier pivot — see git history around `ad08ad0`/`dc881d2`).

### Offer Details
- Product: White-Label AI Infrastructure License, $1,500/month
- Buyer: Digital marketing / lead-gen agency owners (5–50 employees) who resell to their own clients
- Target industries (env var `TARGET_INDUSTRIES`, used by `_qualify_lead()`): Digital Marketing Agency, Lead Generation Agency, SEO Agency, PPC Agency, Social Media Agency, Growth Agency, Advertising Agency
- Proof URL: https://missedcallproject.com
- Payment link: https://buy.stripe.com/3cI14m9hOcPh6Gbcx10000D
- Pitch tone: peer-to-peer, math-driven ("resell to 3 clients at $500/mo and you're already break-even")

### Live URLs
- Orchestrator (FastAPI): https://antigravity-orchestrator-kz94.onrender.com
- Node.js frontend: https://master-hustle-engine.onrender.com
- Logs: https://antigravity-orchestrator-kz94.onrender.com/logs
- GitHub: Jackbockholdt/master-hustle-engine (main branch)

### Render Service IDs
- antigravity-orchestrator: srv-d910i40k1i2s73822a5g
- master-hustle-engine (Node.js): srv-d8thrho0697c73clcvtg

### The one open task
Re-point the Gumloop scraper from its old contractor-lead targeting to the agency-owner targeting params in `marketing/GTM-BLUEPRINT.md` (job titles, company keywords, size, geographies), then connect it to `POST /webhook/lead`.

**Gumloop HTTP node config:**
- URL: `https://antigravity-orchestrator-kz94.onrender.com/webhook/lead`
- Method: POST
- Header: `Content-Type: application/json`
- Body:
```json
{
  "company_name": "{{company_name}}",
  "contact_email": "{{email}}",
  "website": "{{website}}",
  "industry": "{{industry}}"
}
```

### Already working — avoid unrelated changes here
- `orchestrator.py` fully deployed on Render with all env vars set (Gemini, OpenPhone, SMTP, Stripe, payment link).
- Stripe webhook live at `master-hustle-engine.onrender.com/api/stripe-webhook`.
- Lead intake `POST /webhook/lead` (accepts `email` or `contact_email`), OpenPhone webhook `POST /webhook/openphone`, Vapi webhook `POST /webhook/vapi` — all tested and working.
- `/skill/invention-outreach` pitch copy targets agency owners (`skill_invention_outreach` in orchestrator.py).
