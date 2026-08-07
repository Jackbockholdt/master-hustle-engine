---
name: "The Web Page Creator"
version: "1.0.0"
description: "Ingests a business profile and generates high-converting landing page copy, spins up the page on the configured CMS/hosting framework, and wires lead capture forms to the client database."
author: "Jack Bockholdt / Antigravity 2.0"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial production release — brand ingestion, copy generation, page deployment, form-to-database wiring, full audit trail."
---

## Intent

Go from zero to a live, lead-capturing landing page in one automated run. This skill takes a business profile, generates industry-specific copy, deploys the page to the configured hosting environment, and connects lead capture forms directly to the client's master database — no developer required.

---

## Trigger

- **Type:** API call or form submission
- **Source:** Antigravity dashboard, Gumloop workflow, or client onboarding webhook
- **Payload Required:**
  - `brand_name` — string
  - `industry_niche` — string (e.g., "plumbing", "real estate", "hemp retail")
  - `primary_services` — array of strings (up to 5)
  - `color_scheme` — object with `primary`, `secondary`, `accent` hex codes (optional — defaults applied if missing)
  - `target_audience` — string describing ideal customer
  - `client_id` — unique identifier for the client
  - `lead_destination` — webhook URL or Google Sheet ID to route form submissions

---

## Execution Flow

### Step 1 — Ingest & Validate Business Profile
- Accept all payload fields.
- Confirm `brand_name`, `industry_niche`, and `primary_services` are present and non-empty.
- If `color_scheme` is missing → apply industry-default palette (stored in config).
- **GUARDRAIL:** If `brand_name` or `industry_niche` is missing → trigger **ESCAPE HATCH A**.
- **GUARDRAIL:** If `lead_destination` is missing or invalid URL → trigger **ESCAPE HATCH B**. A page without a working lead form is not acceptable.

### Step 2 — Generate High-Converting Copy
- Pass business profile to LLM with system instruction:
  > "You are an expert conversion copywriter. Generate landing page copy for a [industry_niche] business. Include: headline (max 10 words), subheadline (max 20 words), three benefit bullets (max 15 words each), a social proof statement, and a CTA button label. Tone: professional, urgent, benefit-driven. Return as JSON."
- Validate LLM output contains all required sections: `headline`, `subheadline`, `benefits`, `social_proof`, `cta_label`.
- **GUARDRAIL:** If LLM returns incomplete JSON or times out after 15 seconds → trigger **ESCAPE HATCH C**.
- **GUARDRAIL:** Agent is STAGE-FORBIDDEN from publishing placeholder copy (e.g., "Lorem ipsum" or "INSERT HEADLINE HERE").

### Step 3 — Assemble Page Layout
- Inject generated copy and `color_scheme` into the configured page template.
- Template sections:
  - Hero section (headline + subheadline + CTA button)
  - Services section (3-column grid from `primary_services`)
  - Social proof banner
  - Lead capture form (name, phone, email, message)
  - Footer with `brand_name`
- Output: complete HTML/CSS file or CMS-compatible block JSON.

### Step 4 — Deploy to Hosting Environment
- Push assembled page to configured deployment target:
  - **Option A:** Render static site via GitHub push
  - **Option B:** CMS API (configured per client)
- Confirm deployment returns HTTP 200 on the live URL.
- **GUARDRAIL:** If deployment fails or live URL returns non-200 → trigger **ESCAPE HATCH D**.

### Step 5 — Wire Lead Capture Forms
- Configure form submission handler to POST lead data to `lead_destination`.
- Test form endpoint with a synthetic submission: `{"test": true, "source": "setup_verification"}`.
- Confirm `lead_destination` returns HTTP 200 on test ping.
- **GUARDRAIL:** If test ping fails → trigger **ESCAPE HATCH B** (same as missing destination).

### Step 6 — AUDIT LOG (Mandatory — runs before termination on ALL paths)
Push the following record to the observability layer:

| Field | Value |
|---|---|
| `execution_timestamp` | ISO 8601 UTC |
| `input_source` | `client_id` |
| `lead_id` | `brand_name` |
| `operational_status` | `SUCCESS` / `FAIL` |
| `key_decisions` | copy generated Y/N, page deployed Y/N, live URL, form wired Y/N |

**Destination:** Google Sheets via Gumloop webhook → Sheet: `WebPageCreator_Audit` OR SQLite table `logs` on Render.

---

## Guardrails & Escape Hatches

### ESCAPE HATCH A — Missing Core Brand Info
- **Condition:** `brand_name` or `industry_niche` is null or empty.
- **Action:**
  1. Log `FAIL` with `key_decisions: "Missing brand_name or industry_niche"`.
  2. Return error to caller with field-level validation message.
  3. Route to `manual_review/web-page-creator/`.
  4. **Terminate immediately.**

### ESCAPE HATCH B — Missing or Broken Lead Destination
- **Condition:** `lead_destination` missing, malformed URL, or test ping fails.
- **Action:**
  1. Halt page deployment.
  2. Log `FAIL` with `key_decisions: "Lead destination invalid or unreachable"`.
  3. Alert admin and client: "Page NOT deployed — lead form has no valid destination."
  4. **Terminate. A page without a working lead form must not go live.**

### ESCAPE HATCH C — Copy Generation Failed
- **Condition:** LLM timeout, API error, or incomplete JSON response.
- **Action:**
  1. Retry once after 5 seconds.
  2. If second attempt fails → log `FAIL`, route to `manual_review/web-page-creator/`.
  3. Send admin alert: "Copy generation failed for [brand_name] — manual copywriting required."
  4. **Terminate. Do not publish placeholder copy.**

### ESCAPE HATCH D — Deployment Failed
- **Condition:** Hosting push fails or live URL returns non-200 after deployment.
- **Action:**
  1. Log `FAIL` with `key_decisions: "Deployment failed — [HTTP status code]"`.
  2. Preserve assembled HTML in `manual_review/web-page-creator/[client_id]/`.
  3. Alert admin with deployment error details.
  4. **Terminate. Do not mark page as live.**

---

## Failure States Reference

| Code | Condition | Resolution |
|---|---|---|
| `ERR_MISSING_BRAND_INFO` | brand_name or industry_niche missing | Escape Hatch A |
| `ERR_LEAD_DEST_INVALID` | lead_destination missing or unreachable | Escape Hatch B |
| `ERR_COPY_GEN_FAILED` | LLM timeout or incomplete output | Escape Hatch C |
| `ERR_DEPLOYMENT_FAILED` | Hosting push failed or non-200 response | Escape Hatch D |
| `ERR_PLACEHOLDER_COPY` | LLM returned empty or filler text | Block deployment, Escape Hatch C |
| `ERR_AUDIT_WRITE_FAILED` | Logging destination unreachable | Alert admin immediately |
