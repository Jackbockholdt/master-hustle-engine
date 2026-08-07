# CLAUDE.md — Repository Directives

## North Star

This repository exists for exactly one purpose: selling the **White-Label Agency AI Infrastructure** offer.

All work — code, copy, outreach, tooling — must serve that single objective. If a task does not move a qualified agency owner closer to purchasing the single offer below, it is out of scope.

**Status: pivoted from building to selling.** Feature work is frozen unless it directly unblocks a sale or a demo.

## What We Sell

A rebrandable AI automation stack that agencies deploy under their own name: automated lead routing, client follow-up cadences, and custom AI workflows. The buyer keeps the client relationship; nothing in the deployed product points back to us.

Core technical assets:

- **3-skill token router** — cost-aware model routing across providers.
- **9-skill agentic engine** — the workflow layer (routing, enrichment, follow-up, scheduling, summarization, escalation, reporting, CRM sync, billing hooks).

## Pricing Model (canonical — do not deviate)

**There is exactly ONE offer. The tiered menu is gone — do not reintroduce it.**

| | Amount |
|---|---|
| Due at signing | **$4,000** ($2,500 setup + first month) |
| Recurring | **$1,500/month** |

**White-Label Agency AI Infrastructure.** We build, brand, host, and maintain the full stack for the agency. Includes configuration of lead routing, follow-up cadences, and AI workflows, plus ongoing monitoring, support, and monthly optimization. The agency resells it to their own clients under their own name.

**The $25,000 codebase buyout is a price anchor only.** It may appear in human-facing sales copy — landing pages, the one-pager, a live conversation — to frame the license as the cheaper path. It must **never** be quoted as a purchasable option in an API response or in automated outbound email. Setup fees and paid license months may be credited toward a buyout if one is negotiated.

### Where the price lives

`config/pricing.json` is the single pricing authority. `config/pricing.js` (Node) and `orchestrator.py` (Python) both read it.

- Never hardcode a dollar figure in application code — import it.
- `quotableOffer()` is what endpoint responses and automated email must use; it deliberately omits the buyout.
- `salesCopyOffer()` includes the buyout and is for human-facing pages only.
- The `DEPLOYMENT_FEE` env var survives only as a legacy override of the monthly figure. Leave it unset.

Static HTML sales pages carry the price inline by necessity. If the price changes, update `config/pricing.json` **and** grep the repo for the old figure.

## Deprecated — Do Not Reintroduce

The following legacy positioning has been fully removed from this repository. Do not reference, resurrect, or generate content based on it:

- Contractor, plumber, HVAC, roofing, and other home-services pitches
- Missed-call text-back / missed-call automation as a headline offer
- All prior cold-call scripts and phone-first outreach
- Third-party micro-site links (tiiny.site and similar)
- Any hardcoded phone numbers

If you find a reference to any of the above in this repo, delete it rather than updating it.

## Channel Rules

- Outreach points to the landing page, never to a raw Stripe checkout link. Payment links in cold email damage deliverability and read as spam.
- The 60-second workflow demo video is the primary hook in all outreach.
- Canonical outreach copy lives in marketing/DIRECT-AGENCY-OUTREACH.md. Do not fork copy elsewhere.
- Canonical list-building spec lives in marketing/APOLLO-TARGETING-CRITERIA.md.

## Secrets Policy

No secret ever enters source control. All keys are read from the environment at runtime:

```js
const geminiKey = process.env.GEMINI_API_KEY;
const routerKey = process.env.ROUTER_API_KEY;
```

`.env` is gitignored. `.env.example` documents required variable names with empty values only. Any literal key found in tracked code must be treated as compromised: rotate it at the provider, then remove it from the file.
