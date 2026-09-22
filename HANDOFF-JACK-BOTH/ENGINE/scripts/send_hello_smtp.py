#!/usr/bin/env python3
"""Send as hello@master-hustle-engine.com via Hostinger SMTP.
Requires env HOSTINGER_HELLO_MAIL_PASSWORD
"""
import argparse, os, smtplib, ssl, sys
from email.message import EmailMessage
from pathlib import Path

FROM = "hello@master-hustle-engine.com"
HOST, PORT = "smtp.hostinger.com", 465

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--to", required=True, action="append")
    p.add_argument("--subject", required=True)
    p.add_argument("--body-file", required=True)
    args = p.parse_args()
    pw = os.environ.get("HOSTINGER_HELLO_MAIL_PASSWORD", "").strip()
    if not pw:
        sys.exit("Set HOSTINGER_HELLO_MAIL_PASSWORD (Hostinger password for hello@).")
    body = Path(args.body_file).read_text()
    msg = EmailMessage()
    msg["From"] = FROM
    msg["To"] = ", ".join(args.to)
    msg["Subject"] = args.subject
    msg.set_content(body)
    with smtplib.SMTP_SSL(HOST, PORT, timeout=60, context=ssl.create_default_context()) as s:
        s.login(FROM, pw)
        s.send_message(msg)
    print("sent", FROM, "->", ",".join(args.to))

if __name__ == "__main__":
    main()