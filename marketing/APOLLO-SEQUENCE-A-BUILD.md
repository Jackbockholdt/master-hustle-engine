# Apollo Sequence A — Build Sheet

Exact field-by-field spec for finalizing **Sequence A — Cold Agency Owners** in the Apollo UI.
Copy here mirrors `marketing/DIRECT-AGENCY-OUTREACH.md` (canonical). If the two ever disagree,
the canonical file wins — fix Apollo, then re-sync this sheet.

Target state: **5 automated email steps, days 1 / 3 / 6 / 9 / 12, sequence left PAUSED.**

---

## Part 1 — Delete the non-email steps

Delete these two before touching anything else, so the renumbering settles first:

| Delete | Current step | Type |
|--------|--------------|------|
| ✅ | Step 3 | Phone call |
| ✅ | Step 5 | Action item |

Apollo renumbers automatically on delete. After both deletions the surviving email steps
shift up — old Step 4 becomes Step 3, old Step 6 becomes Step 4, and so on. Work top-down
and re-read the step numbers on screen before editing bodies; the numbers below refer to the
**final** state, not the pre-delete state.

---

## Part 2 — Final structure

| Step | Day | Delay before step | Type | Subject mode |
|------|-----|-------------------|------|--------------|
| 1 | Day 1 | — (starts sequence) | Automatic email | New thread |
| 2 | Day 3 | +2 days | Automatic email | Reply to previous thread |
| 3 | Day 6 | +3 days | Automatic email | Reply to previous thread |
| 4 | Day 9 | +3 days | Automatic email | Reply to previous thread |
| 5 | Day 12 | +3 days | Automatic email | New thread |

All five steps are **Automatic email**, not manual tasks. Apollo counts delays in days
between steps, so enter the "delay before step" column, not the absolute day.

For steps 2–4, leave the subject field **blank** and enable *Reply to previous thread* —
that is what makes them thread under Step 1. Step 5 breaks out with its own subject.

---

## Part 3 — Step copy

Merge tags in use: `{{first_name}}`, `{{company}}`. No others — a tag Apollo can't resolve
renders literally in the send.

`[OUR_LIVE_URL]` below = `https://Jackbockholdt.github.io/master-hustle-engine/`
Paste the full URL, not the placeholder.

### Step 1 — Day 1

**Subject:** `quick one, {{company}}`

```
{{first_name}} —

Most agencies I talk to in digital are losing hours a week to lead routing and follow-up that could run itself.

I built a white-label automation stack agencies deploy under their own brand — lead routing, client follow-ups, custom AI workflows. Your logo, your domain, your client relationship.

60-second walkthrough of it running: [OUR_LIVE_URL]

Worth a look?
```

### Step 2 — Day 3

**Subject:** *(blank — reply to previous thread)*

```
{{first_name}} — the short version: it's the same automation layer you'd otherwise spend six months building, rebranded as yours.

Video's still here if you want the 60-second version: [OUR_LIVE_URL]
```

### Step 3 — Day 6

**Subject:** *(blank — reply to previous thread)*

```
{{first_name}} —

The part most agency owners care about: inbound lead hits, gets scored and enriched, routes to the right owner, and the follow-up cadence fires — no one touches it.

That's about 35 seconds into the demo: [OUR_LIVE_URL]

If it's not relevant, tell me and I'll close the loop.
```

### Step 4 — Day 9

**Subject:** *(blank — reply to previous thread)*

```
{{first_name}} —

Two models depending on your team: we deploy and run it for you, or you license it and run it yourself under your brand. Some agencies just buy the codebase outright.

All three are laid out here alongside the demo: [OUR_LIVE_URL]
```

### Step 5 — Day 12 — Breakup

**Subject:** `closing this out`

```
{{first_name}} — I'll stop here. If white-labeling an automation stack becomes relevant this quarter, the demo and pricing live at [OUR_LIVE_URL].

Good luck with {{company}}.
```

---

## Part 4 — Settings

- Plain text only. No images, no HTML formatting.
- One link maximum per email. Every link points to the landing page — never a Stripe
  checkout link in cold email.
- Open/click tracking **off on Step 1** (a tracking pixel on a cold first touch costs
  deliverability). Optional on steps 2–5.
- No pricing figures in Step 1 — the landing page does that job.
- Contacts: verified emails only, per `marketing/APOLLO-TARGETING-CRITERIA.md`.
- **Leave the sequence PAUSED after saving.** Do not activate.

---

## Part 5 — Verification before closing Apollo

- [ ] Exactly 5 steps, all of type Automatic email — no phone call, no action item
- [ ] Delays read 2 / 3 / 3 / 3 days, landing on days 1, 3, 6, 9, 12
- [ ] Steps 2, 3, 4 have blank subjects with *Reply to previous thread* enabled
- [ ] No `{{niche}}` and no `{{LANDING_PAGE_URL}}` anywhere in the sequence
- [ ] All five landing-page URLs resolve on click
- [ ] Sequence status reads **Paused**
