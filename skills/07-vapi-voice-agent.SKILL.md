---
name: "The Vapi Voice Automation Agent"
version: "1.0.0"
description: "Orchestrates automated inbound and outbound voice calls via Vapi, injects live business knowledge guardrails, captures key data points during conversation, logs outcomes, and triggers follow-up actions from call transcripts."
author: "Jack Bockholdt / Antigravity 2.0"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial production release — Vapi call orchestration, live knowledge injection, transcript parsing, outcome logging, follow-up trigger, full audit trail."
---

## Intent

Put a tireless, always-on AI voice agent on every phone line. This skill handles inbound and outbound calls with natural conversation, captures critical lead data in real time, and automatically triggers next steps — appointment bookings, follow-up SMS, database updates — the moment the call ends. No voicemails ignored. No leads dropped.

---

## Trigger

- **Type:** Webhook (outbound: scheduled or on-demand) | Vapi inbound call event
- **Source:** Vapi platform webhook, Gumloop trigger, or Antigravity scheduler
- **Payload Required:**
  - `call_type` — `"INBOUND"` or `"OUTBOUND"`
  - `lead_phone` — E.164 format
  - `lead_name` — string (optional for inbound)
  - `business_context` — object containing: `business_name`, `services`, `booking_url`, `hours_of_operation`
  - `call_id` — unique identifier for this call session
  - `follow_up_actions` — array of action types to trigger post-call (e.g., `["sms", "database_update", "calendar_booking"]`)

---

## Execution Flow

### Step 1 — Initialize Call Session
- For **OUTBOUND**: Trigger Vapi outbound call to `lead_phone` using configured Vapi assistant ID.
- For **INBOUND**: Listen for Vapi `call.started` webhook event.
- Confirm call connects (Vapi status: `in-progress`).
- **GUARDRAIL:** If call fails to connect after 3 rings (OUTBOUND) or no answer within 30 seconds → trigger **ESCAPE HATCH A**.
- **GUARDRAIL:** If `lead_phone` is missing or malformed → trigger **ESCAPE HATCH B** immediately, before any dial attempt.

### Step 2 — Inject Business Knowledge Guardrails
- Load `business_context` into Vapi assistant's live system prompt:
  > "You are a professional AI representative for [business_name]. You handle: [services]. You may book appointments at: [booking_url]. Business hours: [hours_of_operation]. RULES: Never promise a price without first saying 'let me confirm that for you.' Never discuss competitors. Never make commitments outside of these services. If asked something outside your scope, say: 'Great question — let me have someone from our team follow up with you on that.'"
- **GUARDRAIL:** If `business_context` is missing or incomplete → use safe fallback script: "Hi, this is [business_name]. How can I help you today?" — and flag call for immediate human handoff.

### Step 3 — Conduct Live Call
- Vapi manages the live conversation using injected knowledge.
- Agent listens for and captures the following data points during conversation:
  - `appointment_requested` — boolean
  - `preferred_appointment_time` — string (if mentioned)
  - `service_interest` — array of services discussed
  - `customer_sentiment` — `POSITIVE` / `NEUTRAL` / `NEGATIVE` (assessed by Vapi transcript sentiment)
  - `call_outcome` — `BOOKED` / `CALLBACK_REQUESTED` / `NOT_INTERESTED` / `WRONG_NUMBER` / `NO_ANSWER`
- **GUARDRAIL:** Agent must NOT make price commitments, schedule outside stated hours, or offer services not listed in `business_context`. Vapi guardrail prompts enforce this in real time.

### Step 4 — Parse Call Transcript Post-Call
- On Vapi `call.ended` webhook event, receive full transcript.
- Pass transcript to LLM for structured extraction:
  > "Extract from this call transcript: { 'appointment_requested': bool, 'preferred_time': string, 'services_mentioned': array, 'customer_name': string, 'customer_sentiment': string, 'action_items': array of strings, 'call_outcome': string }"
- **GUARDRAIL:** If transcript is empty or LLM extraction fails → log `FAIL` for extraction step, store raw transcript in `manual_review/vapi-voice/[call_id]/`, continue to audit log. Do NOT fabricate extracted data.

### Step 5 — Trigger Follow-Up Actions
Based on `call_outcome` and `follow_up_actions` array:

| Outcome | Automated Action |
|---|---|
| `BOOKED` | Write appointment to calendar + send confirmation SMS to lead |
| `CALLBACK_REQUESTED` | Add to callback queue with `preferred_appointment_time` |
| `NOT_INTERESTED` | Tag lead in database as `DNC` (Do Not Call), log outcome |
| `WRONG_NUMBER` | Remove from active leads, log as `INVALID_CONTACT` |
| `NO_ANSWER` | Queue for one automatic callback attempt after 2 hours |

- **GUARDRAIL:** If calendar booking API fails → log `FAIL`, alert admin, do NOT silently drop the booking.

### Step 6 — AUDIT LOG (Mandatory — runs before termination on ALL paths)
Push the following record to the observability layer:

| Field | Value |
|---|---|
| `execution_timestamp` | ISO 8601 UTC |
| `input_source` | `call_id` |
| `lead_id` | `lead_phone` |
| `operational_status` | `SUCCESS` / `FAIL` |
| `key_decisions` | call_type, call_outcome, appointment_requested, sentiment, follow-up actions triggered |

**Destination:** Google Sheets via Gumloop webhook → Sheet: `VapiVoice_Audit` OR SQLite table `logs` on Render.

---

## Guardrails & Escape Hatches

### ESCAPE HATCH A — Call Failed to Connect
- **Condition:** Outbound call not answered after 3 rings / 30 seconds, or Vapi returns connection error.
- **Action:**
  1. Log `call_outcome = 'NO_ANSWER'`.
  2. Queue for one automatic callback in 2 hours.
  3. Log `SUCCESS (NO_ANSWER)` to audit trail.
  4. **Do not attempt more than 2 total dial attempts per lead per day.**

### ESCAPE HATCH B — Invalid Lead Phone
- **Condition:** `lead_phone` missing, malformed, or fails E.164 validation.
- **Action:**
  1. Log `FAIL` with `key_decisions: "Invalid lead_phone — call not attempted"`.
  2. Route lead record to `manual_review/vapi-voice/`.
  3. Alert admin: "Call not placed — invalid phone number for call_id [call_id]."
  4. **Terminate immediately. Do not dial.**

### ESCAPE HATCH C — Business Context Missing
- **Condition:** `business_context` is null, empty, or missing required fields.
- **Action:**
  1. Use safe fallback script (greeting only, immediate human handoff).
  2. Log `WARN: business_context_missing` in audit.
  3. Alert admin that full context must be configured before next call session.

### ESCAPE HATCH D — Calendar Booking Failed
- **Condition:** Calendar API returns error when attempting to write appointment.
- **Action:**
  1. Log `FAIL` for booking step.
  2. Store appointment details in `manual_review/vapi-voice/pending_bookings/`.
  3. Send admin alert: "Booking failed for [lead_phone] — manual calendar entry required."

---

## Failure States Reference

| Code | Condition | Resolution |
|---|---|---|
| `ERR_CALL_NO_CONNECT` | No answer after 3 rings / timeout | Escape Hatch A — queue callback |
| `ERR_INVALID_PHONE` | lead_phone malformed or missing | Escape Hatch B — do not dial |
| `ERR_CONTEXT_MISSING` | business_context null or incomplete | Escape Hatch C — fallback script |
| `ERR_TRANSCRIPT_EMPTY` | Vapi returned empty transcript | Store raw payload, manual review |
| `ERR_BOOKING_FAILED` | Calendar API error on appointment write | Escape Hatch D |
| `ERR_DNC_VIOLATION` | Lead tagged DNC but queued for call | Block call immediately, alert admin |
| `ERR_AUDIT_WRITE_FAILED` | Logging destination unreachable | Alert admin immediately |
