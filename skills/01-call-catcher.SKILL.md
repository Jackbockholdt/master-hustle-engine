---
name: "The Call Catcher"
version: "1.0.0"
description: "Monitors missed calls and voicemails, extracts caller intent via LLM, and fires a personalized SMS text-back before the lead goes cold."
author: "Jack Bockholdt / Antigravity 2.0"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial production release — webhook trigger, LLM intent classification, SMS response, full audit trail."
---

## Intent

Capture every missed call as a live revenue opportunity. The moment a call goes unanswered, this skill fires an immediate, personalized SMS to the caller so the business stays top-of-mind and the lead does not defect to a competitor. Zero human intervention required.

---

## Trigger

- **Type:** Webhook (POST)
- **Source:** Vapi missed-call event, Twilio missed-call webhook, or any telephony provider configured to emit call events
- **Payload Required:**
  - `caller_phone` — E.164 format (e.g., `+15551234567`)
  - `voicemail_transcript` — string (empty string `""` if no voicemail left)
  - `called_at` — ISO 8601 timestamp
  - `business_name` — string

---

## Execution Flow

### Step 1 — Receive & Validate Webhook Payload
- Accept the inbound POST event.
- Confirm all required fields (`caller_phone`, `called_at`, `business_name`) are present and non-null.
- **GUARDRAIL:** If `caller_phone` is missing or malformed → trigger **ESCAPE HATCH A** immediately.

### Step 2 — Extract Caller Intent via LLM
- Pass `voicemail_transcript` to the LLM with the following system instruction:
  > "You are a lead triage assistant. Analyze this voicemail transcript and return a JSON object with: { 'urgency': 'HIGH' | 'MEDIUM' | 'LOW', 'primary_need': string (max 15 words), 'confidence': float 0.0–1.0 }"
- **GUARDRAIL:** If `confidence` < `0.65` OR transcript is empty → set `urgency = 'UNKNOWN'` and `primary_need = 'General Inquiry'`. Do NOT guess. Proceed to Step 3 with these defaults.
- **GUARDRAIL:** If LLM API call fails (timeout, 5xx, rate limit) → trigger **ESCAPE HATCH B**.

### Step 3 — Draft Personalized SMS
- Compose a text-back message using the extracted `primary_need` and `business_name`.
- Template:
  > "Hi! You just called [business_name]. We missed you but we're on it. [If urgency=HIGH: 'We know this is urgent — someone will call you back within 15 minutes.'] [If urgency=MEDIUM/LOW/UNKNOWN: 'We'll be in touch shortly. Reply to this message if you need anything now.'] — Powered by Antigravity"
- Message must not exceed 160 characters per SMS segment.

### Step 4 — Send SMS
- Dispatch via Twilio SMS API (or configured telephony provider).
- **GUARDRAIL:** If SMS send fails (invalid number, carrier rejection, API error) → trigger **ESCAPE HATCH C**.

### Step 5 — AUDIT LOG (Mandatory — runs before termination on ALL paths)
Push the following record to the observability layer:

| Field | Value |
|---|---|
| `execution_timestamp` | ISO 8601 UTC |
| `input_source` | `webhook:missed_call` |
| `lead_id` | `caller_phone` |
| `operational_status` | `SUCCESS` / `FAIL` |
| `key_decisions` | urgency level, primary_need, SMS sent Y/N |

**Destination:** Google Sheets via Gumloop webhook → Sheet: `CallCatcher_Audit` OR SQLite table `logs` on Render.

---

## Guardrails & Escape Hatches

### ESCAPE HATCH A — Missing Caller Phone
- **Condition:** `caller_phone` is null, missing, or fails E.164 validation.
- **Action:**
  1. Log `FAIL` to audit sheet with `key_decisions: "Invalid payload — caller_phone missing"`.
  2. Route raw payload JSON to `manual_review/call-catcher/` directory.
  3. Send admin failure alert (email or SMS) with raw payload attached.
  4. **Terminate immediately. Do not proceed.**

### ESCAPE HATCH B — LLM API Failure
- **Condition:** LLM call returns error, times out after 10 seconds, or returns malformed JSON.
- **Action:**
  1. Set `urgency = 'UNKNOWN'`, `primary_need = 'General Inquiry'`.
  2. Log `FAIL` to audit with `key_decisions: "LLM unreachable — defaults applied"`.
  3. Continue to Step 3 using defaults. Do NOT retry more than once.

### ESCAPE HATCH C — SMS Send Failure
- **Condition:** SMS API returns 4xx/5xx or delivery fails.
- **Action:**
  1. Log `FAIL` to audit with `key_decisions: "SMS delivery failed — carrier or API error"`.
  2. Route caller data to `manual_review/call-catcher/`.
  3. Send admin alert: "SMS failed for [caller_phone] — manual follow-up required."
  4. **Terminate. Do not retry automatically.**

---

## Failure States Reference

| Code | Condition | Resolution |
|---|---|---|
| `ERR_PAYLOAD_INVALID` | Missing required webhook fields | Escape Hatch A |
| `ERR_LLM_TIMEOUT` | LLM did not respond within 10s | Escape Hatch B |
| `ERR_LLM_LOW_CONFIDENCE` | Confidence < 0.65 | Apply defaults, continue |
| `ERR_SMS_FAILED` | Twilio/carrier rejection | Escape Hatch C |
| `ERR_AUDIT_WRITE_FAILED` | Logging destination unreachable | Alert admin, do not suppress error |
