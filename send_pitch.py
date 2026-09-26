#!/usr/bin/env python3
"""
send_pitch.py
Master Hustle Engine — Python SMTP Pitch Dispatcher for Self-Cleaning Shovel Buyout

Features:
- Reads target recipients from targets.csv
- Loads SMTP credentials from .env
- Formats a 3-line patent buyout pitch linking to https://selfcleaningshovel.tiiny.site
- Implements 45-second throttling between dispatches to maintain deliverability
- Supports --dry-run for validation and simulation
- Updates status in targets.csv in real time
"""

import os
import sys
import csv
import time
import smtplib
import argparse
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

# Ensure UTF-8 output on Windows consoles
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TARGETS_CSV_PATH = os.path.join(BASE_DIR, 'targets.csv')
ENV_PATH = os.path.join(BASE_DIR, '.env')

def load_env(env_path):
    """Load key-value pairs from .env file into os.environ if not already set."""
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
    """Generates the 3-line buyout pitch for the patent-pending self-cleaning shovel."""
    name = first_name.strip() if first_name else 'Team'
    company = company_name.strip() if company_name else 'your company'
    
    subject = f"Patent Buyout / Licensing Inquiry: Self-Cleaning Shovel for {company}"
    
    line1 = f"Hi {name}, I'm the inventor of a patent-pending self-cleaning, self-standing shovel engineered to completely eliminate soil and mud adhesion on commercial jobsites."
    line2 = f"We are currently reviewing direct patent buyout and exclusive manufacturing licensing opportunities with established tool brands like {company}."
    line3 = f"You can review the full utility specifications, video demonstration, and buyout deck here: {LANDING_URL}"
    
    signoff = f"\n\nBest regards,\n{SENDER_NAME}\nInventor & Patent Holder\nDirect: {SENDER_PHONE}\nEmail: {SMTP_USER}"
    
    plain_text = f"{line1}\n\n{line2}\n\n{line3}{signoff}"
    
    html_content = f"""
    <div style="font-family: Arial, sans-serif; font-size: 15px; color: #222; line-height: 1.6;">
        <p>{line1}</p>
        <p>{line2}</p>
        <p><strong>Review the prototype demo and buyout deck:</strong><br>
           <a href="{LANDING_URL}" style="color: #0066cc; font-weight: bold; text-decoration: underline;">{LANDING_URL}</a>
        </p>
        <br>
        <p style="color: #555; font-size: 14px;">
            Best regards,<br>
            <strong>{SENDER_NAME}</strong><br>
            Inventor &amp; Patent Holder<br>
            Direct: {SENDER_PHONE}<br>
            Email: {SMTP_USER}
        </p>
    </div>
    """
    
    return subject, plain_text, html_content

def read_targets(csv_path):
    targets = []
    if not os.path.exists(csv_path):
        print(f"[!] Error: {csv_path} not found.")
        return targets
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            targets.append(row)
    return targets

def write_targets(csv_path, targets):
    if not targets:
        return
    fieldnames = list(targets[0].keys())
    with open(csv_path, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in targets:
            writer.writerow(row)

def send_email_smtp(recipient_email, subject, plain_text, html_content):
    """Sends email via standard SMTP with TLS."""
    msg = MIMEMultipart('alternative')
    msg['From'] = f'"{SENDER_NAME}" <{SMTP_USER}>'
    msg['To'] = recipient_email
    msg['Subject'] = subject
    
    part1 = MIMEText(plain_text, 'plain', 'utf-8')
    part2 = MIMEText(html_content, 'html', 'utf-8')
    
    msg.attach(part1)
    msg.attach(part2)
    
    if SMTP_PORT == 465:
        server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20)
    else:
        server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20)
        server.starttls()
        
    server.login(SMTP_USER, SMTP_PASS)
    server.sendmail(SMTP_USER, recipient_email, msg.as_string())
    server.quit()

def main():
    parser = argparse.ArgumentParser(description="Master Hustle Engine — Shovel Patent Buyout SMTP Dispatcher")
    parser.add_argument('--dry-run', action='store_true', help="Simulate email dispatch and print pitch preview without sending")
    parser.add_argument('--throttle', type=int, default=45, help="Throttle delay in seconds between dispatches (default: 45s)")
    parser.add_argument('--limit', type=int, default=0, help="Limit number of emails to send (0 = all pending)")
    parser.add_argument('--force', action='store_true', help="Re-send to targets even if already marked as SENT")
    args = parser.parse_args()

    print("===================================================================")
    print("MASTER HUSTLE ENGINE - SHOVEL PATENT BUYOUT SMTP DISPATCHER")
    print(f"Mode: {'DRY RUN (SIMULATION)' if args.dry_run else 'LIVE DISPATCH'}")
    print(f"Throttle Delay: {args.throttle} seconds")
    print(f"SMTP Server: {SMTP_HOST}:{SMTP_PORT} | User: {SMTP_USER}")
    print(f"Asset URL: {LANDING_URL}")
    print("===================================================================\n")

    if not args.dry_run and not SMTP_PASS:
        print("[!] Error: SMTP_PASS is missing in .env. Please set your Gmail App Password.")
        sys.exit(1)

    targets = read_targets(TARGETS_CSV_PATH)
    if not targets:
        print(f"No targets found in {TARGETS_CSV_PATH}")
        sys.exit(0)

    pending_targets = [
        t for t in targets 
        if args.force or t.get('status', '').upper() != 'SENT'
    ]

    if args.limit > 0:
        pending_targets = pending_targets[:args.limit]

    print(f"Found {len(targets)} total targets ({len(pending_targets)} queued for dispatch).\n")

    dispatched_count = 0
    for idx, target in enumerate(pending_targets, 1):
        domain = target.get('domain', '')
        company = target.get('company_name', domain)
        first_name = target.get('first_name', '')
        email = target.get('email', '')

        if not email or '@' not in email:
            print(f"[{idx}/{len(pending_targets)}] Skipping {company} ({domain}) - invalid email: '{email}'")
            target['status'] = 'INVALID_EMAIL'
            continue

        subject, plain_text, html_content = build_pitch(first_name, company)

        print(f"[{idx}/{len(pending_targets)}] Target: {company} ({domain}) -> {first_name} <{email}>")
        print(f"    Subject: {subject}")

        if args.dry_run:
            print("    [DRY RUN] Pitch Preview:\n" + "-"*40)
            print(plain_text)
            print("-" * 40)
            target['status'] = 'DRY_RUN_VERIFIED'
            target['last_contacted'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            dispatched_count += 1
        else:
            try:
                print(f"    Dispatching live SMTP email via {SMTP_HOST}...")
                send_email_smtp(email, subject, plain_text, html_content)
                target['status'] = 'SENT'
                target['last_contacted'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                dispatched_count += 1
                print(f"    [+] Successfully sent to {email}")
            except Exception as e:
                print(f"    [-] Failed to send to {email}: {str(e)}")
                target['status'] = f"ERROR: {str(e)[:30]}"

        # Write progress back to targets.csv
        write_targets(TARGETS_CSV_PATH, targets)

        # Throttling between emails
        if idx < len(pending_targets) and args.throttle > 0:
            print(f"    [*] Throttling: sleeping for {args.throttle} seconds before next dispatch...\n")
            time.sleep(args.throttle)

    print("\n===================================================================")
    print(f"Pipeline Run Complete: {dispatched_count} / {len(pending_targets)} processed.")
    print(f"Updated CSV saved to: {TARGETS_CSV_PATH}")
    print("===================================================================")

if __name__ == '__main__':
    main()
