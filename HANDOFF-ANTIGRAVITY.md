# Antigravity 2.0 — Live System Handoff

**Status:** ✅ DEPLOYED AND LIVE  
**Last Updated:** 2026-07-02  
**Orchestrator URL:** https://antigravity-orchestrator-kz94.onrender.com  
**Frontend URL:** https://master-hustle-engine.onrender.com  
**Repository:** jackbockholdt/master-hustle-engine (main branch)

---

## What This System Does

**Antigravity 2.0** is a live AI sales automation engine that:

1. **Scrapes qualified leads** from Gumloop (digital marketing/lead-gen agencies, 5–50 employees)
2. **Qualifies them** by industry (agency vs. non-agency)
3. **Generates personalized pitch emails** using Gemini 2.5 Flash AI
4. **Sends cold outreach emails** via SMTP (Gmail)
5. **Logs all activity** to SQLite for audit trail
6. **Handles follow-up sequences** and manual reviews

### The Offer

- **Product:** White-Label AI Infrastructure License
- **Price:** $1,500/month (recurring)
- **Target:** Digital marketing agencies who white-label the system and resell to local business clients
- **Value Math:** Agencies license for $1,500/mo and resell to 3–5 clients at $500–$1,000/month each → break-even day one + pure margin after
- **What's Included:** 9 production-ready AI skills (call catching, voice agent, lead sorting, web pages, email handling, KDP publishing, vintage appraisal, hemp reviews, inventor outreach)

---

## Live Infrastructure

### Render Services

Both services run on **Render free tier** (cold-start behavior; may take 30–60 seconds on first request after idle).

| Service | URL | Service ID | Language | Deploy Command |
|---------|-----|------------|----------|-----------------|
| **Orchestrator (FastAPI)** | https://antigravity-orchestrator-kz94.onrender.com | srv-d910i40k1i2s73822a5g | Python 3.12 | `uvicorn orchestrator:app --host 0.0.0.0 --port $PORT` |
| **Frontend** | https://master-hustle-engine.onrender.com | srv-d8thrho0697c73clcvtg | Node.js | `npm start` |

### Environment Variables (Orchestrator)

All required vars are **already configured in Render**. Do not change unless needed:

| Variable | Purpose | Status |
|----------|---------|--------|
| `GEMINI_API_KEY` | Google Gemini 2.5 Flash API key | ✅ Configured |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Gmail SMTP for outbound emails | ✅ Configured |
| `ADMIN_EMAIL` | Alert email destination | ✅ Configured |
| `TARGET_INDUSTRIES` | Lead qualification keywords | ✅ Configured: "digital marketing agency,lead generation agency,marketing agency,seo agency,ppc agency,social media agency,growth agency,advertising agency" |
| `PROOF_URL` | Demo/proof link in pitch emails | ✅ Configured: https://missedcallproject.com |
| `STRIPE_PAYMENT_LINK` | Payment checkout link in pitches | ✅ Configured |
| `INVENTOR_NAME`, `INVENTOR_EMAIL` | Deployer contact info | ✅ Configured |
| `INVENTION_NAME`, `INVENTION_SUMMARY` | Offer title and description | ✅ Configured (auto-generates if empty) |
| `DEPLOYMENT_FEE` | Monthly license price | ✅ Configured: $1,500 |

---

## API Endpoints

### 1. Health Check (Public)
```
GET /health
```
Returns list of available skills and service status.

**Example:**
```bash
curl https://antigravity-orchestrator-kz94.onrender.com/health
```

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "skills": ["call-catcher", "vintage-appraiser", ..., "invention-outreach"]
}
```

---

### 2. Lead Intake (Gumloop → Orchestrator)
```
POST /webhook/lead
```

**Accepts:** Scraper output from Gumloop with lead data  
**Returns:** Qualification result + pitch generation status  
**Auto-Actions:**
- ✅ Qualifies lead by industry
- ✅ Generates personalized pitch email (Gemini AI)
- ✅ Sends pitch email to lead contact
- ✅ Logs all activity to SQLite

**Gumloop HTTP Node Config:**
```
URL: https://antigravity-orchestrator-kz94.onrender.com/webhook/lead
Method: POST
Header: Content-Type: application/json
Body:
{
  "company_name": "{{company_name}}",
  "contact_email": "{{email}}",
  "website": "{{website}}",
  "industry": "{{industry}}"
}
```

**Example cURL:**
```bash
curl -X POST https://antigravity-orchestrator-kz94.onrender.com/webhook/lead \
  -H "Content-Type: application/json" \
  -d '{
    "company_name": "Digital Solutions Agency",
    "contact_email": "info@digitalsolutions.com",
    "website": "https://digitalsolutions.com",
    "industry": "lead generation agency"
  }'
```

**Response (Qualified Lead):**
```json
{
  "received": true,
  "status": "SUCCESS",
  "result": {
    "campaign_id": "lead-digital-solutions-agency",
    "offer_name": "White-Label AI Infrastructure License",
    "pitches": [
      {
        "subject": "...",
        "body": "...",
        "sequence": [{"step": 1, "send_on": "Day 0", "status": "PENDING"}, ...]
      }
    ],
    "email_sent": true
  }
}
```

**Response (Disqualified Lead):**
```json
{
  "received": true,
  "status": "DISQUALIFIED",
  "reason": "industry 'plumbing' not in qualified list — discard"
}
```

---

### 3. Other Webhooks
```
POST /webhook/vapi       — Vapi call recordings & transcripts
POST /webhook/gumloop    — Generic Gumloop skill routing
POST /webhook/openphone  — Missed call text-back triggers
```

---

## Gumloop Scraper Setup

The system expects Gumloop to:

1. **Target these job titles:**
   - Agency Owner, Founder, Co-Founder, CEO, Managing Director
   - Head of Agency, Digital Agency Owner, Marketing Agency Owner
   - Lead Generation Specialist, Growth Agency Founder

2. **Target these company keywords:**
   - Digital Marketing Agency, Lead Generation Agency, Marketing Agency
   - SEO Agency, PPC Agency, Social Media Agency, Growth Agency
   - Advertising Agency, Local Marketing, Performance Marketing

3. **Filter by company size:** 1–50 employees

4. **Target geographies:** US cities (prioritize New York, LA, Chicago, Dallas, Houston, Denver, Austin, Nashville, Charlotte, Miami, Tampa, Phoenix)

5. **Scrape fields:**
   - `company_name` — Agency name
   - `email` — Direct contact email (Hunter.io / Apollo enrichment)
   - `website` — Company website
   - `industry` — Company type/description

**Key:** Do NOT target end-business owners directly. The buyer is the **agency** (or tech/SaaS founder) who white-labels and resells — not the local business.

---

## Database

**Path:** `orchestrator_audit.sqlite` (on Render filesystem; lost on redeploy)

**Tables:**

### `audit_log`
Tracks every skill execution:
- `id` — Auto-increment
- `skill_name` — e.g., "invention-outreach"
- `lead_id` — Extracted from payload
- `input_source` — "webhook:lead", "webhook:vapi", etc.
- `operational_status` — "SUCCESS" or "FAIL"
- `key_decisions` — JSON blob of business logic decisions
- `error_message` — Failure reason (if any)
- `duration_ms` — Execution time

### `leads_queue`
Pending leads awaiting processing:
- `id` — Auto-increment
- `company_name`, `contact_email`, `website`, `industry`, `phone`
- `status` — "pending", "sent", "disqualified", "failed"
- `added_at`, `processed_at` — Timestamps

---

## How It Works (Flow Diagram)

```
┌──────────────────────┐
│ Gumloop Scraper      │ (Configured with job titles, industries, geography)
│ (LinkedIn SalesNav)  │
└──────────┬───────────┘
           │
           └──→ POST /webhook/lead
                   ↓
           ┌───────────────────┐
           │ Qualify Lead      │ (Check industry against TARGET_INDUSTRIES)
           └───────┬───────────┘
                   │
        ┌──────────┼──────────┐
        │          │          │
      PASS      FAIL     (empty)
        │          │      PASS
        │          ↓         │
        │     [DISCARD]      │
        │                    │
        └────────┬───────────┘
                 ↓
        ┌────────────────────────────┐
        │ Generate Pitch Email       │ (Gemini AI)
        │ - Personalized to company  │
        │ - 3 value bullets          │
        │ - CTA: 15-min demo         │
        └────────┬───────────────────┘
                 ↓
        ┌────────────────────────────┐
        │ Send Pitch Email           │ (SMTP → Gmail)
        │ (Async, timeout-safe)      │
        └────────┬───────────────────┘
                 ↓
        ┌────────────────────────────┐
        │ Log to audit_log           │ (SUCCESS or FAIL)
        │ (SQLite)                   │
        └────────────────────────────┘
```

---

## SMTP Timeout Fix (Production Stability)

**Issue Fixed:** Orchestrator was hanging indefinitely when SMTP handshake stalled, freezing the entire event loop.

**Solution:** Added 15-second timeout to `smtplib.SMTP()` calls:
```python
with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
```

**Files Modified:**
- `send_admin_alert()` — Line 261
- `send_pitch_email()` — Line 279

**Result:** Endpoints now return within 15–30 seconds even if email delivery fails; no full lockup.

---

## Testing & Monitoring

### Quick Health Check
```bash
curl https://antigravity-orchestrator-kz94.onrender.com/health
```

### Test a Lead
```bash
curl -X POST https://antigravity-orchestrator-kz94.onrender.com/webhook/lead \
  -H "Content-Type: application/json" \
  -d '{
    "company_name": "Test Agency",
    "contact_email": "test@testgency.com",
    "website": "https://testgency.com",
    "industry": "digital marketing agency"
  }' | jq .
```

**Expected:** Should complete in 5–20 seconds with `"status": "SUCCESS"` and `email_sent: true` (or false if SMTP fails, but not hang).

### View Logs
```bash
curl https://antigravity-orchestrator-kz94.onrender.com/logs
```

### Check Database
SSH into Render and run:
```bash
sqlite3 orchestrator_audit.sqlite "SELECT * FROM audit_log ORDER BY id DESC LIMIT 10;"
```

---

## Troubleshooting

### Endpoint Times Out / Hangs
**Cause:** Stalled SMTP connection or cold-start cold.  
**Fix:** 
- Wait 60 seconds (Render cold-start)
- Check SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in Render env vars
- Review logs in Render dashboard

### "email_sent": false
**Cause:** SMTP_USER not configured or SMTP credentials invalid.  
**Fix:**
- Verify SMTP_USER, SMTP_PASS in Render → Environment Variables
- Check ADMIN_EMAIL is set (receives alerts if pitch email fails)
- Test with: `curl -s https://antigravity-orchestrator-kz94.onrender.com/health | jq .`

### Lead Marked "DISQUALIFIED"
**Cause:** Industry not in TARGET_INDUSTRIES list.  
**Fix:**
- Add the industry to TARGET_INDUSTRIES env var in Render
- Industries are case-insensitive, substring-matched ("digital marketing" matches "digital marketing agency")

### No Leads Coming Through
**Cause:** Gumloop scraper not configured or not triggering HTTP POST.  
**Fix:**
- Verify Gumloop HTTP node URL: `https://antigravity-orchestrator-kz94.onrender.com/webhook/lead`
- Verify Content-Type header: `application/json`
- Verify body includes: `company_name`, `email`, `website`, `industry`
- Test manually with curl (see Testing section above)

---

## Deployment & Updates

### To Deploy a Code Change

1. **Commit to `main` branch:**
   ```bash
   git add orchestrator.py
   git commit -m "Description of change"
   git push origin main
   ```

2. **Trigger deploy via Render API:**
   ```bash
   curl -X POST "https://api.render.com/v1/services/srv-d910i40k1i2s73822a5g/deploys" \
     -H "Authorization: Bearer $RENDER_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

3. **Monitor deploy:**
   - Render dashboard: https://dashboard.render.com → antigravity-orchestrator
   - Status: "build_in_progress" → "update_in_progress" → "live" (3–5 min)

### To Update Environment Variables

1. **Via Render Dashboard:**
   - https://dashboard.render.com → antigravity-orchestrator → Environment
   - Edit vars
   - Save (auto-redeploys service)

2. **Via Render API:**
   ```bash
   curl -X PUT "https://api.render.com/v1/services/srv-d910i40k1i2s73822a5g/env-vars" \
     -H "Authorization: Bearer $RENDER_API_KEY" \
     -H "Content-Type: application/json" \
     -d '[{"key":"TARGET_INDUSTRIES","value":"new,industries,here"}]'
   ```

---

## Next Steps

### Immediate (Week 1)
- [ ] Test Gumloop scraper → lead intake pipeline end-to-end
- [ ] Monitor first 10 leads through the system
- [ ] Check audit_log and manual_review/ for any failures
- [ ] Verify emails are reaching agency owners' inboxes (not spam)

### Short-term (Week 2–3)
- [ ] Analyze pitch email open rates and reply rates
- [ ] Adjust pitch copy if needed (via Gemini system prompt in `skill_invention_outreach`)
- [ ] Track which industries/geographies convert best
- [ ] Monitor Render quota (free tier: 750 hours/month)

### Ongoing
- [ ] Check `/health` endpoint weekly for uptime
- [ ] Archive audit_log monthly (SQLite grows over time)
- [ ] Rotate SMTP credentials annually
- [ ] Monitor Gemini API usage and costs

---

## Support & Escalation

**Quick Issues:**
- Endpoint not responding → Check Render dashboard, look for service errors
- Email not sending → Check SMTP vars in Render; test with curl
- Leads not qualifying → Verify industry keywords in TARGET_INDUSTRIES

**Code Changes / New Features:**
- See `orchestrator.py` comments for skill function structure
- See `CLAUDE.md` for project north star and business model
- See `marketing/GTM-BLUEPRINT.md` for cold call script and scraper targeting
- See `marketing/FOLLOWUP-EMAIL-SEQUENCE.md` for 3-email nurture flow

**Production Incident:**
- If service goes down, check Render dashboard for errors
- Redeploy latest commit: `curl -X POST ... /deploys`
- Last stable deploy: Latest commit on main branch

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `orchestrator.py` | Main FastAPI app; all 9 skills; SMTP, Gemini integration |
| `CLAUDE.md` | Project north star; business model; live URLs; config |
| `marketing/GTM-BLUEPRINT.md` | Cold call script; Gumloop scraper targeting params |
| `marketing/FOLLOWUP-EMAIL-SEQUENCE.md` | 3-email nurture sequence (manual setup in email tool) |
| `orchestrator_audit.sqlite` | SQLite audit log (local to Render; ephemeral) |

---

## Summary

✅ **System is live and responding**  
✅ **SMTP timeout fix deployed**  
✅ **All 9 skills registered and ready**  
✅ **Lead intake endpoint active and tested**  
✅ **SQLite audit logging active**  
✅ **Environment variables configured**

**Next action:** Connect Gumloop scraper → `/webhook/lead` and start processing leads.

---

*Generated: 2026-07-02 | Handoff to Antigravity Team*
