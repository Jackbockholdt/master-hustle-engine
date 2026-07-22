# Financial Model — White-Label AI Infrastructure License

`ai_doc_financial_model.xlsx` — a 3-year, fully formula-driven SaaS model for the
$1,500/month White-Label AI Infrastructure License (the product this repo sells).

It replaces an earlier toy spreadsheet (four hardcoded rows, ambiguous units, and a
"sell to Apple for millions" exit that the numbers never supported). This version is
built to survive scrutiny from an actual buyer or lender.

## Tabs

1. **Assumptions** — every input in its own labeled, blue cell. Yellow-filled cells are
   the key levers to stress-test first (adds/month, churn, CAC, founder draw, exit
   multiple). Change these; the rest of the model recalculates.
2. **Monthly Model** — 36-month engine: customer count (adds − churn), MRR/revenue,
   COGS, OpEx, EBITDA, and a running cash balance. Every column uses the same formulas.
3. **Annual Summary** — Year 1/2/3 roll-up plus an *illustrative* ARR-multiple valuation,
   with a disclaimer stating plainly what the number is and isn't.

## Base-case assumptions (all editable)

| Lever | Value |
|---|---|
| License price | $1,500 / customer / month |
| New customers / month | 2 (Y1) → 4 (Y2) → 6 (Y3) |
| Monthly logo churn | 4% (~39% / yr) |
| Variable COGS | $60 / customer / month |
| CAC | $300 / new customer |
| Founder / owner draw | $8,000 / month (real owner cost — set to 0 for pre-salary view) |
| Exit multiple | 3.0× ending ARR (illustrative) |

## Base-case output

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| Ending customers | ~19 | ~51 | ~89 |
| Ending ARR | $347k | $909k | $1.60M |
| Revenue | $202k | $674k | $1.31M |
| EBITDA (after founder draw) | $78k | $510k | $1.10M |
| Ending cash | $83k | $593k | $1.69M |

Illustrative Year-3 enterprise value at 3.0× ARR ≈ **$4.8M**. This is a directional
sanity check, **not** a price and **not** a strategic-acquirer outcome — see the
disclaimer on the Annual Summary tab.

## Editing conventions

- **Blue** cells = inputs (safe to change). **Black** = formulas (don't overwrite).
  **Green** = links to the Assumptions tab.
- Regenerate/verify after edits: the source builder is version-controlled separately;
  recalculate the workbook in Excel/LibreOffice so cached values refresh.
