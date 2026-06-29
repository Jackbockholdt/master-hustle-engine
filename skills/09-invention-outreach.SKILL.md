---
name: "The Invention Outreach & B2B Lead Generator"
version: "1.0.0"
description: "Ingests invention/patent data and corporate targets, locates direct executive contacts at manufacturing companies, drafts high-impact cold pitches for licensing or buyout deals, and manages outreach tracking sequences."
author: "Jack Bockholdt / Antigravity 2.0"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial production release — patent data ingestion, executive contact discovery, cold pitch generation, outreach queue management, response tracking, full audit trail."
---

## Intent

Get the right invention pitch in front of the right executive decision-maker — automatically. This skill finds direct corporate contacts, crafts a professional cold outreach pitch that leads with commercial value and patent credibility, and logs every touchpoint so no follow-up falls through the cracks.

---

## Trigger

- **Type:** API call or form submission
- **Source:** Antigravity dashboard, Gumloop workflow, or inventor onboarding webhook
- **Payload Required:**
  - `invention_name` — string
  - `invention_summary` — string (max 300 words describing the product/utility)
  - `patent_status` — string (`"Provisional Filed"` / `"Non-Provisional Filed"` / `"Pending"` / `"No Patent"`)
  - `patent_number` — string (optional — include if filed)
  - `target_industries` — array of strings (e.g., `["power tools", "construction", "hardware retail"]`)
  - `target_companies` — array of company names (optional — agent will discover if not provided)
  - `inventor_name` — string
  - `inventor_email` — valid email address
  - `campaign_id` — unique identifier for this outreach campaign

---

## Execution Flow

### Step 1 — Ingest & Validate Invention Data
- Accept all payload fields.
- Confirm `invention_name`, `invention_summary`, `target_industries`, `inventor_name`, and `inventor_email` are present and non-empty.
- Validate `inventor_email` is a properly formatted email address.
- **GUARDRAIL:** If `invention_summary` is under 50 words → trigger **ESCAPE HATCH A**. A pitch cannot be crafted without sufficient product context.
- **GUARDRAIL:** If `patent_status = 'No Patent'` → include mandatory disclaimer in all outreach: "This invention is not currently patent-protected." Agent is STAGE-FORBIDDEN from implying patent protection that does not exist.

### Step 2 — Identify Target Corporate Contacts
- If `target_companies` array is provided → use those companies directly.
- If `target_companies` is empty → search business directories for companies in `target_industries`:
  - Source priority: LinkedIn company search, Crunchbase, ZoomInfo (configured API), Google Business Search
  - Identify top 10–20 companies by revenue/market relevance
- For each target company, locate:
  - `contact_name` — VP of Product, Director of Licensing, VP of Innovation, or CEO (for smaller firms)
  - `contact_title` — verified title
  - `contact_email` — direct business email (NOT generic info@ addresses)
  - `company_name` and `company_website`
- **GUARDRAIL:** If contact email cannot be verified (no match found in directories) → mark as `EMAIL_UNVERIFIED` and flag for manual review. Do NOT fabricate email addresses.
- **GUARDRAIL:** If fewer than 3 verified contacts are found across all target companies → trigger **ESCAPE HATCH B**.

### Step 3 — Draft Cold Pitch Email
Pass invention data and contact info to LLM with system instruction:
> "You are an expert B2B licensing outreach copywriter. Draft a cold pitch email for [inventor_name] to [contact_name] at [company_name]. The invention is: [invention_summary]. Patent status: [patent_status]. Structure: Subject line (under 60 characters, curiosity-driven), Opening (personal hook referencing their company's product line), Problem/Opportunity (what gap this invention solves for their market), Unique Value (3 bullet points — utility, commercial potential, patent status), CTA (request a 15-minute call, provide inventor email). Tone: professional, confident, concise — under 250 words. Return as JSON: { 'subject': string, 'body': string }"

- Personalize each email with the specific `company_name` and `contact_name`.
- **GUARDRAIL:** If `patent_status = 'No Patent'` → ensure pitch body includes the mandatory disclaimer. Scan output and inject if missing.
- **GUARDRAIL:** If LLM returns a generic non-personalized draft (no mention of company name or contact name in body) → reject and retry once. If second attempt fails → trigger **ESCAPE HATCH C**.

### Step 4 — Build & Queue Outreach Sequences
- For each verified contact, create an outreach record:
  - `sequence_step: 1` — Initial cold pitch (send immediately or on configured send time)
  - `sequence_step: 2` — Follow-up #1 (send 5 days later if no reply)
  - `sequence_step: 3` — Follow-up #2 / Final attempt (send 10 days later if no reply)
- Store all outreach records in SQLite table `outreach_queue` with status: `PENDING`.
- **GUARDRAIL:** Do NOT queue more than 3 total touchpoints per contact. Exceeding this limit risks spam classification and violates professional outreach standards.

### Step 5 — Log Tracking Statuses
- After each email send, update `outreach_queue` record:
  - `sent_at` — timestamp
  - `status` — `SENT` / `OPENED` / `REPLIED` / `BOUNCED` / `UNSUBSCRIBED`
- On reply received → mark `status = 'REPLIED'`, halt sequence for that contact, and alert inventor via email.
- On bounce → mark `status = 'BOUNCED'`, route contact to `manual_review/invention-outreach/unverified_contacts/`.

### Step 6 — AUDIT LOG (Mandatory — runs before termination on ALL paths)
Push the following record to the observability layer:

| Field | Value |
|---|---|
| `execution_timestamp` | ISO 8601 UTC |
| `input_source` | `campaign_id` |
| `lead_id` | `inventor_name` |
| `operational_status` | `SUCCESS` / `FAIL` |
| `key_decisions` | contacts found count, verified vs. unverified, pitches drafted, emails queued, patent status flag |

**Destination:** Google Sheets via Gumloop webhook → Sheet: `InventionOutreach_Audit` OR SQLite table `logs` on Render.

---

## Guardrails & Escape Hatches

### ESCAPE HATCH A — Insufficient Invention Description
- **Condition:** `invention_summary` under 50 words.
- **Action:**
  1. Log `FAIL` with `key_decisions: "invention_summary too short — minimum 50 words required"`.
  2. Return error to caller with field-level message.
  3. Route to `manual_review/invention-outreach/`.
  4. **Terminate immediately. A pitch cannot be crafted without product context.**

### ESCAPE HATCH B — Insufficient Verified Contacts
- **Condition:** Fewer than 3 verified corporate contacts found after exhausting all directory sources.
- **Action:**
  1. Log `FAIL` with `key_decisions: "Insufficient verified contacts — found [N] of 3 minimum"`.
  2. Export partial contact list (even unverified) to `manual_review/invention-outreach/[campaign_id]/contacts.csv`.
  3. Alert inventor: "We found fewer than 3 verified contacts. Manual research recommended before outreach."
  4. **Terminate. Do not send pitches to unverified or fabricated contacts.**

### ESCAPE HATCH C — Pitch Generation Failed
- **Condition:** LLM returns generic (non-personalized) draft after 2 attempts.
- **Action:**
  1. Log `FAIL` for pitch generation step.
  2. Store raw invention data in `manual_review/invention-outreach/[campaign_id]/`.
  3. Alert admin: "Pitch generation failed for [invention_name] — manual copywriting required."
  4. **Terminate. Do not send a generic, non-personalized cold email.**

### ESCAPE HATCH D — Patent Disclaimer Missing
- **Condition:** `patent_status = 'No Patent'` but disclaimer not found in generated pitch body.
- **Action:**
  1. Inject disclaimer automatically: *"Please note: This invention is not currently patent-protected."*
  2. Log `WARN: patent_disclaimer_injected` in audit.
  3. Continue to queue. Do NOT send without disclaimer present.

---

## Failure States Reference

| Code | Condition | Resolution |
|---|---|---|
| `ERR_SUMMARY_TOO_SHORT` | invention_summary under 50 words | Escape Hatch A |
| `ERR_INSUFFICIENT_CONTACTS` | Fewer than 3 verified contacts found | Escape Hatch B — halt outreach |
| `ERR_PITCH_NOT_PERSONALIZED` | Generic draft returned after 2 attempts | Escape Hatch C |
| `ERR_PATENT_DISCLAIMER_MISSING` | No-patent flag but disclaimer absent from draft | Escape Hatch D — auto-inject |
| `ERR_EMAIL_FABRICATED` | Contact email not found in any directory | Block send, flag for manual research |
| `ERR_SEQUENCE_LIMIT_EXCEEDED` | More than 3 touchpoints queued for one contact | Block additional entries, alert admin |
| `ERR_AUDIT_WRITE_FAILED` | Logging destination unreachable | Alert admin immediately |
