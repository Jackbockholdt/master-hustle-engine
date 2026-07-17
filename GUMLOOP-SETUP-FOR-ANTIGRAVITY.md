# Gumloop Setup — Antigravity Master Hustle Engine

## Where We Are Right Now

**Everything is done, deployed, and live as a single unified service.**

- Unified Node.js backend (`https://master-hustle-engine.onrender.com`) — ✅ live
- Lead intake endpoint (`/webhook/lead`) — ✅ live, accepts agency + SaaS leads
- Pitch email generation (AI-personalized) — ✅ live
- Lead qualification filter — ✅ live
- Stripe payment webhook — ✅ live
- Day 5 / Day 10 follow-up sequences — ✅ live

**The ONLY thing left:** Turn Gumloop on and point it at the endpoint below.

---

## Step 1 — HTTP Node Config

In Gumloop, add/edit the HTTP request node that fires after a lead is scraped:

```
URL: https://master-hustle-engine.onrender.com/webhook/lead
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

### Variant — `antigravity-saas` template campaign

For the SaaS/tech-company scrape flow (Antigravity AI Engine pilot pitch, fixed 3-email sequence: initial / day-3 / day-7), use the same endpoint with two extra fields:

```
Body (JSON):
{
  "company_name": "{{company_name}}",
  "contact_email": "{{email}}",
  "website": "{{website}}",
  "industry": "{{industry}}",
  "first_name": "{{first_name}}",
  "campaign": "antigravity-saas"
}
```

`first_name` is optional — the greeting falls back to "Hi there," when it's missing. Leads WITHOUT the `campaign` field get the original AI-personalized white-label pitch. Both campaigns share one daily send cap (`DAILY_SEND_CAP` env var, default 50/day); leads over the cap are queued and sent on later batch runs, never dropped.

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
curl https://master-hustle-engine.onrender.com/admin/status
```

This shows queue/follow-up counts. Or check the audit log directly:

```bash
curl https://master-hustle-engine.onrender.com/logs
```

If a lead doesn't match the industry keywords above, it gets silently disqualified (no email sent, no error) — that's expected behavior, not a bug.

---

## If Something Doesn't Work

- **Lead sent but no email:** Check `email_sent` in the response — if `false`, the Gmail relay may need re-checking (contact original dev, this is a backend config issue, not a Gumloop issue).
- **Lead always disqualified:** Confirm the `industry` field Gumloop sends actually contains one of the keywords above, case doesn't matter but the substring has to match.
- **Endpoint times out / no response:** Render free tier cold-starts after ~15 min idle; first request after idle can take 30-60 seconds. Retry once.

Full technical reference: `CLAUDE.md` and `HANDOFF-ANTIGRAVITY.md` in the repo root.
