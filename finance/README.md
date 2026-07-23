# Finance — White-Label AI Infrastructure License

Two assets for the White-Label AI Infrastructure License (the product this repo sells).
**Pricing (updated 2026-07-23):** Option A — $2,500 setup + $1,500/month; Option B —
$25,000 one-time codebase buyout.

- **`ai_doc_financial_model.xlsx`** — the 3-year, fully formula-driven model (below).
- **`antigravity_pitch_deck.pptx`** — a 9-slide investor/partner pitch deck built on the
  model's numbers (~93% gross margin, $1.6M modeled Year-3 ARR, $4.8M illustrative EV).
  Includes the same honest valuation disclaimer as the model: the EV is a directional
  sanity check, not a price and not a strategic-acquirer outcome.

## Financial model

`ai_doc_financial_model.xlsx` — a 3-year, fully formula-driven SaaS model for the
White-Label AI Infrastructure License.

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
| Setup fee (Option A) | $2,500 one-time per new customer |
| Codebase buyout (Option B) | $25,000 one-time (reference; alternative to the recurring build) |
| New customers / month | 2 (Y1) → 4 (Y2) → 6 (Y3) |
| Monthly logo churn | 4% (~39% / yr) |
| Variable COGS | $60 / customer / month |
| CAC | $300 / new customer |
| Founder / owner draw | $8,000 / month (real owner cost — set to 0 for pre-salary view) |
| Exit multiple | 3.0× ending ARR (illustrative) |

## Base-case output (recurring + setup fees)

| | Year 1 | Year 2 | Year 3 |
|---|---|---|---|
| Ending customers | ~19 | ~51 | ~89 |
| Ending ARR (recurring) | $347k | $909k | $1.60M |
| Total revenue | $262k | $794k | $1.49M |
| EBITDA (after founder draw) | $136k | $626k | $1.27M |
| Ending cash | $141k | $767k | $2.04M |

Business turns EBITDA-positive in **month 2**. Illustrative Year-3 enterprise value at
3.0× recurring ARR ≈ **$4.8M** (ARR is recurring-only; one-time setup fees are excluded
from ARR by design). This is a directional sanity check, **not** a price and **not** a
strategic-acquirer outcome — see the disclaimer on the Annual Summary tab.

## Unit economics (per customer, base case)

| Metric | Value |
|---|---|
| Avg customer lifetime | 25 months (1 ÷ 4% churn) |
| Monthly recurring contribution | $1,395 |
| Recurring LTV | $34,875 |
| Setup-fee contribution (one-time) | $2,425 |
| **Total LTV / customer** | **$37,300** |
| CAC | $300 |
| **LTV : CAC** | **~124×** |
| CAC payback (recurring) | ~0.2 months (setup fee alone covers CAC on day one) |

> The LTV:CAC ratio is very high because CAC is modeled at $300 — acquisition is
> automated / founder-run, not a paid sales team. A paid outbound motion would raise CAC
> and compress the ratio; treat $300 as the current-reality input, not a promise.

**Buyer's resale break-even:** resell to 3 clients at $500/mo to cover the $1,500/mo
license; the $2,500 setup is recovered in ~5 months from one additional client.

## Editing conventions

- **Blue** cells = inputs (safe to change). **Black** = formulas (don't overwrite).
  **Green** = links to the Assumptions tab.
- Regenerate/verify after edits: the source builder is version-controlled separately;
  recalculate the workbook in Excel/LibreOffice so cached values refresh.
