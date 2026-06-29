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

import json
import logging
import os
import smtplib
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

# ── ENV VARS ──────────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL   = "gemini-2.5-flash"
TWILIO_SID     = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN   = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM    = os.getenv("TWILIO_FROM_PHONE", "")
ADMIN_EMAIL    = os.getenv("ADMIN_EMAIL", "")
SMTP_HOST      = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT      = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER      = os.getenv("SMTP_USER", "")
SMTP_PASS      = os.getenv("SMTP_PASS", "")
DB_PATH        = os.getenv("DB_PATH", "orchestrator_audit.sqlite")
SKILLS_DIR     = Path(__file__).parent / "skills"
REVIEW_DIR     = Path(__file__).parent / "manual_review"

# ── LOGGING ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  [%(levelname)s]  %(name)s — %(message)s",
)
log = logging.getLogger("orchestrator")


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — SQLITE OBSERVABILITY ENGINE
# ══════════════════════════════════════════════════════════════════════════════

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
    con.commit()
    con.close()
    log.info("[DB] audit_log table ready → %s", DB_PATH)


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

async def call_gemini(prompt: str, system: str = "", timeout: float = 30.0) -> str:
    """Call Gemini REST API. Raises on non-2xx or timeout."""
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not configured")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    body: dict = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.4, "maxOutputTokens": 2048},
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}

    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(url, json=body)
        r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"]


async def send_sms(to: str, body: str) -> None:
    """Send SMS via Twilio REST API. Raises on failure."""
    if not TWILIO_SID:
        log.warning("[SMS] Twilio not configured — skipping SMS to %s", to)
        return
    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}/Messages.json"
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            url,
            data={"From": TWILIO_FROM, "To": to, "Body": body},
            auth=(TWILIO_SID, TWILIO_TOKEN),
        )
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Twilio {r.status_code}: {r.text[:200]}")


def send_admin_alert(subject: str, body: str) -> None:
    """Synchronous SMTP alert to ADMIN_EMAIL. Never raises — logs on failure."""
    if not SMTP_USER or not ADMIN_EMAIL:
        log.warning("[ALERT] SMTP not configured — alert dropped: %s", subject)
        return
    try:
        msg = MIMEMultipart()
        msg["From"]    = SMTP_USER
        msg["To"]      = ADMIN_EMAIL
        msg["Subject"] = f"[Orchestrator ALERT] {subject}"
        msg.attach(MIMEText(body, "plain"))
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
            s.starttls()
            s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg)
    except Exception as exc:
        log.error("[ALERT EMAIL FAILED] %s", exc)


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
        raw    = await call_gemini(transcript or "No voicemail left.", system, timeout=10)
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
    raw    = await call_gemini(description, system)
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
    raw    = await call_gemini(prompt, system)
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
    raw  = await call_gemini(prompt, system)
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
    raw      = await call_gemini(prompt, system)
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
    raw = await call_gemini(f"Subject: {subject}\n\n{body_text[:600]}", system)
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
    raw    = await call_gemini(transcript[:3000], system)
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
    invention_name    = payload.get("invention_name", "")
    invention_summary = payload.get("invention_summary", "")
    patent_status     = payload.get("patent_status", "No Patent")
    target_industries = payload.get("target_industries", [])
    target_companies  = payload.get("target_companies", [])
    inventor_name     = payload.get("inventor_name", "")
    inventor_email    = payload.get("inventor_email", "")
    campaign_id       = payload.get("campaign_id", "unknown")

    # ESCAPE HATCH A — summary too short
    if len(invention_summary.split()) < 50:
        save_to_review("invention-outreach", campaign_id, payload)
        raise ValueError("ERR_SUMMARY_TOO_SHORT: invention_summary must be at least 50 words")

    no_patent  = patent_status.lower() in ("no patent", "none", "")
    disclaimer = (
        "\n\n*Note: This invention is not currently patent-protected.*"
        if no_patent else ""
    )

    companies = (target_companies or target_industries)[:5]
    if not companies:
        companies = ["a leading manufacturer in this industry"]

    pitches = []
    for company in companies:
        system = (
            "You are a B2B licensing outreach expert. Return JSON only: "
            '{"subject":"string max 60 chars","body":"string max 250 words"}. '
            "The body MUST mention the company name. No placeholders. "
            "Structure: hook, problem/opportunity, 3 value bullets, 15-min call CTA, "
            "end with {{INVENTOR_EMAIL}}."
        )
        prompt = (
            f"Inventor: {inventor_name}. Invention: {invention_name}. "
            f"Summary: {invention_summary}. Patent: {patent_status}. "
            f"Target company: {company}. Industry: {', '.join(target_industries)}."
        )
        raw   = await call_gemini(prompt, system)
        pitch = json.loads(_clean_json(raw))

        # GUARDRAIL — ensure personalization
        if company.lower() not in pitch.get("body", "").lower():
            pitch["body"] = f"I'm reaching out to {company} specifically because {pitch.get('body', '')}"

        pitch["body"]     = pitch["body"].replace("{{INVENTOR_EMAIL}}", inventor_email)
        pitch["body"]    += disclaimer
        pitch["company"]  = company
        pitch["sequence"] = [
            {"step": 1, "send_on": "Day 0",  "status": "PENDING"},
            {"step": 2, "send_on": "Day 5",  "status": "PENDING"},
            {"step": 3, "send_on": "Day 10", "status": "PENDING"},
        ]
        pitches.append(pitch)

    return {
        "campaign_id":    campaign_id,
        "invention_name": invention_name,
        "inventor_name":  inventor_name,
        "pitches":        pitches,
        "no_patent_flag": no_patent,
        "key_decisions": {
            "pitches_generated":  len(pitches),
            "companies_targeted": companies,
            "no_patent_flag":     no_patent,
            "disclaimer_added":   no_patent,
        },
    }


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

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    log.info("[Orchestrator] Startup complete — %d skills registered", len(SKILL_MAP))
    yield
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
