#!/usr/bin/env python3
"""
send_saas_campaign.py
Master Hustle Engine — White Label SaaS & Marketing Automation Live Outbound Dispatcher

Features:
- Reads target pool from specified JSON file (supports --targets data/saas_targets_batch_2.json)
- Formats personalized 3-line B2B SaaS pitch
- Uses .env SMTP credentials (smtp.gmail.com:587 TLS)
- Enforces 45-60 second random jitter throttling between sends
- Records audit records to saas_outreach_log.jsonl
- Real-time status update to target file
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

# UTF-8 stdout encoding for Windows
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
DEFAULT_TARGETS_PATH = os.path.join(DATA_DIR, 'saas_targets.json')
LOG_JSONL_PATH = os.path.join(BASE_DIR, 'saas_outreach_log.jsonl')
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
SENDER_NAME = os.environ.get('SENDER_NAME', 'Jack')

def build_pitch(first_name):
    name = first_name.strip() if first_name else 'there'
    
    subject = "Quick question regarding your software infrastructure / client retention"
    
    plain_body = f"""Hi {name},

I noticed your current client workflow doesn't appear to have automated follow-up or custom client portal software in place.

We deploy turnkey, custom-branded SaaS and marketing automation engines that plug directly into existing operations to capture lost revenue and automate client retention.

Are you open to a 5-minute walkthrough of the software this week?

Best,
Jack"""

    html_body = f"""<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; color: #222; line-height: 1.6;">
    <p>Hi {name},</p>
    <p>I noticed your current client workflow doesn't appear to have automated follow-up or custom client portal software in place.</p>
    <p>We deploy turnkey, custom-branded SaaS and marketing automation engines that plug directly into existing operations to capture lost revenue and automate client retention.</p>
    <p>Are you open to a 5-minute walkthrough of the software this week?</p>
    <p>Best,<br><strong>Jack</strong></p>
</div>"""

    return subject, plain_body, html_body

def load_targets(filepath):
    if not os.path.exists(filepath):
        print(f"❌ Targets file not found at {filepath}")
        return []
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"❌ Error loading JSON targets: {e}")
        return []

def save_targets(filepath, targets):
    try:
        with open(filepath, 'w', encoding='utf-8') as f:
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
    parser = argparse.ArgumentParser(description="Live SaaS & Marketing Automation Campaign Dispatcher")
    parser.add_argument('--targets', type=str, default=DEFAULT_TARGETS_PATH, help="Path to targets JSON file")
    parser.add_argument('--live', action='store_true', help="Execute live SMTP delivery (default)")
    parser.add_argument('--dry-run', action='store_true', help="Simulate without sending")
    parser.add_argument('--throttle-min', type=int, default=45, help="Minimum throttle seconds (default: 45)")
    parser.add_argument('--throttle-max', type=int, default=60, help="Maximum throttle seconds (default: 60)")
    parser.add_argument('--limit', type=int, default=0, help="Limit number of emails to dispatch")
    parser.add_argument('--force', action='store_true', help="Resend to previously contacted leads")
    args = parser.parse_args()

    targets_path = args.targets
    if not os.path.isabs(targets_path):
        targets_path = os.path.join(BASE_DIR, targets_path)

    is_live = not args.dry_run

    print("===================================================================")
    print("⚡ MASTER HUSTLE ENGINE — WHITE LABEL SAAS OUTBOUND DISPATCHER")
    print(f"• Campaign Mode:   {'🚀 LIVE SMTP DISPATCH' if is_live else '🧪 DRY RUN (Simulation)'}")
    print(f"• Jitter Throttle: {args.throttle_min}s - {args.throttle_max}s delay between sends")
    print(f"• Authenticated:   {SMTP_USER} via {SMTP_HOST}:{SMTP_PORT}")
    print(f"• Target File:     {targets_path}")
    print(f"• Audit Log:       {LOG_JSONL_PATH}")
    print("===================================================================\n")

    if is_live and not SMTP_PASS:
        print("❌ Error: SMTP_PASS is missing in .env. Please configure your App Password.")
        sys.exit(1)

    targets = load_targets(targets_path)
    if not targets:
        print(f"No targets found in {targets_path}.")
        sys.exit(0)

    pending_targets = [
        t for t in targets
        if args.force or t.get('outreach_status', '').upper() != 'SENT'
    ]

    if args.limit > 0:
        pending_targets = pending_targets[:args.limit]

    total_count = len(pending_targets)
    print(f"Discovered {len(targets)} total records -> {total_count} leads ready for live dispatch.\n")

    if total_count == 0:
        print("All targets have already been contacted. Use --force to resend.")
        sys.exit(0)

    successful_dispatches = []
    failed_dispatches = []

    for idx, lead in enumerate(pending_targets, 1):
        company = lead.get('company_name', 'Target Company')
        name = lead.get('first_name', 'there')
        email = lead.get('email', '')

        print(f"[{idx}/{total_count}] Processing: {company}")
        print(f"    Recipient: {name} <{email}>")

        subject, plain_body, html_body = build_pitch(name)
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "lead_id": lead.get('id', 'unknown'),
            "company_name": company,
            "recipient_name": name,
            "recipient_email": email,
            "subject": subject,
            "campaign": "WHITE_LABEL_SAAS_AUTOMATION",
            "mode": "LIVE" if is_live else "DRY_RUN"
        }

        if not is_live:
            lead['outreach_status'] = 'DRY_RUN_VERIFIED'
            lead['last_contacted_at'] = datetime.now().isoformat()
            log_entry['status'] = 'DRY_RUN_SUCCESS'
            successful_dispatches.append(lead)
            print("    [DRY RUN] Pitch injected successfully.")
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
        save_targets(targets_path, targets)

        # Random jitter throttling
        if idx < total_count:
            delay = random.randint(args.throttle_min, args.throttle_max)
            print(f"    ⏳ Jitter Throttle: sleeping for {delay} seconds before next send...\n")
            time.sleep(delay)

    print("\n===================================================================")
    print("🎉 SAAS CAMPAIGN DISPATCH SUMMARY")
    print("===================================================================")
    print(f"• Total Processed:    {total_count}")
    print(f"• Successful Sends:   {len(successful_dispatches)}")
    print(f"• Failed Sends:       {len(failed_dispatches)}")
    print(f"• Updated Database:   {targets_path}")
    print(f"• Audit Trail:        {LOG_JSONL_PATH}")
    print("===================================================================\n")

if __name__ == '__main__':
    main()
