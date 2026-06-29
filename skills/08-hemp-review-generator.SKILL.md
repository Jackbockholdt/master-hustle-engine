---
name: "The Hemp Strain Review & Affiliate Content Generator"
version: "1.0.0"
description: "Ingests strain data (terpenes, effects, vendor details), generates SEO-optimized written reviews and video scripts for affiliate marketing, and embeds monetization links into the final content package."
author: "Jack Bockholdt / Antigravity 2.0"
changelog:
  - version: "1.0.0"
    date: "2026-06-29"
    notes: "Initial production release — strain data ingestion, SEO review generation, video script drafting, affiliate link embedding, full audit trail."
---

## Intent

Turn raw strain data into a complete, revenue-ready content package in one automated run. This skill produces a long-form SEO review, a short-form video script, and social captions — all with affiliate links correctly embedded — so every piece of content published is working to generate passive income.

---

## Trigger

- **Type:** API call or form submission
- **Source:** Antigravity dashboard, Gumloop workflow, or direct POST
- **Payload Required:**
  - `strain_name` — string (e.g., "Sour Space Candy")
  - `strain_type` — string (`"Hemp"` / `"THCA"` / `"CBD"` / `"Delta-8"`)
  - `terpene_profile` — array of strings (e.g., `["Myrcene", "Caryophyllene", "Limonene"]`)
  - `reported_effects` — array of strings (e.g., `["Relaxing", "Euphoric", "Focus"]`)
  - `aroma_flavor` — string description
  - `vendor_name` — string
  - `vendor_url` — valid URL
  - `affiliate_link` — valid URL with affiliate tracking parameter
  - `content_id` — unique identifier for this content job

---

## Execution Flow

### Step 1 — Ingest & Validate Strain Data
- Accept all payload fields.
- Confirm `strain_name`, `vendor_name`, `affiliate_link`, and `vendor_url` are present and non-empty.
- Validate `affiliate_link` and `vendor_url` are valid URLs (must start with `https://`).
- **GUARDRAIL:** If `affiliate_link` is missing, malformed, or does not contain a tracking parameter → trigger **ESCAPE HATCH A**. Content without a working affiliate link must not be published.
- **GUARDRAIL:** If `terpene_profile` or `reported_effects` arrays are empty → proceed with `WARN: missing_strain_data` flag. Agent must clearly label those sections as "Effects vary by individual" — it is STAGE-FORBIDDEN from fabricating specific terpene or effect claims.

### Step 2 — Generate SEO-Optimized Written Review
Pass strain data to LLM with system instruction:
> "You are an expert hemp and cannabis content writer. Write a 600–900 word SEO-optimized strain review for [strain_name] by [vendor_name]. Structure: Introduction (hook + strain overview), Terpene & Aroma Profile, Reported Effects & Experience, Who This Strain Is For, Where to Buy (include affiliate link placeholder: {{AFFILIATE_LINK}}). Tone: informative, enthusiastic, compliant — avoid medical claims. Use the primary keyword '[strain_name] review' naturally 3–5 times. Return plain text with section headers."

- After generation, inject `affiliate_link` at every `{{AFFILIATE_LINK}}` placeholder.
- **GUARDRAIL:** Scan output for prohibited language: "cures", "treats", "heals", "medical", "FDA approved". If any found → remove automatically and replace with compliant alternatives before delivery.
- **GUARDRAIL:** If LLM returns fewer than 400 words or no `{{AFFILIATE_LINK}}` placeholder → trigger **ESCAPE HATCH B**.

### Step 3 — Draft Video Script & Social Captions
Pass strain data to LLM:
> "Write a 60-second unboxing/review video script for [strain_name] by [vendor_name]. Include: Hook (first 5 seconds), Product showcase (visual instructions), Key effects highlights, CTA with affiliate link placeholder: {{AFFILIATE_LINK}}. Also write 3 social media captions (Instagram, TikTok, X) each under 280 characters with 5 relevant hashtags. Return as JSON: { 'video_script': string, 'captions': { 'instagram': string, 'tiktok': string, 'x': string } }"

- Inject `affiliate_link` at all `{{AFFILIATE_LINK}}` placeholders.
- **GUARDRAIL:** Apply same prohibited language scan as Step 2 to all script and caption content.
- **GUARDRAIL:** If JSON is malformed or missing required fields → retry once. If second attempt fails → trigger **ESCAPE HATCH C**.

### Step 4 — Assemble Final Content Package
Compile into delivery folder `hemp_content_[content_id]/`:
- `[strain_name]_REVIEW.md` — full SEO written review with embedded affiliate links
- `[strain_name]_VIDEO_SCRIPT.md` — 60-second video script
- `[strain_name]_SOCIAL_CAPTIONS.md` — Instagram, TikTok, X captions
- `content_metadata.json` — strain data, affiliate link, vendor info, word counts, publish-ready flag

Set `publish_ready: true` only if:
- All affiliate links are embedded
- No prohibited medical language detected
- Word count ≥ 400 for written review
- Video script and at least 2 captions present

### Step 5 — AUDIT LOG (Mandatory — runs before termination on ALL paths)
Push the following record to the observability layer:

| Field | Value |
|---|---|
| `execution_timestamp` | ISO 8601 UTC |
| `input_source` | `content_id` |
| `lead_id` | `strain_name` |
| `operational_status` | `SUCCESS` / `FAIL` |
| `key_decisions` | affiliate link valid Y/N, review word count, prohibited language found Y/N, publish_ready flag |

**Destination:** Google Sheets via Gumloop webhook → Sheet: `HempContent_Audit` OR SQLite table `logs` on Render.

---

## Guardrails & Escape Hatches

### ESCAPE HATCH A — Missing or Invalid Affiliate Link
- **Condition:** `affiliate_link` missing, malformed, or lacks tracking parameter.
- **Action:**
  1. Log `FAIL` with `key_decisions: "Affiliate link invalid — content not generated"`.
  2. Alert admin: "Content job [content_id] halted — no valid affiliate link provided."
  3. Route to `manual_review/hemp-content/`.
  4. **Terminate immediately. Do not generate content that cannot be monetized.**

### ESCAPE HATCH B — Written Review Below Minimum Quality
- **Condition:** LLM returns fewer than 400 words or no affiliate link placeholder.
- **Action:**
  1. Retry LLM generation once with explicit word count reinforcement in prompt.
  2. If second attempt fails → log `FAIL`, store partial content in `manual_review/hemp-content/[content_id]/`.
  3. Alert admin: "Review generation failed for [strain_name] — manual writing required."
  4. **Do not deliver sub-minimum content as complete.**

### ESCAPE HATCH C — Script/Caption JSON Malformed
- **Condition:** LLM returns invalid JSON for video script or captions after 2 attempts.
- **Action:**
  1. Deliver written review only (if complete).
  2. Mark `video_script` and `captions` as `GENERATION_FAILED` in `content_metadata.json`.
  3. Log `SUCCESS (PARTIAL)` with note that script/captions require manual creation.
  4. Alert admin to complete missing content pieces.

---

## Failure States Reference

| Code | Condition | Resolution |
|---|---|---|
| `ERR_AFFILIATE_LINK_INVALID` | Missing or malformed affiliate link | Escape Hatch A — halt generation |
| `ERR_REVIEW_TOO_SHORT` | Written review under 400 words | Escape Hatch B — retry once |
| `ERR_SCRIPT_JSON_MALFORMED` | Video script JSON invalid after 2 attempts | Escape Hatch C — partial delivery |
| `ERR_PROHIBITED_LANGUAGE` | Medical claims detected in output | Auto-remove and replace; re-scan before delivery |
| `WARN_MISSING_STRAIN_DATA` | Terpenes or effects arrays empty | Continue with disclaimer labels — no fabrication |
| `ERR_AUDIT_WRITE_FAILED` | Logging destination unreachable | Alert admin immediately |
