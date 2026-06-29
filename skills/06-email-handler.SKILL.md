---
name: "The Intelligent Email Handler & Router"
version: "1.0.0"
description: "Scans inbound email inboxes, categorizes by intent, extracts key variables, drafts context-aware replies using approved knowledge, and escalates high-priority messages to human team members."
author: "Jack Bockholdt / Antigravity 2.0"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial production release — inbox scan, intent classification, variable extraction, auto-draft or human escalation, full audit trail."
---

## Intent

Handle the email inbox like a seasoned executive assistant — categorize every message, extract what matters, draft accurate replies instantly, and never let a high-priority email get buried. The agent handles routine volume automatically and escalates only what genuinely needs human judgment.

---

## Trigger

- **Type:** Scheduled poll (every 5 minutes) or inbound webhook from email provider
- **Source:** Gmail API, SMTP inbox monitor, or Nodemailer inbound hook
- **Payload Required (per email):**
  - `email_id` — unique message ID from provider
  - `from_address` — sender email
  - `subject` — string
  - `body_text` — plain text body
  - `received_at` — ISO 8601 timestamp
  - `thread_id` — conversation thread ID (for reply threading)

---

## Execution Flow

### Step 1 — Scan Inbox for Unread Messages
- Poll inbox for all unread messages received since last successful run timestamp.
- Filter out: auto-replies (header `X-Autoreply: yes`), bounce notifications, and previously processed `email_id` values (checked against SQLite `logs`).
- **GUARDRAIL:** If inbox API is unreachable → trigger **ESCAPE HATCH A**. Do not silently fail.

### Step 2 — Classify Intent
- Pass `subject` + first 500 characters of `body_text` to LLM with instruction:
  > "Classify this email into exactly one category: SUPPORT | SALES | COMPLAINT | BILLING | SPAM | ESCALATE. Return JSON: { 'category': string, 'confidence': float, 'urgency': 'HIGH' | 'MEDIUM' | 'LOW', 'summary': string (max 20 words) }"
- **GUARDRAIL:** If `confidence` < 0.70 → default to `category = 'ESCALATE'`. Do NOT make routing decisions on low-confidence classifications.
- **GUARDRAIL:** Any email containing keywords: "lawyer", "legal action", "BBB", "lawsuit", "attorney" → force `category = 'ESCALATE'` regardless of LLM output.

### Step 3 — Extract Key Variables
- From `body_text`, extract:
  - Customer name (if present)
  - Order or tracking number (if present)
  - Specific question or request (max 50 words)
  - Any dates or deadlines mentioned
- Store extracted variables in structured object for use in draft generation.
- **GUARDRAIL:** If extraction returns zero variables → proceed with empty extraction object. Do NOT fabricate customer details.

### Step 4 — Route by Category
Apply routing logic:

| Category | Action |
|---|---|
| `SUPPORT` | Draft reply using approved FAQ knowledge base. Queue for send. |
| `SALES` | Draft reply with product/service info + CTA. Queue for send. |
| `BILLING` | Draft acknowledgment reply. Flag for human review before sending. |
| `COMPLAINT` | Draft empathetic acknowledgment. Flag for human review before sending. |
| `SPAM` | Mark as read. Archive. Log. No reply. |
| `ESCALATE` | Do NOT draft. Route immediately to human team member via alert. |

- **GUARDRAIL:** Agent is STAGE-FORBIDDEN from sending any reply for `BILLING`, `COMPLAINT`, or `ESCALATE` categories without explicit human approval. Queue these as drafts only.

### Step 5 — Draft Reply (SUPPORT and SALES only)
- Generate reply using approved company knowledge base + extracted variables.
- Format: professional email with greeting, body (max 200 words), closing, and signature.
- **GUARDRAIL:** If knowledge base returns no relevant content for the query → do NOT fabricate an answer. Escalate to human with note: "No matching knowledge base entry found."
- Prepend subject with `Re:` and maintain `thread_id` for proper threading.

### Step 6 — Send or Queue
- `SUPPORT` / `SALES` drafts → send automatically via SMTP transporter.
- `BILLING` / `COMPLAINT` drafts → save to drafts folder, send human alert with draft preview.
- `ESCALATE` → send immediate human alert with full email content. No draft created.
- `SPAM` → archive only.

### Step 7 — AUDIT LOG (Mandatory — runs before termination on ALL paths)
Push the following record to the observability layer:

| Field | Value |
|---|---|
| `execution_timestamp` | ISO 8601 UTC |
| `input_source` | `email_id` |
| `lead_id` | `from_address` |
| `operational_status` | `SUCCESS` / `FAIL` |
| `key_decisions` | category, confidence, urgency, action taken (sent/drafted/escalated/archived) |

**Destination:** Google Sheets via Gumloop webhook → Sheet: `EmailHandler_Audit` OR SQLite table `logs` on Render.

---

## Guardrails & Escape Hatches

### ESCAPE HATCH A — Inbox API Unreachable
- **Condition:** Email provider API returns error or times out after 10 seconds.
- **Action:**
  1. Log `FAIL` with `key_decisions: "Inbox API unreachable"`.
  2. Send admin alert: "Email handler could not connect to inbox — manual check required."
  3. Retry after 5 minutes (one automatic retry only).
  4. **Terminate after retry failure. Do not silently skip.**

### ESCAPE HATCH B — Legal / Escalation Keyword Detected
- **Condition:** Legal keywords detected in any email.
- **Action:**
  1. Immediately route to human team member with full email content.
  2. Log `ESCALATE` with `key_decisions: "Legal keyword detected — human required"`.
  3. Do NOT draft or send any reply.
  4. Flag `email_id` in SQLite to prevent reprocessing.

### ESCAPE HATCH C — Knowledge Base Miss
- **Condition:** No relevant knowledge base content found for SUPPORT/SALES query.
- **Action:**
  1. Escalate to human with note: "Knowledge base returned no match for this query."
  2. Log `SUCCESS (ESCALATED)` with reason.
  3. Do NOT send a fabricated or generic reply.

---

## Failure States Reference

| Code | Condition | Resolution |
|---|---|---|
| `ERR_INBOX_UNREACHABLE` | Email API timeout or error | Escape Hatch A |
| `ERR_LOW_CONFIDENCE_CLASS` | Classification confidence < 0.70 | Default to ESCALATE |
| `ERR_LEGAL_KEYWORD` | Legal language detected | Escape Hatch B — immediate escalation |
| `ERR_KB_MISS` | Knowledge base has no relevant content | Escape Hatch C — escalate, no fabrication |
| `ERR_SEND_FAILED` | SMTP send returned error | Log FAIL, queue for manual send, alert admin |
| `ERR_AUDIT_WRITE_FAILED` | Logging destination unreachable | Alert admin immediately |
