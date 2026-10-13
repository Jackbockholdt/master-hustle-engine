# ⚡ AGENCY AI INFRASTRUCTURE LAYER
## Multi-LLM Zero-Downtime Failover & Outbound Delivery Guardrails

The **Agency AI Infrastructure Layer** (`Jackbockholdt/margin-engine-core`) is an enterprise-grade reliability and outreach governance backend designed for digital marketing and AI automation agencies.

It prevents client bot outages through zero-downtime multi-LLM failover (<50ms circuit swap on upstream 503/429 errors) and protects client sending domains with deterministic 10-point queue scrubbing and mandatory 48-hour quiet windows.

Measured on live workloads: **dynamically measured token efficiency and cost savings** compared against a strong-model baseline (`gpt-4o`) by stripping context bloat and routing automated triage to cost-effective models.

---

## 🎮 Live Pages & Consoles (`/demo`, `/router`)

1. **AI Router & Redundancy Console (`/router`)**:
   - Plain-English overview of real cost routing and multi-provider failover.
   - Interactive live status widget connected to `/api/router/status`.
   - Real-time provider reachability probes (Gemini, OpenAI, Claude, OpenRouter).
   - Live telemetry showing actual cost and measured savings vs `gpt-4o` baseline.

2. **White-Label Sales Desk Walkthrough (`/demo`)**:
   - Live query routing through Gemini 3.6 Flash (over IPv4).
   - "Kill primary (simulate 503/429)" toggle button.
   - Dynamic `Date.now()` measured latency audit (sub-second failover recovery).
   - Truthful error reporting (`backup not configured`) if secondary keys are unconfigured.

2. **Tab 2: Queue & Guardrail Scrubber**
   - Exact 10-row recipient test fixture:
     1. Valid agency email (`SEND`)
     2. In-batch duplicate (`DROP` — duplicate detected)
     3. Invalid syntax (`DROP` — failed RFC email syntax check)
     4. DNC suppression (`DROP` — matched `do-not-send-list.csv`)
     5. Generic role mailbox (`DROP` — generic `info@` distribution list)
     6. Consumer freemail (`DROP` — `@gmail.com` rejected for enterprise B2B)
     7. Valid second email (`SEND`)
     8. Duplicate of #7 (`DROP` — duplicate detected)
     9. Contacted within 48h (`DROP` — mandatory 48-hour quiet window)
     10. Valid third email (`SEND`)

---

## 🏛️ Architecture & Governance

```text
[ Inbound Client / Bot Query ]
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│  Primary Provider: Gemini 3.6 Flash                          │
│  Response Latency: ~100-300ms                               │
│  Function: High-throughput primary completion               │
└──────────────────────────────┬──────────────────────────────┘
                               │ (On Upstream 503, 429, Timeout)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Zero-Downtime Circuit Breaker (<50ms Swap)                 │
│  Backup Providers: Claude 3.5 Sonnet / OpenAI GPT-4o        │
│  Function: Hot-standby instant failover recovery            │
└─────────────────────────────────────────────────────────────┘
```

```text
[ Recipient Batch Ingestion ]
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│  Deterministic 10-Point Delivery Scrubber                   │
│  Checks: RFC Syntax, In-Batch Deduping, DNC Suppression,    │
│          Role Mailboxes (info@), Freemail (@gmail.com)      │
└──────────────────────────────┬──────────────────────────────┘
                               │ (If Cleared)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  Mandatory 48-Hour Quiet Window                             │
│  Enforces 48-hour cooldown per recipient; prevents domain   │
│  reputation damage and spam complaints                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 💼 Locked Commercial Licensing

All licenses are locked to verified Stripe Checkout tiers:

### 1. Agency Private-Label — $497 setup + $199/month
* Turnkey deployment of Multi-LLM Failover Router to your domain / Render
* Automatic upstream 503/429 circuit breaking (<50ms failover)
* Automated 10-layer queue scrubber (RFC syntax, DNC suppression, role/freemail blocking)
* 48-hour quiet window anti-spam guardrails
* White-label agency dashboard & 24/7 uptime monitoring
* **Stripe Checkout**: [Deploy Agency Private-Label](https://buy.stripe.com/6oU9AS3WGdTlaWr68D0000G)

### 2. Commercial Codebase License — $4,500 one-time
* 100% Full Source Code Transfer (GitHub: `Jackbockholdt/margin-engine-core`)
* Perpetual commercial & developer rights for unlimited client deployments
* Native SQLite queue scrubber, RFC email parser, and DNC suppression tables
* Multi-provider failover router (Gemini 3.6 Flash + Claude 3.5 + OpenAI)
* Zero recurring fees, zero revenue share, full self-hosting sovereignty
* **Stripe Checkout**: [Acquire Commercial License](https://buy.stripe.com/bJecN4al44iL5C7bsX0000H)

---

## 🚀 Quickstart & Local Verification

### 1. Install Dependencies
```powershell
npm install
```

### 2. Run Test Suites
```powershell
# Verify Multi-Model Router with Mocked Providers
node test_router_mocked.js

# Verify Standalone Router Connectivity & Probes
node test_standalone_router.js

# Verify Token Governance & Routing Benchmark
node test_token_governance.js

# Verify 9-Skill Integration Suite
node test_all_9_skills.js
```

### 3. Start Local Server
```powershell
node server.js
# Server running at http://localhost:10000
# Live console at http://localhost:10000/demo
```

---

## 🔔 Reply Alert (`reply_alert.py`)

Texts and/or emails Jack one line for each new reply to **hello@** or **Talha's campaign**:

```
Reply via hello@: Jane Doe <jane@prospect.io>: "Yes, send it over."
```

- Standalone: it reads the inbox itself (IMAP, read-only) and does not touch `send_batch.py`, `talha_batch.py` or the reply-check script.
- Run it right after the reply-check on the same schedule, e.g. `python reply_check.py && python reply_alert.py`.
- Alerts only Jack (`REPLY_ALERT_SMS_TO` via Twilio and/or `REPLY_ALERT_EMAIL_TO` via SMTP). Never contacts a prospect.
- Skips auto-replies, bounces and our own outbound. Each reply alerts once (`reply_alert_state.json`, gitignored); a failed delivery is retried next run.
- First run records existing replies as seen without alerting (`--backfill` to alert on them). `--dry-run` prints alerts and sends nothing.
- Config is env-only — see the "Reply alert" block in `.env.example`. Tests: `python3 test_reply_alert.py`.

## 🔒 Security & Data Isolation Guarantees
* **Live Latency Audits**: Real millisecond latency calculated dynamically with `Date.now()` (never hardcoded).
* **Truthful Provider Reporting**: If backup API keys are unconfigured, router reports `backup not configured` instead of faking success.
* **Strict Suppression**: Zero outbound dispatches allowed to addresses matching `do-not-send-list.csv` or within the 48-hour quiet window.
