# Lead Sourcing — Outscraper direct (no Gumloop)

Gumloop is retired. As of 2026-09-01 its API returns `paid_plan_required` on
every trigger, so the engine now finds its own leads. Two ways in:

| Path | When | Cost |
|---|---|---|
| `tools/load-leads.js` → `POST /admin/leads` | You already have a file (the ~1,000 Outscraper contacts, any CSV) | free |
| `POST /admin/scrape-now` / auto-run | You want fresh leads pulled on a schedule | Outscraper credits |

Neither path sends email. Sending is unchanged: the batch scheduler, behind
`OUTBOUND_PAUSED` and `DAILY_SEND_CAP`.

## 1. Load a file you already have

```bash
# dry run — shows counts, skip reasons, and a sample. Nothing is sent anywhere.
node tools/load-leads.js ~/Downloads/outscraper-agencies.csv

# load for real (ADMIN_KEY = the Render env var)
ADMIN_KEY=xxxx node tools/load-leads.js ~/Downloads/outscraper-agencies.csv --send

# first 200 only, stamped with a campaign key
ADMIN_KEY=xxxx node tools/load-leads.js file.csv --send --limit 200 --campaign sept-agencies
```

Accepts an Outscraper Google Maps export (CSV or JSON — columns like `name`,
`site`, `category`, `email_1`, `email_1_full_name`) **or** the engine's own
template (`tools/leads-template.csv`). Format is detected from the contents.

For each business the loader picks **one** email, in this order of preference:
a named person on the company's own domain, then an unnamed address on that
domain. It drops role mailboxes (`info@`, `hello@`, …), freemail, and any
address whose domain does not match the website. A `first_name` is only set
when Outscraper attached a real name to that address — never from the prefix.

The server then re-runs, per row: placeholder/syntax validation, the ICP
filter (`qualifyLead`), the quality screen (`screenLeadQuality`, incl. the
permanent blocklist), the do-not-contact list, and `alreadyContacted()` —
so a second load of the same file imports zero.

## 2. Scrape fresh leads

Set on Render (Environment tab), then **Manual Deploy → Deploy latest commit**:

```
OUTSCRAPER_API_KEY=...                       # app.outscraper.com → Profile → API
OUTSCRAPER_QUERIES=seo agency, Austin, TX|ppc agency, Denver, CO|digital marketing agency, Nashville, TN
OUTSCRAPER_LIMIT_PER_QUERY=20                # places per query per run
OUTSCRAPER_INTERVAL_HOURS=24                 # 0 = manual only
OUTSCRAPER_VALIDATE_EMAILS=true              # deliverability check, keeps RECEIVING only
```

Queries are separated by `|` because a Google Maps query contains commas.
Good queries are *category, city, state* — the more specific the category
(`seo agency`, `ppc agency`, `social media marketing agency`) the fewer
non-ICP places you pay for.

Run one by hand (dry run first — it costs the search but not the validator,
and writes nothing):

```bash
curl -s -X POST https://master-hustle-engine.onrender.com/admin/scrape-now \
  -H 'Content-Type: application/json' -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"queries":["seo agency, Austin, TX"],"limit":10,"dry_run":true}' | jq .

# for real
curl -s -X POST https://master-hustle-engine.onrender.com/admin/scrape-now \
  -H 'Content-Type: application/json' -H "X-Admin-Key: $ADMIN_KEY" \
  -d '{"queries":["seo agency, Austin, TX"],"limit":20}' | jq '{places,with_email,queued,disqualified,low_quality,duplicate,validated_out,queue}'
```

The response lists `skipped` reasons and a `sample` of what was queued, so a
bad query is visible before it costs a second run.

Auto-runs are skipped while `OUTSCRAPER_MAX_QUEUE` (default 200) leads are
already pending, and are not armed at all while `OUTBOUND_PAUSED=true`
(same rule the Gumloop trigger had). `GET /admin/status` shows the
`lead_source` block.

## 3. Credits

Outscraper bills per place returned; the `domains_service` enrichment (emails
and names from the business site) and the email validator are extra per
record. 20 places × 5 queries × daily is a modest bill; 100 × 50 × 6-hourly is
not. Start at the defaults and widen once reply rate justifies it.

## 4. What is deliberately NOT here

- No guessed addresses. `scripts/send_25_agencies.ps1` and
  `scripts/agency_scraper_feeder.py` carry hand-typed `firstname@` guesses;
  6 of 25 hard-bounced. Those files are kept for the record only — do not run them.
- No enrichment of employee count. Outscraper's Maps data does not carry it;
  the 50-employee ceiling only fires when a file supplies `employee_count`.
  Use specific categories and smaller cities to stay in the 5–50 range.
