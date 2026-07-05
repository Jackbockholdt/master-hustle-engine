"""
orchestrator.py
───────────────────────────────────────────────────────────────────────────────
Antigravity 2.0 — Central API Orchestrator
FastAPI webhook server that receives payloads from Gumloop and Vapi,
routes them to the correct SKILL.md execution handler, runs the skill logic,
and writes every outcome to a local SQLite audit table before responding.

Deploy on Render:
  uvicorn orchestrator:app --host 0.0.0.0 --port $PORT
───────────────────────────────────────────────────────────────────────────────
"""

import asyncio
import json
import logging
import os
import smtplib
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

# ── ENV VARS ──────────────────────────────────────────────────────────────────
GEMINI_API_KEY     = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL       = "gemini-2.5-flash"
OPENPHONE_API_KEY  = os.getenv("OPENPHONE_API_KEY", "")
OPENPHONE_FROM     = os.getenv("OPENPHONE_FROM_NUMBER", "")
ADMIN_EMAIL        = os.getenv("ADMIN_EMAIL", "")
SMTP_HOST      = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT      = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER      = os.getenv("SMTP_USER", "")
SMTP_PASS      = os.getenv("SMTP_PASS", "")
GMAIL_HTTP_URL = os.getenv("GMAIL_HTTP_URL", "")
GMAIL_HTTP_KEY = os.getenv("GMAIL_HTTP_KEY", "")
DB_PATH            = os.getenv("DB_PATH", "orchestrator_audit.sqlite")
SKILLS_DIR         = Path(__file__).parent / "skills"
REVIEW_DIR         = Path(__file__).parent / "manual_review"

# ── B2B SALES ENGINE CONFIG (set once in Render; used by /skill/invention-outreach) ──
DEPLOYER_NAME         = os.getenv("INVENTOR_NAME", "")
DEPLOYER_EMAIL        = os.getenv("INVENTOR_EMAIL", "") or os.getenv("ADMIN_EMAIL", "")
OFFER_NAME            = os.getenv("INVENTION_NAME", "White-Label AI Infrastructure License")
OFFER_SUMMARY         = os.getenv("INVENTION_SUMMARY", "")
PROOF_URL             = os.getenv("PROOF_URL", "https://missedcallproject.com")
DEPLOYMENT_FEE        = os.getenv("DEPLOYMENT_FEE", "1500")
STRIPE_PAYMENT_LINK   = os.getenv("STRIPE_PAYMENT_LINK", "")
QUALIFIED_INDUSTRIES  = [i.strip().lower() for i in os.getenv(
    "TARGET_INDUSTRIES",
    "digital marketing agency,lead generation agency,marketing agency,seo agency,ppc agency,social media agency,growth agency,advertising agency"
).split(",") if i.strip()]

# ── LOGGING ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  [%(levelname)s]  %(name)s — %(message)s",
)
log = logging.getLogger("orchestrator")


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — SQLITE OBSERVABILITY ENGINE
# ══════════════════════════════════════════════════════════════════════════════

BATCH_INTERVAL_HOURS = int(os.getenv("BATCH_INTERVAL_HOURS", "6"))
BATCH_SIZE           = int(os.getenv("BATCH_SIZE", "10"))


def init_db() -> None:
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        CREATE TABLE IF NOT EXISTS audit_log (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_timestamp TEXT    NOT NULL,
            skill_name          TEXT    NOT NULL,
            lead_id             TEXT,
            input_source        TEXT,
            operational_status  TEXT    NOT NULL,
            key_decisions       TEXT,
            error_message       TEXT,
            duration_ms         INTEGER,
            created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS leads_queue (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            company_name  TEXT    NOT NULL,
            contact_email TEXT    NOT NULL,
            website       TEXT,
            industry      TEXT,
            phone         TEXT,
            status        TEXT    NOT NULL DEFAULT 'pending',
            added_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            processed_at  DATETIME
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS follow_ups (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id   TEXT    NOT NULL,
            company_name  TEXT    NOT NULL,
            contact_email TEXT    NOT NULL,
            step          INTEGER NOT NULL,
            subject       TEXT    NOT NULL,
            body          TEXT    NOT NULL,
            due_at        TEXT    NOT NULL,
            status        TEXT    NOT NULL DEFAULT 'pending',
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            sent_at       DATETIME
        )
    """)
    con.commit()
    con.close()
    log.info("[DB] tables ready → %s", DB_PATH)


def queue_leads(leads: List[dict]) -> int:
    """Insert leads into the queue. Skips duplicates by email. Returns count inserted."""
    con = sqlite3.connect(DB_PATH)
    inserted = 0
    for lead in leads:
        email = lead.get("contact_email", "").strip().lower()
        if not email:
            continue
        exists = con.execute(
            "SELECT 1 FROM leads_queue WHERE contact_email = ?", (email,)
        ).fetchone()
        if exists:
            continue
        con.execute(
            """INSERT INTO leads_queue (company_name, contact_email, website, industry, phone)
               VALUES (?, ?, ?, ?, ?)""",
            (
                lead.get("company_name", ""),
                email,
                lead.get("website", ""),
                lead.get("industry", ""),
                lead.get("phone", ""),
            ),
        )
        inserted += 1
    con.commit()
    con.close()
    return inserted


def fetch_pending_leads(limit: int = BATCH_SIZE) -> List[dict]:
    con = sqlite3.connect(DB_PATH)
    rows = con.execute(
        """SELECT id, company_name, contact_email, website, industry, phone
           FROM leads_queue WHERE status = 'pending' ORDER BY id ASC LIMIT ?""",
        (limit,),
    ).fetchall()
    con.close()
    return [
        {"_queue_id": r[0], "company_name": r[1], "contact_email": r[2],
         "website": r[3], "industry": r[4], "phone": r[5]}
        for r in rows
    ]


def mark_lead(queue_id: int, status: str) -> None:
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "UPDATE leads_queue SET status=?, processed_at=CURRENT_TIMESTAMP WHERE id=?",
        (status, queue_id),
    )
    con.commit()
    con.close()


def queue_stats() -> dict:
    con = sqlite3.connect(DB_PATH)
    stats = {}
    for s in ("pending", "sent", "disqualified", "failed"):
        stats[s] = con.execute(
            "SELECT COUNT(*) FROM leads_queue WHERE status=?", (s,)
        ).fetchone()[0]
    con.close()
    return stats


def queue_follow_up(campaign_id: str, company_name: str, contact_email: str,
                     step: int, subject: str, body: str, due_at: datetime) -> None:
    con = sqlite3.connect(DB_PATH)
    con.execute(
        """INSERT INTO follow_ups (campaign_id, company_name, contact_email, step, subject, body, due_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (campaign_id, company_name, contact_email, step, subject, body, due_at.isoformat()),
    )
    con.commit()
    con.close()


def fetch_due_follow_ups(limit: int = 25) -> List[dict]:
    con = sqlite3.connect(DB_PATH)
    now = datetime.now(timezone.utc).isoformat()
    rows = con.execute(
        """SELECT id, campaign_id, company_name, contact_email, step, subject, body
           FROM follow_ups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?""",
        (now, limit),
    ).fetchall()
    con.close()
    return [
        {"id": r[0], "campaign_id": r[1], "company_name": r[2], "contact_email": r[3],
         "step": r[4], "subject": r[5], "body": r[6]}
        for r in rows
    ]


def mark_follow_up(follow_up_id: int, status: str) -> None:
    con = sqlite3.connect(DB_PATH)
    con.execute(
        "UPDATE follow_ups SET status=?, sent_at=CURRENT_TIMESTAMP WHERE id=?",
        (status, follow_up_id),
    )
    con.commit()
    con.close()


def follow_up_stats() -> dict:
    con = sqlite3.connect(DB_PATH)
    stats = {}
    for s in ("pending", "sent", "failed"):
        stats[s] = con.execute(
            "SELECT COUNT(*) FROM follow_ups WHERE status=?", (s,)
        ).fetchone()[0]
    con.close()
    return stats


def write_audit(
    skill_name: str,
    lead_id: str,
    input_source: str,
    status: str,           # SUCCESS | FAIL | PARTIAL
    key_decisions: dict,
    error_message: str = "",
    duration_ms: int = 0,
) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    try:
        con = sqlite3.connect(DB_PATH)
        con.execute(
            """INSERT INTO audit_log
               (execution_timestamp, skill_name, lead_id, input_source,
                operational_status, key_decisions, error_message, duration_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (ts, skill_name, lead_id, input_source, status,
             json.dumps(key_decisions), error_message, duration_ms),
        )
        con.commit()
        con.close()
        log.info("[AUDIT] %s → %s  lead=%s", skill_name, status, lead_id)
    except Exception as exc:
        log.error("[AUDIT WRITE FAILED] %s", exc)
        send_admin_alert(f"AUDIT WRITE FAILED — {skill_name}", str(exc))


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — SHARED HELPERS
# ══════════════════════════════════════════════════════════════════════════════

async def call_gemini(prompt: str, system: str = "", timeout: float = 30.0, json_mode: bool = False) -> str:
    """Call Gemini REST API. Raises on non-2xx or timeout."""
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not configured")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    generation_config = {
        "temperature": 0.4,
        "maxOutputTokens": 4096,
        "thinkingConfig": {"thinkingBudget": 0},
    }
    if json_mode:
        generation_config["responseMimeType"] = "application/json"
    body: dict = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": generation_config,
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}

    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(url, json=body)
        r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"]


async def send_sms(to: str, body: str) -> None:
    """Send SMS via OpenPhone REST API. Skips gracefully if not configured."""
    if not OPENPHONE_API_KEY:
        log.warning("[SMS] OpenPhone not configured — skipping SMS to %s", to)
        return
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            "https://api.openphone.com/v1/messages",
            json={"content": body, "from": OPENPHONE_FROM, "to": [to]},
            headers={"Authorization": OPENPHONE_API_KEY, "Content-Type": "application/json"},
        )
    if r.status_code not in (200, 201, 202):
        raise RuntimeError(f"OpenPhone {r.status_code}: {r.text[:200]}")


def _send_email(to_email: str, subject: str, body: str) -> None:
    """Send email via the Gmail HTTPS relay (Apps Script) if configured, else raw SMTP.
    Render blocks outbound SMTP, so the HTTP relay is the path that actually works there.
    The relay always returns HTTP 200 with {"success": bool, ...} — check the body, not the status."""
    if GMAIL_HTTP_URL:
        r = httpx.post(
            GMAIL_HTTP_URL,
            json={"key": GMAIL_HTTP_KEY, "to": to_email, "subject": subject, "body": body},
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        if not data.get("success"):
            raise RuntimeError(f"Gmail relay error: {data.get('error', 'unknown')}")
        return
    if not SMTP_USER:
        log.warning("[EMAIL] No relay or SMTP configured — skipped for %s", to_email)
        return
    msg = MIMEMultipart()
    msg["From"]    = SMTP_USER
    msg["To"]      = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
        s.starttls()
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)


def send_admin_alert(subject: str, body: str) -> None:
    """Alert to ADMIN_EMAIL via the Gmail relay or SMTP. Never raises — logs on failure."""
    if not ADMIN_EMAIL:
        log.warning("[ALERT] No ADMIN_EMAIL configured — alert dropped: %s", subject)
        return
    try:
        _send_email(ADMIN_EMAIL, f"[Orchestrator ALERT] {subject}", body)
    except Exception as exc:
        log.error("[ALERT EMAIL FAILED] %s", exc)


def send_pitch_email(to_email: str, subject: str, body: str) -> None:
    """Send outbound pitch email to a lead. Raises on failure so audit captures it."""
    _send_email(to_email, subject, body)
    log.info("[PITCH EMAIL] Delivered → %s | %s", to_email, subject)
    log.info("[PITCH EMAIL] Delivered → %s | %s", to_email, subject)


def save_to_review(skill_name: str, lead_id: str, payload: Any) -> None:
    """Persist a failed/escaped payload to manual_review/{skill_name}/."""
    folder = REVIEW_DIR / skill_name
    folder.mkdir(parents=True, exist_ok=True)
    ts  = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = folder / f"{lead_id}_{ts}.json"
    out.write_text(json.dumps(payload, indent=2, default=str))
    log.warning("[MANUAL REVIEW] Payload saved → %s", out)


def load_skill_md(skill_name: str) -> str:
    """Return the raw SKILL.md text for the given skill (used as agent context)."""
    slug = skill_name.lower().replace("_", "-")
    for f in SKILLS_DIR.glob("*.SKILL.md"):
        if slug in f.name.lower():
            return f.read_text(encoding="utf-8")
    return ""


def _extract_lead_id(payload: dict) -> str:
    for field in ("caller_phone", "customer_phone", "lead_phone", "from_address",
                  "request_id", "email_id", "client_id", "content_id",
                  "campaign_id", "job_id", "submission_id"):
        if val := payload.get(field):
            return str(val)
    return "unknown"


def _clean_json(raw: str) -> str:
    return raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()


def _to_e164(phone: str) -> str:
    """
    Silently normalize a US phone number to E.164 (+1XXXXXXXXXX).
    Accepts: 2175121377 | 217-512-1377 | (217) 512-1377 | +12175121377
    Returns the original string unchanged if it cannot be normalized.
    """
    if not phone:
        return phone
    # Already valid E.164
    if phone.startswith("+") and phone[1:].isdigit() and len(phone) >= 11:
        return phone
    digits = "".join(c for c in phone if c.isdigit())
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return phone  # unrecognized format — return as-is, guardrail will catch it


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — SKILL HANDLERS
# Each handler implements the execution flow defined in its SKILL.md file,
# including all guardrails and escape hatches.
# ══════════════════════════════════════════════════════════════════════════════

async def skill_call_catcher(payload: dict) -> dict:
    # Accept caller_phone or customer_phone interchangeably
    raw_phone     = payload.get("caller_phone") or payload.get("customer_phone", "")
    caller_phone  = _to_e164(raw_phone)
    transcript    = payload.get("voicemail_transcript", "")
    business_name = payload.get("business_name", "the team")

    # ESCAPE HATCH A — missing or still-malformed phone after sanitization
    if not caller_phone or not caller_phone.startswith("+"):
        save_to_review("call-catcher", raw_phone or "unknown", payload)
        raise ValueError(f"ERR_PAYLOAD_INVALID: could not normalize '{raw_phone}' to E.164")

    # LLM intent classification (ESCAPE HATCH B — use defaults on failure)
    urgency, primary_need = "UNKNOWN", "General Inquiry"
    try:
        system = (
            "Analyze the voicemail transcript and return JSON only: "
            '{"urgency":"HIGH|MEDIUM|LOW","primary_need":"string max 15 words","confidence":0.0}'
        )
        raw    = await call_gemini(transcript or "No voicemail left.", system, timeout=10, json_mode=True)
        parsed = json.loads(_clean_json(raw))
        if float(parsed.get("confidence", 0)) >= 0.65:
            urgency      = parsed.get("urgency", "UNKNOWN")
            primary_need = parsed.get("primary_need", "General Inquiry")
    except Exception as exc:
        log.warning("[call-catcher] LLM failed — defaults applied: %s", exc)

    # Compose SMS (160 chars per segment cap)
    if urgency == "HIGH":
        sms_body = (
            f"Hi! You called {business_name}. We know this is urgent — "
            "someone calls you back within 15 min. Reply now if needed."
        )
    else:
        sms_body = (
            f"Hi! You called {business_name}. We missed you but we're on it. "
            "We'll be in touch shortly — reply here if you need us now."
        )

    # ESCAPE HATCH C — SMS delivery failure
    try:
        await send_sms(caller_phone, sms_body[:320])
    except Exception as exc:
        save_to_review("call-catcher", caller_phone, payload)
        send_admin_alert(f"SMS failed — {caller_phone}", str(exc))
        raise RuntimeError(f"ERR_SMS_FAILED: {exc}") from exc

    return {
        "lead_id":       caller_phone,
        "urgency":       urgency,
        "primary_need":  primary_need,
        "sms_sent":      True,
        "key_decisions": {"urgency": urgency, "primary_need": primary_need, "sms_sent": True},
    }


async def skill_vintage_appraiser(payload: dict) -> dict:
    description  = payload.get("item_description", "")
    seller_name  = payload.get("seller_name", "unknown")
    request_id   = payload.get("request_id", seller_name)

    # ESCAPE HATCH A — description too short
    if len(description) < 10:
        save_to_review("vintage-appraiser", request_id, payload)
        raise ValueError("ERR_INPUT_INVALID: item_description must be at least 10 characters")

    system = (
        "You are an expert vintage and antique appraiser. Return JSON only: "
        '{"estimated_era":"string","manufacturer_or_origin":"string",'
        '"authenticity_markers":["string"],'
        '"comparable_sales":[{"description":"string","price":"string"}],'
        '"value_low":"string","value_mid":"string","value_high":"string",'
        '"confidence":"HIGH|MEDIUM|LOW","seller_recommendations":"string"}'
    )
    raw    = await call_gemini(description, system, json_mode=True)
    report = json.loads(_clean_json(raw))

    # ESCAPE HATCH C — low confidence labeling
    if report.get("confidence", "LOW") == "LOW":
        for k in ("value_low", "value_mid", "value_high"):
            report[k] = f"ESTIMATED — INSUFFICIENT DATA: {report.get(k, 'N/A')}"

    report["request_id"]   = request_id
    report["seller_name"]  = seller_name
    report["key_decisions"] = {
        "confidence":            report.get("confidence"),
        "comparable_sales_count": len(report.get("comparable_sales", [])),
        "value_range":           f"{report.get('value_low')} – {report.get('value_high')}",
    }
    return report


async def skill_file_mixup_catcher(payload: dict) -> dict:
    raw_data      = payload.get("raw_data", "")
    target_schema = payload.get("target_schema", {})
    job_id        = payload.get("job_id", "unknown")
    submitted_by  = payload.get("submitted_by", "unknown")

    # ESCAPE HATCH A — no data
    if not raw_data:
        save_to_review("file-mixup-catcher", job_id, payload)
        raise ValueError("ERR_ALL_FILES_FAILED: raw_data is empty")

    system = (
        "You are a data cleaning expert. Parse the raw data, normalize it, and return JSON only: "
        '{"headers":["string"],"rows":[["values"]],"unmapped_fields":["string"],'
        '"duplicates_removed":0,"notes":"string"}. '
        "Dates → ISO 8601. Phones → E.164. Emails → lowercase. "
        "Fields with no clear match → mark as UNMAPPED."
    )
    prompt = f"Target schema: {json.dumps(target_schema)}\n\nRaw data:\n{raw_data[:4000]}"
    raw    = await call_gemini(prompt, system, json_mode=True)
    result = json.loads(_clean_json(raw))

    result["job_id"]        = job_id
    result["submitted_by"]  = submitted_by
    result["key_decisions"] = {
        "rows_extracted":     len(result.get("rows", [])),
        "duplicates_removed": result.get("duplicates_removed", 0),
        "unmapped_fields":    result.get("unmapped_fields", []),
    }
    return result


async def skill_web_page_creator(payload: dict) -> dict:
    brand_name       = payload.get("brand_name", "")
    industry_niche   = payload.get("industry_niche", "")
    primary_services = payload.get("primary_services", [])
    color_scheme     = payload.get("color_scheme", {
        "primary": "#1a1a2e", "secondary": "#16213e", "accent": "#0f3460"
    })
    target_audience  = payload.get("target_audience", "local customers")
    client_id        = payload.get("client_id", "unknown")
    lead_destination = payload.get("lead_destination", "")

    # ESCAPE HATCH A — missing brand info
    if not brand_name or not industry_niche:
        save_to_review("web-page-creator", client_id, payload)
        raise ValueError("ERR_MISSING_BRAND_INFO: brand_name or industry_niche missing")

    # ESCAPE HATCH B — no lead destination
    if not lead_destination:
        save_to_review("web-page-creator", client_id, payload)
        send_admin_alert(f"Web Page Creator halted — {brand_name}", "lead_destination missing")
        raise ValueError("ERR_LEAD_DEST_INVALID: lead_destination missing — page cannot go live")

    system = (
        "You are an expert conversion copywriter. Return JSON only: "
        '{"headline":"string max 10 words","subheadline":"string max 20 words",'
        '"benefits":["string x3 max 15 words each"],'
        '"social_proof":"string","cta_label":"string max 5 words"}'
    )
    prompt = (
        f"Write landing page copy for a {industry_niche} business called '{brand_name}'. "
        f"Target audience: {target_audience}. Services: {', '.join(primary_services)}. "
        "Tone: professional, urgent, benefit-driven. No placeholder text."
    )
    raw  = await call_gemini(prompt, system, json_mode=True)
    copy = json.loads(_clean_json(raw))

    # GUARDRAIL — block placeholder copy
    forbidden = ("lorem ipsum", "insert headline", "placeholder", "coming soon")
    if any(f in json.dumps(copy).lower() for f in forbidden):
        save_to_review("web-page-creator", client_id, payload)
        raise ValueError("ERR_PLACEHOLDER_COPY: LLM returned filler text — blocking deployment")

    p  = color_scheme.get("primary", "#1a1a2e")
    s  = color_scheme.get("secondary", "#16213e")
    a  = color_scheme.get("accent", "#0f3460")
    yr = datetime.now().year

    services_html = "".join(
        f"<div class='card'><p>{svc}</p></div>" for svc in primary_services
    )
    benefits_html = "".join(
        f"<li>&#10003; {b}</li>" for b in copy.get("benefits", [])
    )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{brand_name}</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:'Segoe UI',system-ui,sans-serif;color:#222}}
.hero{{background:{p};color:#fff;padding:80px 24px;text-align:center}}
.hero h1{{font-size:clamp(1.8rem,4vw,2.6rem);margin-bottom:16px;line-height:1.2}}
.hero h2{{font-size:1.15rem;opacity:.88;margin-bottom:32px}}
.cta{{display:inline-block;background:{a};color:#fff;padding:16px 40px;border-radius:6px;font-size:1.05rem;text-decoration:none;font-weight:600}}
.benefits{{padding:56px 24px;max-width:760px;margin:auto}}
.benefits ul{{list-style:none;font-size:1.05rem;line-height:2.2}}
.services{{background:#f7f7f7;padding:56px 24px;display:flex;flex-wrap:wrap;gap:20px;justify-content:center}}
.card{{background:#fff;padding:24px 32px;border-radius:8px;min-width:180px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.07);font-size:1rem}}
.proof{{background:{s};color:#fff;padding:40px 24px;text-align:center;font-size:1.1rem;line-height:1.6}}
.form-wrap{{max-width:540px;margin:60px auto;padding:0 24px}}
.form-wrap h3{{font-size:1.4rem;margin-bottom:20px;color:{p}}}
.form-wrap input,.form-wrap textarea{{width:100%;padding:13px;margin:7px 0;border:1.5px solid #ddd;border-radius:6px;font-size:1rem;font-family:inherit}}
.form-wrap button{{width:100%;padding:16px;background:{a};color:#fff;border:none;border-radius:6px;font-size:1.05rem;font-weight:600;cursor:pointer;margin-top:8px}}
footer{{background:#111;color:#999;text-align:center;padding:24px;font-size:.88rem}}
</style>
</head>
<body>
<section class="hero">
  <h1>{copy.get('headline', brand_name)}</h1>
  <h2>{copy.get('subheadline', '')}</h2>
  <a class="cta" href="#contact">{copy.get('cta_label', 'Get Started Today')}</a>
</section>
<section class="benefits">
  <ul>{benefits_html}</ul>
</section>
<section class="services">{services_html}</section>
<section class="proof"><p>{copy.get('social_proof', '')}</p></section>
<section class="form-wrap" id="contact">
  <h3>Get In Touch</h3>
  <form action="{lead_destination}" method="POST">
    <input name="name"    placeholder="Your Name"     required>
    <input name="phone"   placeholder="Phone Number"  required>
    <input name="email"   placeholder="Email Address" type="email" required>
    <textarea name="message" placeholder="How can we help you?" rows="4"></textarea>
    <button type="submit">{copy.get('cta_label', 'Send Message')}</button>
  </form>
</section>
<footer><p>&copy; {yr} {brand_name}. Powered by Antigravity AI.</p></footer>
</body>
</html>"""

    return {
        "client_id":  client_id,
        "brand_name": brand_name,
        "html":       html,
        "copy":       copy,
        "key_decisions": {
            "copy_generated":    True,
            "lead_destination":  lead_destination,
            "services_count":    len(primary_services),
            "placeholder_check": "PASSED",
        },
    }


async def skill_kdp_publisher(payload: dict) -> dict:
    book_title      = payload.get("book_title", "Untitled")
    author_name     = payload.get("author_name", "Unknown Author")
    genre           = payload.get("genre", "General")
    target_audience = payload.get("target_audience", "general readers")
    manuscript      = payload.get("manuscript_text", "")
    submission_id   = payload.get("submission_id", "unknown")

    # ESCAPE HATCH A — unreadable manuscript
    if not manuscript or len(manuscript) < 100:
        save_to_review("kdp-publisher", submission_id, payload)
        raise ValueError("ERR_MANUSCRIPT_UNREADABLE: manuscript_text missing or too short")

    word_count = len(manuscript.split())
    short_form = word_count < 2500

    system = (
        "You are an expert Amazon KDP publishing consultant. Return JSON only: "
        '{"book_description":"string max 3000 chars SEO-optimized",'
        '"backend_keywords":["7 phrases each max 50 chars"],'
        '"bisac_categories":["category 1","category 2"],'
        '"subtitle_suggestion":"string max 200 chars"}'
    )
    prompt = (
        f"Book: '{book_title}' by {author_name}. Genre: {genre}. "
        f"Audience: {target_audience}.\n\nExcerpt:\n{manuscript[:1500]}"
    )
    raw      = await call_gemini(prompt, system, json_mode=True)
    metadata = json.loads(_clean_json(raw))

    keywords = metadata.get("backend_keywords", [])
    if len(keywords) < 7:
        metadata["backend_keywords"] = keywords + ["REQUIRES_MANUAL_COMPLETION"] * (7 - len(keywords))

    checklist = (
        f"# KDP Submission Checklist — {book_title}\n\n"
        f"- [ ] Log into KDP: https://kdp.amazon.com\n"
        f"- [ ] Click **Create** → **eBook** or **Paperback**\n"
        f"- [ ] Title: `{book_title}`\n"
        f"- [ ] Subtitle: `{metadata.get('subtitle_suggestion', '')}`\n"
        f"- [ ] Author: `{author_name}`\n"
        f"- [ ] Paste `book_description` from metadata\n"
        f"- [ ] Enter 7 backend keywords from metadata\n"
        f"- [ ] BISAC categories: {' / '.join(metadata.get('bisac_categories', []))}\n"
        f"- [ ] Upload formatted manuscript (.docx preferred)\n"
        f"- [ ] Set price: $2.99–$9.99 for 70% royalty tier\n"
        f"- [ ] Submit for review (3–5 business days)\n"
    )

    return {
        "submission_id":       submission_id,
        "book_title":          book_title,
        "word_count":          word_count,
        "short_form_flag":     short_form,
        "metadata":            metadata,
        "submission_checklist": checklist,
        "key_decisions": {
            "word_count":       word_count,
            "short_form_flag":  short_form,
            "keywords_count":   len(metadata.get("backend_keywords", [])),
            "metadata_complete": "REQUIRES_MANUAL_COMPLETION" not in metadata.get("backend_keywords", []),
        },
    }


async def skill_email_handler(payload: dict) -> dict:
    email_id  = payload.get("email_id", "unknown")
    from_addr = payload.get("from_address", "")
    subject   = payload.get("subject", "")
    body_text = payload.get("body_text", "")

    # ESCAPE HATCH B — legal keyword detection
    legal_kw = ["lawyer", "legal action", "bbb", "lawsuit", "attorney", "sue ", "litigation"]
    full_text = (subject + " " + body_text).lower()
    if any(kw in full_text for kw in legal_kw):
        send_admin_alert(
            f"LEGAL EMAIL — {from_addr}",
            f"Subject: {subject}\n\n{body_text[:600]}"
        )
        return {
            "email_id":  email_id,
            "category":  "ESCALATE",
            "action":    "LEGAL_KEYWORD — human alert sent, no auto-reply",
            "draft":     None,
            "key_decisions": {"category": "ESCALATE", "reason": "legal_keyword", "action": "alert_sent"},
        }

    # Classify intent
    system = (
        "Classify this email. Return JSON only: "
        '{"category":"SUPPORT|SALES|COMPLAINT|BILLING|SPAM|ESCALATE",'
        '"confidence":0.0,"urgency":"HIGH|MEDIUM|LOW","summary":"string max 20 words"}'
    )
    raw = await call_gemini(f"Subject: {subject}\n\n{body_text[:600]}", system, json_mode=True)
    cls = json.loads(_clean_json(raw))

    # GUARDRAIL — low confidence → always escalate
    if float(cls.get("confidence", 0)) < 0.70:
        cls["category"] = "ESCALATE"

    category = cls["category"]
    draft: Optional[str] = None
    action = "NONE"

    if category in ("SUPPORT", "SALES"):
        draft_sys = (
            "You are a professional assistant. Write a concise, helpful email reply under 200 words. "
            "Include a greeting, clear body, and professional closing. No placeholders."
        )
        draft  = await call_gemini(f"Reply to:\nSubject: {subject}\n\n{body_text[:800]}", draft_sys)
        action = "AUTO_DRAFTED"

    elif category in ("BILLING", "COMPLAINT"):
        draft  = f"[DRAFT — Requires human approval before sending]\n\nFrom: {from_addr}\nSubject: {subject}\n\n{body_text[:400]}"
        action = "DRAFTED_PENDING_HUMAN_APPROVAL"
        send_admin_alert(f"{category} email — {from_addr}", f"Subject: {subject}\n\n{body_text[:400]}")

    elif category == "ESCALATE":
        action = "ESCALATED_TO_HUMAN"
        send_admin_alert(f"ESCALATE email — {from_addr}", f"Subject: {subject}\n\n{body_text[:400]}")

    elif category == "SPAM":
        action = "ARCHIVED"

    return {
        "email_id":   email_id,
        "from":       from_addr,
        "category":   category,
        "confidence": cls.get("confidence"),
        "urgency":    cls.get("urgency"),
        "summary":    cls.get("summary"),
        "action":     action,
        "draft":      draft,
        "key_decisions": {"category": category, "confidence": cls.get("confidence"), "action": action},
    }


async def skill_vapi_voice_agent(payload: dict) -> dict:
    call_id    = payload.get("call_id", "unknown")
    lead_phone = payload.get("lead_phone") or payload.get("caller_phone", "")
    transcript = payload.get("transcript") or payload.get("call_transcript", "")
    call_type  = payload.get("call_type", "INBOUND")

    # ESCAPE HATCH B — invalid phone
    if not lead_phone:
        save_to_review("vapi-voice-agent", call_id, payload)
        raise ValueError("ERR_INVALID_PHONE: lead_phone missing")

    # ESCAPE HATCH — empty transcript
    if not transcript:
        save_to_review("vapi-voice-agent", call_id, payload)
        return {
            "call_id":   call_id,
            "lead_phone": lead_phone,
            "outcome":   "NO_TRANSCRIPT",
            "key_decisions": {"outcome": "NO_TRANSCRIPT", "action": "manual_review_queued"},
        }

    system = (
        "Parse this call transcript. Return JSON only: "
        '{"appointment_requested":false,"preferred_time":"string",'
        '"services_mentioned":["string"],"customer_name":"string",'
        '"customer_sentiment":"POSITIVE|NEUTRAL|NEGATIVE",'
        '"call_outcome":"BOOKED|CALLBACK_REQUESTED|NOT_INTERESTED|WRONG_NUMBER|NO_ANSWER",'
        '"action_items":["string"]}'
    )
    raw    = await call_gemini(transcript[:3000], system, json_mode=True)
    result = json.loads(_clean_json(raw))
    outcome = result.get("call_outcome", "CALLBACK_REQUESTED")

    # Trigger follow-ups
    if outcome == "BOOKED" and result.get("preferred_time"):
        try:
            await send_sms(
                lead_phone,
                f"Confirmed: your appointment is set for {result['preferred_time']}. We look forward to it!"
            )
        except Exception as exc:
            send_admin_alert(f"Booking SMS failed — {lead_phone}", str(exc))

    elif outcome == "NOT_INTERESTED":
        log.info("[vapi-voice-agent] Lead %s → DNC", lead_phone)

    result.update({
        "call_id":   call_id,
        "lead_phone": lead_phone,
        "call_type": call_type,
        "key_decisions": {
            "call_outcome":           outcome,
            "appointment_requested":  result.get("appointment_requested"),
            "sentiment":              result.get("customer_sentiment"),
            "action_items_count":     len(result.get("action_items", [])),
        },
    })
    return result


async def skill_hemp_review_generator(payload: dict) -> dict:
    strain_name      = payload.get("strain_name", "")
    strain_type      = payload.get("strain_type", "Hemp")
    terpene_profile  = payload.get("terpene_profile", [])
    reported_effects = payload.get("reported_effects", [])
    aroma_flavor     = payload.get("aroma_flavor", "")
    vendor_name      = payload.get("vendor_name", "")
    affiliate_link   = payload.get("affiliate_link", "")
    content_id       = payload.get("content_id", strain_name)

    # ESCAPE HATCH A — affiliate link required
    if not affiliate_link or not affiliate_link.startswith("https://"):
        save_to_review("hemp-review-generator", content_id, payload)
        raise ValueError("ERR_AFFILIATE_LINK_INVALID: affiliate_link missing or not HTTPS")

    missing_data = not terpene_profile or not reported_effects

    review_sys = (
        "You are an expert hemp content writer. Write a 600–900 word SEO-optimized strain review. "
        "Sections: Introduction, Terpene & Aroma Profile, Reported Effects & Experience, "
        "Who This Strain Is For, Where to Buy (include {{AFFILIATE_LINK}} here). "
        "NEVER write: cures, treats, heals, medical treatment, FDA approved. "
        "If effects data is missing, write: 'Effects vary by individual.'"
    )
    review_text = await call_gemini(
        f"Strain: {strain_name} ({strain_type}) by {vendor_name}\n"
        f"Terpenes: {', '.join(terpene_profile) or 'Not specified'}\n"
        f"Effects: {', '.join(reported_effects) or 'Not specified'}\n"
        f"Aroma/Flavor: {aroma_flavor or 'Not specified'}",
        review_sys,
    )
    review_text = review_text.replace("{{AFFILIATE_LINK}}", affiliate_link)

    # Prohibited language auto-removal
    for bad in ("cures", "treats", "heals", "fda approved", "medical treatment"):
        review_text = review_text.replace(bad, "may support wellness")

    # ESCAPE HATCH B — review too short
    if len(review_text.split()) < 400:
        save_to_review("hemp-review-generator", content_id, payload)
        raise ValueError("ERR_REVIEW_TOO_SHORT: review under 400 words after generation")

    script_sys = (
        "Write a 60-second video script and 3 social captions. "
        "Include {{AFFILIATE_LINK}} once in the script CTA. "
        "Return JSON only: "
        '{"video_script":"string","captions":{"instagram":"string","tiktok":"string","x":"string"}}'
    )
    raw_script = await call_gemini(
        f"Product: {strain_name} by {vendor_name}. "
        f"Effects: {', '.join(reported_effects) or 'relaxing, enjoyable'}.",
        script_sys,
        json_mode=True,
    )
    script_data = json.loads(_clean_json(raw_script))
    if "video_script" in script_data:
        script_data["video_script"] = script_data["video_script"].replace("{{AFFILIATE_LINK}}", affiliate_link)

    publish_ready = (
        affiliate_link in review_text
        and len(review_text.split()) >= 400
        and "video_script" in script_data
    )

    return {
        "content_id":       content_id,
        "strain_name":      strain_name,
        "review":           review_text,
        "script":           script_data,
        "affiliate_link":   affiliate_link,
        "publish_ready":    publish_ready,
        "missing_data_flag": missing_data,
        "key_decisions": {
            "affiliate_link_valid": True,
            "review_word_count":   len(review_text.split()),
            "publish_ready":       publish_ready,
            "missing_strain_data": missing_data,
        },
    }


async def skill_invention_outreach(payload: dict) -> dict:
    offer_name    = payload.get("invention_name",    "") or OFFER_NAME
    offer_summary = payload.get("invention_summary", "") or OFFER_SUMMARY
    deployer_name = payload.get("inventor_name",     "") or DEPLOYER_NAME
    deployer_email= payload.get("inventor_email",    "") or DEPLOYER_EMAIL
    target_co     = payload.get("target_companies",  [])
    campaign_id   = payload.get("campaign_id",       "unknown")
    proof_url     = payload.get("proof_url",         PROOF_URL)
    fee           = payload.get("deployment_fee",    DEPLOYMENT_FEE)
    contact_email = payload.get("contact_email",     "")

    # Use a default summary if env var is not set, so leads still get pitched
    if len(offer_summary.split()) < 10:
        offer_summary = (
            f"{offer_name} is a complete, production-ready 9-skill AI infrastructure backend "
            "(call catching, voice agent, web page creation, lead sorting, email handling, and more) "
            "that agencies white-label under their own brand and resell to local business clients. "
            f"Agencies license it for a flat ${fee}/month and resell access to 3-5 clients at "
            "$500-$1,000/month each — break-even from month one, pure margin after. No dev team, "
            f"no build time, no maintenance. Proof: {proof_url}"
        )
        log.warning("[invention-outreach] INVENTION_SUMMARY env var not set — using default summary")

    companies = target_co[:5] or ["a leading agency in this space"]

    pitches = []
    for company in companies:
        system = (
            "You are an elite B2B sales copywriter. Write a cold outreach email selling a white-label "
            "AI infrastructure license to a marketing/lead-gen agency owner who will resell it to their "
            "own local business clients. Return JSON only: "
            '{"subject":"string max 60 chars","body":"string max 220 words"}. '
            "Rules: "
            "1. The body MUST name the target company. "
            "2. Frame this as a REVENUE LINE for their agency, not a tech purchase — they resell it under their own brand. "
            "3. Lead with the math: resell to 3-5 clients at $500-$1,000/month each covers the license; everything after is pure margin. "
            "4. Present the offer as a complete 9-skill AI infrastructure backend (call catching, voice agent, lead sorting, web pages, email handling) they can resell tonight — no dev team, no build time. "
            "5. Include exactly 3 value bullets: (a) the resell math/break-even, (b) zero dev/maintenance burden, (c) sticky recurring revenue — clients don't churn off infrastructure embedded in their operations. "
            f"6. End CTA: request a 15-min screen-share demo. Close with proof link: {proof_url}"
            + (f" and payment/booking link: {STRIPE_PAYMENT_LINK}" if STRIPE_PAYMENT_LINK else "")
            + f" and contact email {{{{DEPLOYER_EMAIL}}}}. "
            "7. No buzzwords, no hype, no mockups. Direct, peer-to-peer, confident tone."
        )
        prompt = (
            f"Deployer: {deployer_name}. Offer: {offer_name}. "
            f"Summary: {offer_summary}. Monthly fee: ${fee}. "
            f"Target company: {company}."
        )
        raw = await call_gemini(prompt, system, json_mode=True)
        try:
            pitch = json.loads(_clean_json(raw))
        except json.JSONDecodeError as exc:
            raise ValueError(f"ERR_GEMINI_JSON_PARSE: {exc} — raw[:300]={raw[:300]!r}") from exc

        # GUARDRAIL — reject generic non-personalized draft
        if company.lower() not in pitch.get("body", "").lower():
            pitch["body"] = f"I'm reaching out to {company} specifically because {pitch.get('body', '')}"

        pitch["body"]    = pitch["body"].replace("{{DEPLOYER_EMAIL}}", deployer_email)
        pitch["company"] = company
        pitch["sequence"] = [
            {"step": 1, "send_on": "Day 0",  "status": "PENDING"},
            {"step": 2, "send_on": "Day 5",  "status": "PENDING"},
            {"step": 3, "send_on": "Day 10", "status": "PENDING"},
        ]
        pitches.append(pitch)

    # Send the pitch email to the lead contact
    email_sent  = False
    email_error = ""
    if contact_email and pitches:
        try:
            send_pitch_email(contact_email, pitches[0]["subject"], pitches[0]["body"])
            email_sent = True
        except Exception as exc:
            email_error = str(exc)
            log.error("[invention-outreach] Pitch email failed for %s: %s", contact_email, exc)
            send_admin_alert(f"Pitch email FAILED — {contact_email}", str(exc))

    # Queue the day-5 / day-10 follow-ups so the sequence actually fires later
    if email_sent and contact_email:
        try:
            company = pitches[0]["company"]
            now = datetime.now(timezone.utc)
            for step, days in ((2, 5), (3, 10)):
                subject, body = await _generate_followup_copy(
                    step, company, deployer_name, deployer_email, proof_url, fee, offer_name, offer_summary,
                )
                queue_follow_up(campaign_id, company, contact_email, step, subject, body,
                                 now + timedelta(days=days))
        except Exception as exc:
            log.error("[invention-outreach] Follow-up queue failed for %s: %s", contact_email, exc)

    return {
        "campaign_id":   campaign_id,
        "offer_name":    offer_name,
        "deployer_name": deployer_name,
        "proof_url":     proof_url,
        "pitches":       pitches,
        "email_sent":    email_sent,
        "key_decisions": {
            "pitches_generated":  len(pitches),
            "companies_targeted": companies,
            "deployment_fee":     fee,
            "email_sent":         email_sent,
            "email_error":        email_error,
            "contact_email":      contact_email,
        },
    }


async def _generate_followup_copy(
    step: int, company: str, deployer_name: str, deployer_email: str,
    proof_url: str, fee: str, offer_name: str, offer_summary: str,
) -> tuple[str, str]:
    """Generate day-5 (step 2) or day-10 (step 3) follow-up copy for a lead who hasn't replied."""
    angle = {
        2: "Social proof follow-up. Share a believable, concrete example of another agency reselling "
           "this to local business clients and hitting break-even fast. Slightly stronger CTA than a first touch.",
        3: "Final follow-up. Give them permission to walk away, note this is the last email, and add light "
           "urgency about being first in their market. Include a line offering to stop future emails on reply.",
    }[step]
    system = (
        "You are an elite B2B sales copywriter writing follow-up email "
        f"#{step} in a 3-email cold outreach sequence — the prospect has not replied yet. "
        "Return JSON only: {\"subject\":\"string max 60 chars\",\"body\":\"string max 180 words\"}. "
        f"{angle} "
        "The body MUST name the target company. Frame the offer as a white-label AI infrastructure "
        "license the agency resells to its own local business clients as a new revenue line. "
        f"Close with proof link: {proof_url}"
        + (f" and payment/booking link: {STRIPE_PAYMENT_LINK}" if STRIPE_PAYMENT_LINK else "")
        + f" and contact email {deployer_email}. No buzzwords, no hype. Direct, peer-to-peer tone."
    )
    prompt = (
        f"Deployer: {deployer_name}. Offer: {offer_name}. Summary: {offer_summary}. "
        f"Monthly fee: ${fee}. Target company: {company}."
    )
    raw = await call_gemini(prompt, system, json_mode=True)
    pitch = json.loads(_clean_json(raw))
    return pitch["subject"], pitch["body"]


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — SKILL ROUTER
# ══════════════════════════════════════════════════════════════════════════════

SKILL_MAP: dict[str, Any] = {
    "call-catcher":          skill_call_catcher,
    "vintage-appraiser":     skill_vintage_appraiser,
    "file-mixup-catcher":    skill_file_mixup_catcher,
    "web-page-creator":      skill_web_page_creator,
    "kdp-book-publisher":    skill_kdp_publisher,
    "email-handler":         skill_email_handler,
    "vapi-voice-agent":      skill_vapi_voice_agent,
    "hemp-review-generator": skill_hemp_review_generator,
    "invention-outreach":    skill_invention_outreach,
}

# keyword aliases for auto-detection from webhook payloads
_ALIASES: dict[str, str] = {
    "missed_call": "call-catcher",   "missed-call": "call-catcher",
    "voicemail":   "call-catcher",
    "vintage":     "vintage-appraiser", "antique": "vintage-appraiser",
    "appraisal":   "vintage-appraiser",
    "file":        "file-mixup-catcher", "data_sort": "file-mixup-catcher",
    "sort":        "file-mixup-catcher",
    "webpage":     "web-page-creator",  "website": "web-page-creator",
    "landing_page":"web-page-creator",
    "kdp":         "kdp-book-publisher","book": "kdp-book-publisher",
    "publish":     "kdp-book-publisher",
    "email":       "email-handler",     "inbox": "email-handler",
    "voice":       "vapi-voice-agent",  "call": "vapi-voice-agent",
    "vapi":        "vapi-voice-agent",  "end-of-call-report": "vapi-voice-agent",
    "hemp":        "hemp-review-generator", "strain": "hemp-review-generator",
    "thca":        "hemp-review-generator", "affiliate": "hemp-review-generator",
    "invention":   "invention-outreach",   "patent": "invention-outreach",
    "outreach":    "invention-outreach",   "b2b": "invention-outreach",
}


def resolve_skill(payload: dict) -> Optional[str]:
    """Identify which skill to run from the inbound webhook payload."""
    # 1. Explicit skill field at root level
    for field in ("skill", "skill_name", "intent", "niche", "type", "event"):
        val = str(payload.get(field, "")).lower().strip()
        if val in SKILL_MAP:
            return val
        if val in _ALIASES:
            return _ALIASES[val]

    # 2. Vapi message type
    msg_type = str(payload.get("message", {}).get("type", "")).lower()
    if msg_type:
        for alias, skill in _ALIASES.items():
            if alias in msg_type:
                return skill

    # 3. Nested metadata (Gumloop / Stripe style)
    for meta_key in ("metadata", "data", "payload"):
        meta = payload.get(meta_key)
        if isinstance(meta, dict):
            for field in ("skill", "intent", "niche"):
                val = str(meta.get(field, "")).lower().strip()
                if val in SKILL_MAP:
                    return val
                if val in _ALIASES:
                    return _ALIASES[val]

    return None


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — FASTAPI APPLICATION
# ══════════════════════════════════════════════════════════════════════════════

async def _process_lead_queue(batch_size: int = BATCH_SIZE) -> dict:
    """Pull pending leads from SQLite and run invention-outreach on each."""
    leads = fetch_pending_leads(batch_size)
    if not leads:
        log.info("[Scheduler] No pending leads.")
        return {"processed": 0, "sent": 0, "disqualified": 0, "failed": 0}

    sent, disq, failed = 0, 0, 0
    for lead in leads:
        qid = lead.pop("_queue_id")
        try:
            qualified, reason = _qualify_lead(lead["company_name"], lead.get("industry", ""))
            if not qualified:
                mark_lead(qid, "disqualified")
                disq += 1
                continue
            await skill_invention_outreach(lead)
            mark_lead(qid, "sent")
            sent += 1
        except Exception as exc:
            log.error("[Scheduler] Lead %s failed: %s", lead.get("contact_email"), exc)
            mark_lead(qid, "failed")
            failed += 1
        await asyncio.sleep(2)  # rate-limit between sends

    log.info("[Scheduler] Batch done — sent=%d disq=%d failed=%d", sent, disq, failed)
    return {"processed": len(leads), "sent": sent, "disqualified": disq, "failed": failed}


async def _scheduler_loop():
    """Background task: process lead queue every BATCH_INTERVAL_HOURS hours."""
    log.info("[Scheduler] Starting — interval=%dh batch=%d", BATCH_INTERVAL_HOURS, BATCH_SIZE)
    while True:
        await asyncio.sleep(BATCH_INTERVAL_HOURS * 3600)
        log.info("[Scheduler] Firing batch run")
        try:
            await _process_lead_queue()
        except Exception as exc:
            log.error("[Scheduler] Batch run error: %s", exc)


async def _follow_up_loop():
    """Background task: send any due day-5/day-10 follow-ups every hour."""
    log.info("[FollowUps] Starting — checking hourly")
    while True:
        await asyncio.sleep(3600)
        try:
            due = fetch_due_follow_ups()
            for fu in due:
                try:
                    send_pitch_email(fu["contact_email"], fu["subject"], fu["body"])
                    mark_follow_up(fu["id"], "sent")
                    log.info("[FollowUps] Sent step %d → %s", fu["step"], fu["contact_email"])
                except Exception as exc:
                    mark_follow_up(fu["id"], "failed")
                    log.error("[FollowUps] Send failed for %s: %s", fu["contact_email"], exc)
                await asyncio.sleep(2)  # rate-limit between sends
        except Exception as exc:
            log.error("[FollowUps] Batch error: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    lead_task = asyncio.create_task(_scheduler_loop())
    follow_up_task = asyncio.create_task(_follow_up_loop())
    log.info("[Orchestrator] Startup complete — %d skills registered, scheduler armed (%dh)", len(SKILL_MAP), BATCH_INTERVAL_HOURS)
    yield
    lead_task.cancel()
    follow_up_task.cancel()
    log.info("[Orchestrator] Shutdown")


app = FastAPI(
    title="Antigravity 2.0 — Central API Orchestrator",
    version="1.0.0",
    description="Routes Gumloop and Vapi webhooks to the correct SKILL.md handler with full SQLite audit logging.",
    lifespan=lifespan,
)


async def _run(skill_name: str, payload: dict, input_source: str) -> dict:
    """Execute a skill, write audit log, and return result. Propagates exceptions."""
    lead_id = _extract_lead_id(payload)
    t0      = time.perf_counter()
    try:
        result   = await SKILL_MAP[skill_name](payload)
        duration = int((time.perf_counter() - t0) * 1000)
        write_audit(
            skill_name=skill_name, lead_id=lead_id, input_source=input_source,
            status="SUCCESS", key_decisions=result.get("key_decisions", {}),
            duration_ms=duration,
        )
        return result
    except Exception as exc:
        duration = int((time.perf_counter() - t0) * 1000)
        write_audit(
            skill_name=skill_name, lead_id=lead_id, input_source=input_source,
            status="FAIL", key_decisions={}, error_message=str(exc),
            duration_ms=duration,
        )
        raise


# ── ROUTES ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0", "skills": list(SKILL_MAP)}


@app.post("/webhook/vapi")
async def webhook_vapi(request: Request):
    payload = await request.json()
    skill   = resolve_skill(payload)
    if not skill:
        log.warning("[Vapi] skill unresolved — payload keys: %s", list(payload.keys()))
        return JSONResponse({"received": True, "skill": None, "warning": "skill could not be resolved from payload"})
    result = await _run(skill, payload, input_source="webhook:vapi")
    return JSONResponse({"received": True, "skill": skill, "result": result})


@app.post("/webhook/gumloop")
async def webhook_gumloop(request: Request):
    payload = await request.json()
    skill   = resolve_skill(payload)
    if not skill:
        log.warning("[Gumloop] skill unresolved — payload keys: %s", list(payload.keys()))
        return JSONResponse({"received": True, "skill": None, "warning": "skill could not be resolved from payload"})
    result = await _run(skill, payload, input_source="webhook:gumloop")
    return JSONResponse({"received": True, "skill": skill, "result": result})


@app.post("/webhook/lead")
async def webhook_lead(request: Request):
    """
    Dedicated Gumloop lead intake. Expects company_name, contact_email, website.
    Runs lead qualification then fires the B2B outreach pitch on qualifying leads.
    """
    body = await request.json()
    # Accept 'email' as alias for 'contact_email' (common Gumloop/scraper field name)
    if not body.get("contact_email") and body.get("email"):
        body["contact_email"] = body["email"]
    missing = [f for f in ("company_name", "contact_email", "website") if not body.get(f)]
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing required fields: {missing}")

    industry  = body.get("industry", "")
    qualified, reason = _qualify_lead(body["company_name"], industry)
    if not qualified:
        log.info("[webhook/lead] DISQUALIFIED %s — %s", body["company_name"], reason)
        return JSONResponse({"received": True, "status": "DISQUALIFIED", "reason": reason})

    campaign_id = body.get("campaign_id") or f"lead-{body['company_name'].lower().replace(' ', '-')}"
    payload = {
        "invention_name":    OFFER_NAME,
        "invention_summary": OFFER_SUMMARY,
        "target_companies":  [body["company_name"]],
        "inventor_name":     DEPLOYER_NAME,
        "inventor_email":    DEPLOYER_EMAIL,
        "contact_email":     body["contact_email"],
        "website":           body["website"],
        "proof_url":         PROOF_URL,
        "deployment_fee":    DEPLOYMENT_FEE,
        "campaign_id":       campaign_id,
    }
    result = await _run("invention-outreach", payload, input_source="webhook:lead")
    return JSONResponse({"received": True, "status": "SUCCESS", "result": result})


@app.post("/webhook/openphone")
async def webhook_openphone(request: Request):
    """
    OpenPhone webhook receiver. Handles call.completed and call.missed events.
    Routes missed/unanswered calls to the Call Catcher skill for instant SMS text-back.
    """
    body = await request.json()
    event_type = body.get("type", "")
    data       = body.get("data", {}).get("object", body.get("data", {}))

    log.info("[OpenPhone] event=%s", event_type)

    # Only act on missed or completed-unanswered calls
    if event_type not in ("call.completed", "call.missed", "call.ringing"):
        return JSONResponse({"received": True, "action": "ignored", "event": event_type})

    caller_phone  = data.get("from") or data.get("caller", "")
    call_status   = data.get("status", "")
    transcript    = data.get("transcription", {}).get("text", "") if isinstance(data.get("transcription"), dict) else ""

    # Only text back missed/unanswered calls
    if call_status not in ("missed", "no-answer", "canceled", "") and event_type != "call.missed":
        return JSONResponse({"received": True, "action": "ignored", "reason": f"call status '{call_status}' not a missed call"})

    if not caller_phone:
        log.warning("[OpenPhone] no caller phone in payload — skipping")
        return JSONResponse({"received": True, "action": "skipped", "reason": "no caller_phone"})

    payload = {
        "caller_phone":          caller_phone,
        "voicemail_transcript":  transcript,
        "business_name":         DEPLOYER_NAME or "the team",
    }
    result = await _run("call-catcher", payload, input_source="webhook:openphone")
    return JSONResponse({"received": True, "status": "SUCCESS", "result": result})


def _qualify_lead(company_name: str, industry: str) -> tuple[bool, str]:
    """
    Return (qualified: bool, reason: str).
    Discard any lead whose industry doesn't match QUALIFIED_INDUSTRIES.
    An empty industry field passes through — let the pitch attempt rather than false-discard.
    """
    if not industry:
        return True, "industry not provided — passing through"
    ind = industry.strip().lower()
    for q in QUALIFIED_INDUSTRIES:
        if q in ind or ind in q:
            return True, f"matched qualified industry: {q}"
    return False, f"industry '{industry}' not in qualified list — discard"


@app.post("/skill/invention-outreach")
async def run_invention_outreach(request: Request):
    """
    Gumloop intake for the B2B sales engine.
    Required: company_name, contact_email, website.
    Optional: industry (used for lead qualification filter).
    Leads outside QUALIFIED_INDUSTRIES are silently discarded with status DISQUALIFIED.
    """
    body = await request.json()

    # ── Field validation — 400 if required fields missing ────────────────────
    missing = [f for f in ("company_name", "contact_email", "website") if not body.get(f)]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Missing required fields: {missing}. "
                   "Payload must include company_name, contact_email, and website."
        )

    # ── Lead qualification — discard non-target industries ───────────────────
    industry = body.get("industry", "")
    qualified, reason = _qualify_lead(body["company_name"], industry)
    if not qualified:
        log.info("[invention-outreach] DISQUALIFIED %s — %s", body["company_name"], reason)
        return JSONResponse({
            "skill":   "invention-outreach",
            "status":  "DISQUALIFIED",
            "company": body["company_name"],
            "reason":  reason,
        })

    # ── Build full payload enriched with deployer config from env vars ────────
    campaign_id = body.get("campaign_id") or f"gumloop-{body['company_name'].lower().replace(' ', '-')}"
    payload = {
        "invention_name":    OFFER_NAME,
        "invention_summary": OFFER_SUMMARY,
        "target_companies":  [body["company_name"]],
        "inventor_name":     DEPLOYER_NAME,
        "inventor_email":    DEPLOYER_EMAIL,
        "contact_email":     body["contact_email"],
        "website":           body["website"],
        "proof_url":         PROOF_URL,
        "deployment_fee":    DEPLOYMENT_FEE,
        "campaign_id":       campaign_id,
    }

    # ── Run skill — _run() handles SQLite audit on SUCCESS and FAIL ──────────
    try:
        result = await _run("invention-outreach", payload,
                            input_source="direct:POST /skill/invention-outreach")
        return JSONResponse({"skill": "invention-outreach", "status": "SUCCESS", "result": result})
    except Exception as exc:
        log.error("[invention-outreach] endpoint error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/skill/{skill_name}")
async def run_skill_direct(skill_name: str, request: Request):
    """Direct skill execution endpoint. Useful for testing from Gumloop or Postman."""
    if skill_name not in SKILL_MAP:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown skill '{skill_name}'. Available: {list(SKILL_MAP)}"
        )
    payload = await request.json()
    result  = await _run(skill_name, payload, input_source=f"direct:POST /skill/{skill_name}")
    return JSONResponse({"skill": skill_name, "status": "SUCCESS", "result": result})


@app.get("/logs")
async def get_logs(
    limit:  int           = 50,
    skill:  Optional[str] = None,
    status: Optional[str] = None,
):
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    q, params = "SELECT * FROM audit_log WHERE 1=1", []
    if skill:
        q += " AND skill_name = ?"
        params.append(skill)
    if status:
        q += " AND operational_status = ?"
        params.append(status.upper())
    q += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    rows = [dict(r) for r in con.execute(q, params).fetchall()]
    con.close()
    return {"count": len(rows), "logs": rows}


@app.get("/logs/{skill_name}")
async def get_skill_logs(skill_name: str, limit: int = 25):
    return await get_logs(limit=limit, skill=skill_name)


@app.get("/skills")
async def list_skills():
    out = {}
    for name in SKILL_MAP:
        md      = load_skill_md(name)
        version = "1.0.0"
        for line in md.splitlines():
            if line.strip().startswith("version:"):
                version = line.split(":", 1)[1].strip().strip('"')
                break
        out[name] = {"version": version, "playbook_loaded": bool(md)}
    return {"total": len(out), "skills": out}


# ── SELF-TRIGGER ADMIN ROUTES ─────────────────────────────────────────────────

@app.post("/admin/leads")
async def import_leads(request: Request):
    """Bulk-import leads into the queue. Body: list of lead objects or {leads: [...]}"""
    body = await request.json()
    leads = body if isinstance(body, list) else body.get("leads", [])
    if not leads:
        raise HTTPException(status_code=400, detail="Send a JSON array of leads or {leads: [...]}")
    inserted = queue_leads(leads)
    stats = queue_stats()
    return {"imported": inserted, "skipped": len(leads) - inserted, "queue": stats}


@app.post("/admin/run-now")
async def run_now(request: Request):
    """Immediately process the next batch of pending leads. Optional: {batch_size: N}"""
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    size = int(body.get("batch_size", BATCH_SIZE))
    result = await _process_lead_queue(size)
    result["queue"] = queue_stats()
    return result


@app.get("/admin/status")
async def queue_status():
    """Return current lead queue and follow-up sequence stats."""
    return {
        "queue":      queue_stats(),
        "follow_ups": follow_up_stats(),
        "config":     {"batch_size": BATCH_SIZE, "interval_hours": BATCH_INTERVAL_HOURS},
    }
