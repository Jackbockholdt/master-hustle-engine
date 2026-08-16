---
name: "White-Label AI Infrastructure — Go-To-Market Blueprint"
version: "2.0.0"
description: "Production GTM assets for distributing the 9-skill agent framework to digital marketing and lead generation agencies as a white-label recurring retainer."
author: "Jack Bockholdt"
changelog:
  - version: "2.0.0"
    date: "2026-08-15"
    notes: "Removed the Vapi cold call script (phone-first outreach is deprecated). Removed unsourced traction and cost claims from checkout copy. Dropped the phone-number hard requirement from scraper filters."
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial release — Vapi cold call script, Gumloop scraper parameters, Stripe checkout positioning."
---

> **Outreach copy is not in this file.** The canonical sequence lives in
> `marketing/DIRECT-AGENCY-OUTREACH.md`. Do not fork it here.

---

# ASSET 1: GUMLOOP SCRAPER TARGETING PARAMETERS

**Objective:** Pull the most qualified list of agency owners for the email sequence. Quality over volume — one right contact beats fifty wrong ones.

---

## JOB TITLES TO TARGET

Use ALL of the following (OR logic — match any):

```
"Agency Owner"
"Founder"
"Co-Founder"
"CEO"
"Managing Director"
"Head of Agency"
"Digital Agency Owner"
"Marketing Agency Owner"
"Lead Generation Specialist"
"Growth Agency Founder"
```

**Exclude:**
```
"Intern"
"Assistant"
"Coordinator"
"Junior"
"Freelancer"
"Student"
```

---

## INDUSTRY / COMPANY KEYWORDS

Target companies whose name or description contains ANY of:

```
"Digital Marketing Agency"
"Lead Generation Agency"
"Marketing Agency"
"SEO Agency"
"PPC Agency"
"Social Media Agency"
"Growth Agency"
"Advertising Agency"
"Local Marketing"
"Online Marketing"
"Performance Marketing"
"Demand Generation"
"Inbound Marketing"
"Local SEO"
"Google Ads Agency"
"Facebook Ads Agency"
"Full-Service Marketing"
```

---

## COMPANY SIZE

```
Employees: 1–50
Revenue Range: $100K – $10M annually
```

*Rationale: Solo operators can't implement AI. Enterprises have their own tech stack. The sweet spot is 2–20 employee agencies actively looking to scale MRR without hiring.*

---

## TARGET GEOGRAPHIES

Priority Tier 1 — Highest agency density:
```
New York, NY
Los Angeles, CA
Chicago, IL
Houston, TX
Dallas, TX
Atlanta, GA
Miami, FL
Phoenix, AZ
Denver, CO
Austin, TX
Nashville, TN
Charlotte, NC
```

Priority Tier 2 — Fast-growing secondary markets:
```
Tampa, FL
Orlando, FL
Las Vegas, NV
San Antonio, TX
Columbus, OH
Raleigh, NC
Salt Lake City, UT
Kansas City, MO
```

---

## DATA FIELDS TO SCRAPE (per lead)

Configure Gumloop output columns:

| Field | Source |
|---|---|
| `first_name` | LinkedIn / directory |
| `last_name` | LinkedIn / directory |
| `job_title` | LinkedIn |
| `company_name` | LinkedIn / website |
| `company_website` | LinkedIn / Google |
| `direct_email` | Hunter.io / Apollo enrichment |
| `city` | LinkedIn |
| `employee_count` | LinkedIn / Crunchbase |
| `linkedin_url` | LinkedIn |

---

## SCRAPER QUALITY FILTERS

Apply these filters BEFORE exporting to the send queue:

- `direct_email` must be present and verified (status `RECEIVING`). Treat catch-all domains as risky.
- `employee_count` must be ≤ 50
- `job_title` must match target title list (exact or fuzzy match ≥ 0.80 confidence)
- Deduplicate on `company_website` domain (one contact per agency)
- Drop anything already on the do-not-send list (`config/blocklist.json`)

Role addresses (`info@`, `hello@`, `contact@`) are usable but lower priority than a named person. Do not construct addresses to fill a gap — if the source yielded 13 real contacts, the answer is a better source, not a guessed `firstname@company.com` pattern.

---

## ENRICHMENT STACK (recommended Gumloop integrations)

```
1. LinkedIn Sales Navigator → initial scrape
2. Apollo.io → email enrichment + verification
3. Hunter.io → email verification fallback
4. Clearbit → company size + revenue validation
```

---
---

# ASSET 2: STRIPE CHECKOUT POSITIONING

**Product:** White-Label AI Infrastructure License
**Price:** $4,000 to start ($2,500 setup + first month), then $1,500 / month recurring
**Buyer:** Digital marketing or lead gen agency owner

**Positioning goal:** Make $4,000 to start and $1,500/month feel like the most obvious business decision they've made all year.

---

## THREE CHECKOUT BULLETS

---

**Bullet 1 — The Math Does the Selling**

> **Three clients covers the license. The fourth is profit.**
> This isn't a cost — it's a revenue line. License the AI infrastructure under your brand and resell access to your own clients. Three clients at $500/month covers your recurring license exactly ($1,500/mo in, $1,500/mo out). Your fourth client is pure recurring margin, and every one after that compounds. If you charge your own clients an onboarding fee, that's what offsets the $2,500 setup on your side.

---

**Bullet 2 — What You're Actually Getting**

> **9 production-ready AI skills. No dev team. No build time. No maintenance.**
> You're getting a complete agentic backend — Call Catcher, Voice Agent, Web Page Creator, Lead Sorter, Email Handler, KDP Publisher, Vintage Appraiser, Hemp Content Engine, and Invention Outreach — fully built, hosted, and maintained. Building this stack in-house means months of engineering time you'd rather spend on clients. You're getting it live for $4,000 to start and $1,500/month with your logo on it.

---

**Bullet 3 — The Retention Lock-In**

> **AI automation is among the stickiest services an agency can sell.**
> Traditional agency services (ads, SEO, social) churn when results plateau. AI automation that runs a client's business operations — catching calls, sorting leads, creating content — becomes infrastructure. It's embedded in how they work, and embedded services are harder to cancel than campaigns. That's the kind of recurring revenue that compounds.

---

## CHECKOUT PAGE SUPPORTING ELEMENTS

**Headline:**
> "The AI Backend Your Agency Should Have Built 18 Months Ago."

**Subheadline:**
> "White-label 9 AI skills. Resell to your clients. Keep the margin."

**CTA Button:**
> "Start My License — $4,000 to start"

**Trust line beneath button:**
> "Cancel anytime. Infrastructure stays live until end of billing period. Onboarding call included."

---

## COPY RULES FOR THIS FILE

Claims on a checkout page get read by a buyer who may ask a follow-up question. Anything here has to survive that.

- **No customer counts, churn rates, or break-even statistics.** This is pre-revenue. "Agencies in our network report…" is not an available phrase until there is a network.
- **No unsourced dollar or duration figures** for what building in-house costs. If a number appears, it needs a citation.
- **One price, stated in canonical terms:** $4,000 to start ($2,500 setup + first month), then $1,500/month. No trials, no waived setup, no tiers.
- **The $25,000 buyout is an anchor for human conversation only.** It does not belong on an automated surface.
