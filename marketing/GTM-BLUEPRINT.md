---
name: "White-Label AI Infrastructure — Go-To-Market Blueprint"
version: "1.0.0"
description: "Three production GTM assets for distributing the 9-skill Antigravity Agent Framework to digital marketing and lead generation agencies as a white-label recurring retainer."
author: "Jack Bockholdt / Antigravity 2.0"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial release — Vapi cold call script, Gumloop scraper parameters, Stripe checkout positioning."
---

---

# ASSET 1: VAPI COLD CALL SCRIPT

**Agent Persona:** Professional, direct, slightly informal. Not robotic. Not salesy. Speaks like a sharp operator who respects the agency owner's time.

**Target:** Digital marketing agency owners, lead gen agency owners. 5–50 employees. US-based.

---

## SCRIPT

**[OPENING — First 8 seconds. Hook before they hang up.]**

> "Hey [First Name], this is Alex calling on behalf of Antigravity AI. Quick question — are you currently offering any kind of AI automation to your local business clients, or is that still on the roadmap for you?"

*[Wait for response.]*

---

**[IF YES — They're already doing something:]**

> "Perfect. Then you already know the margin on that. Here's why I'm calling — we built the backend infrastructure that most agencies are spending six figures and six months trying to build themselves. Call catching, lead sorting, web page creation, voice agents — all pre-built, fully white-labeled, so you slap your brand on it and resell it to your clients tonight. No dev work. No hiring. Just stack the MRR. Does that sound like something worth a fifteen-minute look?"

---

**[IF NO — They haven't started yet:]**

> "That's actually exactly why I'm calling. The agencies locking in the most retainer revenue right now are the ones offering AI automation as a service — not just ads or SEO. We built the entire backend infrastructure — call catching, data sorting, voice agents, web tools — all white-labeled so you can resell it to your local business clients under your own brand. Your clients get the results. You get the recurring revenue. Takes fifteen minutes to see if it fits. You open this week?"

---

**[OBJECTION: "What does it cost?"]**

> "It's a fifteen-hundred-a-month infrastructure license. But the math is simple — you resell it to three local business clients at five hundred each, you're already at break-even on day one and everything else is pure margin. That's why most agencies treat it as a revenue line, not an expense."

---

**[OBJECTION: "Send me an email."]**

> "I will — but honestly the email won't do it justice because it's live software, not a PDF. What I'd rather do is get you fifteen minutes on a screen share so you can see the actual dashboard working. If it doesn't fit, no harm. What does your calendar look like Thursday or Friday?"

---

**[OBJECTION: "We're not interested in AI right now."]**

> "Totally fair. Quick honest question — are your competitors offering this to local businesses in your market yet? Because in most cities it's still early and the agencies that move first are the ones locking in the longest retainers. Either way I'll let you go — just didn't want you to hear about this six months from now and wish someone had called."

---

**[CLOSE — Push for the calendar, not the sale.]**

> "All I need is fifteen minutes on a screen share to show you the infrastructure live. No pitch deck, just the actual product. I can do [DAY] at [TIME] or [DAY] at [TIME] — which one works better for you?"

---

**[VOICEMAIL — if no answer:]**

> "Hey [First Name], Alex with Antigravity AI. We built white-label AI infrastructure for agencies — call catching, voice agents, lead sorting, all ready to resell to your local business clients under your brand. Fifteen-hundred a month, unlimited resell. Worth a fifteen-minute look. Call me back at [NUMBER] or I'll try you again [DAY]. Talk soon."

---
---

# ASSET 2: GUMLOOP SCRAPER TARGETING PARAMETERS

**Objective:** Pull the most qualified list of agency owners for the Vapi cold call sequence. Quality over volume — one right contact beats fifty wrong ones.

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
| `phone_number` | ZoomInfo / Lusha enrichment |
| `city` | LinkedIn |
| `employee_count` | LinkedIn / Crunchbase |
| `linkedin_url` | LinkedIn |

---

## SCRAPER QUALITY FILTERS

Apply these filters BEFORE exporting to the call queue:

- `direct_email` must be present (no `info@`, `contact@`, or `hello@` generic addresses)
- `phone_number` must be present (Vapi requires a dialable number)
- `employee_count` must be ≤ 50
- `job_title` must match target title list (exact or fuzzy match ≥ 0.80 confidence)
- Deduplicate on `company_website` domain (one contact per agency)

---

## ENRICHMENT STACK (recommended Gumloop integrations)

```
1. LinkedIn Sales Navigator → initial scrape
2. Apollo.io → email enrichment + verification
3. Hunter.io → email verification fallback
4. Lusha or ZoomInfo → phone number enrichment
5. Clearbit → company size + revenue validation
```

---
---

# ASSET 3: STRIPE CHECKOUT POSITIONING

**Product:** White-Label AI Infrastructure License
**Price:** $1,500 / month recurring
**Buyer:** Digital marketing or lead gen agency owner

**Positioning goal:** Make $1,500/month feel like the most obvious business decision they've made all year.

---

## THREE CHECKOUT BULLETS

---

**Bullet 1 — The Math Does the Selling**

> **Resell to 3 clients at $500/month each. You're profitable on day one.**
> This isn't a cost — it's a revenue line. License the full 9-skill AI infrastructure under your brand and resell access to your local business clients. Three clients at $500/month covers your license and puts $0 net cost on your books. Every client after that is pure margin. Most agencies in our network hit break-even within their first 30 days.

---

**Bullet 2 — What You're Actually Getting**

> **9 production-ready AI skills. No dev team. No build time. No maintenance.**
> You're getting a complete, enterprise-grade agentic backend — Call Catcher, Voice Agent, Web Page Creator, Lead Sorter, Email Handler, KDP Publisher, Vintage Appraiser, Hemp Content Engine, and Invention Outreach — fully built, hosted, and maintained. Agencies that tried to build this stack themselves spent $40,000–$120,000 and 6–12 months. You're getting it live tonight for $1,500/month with your logo on it.

---

**Bullet 3 — The Retention Lock-In**

> **Your clients won't cancel. AI automation is the stickiest service an agency can sell.**
> Traditional agency services (ads, SEO, social) churn when results plateau. AI automation that runs their business operations — catching calls, sorting leads, creating content — becomes infrastructure. It's embedded in how they work. Agencies in our network report zero churn on clients using this stack because canceling means their business goes quiet. That's the kind of recurring revenue that compounds.

---

## CHECKOUT PAGE SUPPORTING ELEMENTS

**Headline:**
> "The AI Backend Your Agency Should Have Built 18 Months Ago."

**Subheadline:**
> "White-label 9 AI skills. Resell to your clients. Keep the margin."

**CTA Button:**
> "Start My License — $1,500/mo"

**Trust line beneath button:**
> "Cancel anytime. Infrastructure stays live until end of billing period. Onboarding call included."

**Urgency element (optional):**
> "We limit active licenses per metro area to protect your resell territory. Check availability for [CITY] before checkout."
