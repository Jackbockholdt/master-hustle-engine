# Task: apply the follow-up dedupe patch and open a PR

Repo: https://github.com/Jackbockholdt/master-hustle-engine
Base: `main` at commit `5451d56` ("Merge pull request #86 from Jackbockholdt/retire-gumloop-outscraper-direct")

## Before you start

1. **Work from a fresh clone of `main`.** Do NOT use
   `C:\Users\jack\.gemini\antigravity-ide\scratch\master-hustle-engine` — that copy
   is stale (its `server.js` is 1004 lines; `main` is 2512). The patch will not apply there.
2. **Verify every identifier you use before acting on it.** If a commit hash, PR
   number, file path, line number, or env var does not resolve, STOP and say so.
   Do not invent one and do not proceed on an assumption.

## What to change

Apply `followup-dedupe.patch` to `server.js`. If it does not apply cleanly, make
these three changes by hand:

**1. `fetchDueFollowUps()`** — currently selects every pending row. Change the query to
return at most one row per ADDRESS per run, keeping the earliest campaign:

```sql
SELECT id, campaign_id, company_name, contact_email, step, subject, body
  FROM follow_ups
 WHERE status = 'pending' AND due_at <= ?
   AND id IN (SELECT MIN(id) FROM follow_ups
               WHERE status = 'pending' AND due_at <= ?
               GROUP BY LOWER(contact_email))
 ORDER BY due_at ASC LIMIT ?
```
Bind params become `[now, now, limit || 25]`.

**2. Add a recent-send guard.** New const `FOLLOWUP_MIN_GAP_HOURS`
(`process.env.FOLLOWUP_MIN_GAP_HOURS || 48`) and a `mailedRecently(email)` helper that
queries `send_log` for `LOWER(sent_to) = ?` within the window. In the follow-up
scheduler loop, immediately after the existing `isDoNotContact` check, suppress and
`continue` if `mailedRecently()` returns a row.

**3. Add `retireDuplicateSequences()`** — a one-time repair that runs at boot (call it
just before the `[Follow-up Scheduler] Armed` log line). For any address with pending
follow-ups under more than one `campaign_id`, keep the earliest campaign and set the
rest to `status='suppressed'`. Log one line per address.

## Verify

- `node --check server.js` must pass.
- Confirm all three anchors were actually modified — grep for `FOLLOWUP_MIN_GAP_HOURS`,
  `mailedRecently`, `retireDuplicateSequences` and show the matches.

## Then

Open a pull request against `main`. Title: `Follow-up scheduler: dedupe by address, not campaign`.
In the body, explain the bug: an address that picked up two campaigns had a pending
sequence under each, and the scheduler sent both — eric@singlegrain.com received two
step-2 pitches four seconds apart on 2026-09-03.

## Do NOT

- Do not push directly to `main`. PR only.
- Do not deploy. Auto-deploy is off on both Render services and must stay off.
- Do not change `OUTBOUND_PAUSED`. It is `true` on purpose; outbound is paused pending cleanup.
- Do not add `ALLOW_ROLE_MAILBOXES` or any toggle that lets role mailboxes
  (`info@`, `hello@`, `contact@`, `support@`, `admin@`, `sales@`) past qualification.
  The gate in `server.js` exists because those addresses hard-bounced; the bounced
  ones are in `config/blocklist.json` permanently.
- Do not run anything in `scripts/` that carries hand-guessed addresses
  (see CLAUDE.md, "Lead Sourcing"). Those feeder scripts double-sent the Aug 18 batch.
- Do not touch `README.md` sales claims, `index.html`, or `pitch.html` in this PR.
