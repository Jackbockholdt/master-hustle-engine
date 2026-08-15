---
name: "The Vintage & Antique Appraiser"
version: "1.0.0"
description: "Researches, identifies, and values collectible or vintage items using online databases and historical sales data. Outputs a structured appraisal report."
author: "Jack Bockholdt"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial production release — item ingestion, cross-reference research, market valuation, structured report generation, full audit trail."
---

## Intent

Turn any vintage item description or image into a professional appraisal report in minutes. This skill eliminates manual research by cross-referencing live marketplace data, historical auction records, and authenticity markers — then packages everything into a clean, seller-ready document.

---

## Trigger

- **Type:** API call, file upload, or form submission
- **Source:** Engine dashboard, Gumloop workflow, or direct webhook
- **Payload Required:**
  - `item_description` — string (text description of the item)
  - `item_images` — array of URLs or base64 strings (optional but improves confidence)
  - `seller_name` — string
  - `request_id` — unique identifier for this appraisal request

---

## Execution Flow

### Step 1 — Ingest & Validate Input
- Accept `item_description` and optional `item_images`.
- Confirm `item_description` is present and contains at least 10 characters.
- Confirm `request_id` is unique (check against SQLite `logs` table).
- **GUARDRAIL:** If `item_description` is missing or fewer than 10 characters → trigger **ESCAPE HATCH A**.

### Step 2 — Cross-Reference Research
- Query available data sources in this priority order:
  1. eBay completed listings API (sold prices, not listed prices)
  2. Google Shopping / marketplace search for item markings, manufacturer, era
  3. LLM knowledge base for historical context, production dates, authenticity markers
- Extract:
  - `estimated_era` — decade or date range of manufacture
  - `manufacturer_or_origin` — brand, region, or maker's mark
  - `authenticity_markers` — known signatures, stamps, material composition
  - `comparable_sales` — array of 3–5 recent sold prices with source URLs
- **GUARDRAIL:** If fewer than 2 comparable sales are found → set `confidence = 'LOW'` and flag for manual review. Do NOT fabricate sale prices.
- **GUARDRAIL:** If all external API calls fail → trigger **ESCAPE HATCH B**.

### Step 3 — Calculate Market Value Range
- Derive `value_low`, `value_mid`, and `value_high` from `comparable_sales` data.
- Apply condition adjustment:
  - Excellent: +15% to mid value
  - Good: no adjustment
  - Fair/Poor: -20% to mid value
- **GUARDRAIL:** If `confidence = 'LOW'`, value range must be labeled **"ESTIMATED — INSUFFICIENT DATA"** in the report. Agent is STAGE-FORBIDDEN from presenting low-confidence values as definitive.

### Step 4 — Generate Appraisal Report
- Compile structured report with the following sections:
  1. **Item Summary** — description, estimated era, manufacturer/origin
  2. **Authenticity Analysis** — verified markers, red flags (if any)
  3. **Market Comparables** — table of 3–5 sold listings with prices and dates
  4. **Valuation** — low / mid / high range with confidence level
  5. **Seller Recommendations** — best platform to sell, timing, and presentation tips
- Format: Markdown (`.md`) and optionally PDF via render pipeline.

### Step 5 — AUDIT LOG (Mandatory — runs before termination on ALL paths)
Push the following record to the observability layer:

| Field | Value |
|---|---|
| `execution_timestamp` | ISO 8601 UTC |
| `input_source` | `request_id` |
| `lead_id` | `seller_name` |
| `operational_status` | `SUCCESS` / `FAIL` |
| `key_decisions` | confidence level, comparable sales count, value range, condition applied |

**Destination:** Google Sheets via Gumloop webhook → Sheet: `VintageAppraiser_Audit` OR SQLite table `logs` on Render.

---

## Guardrails & Escape Hatches

### ESCAPE HATCH A — Invalid Input
- **Condition:** `item_description` missing or under 10 characters.
- **Action:**
  1. Log `FAIL` with `key_decisions: "Insufficient item description provided"`.
  2. Return error response to caller: `"ERROR: Item description too short. Minimum 10 characters required."`
  3. Route request to `manual_review/vintage-appraiser/`.
  4. **Terminate immediately.**

### ESCAPE HATCH B — All External APIs Failed
- **Condition:** eBay API, marketplace search, and LLM all return errors or timeouts.
- **Action:**
  1. Log `FAIL` with `key_decisions: "All data sources unreachable"`.
  2. Route raw payload to `manual_review/vintage-appraiser/`.
  3. Send admin alert: "Appraisal request [request_id] failed — all data sources down."
  4. **Terminate. Do not generate a report with fabricated data.**

### ESCAPE HATCH C — Low Confidence Flag
- **Condition:** Fewer than 2 comparable sales found.
- **Action:**
  1. Continue to report generation with `confidence = 'LOW'`.
  2. Label all values as **"ESTIMATED — INSUFFICIENT DATA"**.
  3. Log `SUCCESS (LOW CONFIDENCE)` to audit trail.
  4. Notify seller that a manual expert review is recommended.

---

## Failure States Reference

| Code | Condition | Resolution |
|---|---|---|
| `ERR_INPUT_INVALID` | Description missing or too short | Escape Hatch A |
| `ERR_ALL_APIS_FAILED` | eBay, search, and LLM all unreachable | Escape Hatch B |
| `ERR_LOW_COMPARABLES` | Fewer than 2 comparable sales found | Escape Hatch C — continue with LOW confidence flag |
| `ERR_DUPLICATE_REQUEST` | `request_id` already exists in logs | Reject with duplicate error, do not reprocess |
| `ERR_AUDIT_WRITE_FAILED` | Logging destination unreachable | Alert admin immediately |
