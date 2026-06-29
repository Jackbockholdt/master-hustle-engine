---
name: "The File Mix-Up Catcher"
version: "1.0.0"
description: "Ingests disorganized, messy data sets — spreadsheets, CSVs, raw text — parses hidden structure, remaps to a standardized schema, deduplicates, and exports a clean output file."
author: "Jack Bockholdt / Antigravity 2.0"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial production release — multi-format ingestion, LLM-assisted schema mapping, deduplication, clean export, full audit trail."
---

## Intent

Stop losing money to bad data. This skill takes any pile of mismatched spreadsheets, CSV dumps, or disorganized text files and outputs a single, clean, structured master file — with duplicates removed, fields normalized, and nothing left behind. Fully automated, zero manual cleanup.

---

## Trigger

- **Type:** File upload, API payload, or Gumloop file ingestion node
- **Source:** Antigravity dashboard, email attachment handler, or direct POST
- **Payload Required:**
  - `input_files` — array of file paths or URLs (CSV, XLSX, TXT, JSON)
  - `target_schema` — JSON object defining the output column names and data types
  - `job_id` — unique identifier for this sorting job
  - `submitted_by` — string (client name or system identifier)

---

## Execution Flow

### Step 1 — Ingest & Validate Files
- Accept all files in `input_files` array.
- Confirm each file:
  - Is accessible (URL resolves or file path exists)
  - Is a supported format: `.csv`, `.xlsx`, `.txt`, `.json`
  - Is not empty (file size > 0 bytes)
- **GUARDRAIL:** If any file is inaccessible, unsupported, or empty → log warning for that file, skip it, and continue with remaining files. If ALL files fail → trigger **ESCAPE HATCH A**.

### Step 2 — Parse & Extract Key Data Points
- For each valid file, parse the raw contents and extract:
  - Column headers (or infer headers from first data row if none present)
  - All data rows
  - Data types per column (string, integer, date, email, phone)
- Use LLM to identify and extract hidden key fields:
  - Names, email addresses, phone numbers
  - Dates, transaction IDs, monetary values
  - Any field matching a column in `target_schema`
- **GUARDRAIL:** If a file has zero parseable rows after extraction → log `WARN: empty_after_parse` for that file and skip it. Do NOT fabricate rows.

### Step 3 — Remap to Target Schema
- Map each extracted field to its corresponding column in `target_schema`.
- For fields with no clear match:
  - Attempt fuzzy match using LLM (e.g., "Phone Number" → `phone`, "E-Mail" → `email`)
  - **GUARDRAIL:** If LLM confidence for a field mapping is below 0.70 → leave that field as `UNMAPPED` in the output. Do NOT guess column assignments.
- Normalize data formats:
  - Dates → ISO 8601 (`YYYY-MM-DD`)
  - Phone numbers → E.164 format
  - Emails → lowercase
  - Monetary values → two decimal places, no currency symbols in data cells

### Step 4 — Deduplicate
- Identify duplicates based on primary key fields defined in `target_schema` (e.g., `email` or `transaction_id`).
- Keep the most recently dated record when duplicates exist.
- Log count of duplicates removed to audit trail.
- **GUARDRAIL:** If no primary key field is identifiable → flag entire output as `DEDUP_SKIPPED` and notify admin. Do NOT silently skip deduplication.

### Step 5 — Export Clean Output
- Write the cleaned, remapped, deduplicated data to:
  - A `.csv` file named `cleaned_[job_id]_[timestamp].csv`
  - Optionally push directly to a target Google Sheet via Gumloop webhook
- Include a `_UNMAPPED` tab or section for any rows containing `UNMAPPED` fields so nothing is silently lost.

### Step 6 — AUDIT LOG (Mandatory — runs before termination on ALL paths)
Push the following record to the observability layer:

| Field | Value |
|---|---|
| `execution_timestamp` | ISO 8601 UTC |
| `input_source` | `job_id` |
| `lead_id` | `submitted_by` |
| `operational_status` | `SUCCESS` / `FAIL` / `PARTIAL` |
| `key_decisions` | files processed count, rows extracted, duplicates removed, unmapped fields list |

**Destination:** Google Sheets via Gumloop webhook → Sheet: `FileMixup_Audit` OR SQLite table `logs` on Render.

---

## Guardrails & Escape Hatches

### ESCAPE HATCH A — All Files Failed Ingestion
- **Condition:** Every file in `input_files` is inaccessible, unsupported, or empty.
- **Action:**
  1. Log `FAIL` with `key_decisions: "No valid files could be ingested"`.
  2. Route raw `job_id` and payload metadata to `manual_review/file-mixup/`.
  3. Send admin alert with full error list per file.
  4. **Terminate immediately. Do not produce an empty output file.**

### ESCAPE HATCH B — Schema Mapping Failure
- **Condition:** Zero fields from any file can be mapped to `target_schema` (all below 0.70 confidence).
- **Action:**
  1. Log `FAIL` with `key_decisions: "Schema mapping failed — no fields matched"`.
  2. Export raw parsed data to `manual_review/file-mixup/raw_[job_id].csv`.
  3. Send admin alert: "File Mix-Up job [job_id] — schema incompatible, manual mapping required."
  4. **Terminate. Do not output a partially mapped file as if it were complete.**

### ESCAPE HATCH C — Deduplication Key Missing
- **Condition:** No primary key field identifiable in `target_schema`.
- **Action:**
  1. Continue to export with `DEDUP_SKIPPED` flag in output metadata.
  2. Log `SUCCESS (DEDUP_SKIPPED)` to audit trail.
  3. Notify admin that manual deduplication review is required.

---

## Failure States Reference

| Code | Condition | Resolution |
|---|---|---|
| `ERR_ALL_FILES_FAILED` | No valid input files | Escape Hatch A |
| `ERR_SCHEMA_MAP_FAILED` | Zero fields mappable to target schema | Escape Hatch B |
| `ERR_DEDUP_KEY_MISSING` | No primary key in schema | Escape Hatch C — continue, flag output |
| `ERR_EMPTY_AFTER_PARSE` | File accessible but zero parseable rows | Skip file, log WARN, continue |
| `ERR_AUDIT_WRITE_FAILED` | Logging destination unreachable | Alert admin immediately |
