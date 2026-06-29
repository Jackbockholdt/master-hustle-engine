---
name: "The KDP Book Publisher Helper"
version: "1.0.0"
description: "Takes a raw manuscript, auto-formats it to Amazon KDP specifications, generates optimized metadata (description, keywords, categories), and packages the upload-ready files with a submission checklist."
author: "Jack Bockholdt / Antigravity 2.0"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial production release — manuscript ingestion, KDP formatting, metadata generation, final package assembly, full audit trail."
---

## Intent

Eliminate the 80% of KDP publishing that is pure formatting busywork. This skill takes a raw manuscript and outputs a fully formatted, KDP-compliant file package — complete with optimized title metadata, backend keywords, and category selections — ready to upload directly to Amazon with zero rework.

---

## Trigger

- **Type:** File upload or API call
- **Source:** Antigravity dashboard, Gumloop file ingestion, or direct POST
- **Payload Required:**
  - `manuscript_file` — URL or base64 of `.docx`, `.txt`, or `.pdf`
  - `book_title` — string
  - `author_name` — string
  - `genre` — string (e.g., "Self-Help", "Romance", "Low Content / Notebooks")
  - `target_audience` — string
  - `submission_id` — unique identifier for this publishing job

---

## Execution Flow

### Step 1 — Ingest & Validate Manuscript
- Download or decode `manuscript_file`.
- Confirm file is accessible and non-empty.
- Detect format: `.docx`, `.txt`, or `.pdf`.
- Extract raw text content and chapter structure.
- Count: total word count, chapter count, estimated page count.
- **GUARDRAIL:** If file is inaccessible, corrupt, or results in zero extracted text → trigger **ESCAPE HATCH A**.
- **GUARDRAIL:** If word count is under 2,500 words → flag as `SHORT_FORM` and note in audit log. Continue processing but alert client that Amazon's minimum content requirements may not be met.

### Step 2 — Format to KDP Specifications
Apply the following formatting rules to the extracted text:
- **Font:** Times New Roman 12pt (body), 14pt (chapter headings)
- **Margins:** 1 inch all sides (or mirror margins for print: inner 1.25", outer 0.75")
- **Line spacing:** 1.15 (ebooks) or double-spaced (print)
- **Chapter breaks:** Page break before each new chapter heading
- **Front matter:** Title page, copyright page, table of contents (auto-generated)
- **Back matter:** About the Author section (populated from `author_name` + `genre` context)
- Output formatted file as `.docx` (KDP preferred upload format).
- **GUARDRAIL:** If formatting engine fails or produces a malformed output file → trigger **ESCAPE HATCH B**.

### Step 3 — Generate Optimized Metadata
Pass `book_title`, `genre`, `target_audience`, and a 500-word excerpt to the LLM:
- **Book Description** (max 4,000 characters): Hook, benefit bullets, CTA to buy. Optimized for Amazon A9 search algorithm.
- **Backend Keywords** (7 keyword phrases, max 50 characters each): High-search, low-competition phrases based on genre.
- **Category Selections** (2 BISAC categories): Most relevant categories with highest discoverability for `genre`.
- **Subtitle suggestion** (if none provided): Keyword-rich subtitle under 200 characters.
- **GUARDRAIL:** If LLM returns fewer than 7 keywords or an incomplete description → retry once. If second attempt fails → trigger **ESCAPE HATCH C**.

### Step 4 — Assemble Final Package
Compile the following into a single delivery folder `kdp_package_[submission_id]/`:
- `[book_title]_FORMATTED.docx` — KDP-ready manuscript
- `metadata.json` — book description, keywords, categories, subtitle
- `KDP_SUBMISSION_CHECKLIST.md` — step-by-step Amazon upload guide:
  - [ ] Log into KDP at kdp.amazon.com
  - [ ] Click "Create" → "eBook" or "Paperback"
  - [ ] Enter title, subtitle, author from metadata.json
  - [ ] Paste book description from metadata.json
  - [ ] Enter 7 backend keywords from metadata.json
  - [ ] Select 2 BISAC categories from metadata.json
  - [ ] Upload formatted manuscript file
  - [ ] Set pricing (recommend $2.99–$9.99 for 70% royalty tier)
  - [ ] Submit for review (3–5 business day review period)

### Step 5 — AUDIT LOG (Mandatory — runs before termination on ALL paths)
Push the following record to the observability layer:

| Field | Value |
|---|---|
| `execution_timestamp` | ISO 8601 UTC |
| `input_source` | `submission_id` |
| `lead_id` | `author_name` |
| `operational_status` | `SUCCESS` / `FAIL` |
| `key_decisions` | word count, page count, short-form flag Y/N, metadata generated Y/N, package assembled Y/N |

**Destination:** Google Sheets via Gumloop webhook → Sheet: `KDPPublisher_Audit` OR SQLite table `logs` on Render.

---

## Guardrails & Escape Hatches

### ESCAPE HATCH A — Manuscript Unreadable
- **Condition:** File inaccessible, corrupt, password-protected, or zero text extracted.
- **Action:**
  1. Log `FAIL` with `key_decisions: "Manuscript unreadable — zero text extracted"`.
  2. Route raw file reference to `manual_review/kdp-publisher/`.
  3. Alert client: "Your manuscript file could not be processed. Please re-upload in .docx or .txt format."
  4. **Terminate immediately.**

### ESCAPE HATCH B — Formatting Engine Failure
- **Condition:** Formatted output file is malformed, empty, or fails validation.
- **Action:**
  1. Log `FAIL` with `key_decisions: "KDP formatting engine produced invalid output"`.
  2. Preserve raw extracted text in `manual_review/kdp-publisher/[submission_id]/`.
  3. Send admin alert with error details.
  4. **Terminate. Do not deliver a malformed manuscript.**

### ESCAPE HATCH C — Metadata Generation Incomplete
- **Condition:** LLM returns fewer than 7 keywords or incomplete description after 2 attempts.
- **Action:**
  1. Deliver partial package with whatever metadata was generated.
  2. Mark missing fields as `REQUIRES_MANUAL_COMPLETION` in `metadata.json`.
  3. Log `SUCCESS (PARTIAL)` with `key_decisions: "Metadata incomplete — manual review required"`.
  4. Alert client to manually complete flagged fields before submission.

---

## Failure States Reference

| Code | Condition | Resolution |
|---|---|---|
| `ERR_MANUSCRIPT_UNREADABLE` | File corrupt, inaccessible, or empty | Escape Hatch A |
| `ERR_FORMAT_FAILED` | Formatting engine produced malformed output | Escape Hatch B |
| `ERR_METADATA_INCOMPLETE` | LLM couldn't complete full metadata | Escape Hatch C — partial delivery |
| `WARN_SHORT_FORM` | Word count under 2,500 | Continue, flag in audit, alert client |
| `ERR_AUDIT_WRITE_FAILED` | Logging destination unreachable | Alert admin immediately |
