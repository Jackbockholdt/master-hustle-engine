---
name: "Agency Owner Follow-Up Email Sequence"
version: "1.0.0"
description: "3-step cold outreach email sequence targeting agency owners who hung up on the Vapi call or requested more information. Designed to convert warm prospects into booked demo calls."
author: "Jack Bockholdt / Antigravity 2.0"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial release — 3 emails: same-day follow-up, day 3 value drop, day 7 final push."
---

# AGENCY OWNER FOLLOW-UP EMAIL SEQUENCE

**Sequence trigger:** Vapi call ended without a booked demo (hung up, asked for info, said "send me something").
**Send cadence:** Email 1 same day → Email 2 on day 3 → Email 3 on day 7.
**Goal:** Book a 15-minute screen share demo.

---

## EMAIL 1 — Same Day
**Send:** Within 1 hour of the Vapi call ending.

**Subject:** `What I mentioned on the call — [First Name]`

---

Hey [First Name],

Just tried you on the phone — here's the short version of what I was calling about.

We built a complete AI automation backend that agencies like yours can white-label and resell to local business clients. Nine skills, all production-ready:

- **Call Catcher** — catches missed calls, texts the lead back instantly
- **Voice Agent** — handles inbound calls, books appointments, logs outcomes
- **Web Page Creator** — spins up client landing pages on demand
- **Lead Sorter** — cleans and organizes messy client data automatically
- **Email Handler** — screens, categorizes, and drafts replies to inbound inquiries

You put your agency's name on it. You set the price. Your clients pay you every month for AI that runs their business operations — and you never touch a line of code.

License is $1,500/month. Most agencies resell access to 3–5 clients at $500–$1,000 each and treat it as a pure revenue line from month one.

**Worth 15 minutes?**

[BOOK A DEMO → calendly.com/YOUR-LINK]

Talk soon,
[YOUR NAME]
Antigravity AI
[PHONE NUMBER]

---

## EMAIL 2 — Day 3
**Send:** 3 days after Email 1 if no reply.

**Subject:** `The agency in [CITY] already using this`

---

Hey [First Name],

Checking back in — didn't hear from you after the call and I know inboxes get buried.

Wanted to share something concrete:

A two-person marketing agency in [SIMILAR CITY / your city] started reselling our AI infrastructure to HVAC and plumbing contractors in their market. They pitched it as an "AI Lead Recovery System" — missed call text-back, voice agent, monthly lead report.

They signed 4 clients in the first 30 days at $750/month each.

That's $3,000/month in new MRR on top of their existing retainers. Their license cost them $1,500. Net margin on the AI service alone: $1,500/month, recurring, with zero fulfillment hours.

Here's what they did differently: they didn't try to explain the technology. They just showed the clients what happens when a missed call gets texted back in under 60 seconds. That demo closed every single one.

That's the 15 minutes I want to give you.

**Pick a time here:** [calendly.com/YOUR-LINK]

If this isn't the right fit, just reply and I'll stop following up — no hard feelings.

[YOUR NAME]
Antigravity AI

---

## EMAIL 3 — Day 7
**Send:** 7 days after Email 1 if still no reply. Final touch.

**Subject:** `Last one from me, [First Name]`

---

Hey [First Name],

This is the last email I'll send — I don't want to clog your inbox if the timing isn't right.

One thing I want to leave you with:

The agencies winning the most local business clients right now aren't winning on ads or SEO anymore. They're winning because they're offering something the client can *feel* — a phone that always gets answered, a lead that never falls through the cracks, a report that shows up every Monday without anyone building it.

That's what this infrastructure does. And the window to be the first agency offering it in your market won't stay open forever.

If you want to see it live — 15 minutes, screen share, no pitch deck — just hit reply or grab a time below.

If not, I genuinely wish you the best with the agency. You're clearly building something.

**One last look:** [calendly.com/YOUR-LINK]

[YOUR NAME]
Antigravity AI
[PHONE NUMBER]

*Reply STOP to opt out of future messages.*

---

## SEQUENCE RULES

| Step | Trigger | Send Time | Goal |
|---|---|---|---|
| Email 1 | Vapi call ended, no booking | Within 1 hour | Deliver the info they asked for, soft CTA |
| Email 2 | No reply to Email 1 | Day 3, 10:00 AM local | Social proof story, stronger CTA |
| Email 3 | No reply to Email 2 | Day 7, 9:00 AM local | Final send, permission to walk away, urgency |

**After Email 3 with no reply:** Move contact to a 90-day re-engagement list. Do not continue active outreach. Tag as `COLD — REVISIT Q[NEXT QUARTER]` in CRM.

**On any reply (even negative):** Halt sequence immediately. Route to human for personal response.

**On demo booked:** Halt sequence immediately. Trigger onboarding flow.
