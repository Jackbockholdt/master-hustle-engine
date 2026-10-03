#!/usr/bin/env python3
"""
send_shovel_campaign.py
Master Hustle Engine — Shovel Patent Buyout & Licensing Campaign Dispatcher

Features:
- Reads target pool from data/shovel_targets.json
- Formats personalized 3-line patent buyout pitch linking to https://selfcleaningshovel.tiiny.site
- Authenticates with Gmail SMTP TLS via .env credentials
- Enforces strict 45-60 second random jitter throttling between sends
- Records audit entries in shovel_outreach_log.jsonl
- Updates data/shovel_targets.json with real-time status and timestamps
"""

import os
import sys
import json
import time
import random
import smtplib
import argparse
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

# Force UTF-8 stdout encoding on Windows
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
TARGETS_JSON_PATH = os.path.join(DATA_DIR, 'shovel_targets.json')
LOG_JSONL_PATH = os.path.join(BASE_DIR, 'shovel_outreach_log.jsonl')
ENV_PATH = os.path.join(BASE_DIR, '.env')

def load_env(env_path):
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

SMTP_HOST = os.environ.get('SMTP_HOST', 'smtp.gmail.com')
SMTP_PORT = int(os.environ.get('SMTP_PORT', '587'))
SMTP_USER = os.environ.get('SMTP_USER', 'jbockholdt4@gmail.com')
SMTP_PASS = os.environ.get('SMTP_PASS', '')
SENDER_NAME = os.environ.get('SENDER_NAME', 'Jack Bockholdt')
SENDER_PHONE = os.environ.get('SENDER_PHONE', '(217) 609-1305')
LANDING_URL = 'https://selfcleaningshovel.tiiny.site'

def build_pitch(first_name, company_name):
    name = first_name.strip() if first_name else 'Team'
    company = company_name.strip() if company_name else 'your brand'
    
    subject = f"Patent Buyout / Licensing Inquiry: Self-Cleaning Shovel for {company}"
    
    plain_body = f"""Hi {name},

I'm the inventor of a patent-pending self-cleaning, self-standing shovel engineered to eliminate soil, mud, and clay adhesion on commercial jobsites.

We are currently reviewing direct patent buyout and exclusive manufacturing licensing opportunities with established tool brands like {company}.

You can review the full utility specifications, video demonstration, and buyout deck here: {LANDING_URL}

Best regards,
{SENDER_NAME}
Inventor & Patent Holder
Direct: {SENDER_PHONE}
Email: {SMTP_USER}"""

    html_body = f"""<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; color: #222; line-height: 1.6; max-width: 600px;">
    <p>Hi {name},</p>
    <p>I'm the inventor of a patent-pending self-cleaning, self-standing shovel engineered to completely eliminate soil, mud, and clay adhesion on commercial jobsites.</p>
    <p>We are currently reviewing direct patent buyout and exclusive manufacturing licensing opportunities with established tool brands like <strong>{company}</strong>.</p>
    <p>You can review the full utility specifications, video demonstration, and buyout deck directly here:<br>
    👉 <a href="{LANDING_URL}" style="color: #008844; font-weight: bold; text-decoration: underline;">{LANDING_URL}</a></p>
    <p style="margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px; font-size: 14px; color: #555;">
        <strong>{SENDER_NAME}</strong><br>
        Inventor &amp; Patent Holder<br>
        Direct: {SENDER_PHONE}<br>
        Email: <a href="mailto:{SMTP_USER}">{SMTP_USER}</a>
    </p>
</div>"""

    return subject, plain_body, html_body

def load_targets():
    if not os.path.exists(TARGETS_JSON_PATH):
        print(f"❌ Targets file not found at {TARGETS_JSON_PATH}")
        return []
    try:
        with open(TARGETS_JSON_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"❌ Error loading JSON targets: {e}")
        return []

def save_targets(targets):
    try:
        with open(TARGETS_JSON_PATH, 'w', encoding='utf-8') as f:
            json.dump(targets, f, indent=2)
    except Exception as e:
        print(f"⚠️ Warning: Could not save targets file: {e}")

def log_dispatch(record):
    with open(LOG_JSONL_PATH, 'a', encoding='utf-8') as f:
        f.write(json.dumps(record) + '\n')

def send_smtp_message(recipient_email, subject, plain_body, html_body):
    msg = MIMEMultipart('alternative')
    msg['From'] = f'"{SENDER_NAME}" <{SMTP_USER}>'
    msg['To'] = recipient_email
    msg['Subject'] = subject

    msg.attach(MIMEText(plain_body, 'plain', 'utf-8'))
    msg.attach(MIMEText(html_body, 'html', 'utf-8'))

    if SMTP_PORT == 465:
        server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=25)
    else:
        server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=25)
        server.starttls()

    server.login(SMTP_USER, SMTP_PASS)
    server.sendmail(SMTP_USER, recipient_email, msg.as_string())
    server.quit()

def main():
    parser = argparse.ArgumentParser(description="Live Shovel Patent Outbound Campaign Dispatcher")
    parser.add_argument('--live', action='store_true', help="Execute live SMTP delivery (default)")
    parser.add_argument('--dry-run', action='store_true', help="Simulate without sending")
    parser.add_argument('--throttle-min', type=int, default=45, help="Minimum throttle seconds (default: 45)")
    parser.add_argument('--throttle-max', type=int, default=60, help="Maximum throttle seconds (default: 60)")
    parser.add_argument('--limit', type=int, default=0, help="Limit number of emails to dispatch")
    parser.add_argument('--force', action='store_true', help="Resend to previously contacted leads")
    args = parser.parse_args()

    is_live = not args.dry_run

    print("===================================================================")
    print("⚡ MASTER HUSTLE ENGINE — SHOVEL PATENT OUTBOUND DISPATCHER")
    print(f"• Campaign Mode:   {'🚀 LIVE SMTP DISPATCH' if is_live else '🧪 DRY RUN (Simulation)'}")
    print(f"• Jitter Throttle: {args.throttle_min}s - {args.throttle_max}s delay between sends")
    print(f"• Authenticated:   {SMTP_USER} via {SMTP_HOST}:{SMTP_PORT}")
    print(f"• Source File:     {TARGETS_JSON_PATH}")
    print(f"• Audit Log:       {LOG_JSONL_PATH}")
    print("===================================================================\n")

    if is_live and not SMTP_PASS:
        print("❌ Error: SMTP_PASS is missing in .env. Please configure your App Password.")
        sys.exit(1)

    targets = load_targets()
    if not targets:
        print("No targets found in data/shovel_targets.json.")
        sys.exit(0)

    pending_targets = [
        t for t in targets
        if args.force or t.get('outreach_status', '').upper() != 'SENT'
    ]

    if args.limit > 0:
        pending_targets = pending_targets[:args.limit]

    total_count = len(pending_targets)
    print(f"Discovered {len(targets)} total records -> {total_count} leads ready for dispatch.\n")

    if total_count == 0:
        print("All targets have already been contacted. Use --force to resend.")
        sys.exit(0)

    successful_dispatches = []
    failed_dispatches = []

    for idx, lead in enumerate(pending_targets, 1):
        company = lead.get('company_name', 'Commercial Tool Manufacturer')
        name = lead.get('contact_name', 'Team')
        email = lead.get('email', '')

        print(f"[{idx}/{total_count}] Processing: {company}")
        print(f"    Recipient: {name} <{email}>")

        subject, plain_body, html_body = build_pitch(name, company)
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "target_id": lead.get('id', 'unknown'),
            "company_name": company,
            "recipient_name": name,
            "recipient_email": email,
            "subject": subject,
            "campaign": "SHOVEL_PATENT_BUYOUT",
            "asset_url": LANDING_URL,
            "mode": "LIVE" if is_live else "DRY_RUN"
        }

        if not is_live:
            lead['outreach_status'] = 'DRY_RUN_VERIFIED'
            lead['last_contacted_at'] = datetime.now().isoformat()
            log_entry['status'] = 'DRY_RUN_SUCCESS'
            successful_dispatches.append(lead)
            print("    [DRY RUN] Pitch formatted and verified.")
        else:
            try:
                print(f"    Connecting to {SMTP_HOST}:{SMTP_PORT} (TLS)...")
                send_smtp_message(email, subject, plain_body, html_body)
                lead['outreach_status'] = 'SENT'
                lead['last_contacted_at'] = datetime.now().isoformat()
                log_entry['status'] = 'SENT'
                successful_dispatches.append(lead)
                print(f"    ✅ Live dispatch delivered to {email}")
            except Exception as e:
                print(f"    ❌ Dispatch failed for {email}: {e}")
                lead['outreach_status'] = f"ERROR: {str(e)[:30]}"
                log_entry['status'] = f"FAILED: {str(e)}"
                failed_dispatches.append({"lead": lead, "error": str(e)})

        log_dispatch(log_entry)
        save_targets(targets)

        # Random jitter throttling between sends
        if idx < total_count:
            delay = random.randint(args.throttle_min, args.throttle_max)
            print(f"    ⏳ Jitter Throttle: sleeping for {delay} seconds before next send...\n")
            time.sleep(delay)

    print("\n===================================================================")
    print("🎉 SHOVEL OUTBOUND CAMPAIGN COMPLETE")
    print("===================================================================")
    print(f"• Total Processed:    {total_count}")
    print(f"• Successful Sends:   {len(successful_dispatches)}")
    print(f"• Failed Sends:       {len(failed_dispatches)}")
    print(f"• Updated Database:   {TARGETS_JSON_PATH}")
    print(f"• Audit Trail:        {LOG_JSONL_PATH}")
    print("===================================================================\n")

if __name__ == '__main__':
    main()
