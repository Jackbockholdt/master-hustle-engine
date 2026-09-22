# Master Hustle Engine — Operator Guide

## Product
Private-label 9-skill AI SDR / outreach workforce for agencies.  
Sold as white-label license (not a chatbot toy).

## Live URLs
- Sales page: https://www.master-hustle-engine.com/
- Backup Tiiny: https://antigravity-ai.tiiny.site/
- Live demo: https://master-hustle-engine.onrender.com/demo
- From address: hello@master-hustle-engine.com

## Pricing (ONLY after reply / on call — never in cold email)
- Start: $4,000 then $1,500/mo
- Buyout: $25,000
- Stripe start: https://buy.stripe.com/bJecN4al44iL5C7bsX0000H
- Stripe buyout: https://buy.stripe.com/6oU9AS3WGdTlaWr68D0000G

## SMTP (Hostinger)
- Host: smtp.hostinger.com
- Port: 465 SSL
- User: hello@master-hustle-engine.com
- Password: set env `HOSTINGER_HELLO_MAIL_PASSWORD` (Jack provides — not stored in this pack)

## Today’s Monday batch (2026-09-21)
File: `batches/2026-09-21-monday-25.json` — 25 verified remainder leads from Sunday wave.

### Run (Python 3)
```bash
export HOSTINGER_HELLO_MAIL_PASSWORD='(ask Jack)'
cd ENGINE
python3 scripts/run_daily_batch.py batches/2026-09-21-monday-25.json
```
Paces ~50s between sends. Skips emails listed in `batches/already-pitched-emails.txt`. Writes results under `logs/`.

### Manual send one-off
```bash
python3 scripts/send_hello_smtp.py --to lead@agency.com --subject "Subject" --body-file templates/cold-email.txt
```

## Cold rules
- Demo + landing only
- No Stripe, no $ amounts
- Skip anything in already-pitched list
- After heavy weeks: ~15–20/day ongoing (25 max when domain is healthy)
- ICP: AI agencies / marketing automation agencies with public hello@ or info@

## Reply handling
- Hot interest → Jack runs demo / closes
- Soft reply → propose 2 times, send demo link again
- Bounce → remove from future batches

## Going forward after Monday batch
1. Build next 15–25 MX+published-contact leads (AI/marketing agencies)
2. Dedupe against `already-pitched-emails.txt`
3. Save as `batches/YYYY-MM-DD.json` same schema as Monday file
4. Run `run_daily_batch.py`

## LinkedIn (optional same day)
- Partner/agency owner connects + short DM with demo URL
- Stop if weekly invitation limit hits
