# CLAUDE.md — Repository Directives

## North Star

This repository exists for exactly one purpose: selling the **White-Label Agency AI Infrastructure** offer.

All work — code, copy, outreach, tooling — must serve that single objective. If a task does not move a qualified agency owner closer to purchasing one of the three tiers below, it is out of scope.

**Status: pivoted from building to selling.** Feature work is frozen unless it directly unblocks a sale or a demo.

## What We Sell

A rebrandable AI automation stack that agencies deploy under their own name: automated lead routing, client follow-up cadences, and custom AI workflows. The buyer keeps the client relationship; nothing in the deployed product points back to us.

Core technical assets:

- **3-skill token router** — cost-aware model routing across providers.
- **9-skill agentic engine** — the workflow layer (routing, enrichment, follow-up, scheduling, summarization, escalation, reporting, CRM sync, billing hooks).

## Pricing Model (canonical — do not deviate)

| Tier | Name | Price |
|------|------|-------|
| 1 | Done-For-You Agency Deployment | $2,500 setup + $1,500/mo license |
| 2 | White-Label Partner License | $1,500/mo + usage |
| 3 | Complete IP / Codebase Buyout | $25,000 one-time |

**Tier 1 — Done-For-You Agency Deployment.** We build, brand, host, and maintain the full stack for the client. Includes configuration of lead routing, follow-up cadences, and AI workflows, plus ongoing monitoring, support, and monthly optimization.

**Tier 2 — White-Label Partner License.** The client runs the stack themselves under their brand. Monthly license plus metered usage. Self-serve onboarding, documentation, and standard support. No setup fee — this tier is for partners who already have technical capacity.

**Tier 3 — Complete IP / Codebase Buyout.** Full transfer of source, assets, and workflow ownership. Unlimited deployments, complete handover, documentation, training, and 30 days of transition support. This tier primarily functions as a price anchor; Tier 1 is the conversion target.

Setup fees and paid license months may be credited toward a Tier 3 buyout.

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
