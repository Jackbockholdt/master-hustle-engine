# QUICK HANDOFF — If Claude Runs Out of Tokens

**Last Status:** System processing 16/20 leads ✅ LIVE  
**Date:** 2026-07-02  
**All systems deployed and running**

---

## ONE-LINER RESTART (If Needed)

```bash
curl -X POST "https://api.render.com/v1/services/srv-d910i40k1i2s73822a5g/deploys" \
  -H "Authorization: Bearer rnd_cPsi2XSiG8SJydsNrwYDrRPjTzmh" \
  -H "Content-Type: application/json" -d '{}'
```

---

## LIVE URLS

| Service | URL |
|---------|-----|
| **Orchestrator** | https://antigravity-orchestrator-kz94.onrender.com |
| **Health Check** | https://antigravity-orchestrator-kz94.onrender.com/health |
| **Lead Intake** | POST https://antigravity-orchestrator-kz94.onrender.com/webhook/lead |

---

## API KEY & SERVICE IDs

```
RENDER_API_KEY: rnd_cPsi2XSiG8SJydsNrwYDrRPjTzmh
ORCHESTRATOR SERVICE ID: srv-d910i40k1i2s73822a5g
VAPI_KEY: c7769ccd-ee55-4d76-83eb-8dd04a558bb6
```

---

## TEST ENDPOINT

```bash
curl -X POST https://antigravity-orchestrator-kz94.onrender.com/webhook/lead \
  -H "Content-Type: application/json" \
  -d '{
    "company_name": "Test Agency",
    "email": "test@test.com",
    "website": "https://test.com",
    "industry": "digital marketing agency"
  }'
```

Should return `"status": "SUCCESS"` within 30 seconds.

---

## WHAT'S WORKING

✅ Orchestrator FastAPI server (Python) — handling 9 skills  
✅ Lead intake endpoint → Gemini pitch generation → SMTP email send  
✅ SQLite audit logging  
✅ SMTP timeouts (15s) preventing event-loop hangs  
✅ Gumloop → `/webhook/lead` integration ready  

---

## QUALIFIED INDUSTRIES

```
digital marketing agency
lead generation agency
marketing agency
seo agency
ppc agency
social media agency
growth agency
advertising agency
```

---

## IF SOMETHING BREAKS

**Endpoint hangs?** → Redeploy via API above  
**Email not sending?** → Check SMTP_USER env var in Render  
**Lead disqualified?** → Check industry keyword in TARGET_INDUSTRIES  
**Need full docs?** → Read `HANDOFF-ANTIGRAVITY.md`  

---

## NEXT STEP

Keep processing leads. Gumloop scraper should keep hitting `/webhook/lead`.  
Monitor at: https://antigravity-orchestrator-kz94.onrender.com/health

System auto-qualifies, generates pitches, sends emails. No manual intervention needed.

---

Done. Go process your 16→20 leads. 🚀
