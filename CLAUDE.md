# Antigravity 2.0 — Current State

## What This Is
A live AI sales engine that scrapes leads, qualifies them, and auto-sends pitch emails for Jack Bockholdt's "Autonomous Business Infrastructure" offer ($1,500/month).

## Live URLs
- **Orchestrator:** https://antigravity-orchestrator-kz94.onrender.com
- **Node.js frontend:** https://master-hustle-engine.onrender.com
- **GitHub:** Jackbockholdt/master-hustle-engine (main branch)

## Everything That Is Already Working — DO NOT TOUCH
- `orchestrator.py` — FastAPI server, 9 skills, deployed on Render
- All Render env vars set (Gemini, OpenPhone, SMTP, Stripe, payment link)
- Stripe webhook live at master-hustle-engine.onrender.com/api/stripe-webhook
- Lead intake endpoint: POST /webhook/lead (tested and working)
- OpenPhone webhook: POST /webhook/openphone
- Vapi webhook: POST /webhook/vapi

## The ONE Thing Left To Do
Connect Gumloop to the lead intake endpoint.

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
- Product: Autonomous Business Infrastructure
- Price: $1,500/month deployment fee
- Targets: Construction, HVAC, Plumbing, Electrical, Logistics, Industrial Services, Property Management, B2B Consulting
- Proof URL: https://missedcallproject.com
- Payment link: https://buy.stripe.com/3cI14m9hOcPh6Gbcx10000D
- Pitch tone: Peer-to-peer, high-scarcity ("looking for 3 partners this month")
- NEVER mention: SHOVL, shovel, invention, patent licensing

## Render Service IDs
- antigravity-orchestrator: srv-d910i40k1i2s73822a5g
- master-hustle-engine (Node.js): srv-d8thrho0697c73clcvtg

## Test The Engine
```bash
curl -X POST https://antigravity-orchestrator-kz94.onrender.com/webhook/lead \
  -H "Content-Type: application/json" \
  -d '{"company_name":"Test Co","contact_email":"jackbockholdt88@gmail.com","website":"https://test.com","industry":"construction"}'
```

## Check Logs
https://antigravity-orchestrator-kz94.onrender.com/logs
