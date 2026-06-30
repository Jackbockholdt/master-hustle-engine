# Antigravity 2.0 — Current State

## What This Is
A live AI sales engine that scrapes leads, qualifies them, and auto-sends pitch emails for Jack Bockholdt's **White-Label AI Infrastructure License** ($1,500/month) — sold to digital marketing / lead-gen agency owners, who white-label the 9-skill engine and resell it to their own local business clients.

**This supersedes the old contractor/missed-call offer.** Do not pitch plumbers, HVAC, or other end-business owners directly — the buyer is the agency, not the end client. Full playbook: `marketing/GTM-BLUEPRINT.md` (cold call script + scraper targeting) and `marketing/FOLLOWUP-EMAIL-SEQUENCE.md` (3-email follow-up).

## Live URLs
- **Orchestrator:** https://antigravity-orchestrator-kz94.onrender.com
- **Node.js frontend:** https://master-hustle-engine.onrender.com
- **GitHub:** Jackbockholdt/master-hustle-engine (main branch)

## Everything That Is Already Working — DO NOT TOUCH
- `orchestrator.py` — FastAPI server, 9 skills, deployed on Render
- All Render env vars set (Gemini, OpenPhone, SMTP, Stripe, payment link)
- Stripe webhook live at master-hustle-engine.onrender.com/api/stripe-webhook
- Lead intake endpoint: POST /webhook/lead (tested and working, accepts `email` or `contact_email`)
- OpenPhone webhook: POST /webhook/openphone
- Vapi webhook: POST /webhook/vapi
- `/skill/invention-outreach` pitch copy now targets agency owners (see `orchestrator.py` `skill_invention_outreach`)

## The ONE Thing Left To Do
Re-point the Gumloop scraper from contractor leads to **agency owner leads** using the targeting params in `marketing/GTM-BLUEPRINT.md` (job titles, company keywords, size, geographies), then connect it to the lead intake endpoint.

**Gumloop HTTP node config:**
- URL: https://antigravity-orchestrator-kz94.onrender.com/webhook/lead
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

## Offer Details
- Product: White-Label AI Infrastructure License
- Price: $1,500/month license fee
- Buyer: Digital marketing / lead-gen agency owners (5–50 employees) who resell to their own clients
- Targets (industry keywords for scraper): Digital Marketing Agency, Lead Generation Agency, SEO Agency, PPC Agency, Social Media Agency, Growth Agency, Advertising Agency
- Proof URL: https://missedcallproject.com
- Payment link: https://buy.stripe.com/3cI14m9hOcPh6Gbcx10000D
- Pitch tone: Peer-to-peer, math-driven ("resell to 3 clients at $500/mo and you're already break-even")
- NEVER mention: SHOVL, shovel, invention, patent licensing

## Render Service IDs
- antigravity-orchestrator: srv-d910i40k1i2s73822a5g
- master-hustle-engine (Node.js): srv-d8thrho0697c73clcvtg

## Test The Engine
```bash
curl -X POST https://antigravity-orchestrator-kz94.onrender.com/webhook/lead \
  -H "Content-Type: application/json" \
  -d '{"company_name":"Test Agency","contact_email":"jackbockholdt88@gmail.com","website":"https://test.com","industry":"digital marketing agency"}'
```

## Check Logs
https://antigravity-orchestrator-kz94.onrender.com/logs
