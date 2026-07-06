# Gumloop Setup — Hand This To Antigravity

## Where We Are Right Now

**Everything except Gumloop itself is done, deployed, and tested live.**

- Orchestrator backend (`https://antigravity-orchestrator-kz94.onrender.com`) — ✅ live, healthy
- Frontend service — ✅ live, healthy, daily cron fixed (was failing 6 days straight on a dead SMTP path, now fixed via Gmail relay)
- Lead intake endpoint (`/webhook/lead`) — ✅ tested live, confirmed working for BOTH:
  - Marketing/lead-gen agency leads
  - Tech/SaaS/startup leads
- Pitch email generation (AI-personalized) — ✅ tested live, confirmed sending
- Lead qualification filter — ✅ configured and live

**The ONLY thing left:** Gumloop needs to actually be turned on and pointed at the endpoint below. Nothing happens — zero leads, zero emails — until this is done. This is not a code problem, it's a "log into Gumloop and configure it" problem, which is why I can't do it myself (no Gumloop access from here).

---

## Step 1 — HTTP Node Config

In Gumloop, add/edit the HTTP request node that fires after a lead is scraped:

```
URL: https://antigravity-orchestrator-kz94.onrender.com/webhook/lead
Method: POST
Header: Content-Type: application/json

Body (JSON):
{
  "company_name": "{{company_name}}",
  "contact_email": "{{email}}",
  "website": "{{website}}",
  "industry": "{{industry}}"
}
```

Map `{{company_name}}`, `{{email}}`, `{{website}}`, `{{industry}}` to whatever field names Gumloop's scraper node actually outputs — these are placeholders, the exact variable names depend on how the scrape step is set up.

---

## Step 2 — Scraper Targeting

**Job titles (match any):**
```
Founder, Co-Founder, CEO, Owner, Managing Director, Head of Growth, Agency Owner
```

**Industry / company description keywords (match any):**
```
digital marketing agency, lead generation agency, marketing agency, seo agency,
ppc agency, social media agency, growth agency, advertising agency,
startup, saas, software company, tech startup, online startup,
digital services, digital agency, web development agency, software agency, tech company
```

**Company size filter:** 1–50 employees

**Required fields before a lead gets sent:**
- Real contact email (not `info@`, `hello@`, `contact@`)
- Working company website

---

## Step 3 — Turn It On

Once the HTTP node and targeting are set, activate/run the Gumloop workflow. Leads will hit `/webhook/lead` and — if qualified — get an AI-personalized pitch email within 5–10 seconds automatically. No further steps needed on the backend side.

---

## How To Verify It's Working

After Gumloop sends its first few leads, check:

```bash
curl https://antigravity-orchestrator-kz94.onrender.com/admin/status
```

This shows queue/follow-up counts. Or check the audit log directly:

```bash
curl https://antigravity-orchestrator-kz94.onrender.com/logs
```

If a lead doesn't match the industry keywords above, it gets silently disqualified (no email sent, no error) — that's expected behavior, not a bug.

---

## If Something Doesn't Work

- **Lead sent but no email:** Check `email_sent` in the response — if `false`, the Gmail relay may need re-checking (contact original dev, this is a backend config issue, not a Gumloop issue).
- **Lead always disqualified:** Confirm the `industry` field Gumloop sends actually contains one of the keywords above, case doesn't matter but the substring has to match.
- **Endpoint times out / no response:** Render free tier cold-starts after ~15 min idle; first request after idle can take 30-60 seconds. Retry once.

Full technical reference: `CLAUDE.md` and `HANDOFF-ANTIGRAVITY.md` in the repo root.
