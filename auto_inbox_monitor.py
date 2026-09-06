#!/usr/bin/env python3
"""
auto_inbox_monitor.py
Master Hustle Engine — 24/7 Automated Inbound Email Monitor & Multi-Venture Triage

Monitors Gmail via IMAP every 60 seconds, classifies incoming emails across:
1. Shovel Buyout (Keywords: shovel, patent, buyout, tiiny.site, licensing, tool)
2. White Label / SaaS / Digital Marketing (Keywords: saas, white label, marketing, software, agency, demo, pricing)
3. JaxPlugReviews / THCA (Keywords: jaxplug, review, thca, strain, sample, collab)

Logs all matches to inbound_triage_log.jsonl and outputs real-time alerts to terminal.
"""

import os
import sys
import json
import time
import email
import imaplib
import argparse
from datetime import datetime
from email.header import decode_header

# Force UTF-8 stdout encoding on Windows
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, '.env')
LOG_JSONL_PATH = os.path.join(BASE_DIR, 'inbound_triage_log.jsonl')
SEEN_FILE_PATH = os.path.join(BASE_DIR, 'seen_email_ids.json')

def load_env(env_path):
    """Load key-value pairs from .env file into os.environ."""
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k not in os.environ:
                    os.environ[k] = v

load_env(ENV_PATH)

IMAP_SERVER = os.environ.get('IMAP_SERVER', 'imap.gmail.com')
IMAP_PORT = int(os.environ.get('IMAP_PORT', '993'))
EMAIL_USER = os.environ.get('IMAP_USER', os.environ.get('SMTP_USER', 'jbockholdt4@gmail.com'))
EMAIL_PASS = os.environ.get('IMAP_PASS', os.environ.get('SMTP_PASS', ''))

# Multi-Venture Keyword Rules
VENTURE_RULES = {
    "SHOVEL_BUYOUT": {
        "name": "Self-Cleaning Shovel IP / Buyout",
        "keywords": ["shovel", "patent", "buyout", "tiiny.site", "licensing", "tool", "cad", "prototype", "utility"],
        "asset_link": "https://selfcleaningshovel.tiiny.site"
    },
    "WHITE_LABEL_SAAS": {
        "name": "White Label / SaaS / Digital Marketing",
        "keywords": ["saas", "white label", "marketing", "software", "agency", "demo", "pricing", "missed call", "retainer"],
        "asset_link": "https://misscallproject.com"
    },
    "JAXPLUG_THCA": {
        "name": "JaxPlugReviews / THCA",
        "keywords": ["jaxplug", "review", "thca", "strain", "sample", "collab", "flower", "distro", "dispensary"],
        "asset_link": "https://jacksplugreviews.com"
    }
}

def decode_mime_words(raw_header):
    """Safely decodes RFC 2047 MIME encoded headers."""
    if not raw_header:
        return ""
    decoded_fragments = []
    for text, enc in decode_header(raw_header):
        if isinstance(text, bytes):
            try:
                decoded_fragments.append(text.decode(enc or 'utf-8', errors='replace'))
            except Exception:
                decoded_fragments.append(text.decode('latin1', errors='replace'))
        else:
            decoded_fragments.append(str(text))
    return " ".join(decoded_fragments)

def parse_sender_info(from_header):
    """Extracts display name and clean email from From header."""
    clean_from = decode_mime_words(from_header)
    if '<' in clean_from and '>' in clean_from:
        name_part = clean_from.split('<')[0].strip().strip('"').strip("'")
        email_part = clean_from.split('<')[1].split('>')[0].strip().lower()
    else:
        name_part = clean_from.strip()
        email_part = clean_from.strip().lower()
    return name_part or "Decision Maker", email_part

def extract_email_body(msg):
    """Extracts plain text (or html fallback) body from an email Message object."""
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            cdisp = str(part.get('Content-Disposition'))
            if ctype == 'text/plain' and 'attachment' not in cdisp:
                payload = part.get_payload(decode=True)
                if payload:
                    body += payload.decode('utf-8', errors='replace') + "\n"
            elif ctype == 'text/html' and not body and 'attachment' not in cdisp:
                payload = part.get_payload(decode=True)
                if payload:
                    body += payload.decode('utf-8', errors='replace') + "\n"
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            body = payload.decode('utf-8', errors='replace')
    return body.strip()

def identify_venture(subject, body):
    """Identifies venture based on matching keywords in subject and body."""
    combined = (subject + " " + body).lower()
    matched_ventures = []

    for v_key, v_info in VENTURE_RULES.items():
        found = [kw for kw in v_info["keywords"] if kw in combined]
        if found:
            matched_ventures.append((v_key, v_info["name"], found, len(found)))

    if not matched_ventures:
        return "GENERAL_INQUIRY", "General / Uncategorized Inquiry", []

    # Sort by number of matching keywords descending
    matched_ventures.sort(key=lambda x: x[3], reverse=True)
    best = matched_ventures[0]
    return best[0], best[1], best[2]

def classify_intent(venture_key, subject, body, sender_name, sender_email):
    """Classifies inbound email intent and generates draft response."""
    combined = (subject + " " + body).lower()
    
    # 1. Unqualified / No / Unsubscribe / Out of Office
    if any(k in combined for k in ["out of office", "autoreply", "automatic reply", "on vacation", "away from"]):
        return {
            "classification": "UNQUALIFIED_NO",
            "intent": "OUT_OF_OFFICE",
            "summary": "Automated out-of-office response received.",
            "recommended_action": "Snooze follow-up for 5 business days.",
            "draft_reply": ""
        }
    if any(k in combined for k in ["unsubscribe", "remove", "not interested", "stop emailing", "opt out", "wrong person", "no thanks"]):
        return {
            "classification": "UNQUALIFIED_NO",
            "intent": "PASS_UNSUBSCRIBE",
            "summary": f"{sender_name} requested removal or expressed non-interest.",
            "recommended_action": "Log status as CLOSED_NOT_INTERESTED and suppress automated outreach.",
            "draft_reply": f"Hi {sender_name},\n\nUnderstood completely. You've been removed from all future updates.\n\nBest,\nJack"
        }

    # 2. NDA Required (CAD / Blueprints / Internal Specs)
    if any(k in combined for k in ["cad", "blueprint", "tolerances", "drawings", "schematic", "manufacturing specs", "internal dimensions", "step file"]):
        return {
            "classification": "NDA_REQUIRED",
            "intent": "TECHNICAL_DATA_REQUEST",
            "summary": f"{sender_name} requested CAD/mechanical blueprints or proprietary specs.",
            "recommended_action": "Flag immediately as REQUIRE_NDA and execute mutual NDA prior to file transmission.",
            "draft_reply": (
                f"Hi {sender_name},\n\n"
                f"Thank you for the interest in the self-cleaning shovel utility patent. "
                f"We can provide the full CAD, mechanical tolerances, and tooling files under a standard mutual NDA.\n\n"
                f"Please let me know where to send our 1-page mutual NDA, or feel free to attach your standard agreement.\n\n"
                f"Best regards,\nJack Bockholdt\n(217) 609-1305"
            )
        }

    # 3. High Interest (Call, Demo, Sell Sheet, Buyout Deck, Pricing)
    if any(k in combined for k in ["call", "demo", "sell sheet", "deck", "pricing", "cost", "schedule", "talk", "interested", "valuation", "video", "send over", "prototype"]):
        if venture_key == "SHOVEL_BUYOUT":
            draft = (
                f"Hi {sender_name},\n\n"
                f"Appreciate the response. The self-cleaning, self-standing shovel is patent-pending (U.S. App #64/035,114) and engineered specifically for commercial heavy-duty use.\n\n"
                f"You can review the 1-page sell sheet, utility specs, and video demonstration directly here: https://selfcleaningshovel.tiiny.site\n\n"
                f"Would you be open to a brief 10-minute call later this week to discuss licensing terms or direct IP buyout?\n\n"
                f"Best regards,\nJack Bockholdt\n(217) 609-1305"
            )
        elif venture_key == "WHITE_LABEL_SAAS":
            draft = (
                f"Hi {sender_name},\n\n"
                f"Thanks for reaching out. We can get the complete 24/7 AI lead capture system deployed for your agency in under 24 hours.\n\n"
                f"Here is the interactive demo breakdown: https://misscallproject.com\n\n"
                f"Are you available for a quick 10-minute walkthrough tomorrow?\n\n"
                f"Best,\nJack"
            )
        else: # THCA
            draft = (
                f"Hi {sender_name},\n\n"
                f"Thanks for reaching out regarding JaxPlugReviews. We cover verified lab COA results and full strain breakdowns.\n\n"
                f"You can review our live directory here: https://jacksplugreviews.com\n\n"
                f"Let's coordinate on sample shipment and featured coverage details.\n\n"
                f"Best,\nJack"
            )
        return {
            "classification": "HIGH_INTEREST",
            "intent": "DECISION_MAKER_ENGAGEMENT",
            "summary": f"{sender_name} expressed active interest in documentation, demo, or scheduling discussion.",
            "recommended_action": "Reply immediately (<15 mins) with direct asset link and propose call times.",
            "draft_reply": draft
        }

    # 4. Counter / Commercial Questions
    if any(k in combined for k in ["license", "licensing", "royalty", "exclusive", "territory", "terms", "unit cost", "cogs", "distribution", "manufacturer"]):
        return {
            "classification": "COUNTER_OR_QUESTIONS",
            "intent": "COMMERCIAL_TERMS_INQUIRY",
            "summary": f"{sender_name} is evaluating commercial structure (royalties, licensing, or manufacturing exclusivity).",
            "recommended_action": "Provide high-level structure and invite to a direct 15-minute alignment call.",
            "draft_reply": (
                f"Hi {sender_name},\n\n"
                f"Thanks for your question regarding licensing terms. We are open to both exclusive territory manufacturing licenses and direct patent acquisition.\n\n"
                f"Full specs and baseline term overviews are available here: https://selfcleaningshovel.tiiny.site\n\n"
                f"Let's set up a quick 15-minute call to align on your distribution footprint and commercial model.\n\n"
                f"Best regards,\nJack Bockholdt\n(217) 609-1305"
            )
        }

    # Default fallback
    return {
        "classification": "GENERAL_INQUIRY",
        "intent": "GENERAL_FOLLOWUP",
        "summary": f"Inbound message from {sender_name}.",
        "recommended_action": "Review message context and respond manually.",
        "draft_reply": f"Hi {sender_name},\n\nThanks for reaching out. How can we best assist you?\n\nBest,\nJack"
    }

def load_seen_ids():
    if os.path.exists(SEEN_FILE_PATH):
        try:
            with open(SEEN_FILE_PATH, 'r', encoding='utf-8') as f:
                return set(json.load(f))
        except Exception:
            return set()
    return set()

def save_seen_ids(seen_set):
    try:
        with open(SEEN_FILE_PATH, 'w', encoding='utf-8') as f:
            json.dump(list(seen_set)[-1000:], f, indent=2)
    except Exception as e:
        print(f"[!] Warning: Could not save seen IDs: {e}")

def log_triage_record(record):
    """Appends classified record to inbound_triage_log.jsonl."""
    with open(LOG_JSONL_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(record) + '\n')

def print_alert(record):
    """Prints formatted real-time alert to terminal."""
    classification = record.get('classification', 'GENERAL')
    venture_name = record.get('venture_name', 'General')
    sender = record.get('sender_name', 'Unknown')
    email_addr = record.get('sender_email', '')
    subject = record.get('subject', '')
    summary = record.get('summary', '')
    action = record.get('recommended_action', '')
    keywords = ", ".join(record.get('matched_keywords', [])) or "None"

    badge = "[HIGH INTEREST]" if classification == "HIGH_INTEREST" else f"[{classification}]"
    
    print("\n" + "="*70)
    print(f"🚨 INBOUND EMAIL ALERT: {badge} -> {venture_name}")
    print("="*70)
    print(f"• Timestamp:    {record.get('timestamp')}")
    print(f"• Sender:       {sender} <{email_addr}>")
    print(f"• Subject:      {subject}")
    print(f"• Venture:      {venture_name} ({record.get('venture_key')})")
    print(f"• Keywords:     {keywords}")
    print(f"• Summary:      {summary}")
    print(f"• Action:       {action}")
    if record.get('draft_reply'):
        print(f"\n--- Suggested Draft Response ---")
        print(record.get('draft_reply'))
        print("-" * 32)
    print("="*70 + "\n")

def check_inbox(seen_ids):
    """Connects to Gmail via IMAP, inspects recent messages, and triages new ones."""
    if not EMAIL_PASS:
        print("[!] Error: SMTP_PASS / IMAP_PASS is missing in .env")
        return 0

    new_matches = 0
    try:
        mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
        mail.login(EMAIL_USER, EMAIL_PASS)
        mail.select('INBOX')

        # Search for recent messages
        status, messages = mail.search(None, 'ALL')
        if status != 'OK' or not messages[0]:
            mail.logout()
            return 0

        msg_ids = messages[0].split()
        # Check the latest 25 messages
        recent_ids = msg_ids[-25:]

        for m_id in recent_ids:
            str_id = m_id.decode('utf-8')
            if str_id in seen_ids:
                continue

            status, data = mail.fetch(m_id, '(RFC822)')
            if status != 'OK' or not data or not data[0]:
                continue

            raw_email = data[0][1]
            msg = email.message_from_bytes(raw_email)

            from_hdr = msg.get('From', '')
            sender_name, sender_email = parse_sender_info(from_hdr)

            # Skip self-sent emails
            if EMAIL_USER.lower() in sender_email.lower():
                seen_ids.add(str_id)
                continue

            subject = decode_mime_words(msg.get('Subject', ''))
            body = extract_email_body(msg)

            venture_key, venture_name, matched_kws = identify_venture(subject, body)
            triage_res = classify_intent(venture_key, subject, body, sender_name, sender_email)

            record = {
                "timestamp": datetime.now().isoformat(),
                "message_id": str_id,
                "sender_name": sender_name,
                "sender_email": sender_email,
                "subject": subject,
                "venture_key": venture_key,
                "venture_name": venture_name,
                "matched_keywords": matched_kws,
                "classification": triage_res["classification"],
                "intent": triage_res["intent"],
                "summary": triage_res["summary"],
                "recommended_action": triage_res["recommended_action"],
                "draft_reply": triage_res["draft_reply"],
                "snippet": body[:200]
            }

            log_triage_record(record)
            print_alert(record)
            seen_ids.add(str_id)
            new_matches += 1

        save_seen_ids(seen_ids)
        mail.logout()

    except Exception as e:
        print(f"[!] IMAP Check Exception: {e}")

    return new_matches

def main():
    parser = argparse.ArgumentParser(description="Master Hustle Engine - Multi-Venture 24/7 Inbound Email Monitor")
    parser.add_argument('--interval', type=int, default=60, help="Check interval in seconds (default: 60)")
    parser.add_argument('--once', action='store_true', help="Run single inbox poll and exit")
    parser.add_argument('--test-inject', action='store_true', help="Inject sample test replies across all 3 ventures to verify pipeline")
    args = parser.parse_args()

    print("===================================================================")
    print("⚡ MASTER HUSTLE ENGINE — 24/7 INBOX MONITOR & TRIAGE SYSTEM")
    print(f"• IMAP Server:   {IMAP_SERVER}:{IMAP_PORT}")
    print(f"• Monitoring:    {EMAIL_USER}")
    print(f"• Poll Interval: {args.interval}s")
    print(f"• Log Output:    {LOG_JSONL_PATH}")
    print("===================================================================\n")

    seen_ids = load_seen_ids()
    print(f"[+] Loaded {len(seen_ids)} previously seen message IDs.")

    if args.test_inject:
        print("\n[🧪] INJECTING SYNTHETIC TEST PAYLOADS ACROSS ALL 3 VENTURES...")
        test_samples = [
            {
                "sender_name": "Steve Miller",
                "sender_email": "sales@krafttool.com",
                "subject": "Re: Patent Buyout / Licensing Inquiry: Self-Cleaning Shovel for Kraft Tool Co.",
                "body": "Hi Jack, we received your inquiry regarding the self-cleaning shovel utility patent. Could you send over the 1-page sell sheet, video breakdown, and current valuation for exclusive licensing?"
            },
            {
                "sender_name": "Sarah Connor",
                "sender_email": "operations@apexmarketing.io",
                "subject": "Re: White Label 24/7 AI System",
                "body": "Hey Jack, we run a 15-person marketing software agency. What is the pricing and setup timeline for your white label SaaS missed call demo?"
            },
            {
                "sender_name": "Marcus Vance",
                "sender_email": "info@greenleafdistro.com",
                "subject": "Re: JaxPlugReviews Partnership",
                "body": "Hi Jack, saw your review on the Emerald Runtz strain. We have 3 new THCA strains launching next month and want to send sample packs for a collab review."
            }
        ]

        for sample in test_samples:
            v_key, v_name, kws = identify_venture(sample["subject"], sample["body"])
            triage_res = classify_intent(v_key, sample["subject"], sample["body"], sample["sender_name"], sample["sender_email"])
            record = {
                "timestamp": datetime.now().isoformat(),
                "message_id": f"test-synthetic-{int(time.time()*1000)}",
                "sender_name": sample["sender_name"],
                "sender_email": sample["sender_email"],
                "subject": sample["subject"],
                "venture_key": v_key,
                "venture_name": v_name,
                "matched_keywords": kws,
                "classification": triage_res["classification"],
                "intent": triage_res["intent"],
                "summary": triage_res["summary"],
                "recommended_action": triage_res["recommended_action"],
                "draft_reply": triage_res["draft_reply"],
                "snippet": sample["body"][:200]
            }
            log_triage_record(record)
            print_alert(record)
            time.sleep(1)

        print("[✅] Synthetic injection test complete. Records logged to inbound_triage_log.jsonl\n")
        if args.once:
            return

    # Continuous Polling Loop
    cycle = 1
    while True:
        timestamp_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        print(f"[{timestamp_str}] [Cycle #{cycle}] Polling {EMAIL_USER} inbox via IMAP SSL...")
        matched = check_inbox(seen_ids)
        if matched > 0:
            print(f"[{timestamp_str}] [Cycle #{cycle}] 🎯 Processed and logged {matched} new triaged message(s).")
        else:
            print(f"[{timestamp_str}] [Cycle #{cycle}] No new unhandled messages. Inbox clean.")

        if args.once:
            break

        cycle += 1
        time.sleep(args.interval)

if __name__ == '__main__':
    main()
