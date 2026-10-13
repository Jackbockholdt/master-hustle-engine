#!/usr/bin/env python3
"""
reply_alert.py
Master Hustle Engine — new-reply alert for Jack.

Runs alongside the reply-check (same schedule, right after it). Reads the
inbox over IMAP, picks out new replies addressed to a watched mailbox
(hello@ and Talha's campaign sender) and sends Jack a one-line summary:

    Reply via hello@: Jane Doe <jane@acme.com>: "Yes, let's talk Thursday."

Delivery is SMS (Twilio) and/or email, whichever is configured. It only ever
alerts Jack: it never replies to or emails a prospect, and it does not touch
send_batch.py, talha_batch.py or the reply-check script.

Credentials come from environment variables only (see .env.example). This
script never reads .secret.

Usage:
    python reply_alert.py              # check once, alert on new replies
    python reply_alert.py --dry-run    # print alerts, send nothing, save nothing
    python reply_alert.py --backfill   # first run: alert on recent replies too

First run without --backfill records the replies already in the inbox as seen
and alerts on nothing, so Jack is not flooded with old threads.
"""

import os
import re
import sys
import json
import base64
import imaplib
import smtplib
import argparse
import html
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email import message_from_bytes, policy
from email.message import EmailMessage
from email.utils import getaddresses, parseaddr

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.environ.get('REPLY_ALERT_STATE_PATH') or os.path.join(BASE_DIR, 'reply_alert_state.json')
MAX_SEEN = 5000
SMS_MAX = 300


def env(name, default=''):
    return os.environ.get(name, default).strip()


def env_list(name):
    return [v.strip().lower() for v in env(name).split(',') if v.strip()]


def load_config():
    """Build config from environment. Talha's campaign is identified by its
    sender address(es) and, optionally, a subject tag."""
    watch = {}
    for addr in env_list('REPLY_ALERT_HELLO_ADDRESSES'):
        watch[addr] = 'hello@'
    for addr in env_list('REPLY_ALERT_TALHA_ADDRESSES'):
        watch[addr] = 'Talha campaign'
    return {
        'imap_server': env('REPLY_ALERT_IMAP_SERVER') or env('IMAP_SERVER', 'imap.gmail.com'),
        'imap_port': int(env('REPLY_ALERT_IMAP_PORT') or env('IMAP_PORT', '993')),
        'imap_user': env('REPLY_ALERT_IMAP_USER') or env('IMAP_USER'),
        'imap_pass': env('REPLY_ALERT_IMAP_PASS') or env('IMAP_PASS'),
        'imap_folder': env('REPLY_ALERT_IMAP_FOLDER', 'INBOX'),
        'lookback_days': int(env('REPLY_ALERT_LOOKBACK_DAYS', '3')),
        'watch': watch,
        'talha_subject_tags': env_list('REPLY_ALERT_TALHA_SUBJECT_TAGS'),
        'email_to': env('REPLY_ALERT_EMAIL_TO'),
        'smtp_host': env('SMTP_HOST', 'smtp.gmail.com'),
        'smtp_port': int(env('SMTP_PORT', '465')),
        'smtp_user': env('SMTP_USER'),
        'smtp_pass': env('SMTP_PASS'),
        'sms_to': env('REPLY_ALERT_SMS_TO'),
        'twilio_sid': env('TWILIO_ACCOUNT_SID'),
        'twilio_token': env('TWILIO_AUTH_TOKEN'),
        'twilio_from': env('TWILIO_FROM_NUMBER'),
    }


# ---------------------------------------------------------------------------
# Message parsing
# ---------------------------------------------------------------------------

AUTO_SUBJECT = re.compile(
    r'^(automatic reply|auto[- ]?reply|out of (the )?office|undeliverable|'
    r'delivery status notification|mail delivery (failed|subsystem)|returned mail)',
    re.I)


def is_auto_reply(msg):
    auto = (msg.get('Auto-Submitted') or '').lower()
    if auto and auto != 'no':
        return True
    if msg.get('X-Autoreply') or msg.get('X-Autorespond'):
        return True
    if (msg.get('Precedence') or '').lower() in ('auto_reply', 'bulk', 'junk'):
        return True
    sender = parseaddr(msg.get('From', ''))[1].lower()
    if sender.startswith(('mailer-daemon@', 'postmaster@', 'no-reply@', 'noreply@')):
        return True
    return bool(AUTO_SUBJECT.match((msg.get('Subject') or '').strip()))


def is_reply(msg):
    subject = (msg.get('Subject') or '').strip()
    return bool(msg.get('In-Reply-To') or msg.get('References')
                or re.match(r'^(re|aw|sv)\s*:', subject, re.I))


def recipients(msg):
    fields = []
    for header in ('To', 'Cc', 'Delivered-To', 'X-Original-To', 'X-Forwarded-To'):
        fields.extend(msg.get_all(header, []))
    return {addr.lower() for _, addr in getaddresses(fields) if addr}


def classify(msg, cfg):
    """Return the campaign label ('hello@' / 'Talha campaign') or None."""
    if not is_reply(msg) or is_auto_reply(msg):
        return None
    sender = parseaddr(msg.get('From', ''))[1].lower()
    if sender in cfg['watch']:
        return None  # our own outbound / follow-up, not a reply
    for addr in recipients(msg):
        if addr in cfg['watch']:
            return cfg['watch'][addr]
    subject = (msg.get('Subject') or '').lower()
    if any(tag in subject for tag in cfg['talha_subject_tags']):
        return 'Talha campaign'
    return None


def body_text(msg):
    part = msg.get_body(preferencelist=('plain', 'html'))
    if part is None:
        return ''
    try:
        text = part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b''
        text = payload.decode(part.get_content_charset() or 'utf-8', errors='replace')
    if part.get_content_type() == 'text/html':
        text = re.sub(r'(?is)<(script|style).*?</\1>', ' ', text)
        text = re.sub(r'(?i)<br\s*/?>|</p>|</div>', '\n', text)
        text = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    return text


QUOTE_START = re.compile(
    r'^(on .{0,200}wrote:?|-{2,}\s*original message\s*-{2,}|_{5,}|from:\s.+|sent from my .+)$',
    re.I)


def first_sentence(text, limit=160):
    """First sentence of the new text in a reply (quoted history removed)."""
    lines = []
    for line in text.replace('\r', '').split('\n'):
        stripped = line.strip()
        if stripped.startswith('>') or QUOTE_START.match(stripped) or stripped in ('--', '-- '):
            break
        lines.append(stripped)
    new_text = re.sub(r'\s+', ' ', ' '.join(lines)).strip()
    if not new_text:
        return '(no text)'
    match = re.search(r'^(.+?[.!?])(\s|$)', new_text)
    sentence = match.group(1) if match else new_text
    if len(sentence) > limit:
        sentence = sentence[:limit - 1].rstrip() + '…'
    return sentence


def summarize(msg, label):
    name, addr = parseaddr(msg.get('From', ''))
    who = f'{name} <{addr}>' if name and name != addr else addr
    line = f'Reply via {label}: {who}: "{first_sentence(body_text(msg))}"'
    return re.sub(r'\s+', ' ', line)


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

def load_state():
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            state = json.load(f)
        return {'initialized': bool(state.get('initialized')), 'seen': list(state.get('seen', []))}
    except (FileNotFoundError, ValueError):
        return {'initialized': False, 'seen': []}


def save_state(state):
    state['seen'] = state['seen'][-MAX_SEEN:]
    tmp = STATE_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_PATH)


def message_key(msg, uid):
    return (msg.get('Message-ID') or '').strip() or f'uid:{uid}'


# ---------------------------------------------------------------------------
# Delivery (Jack only)
# ---------------------------------------------------------------------------

def send_email(cfg, line):
    em = EmailMessage()
    em['From'] = cfg['smtp_user']
    em['To'] = cfg['email_to']
    em['Subject'] = line[:120]
    em.set_content(line + '\n')
    with smtplib.SMTP_SSL(cfg['smtp_host'], cfg['smtp_port'], timeout=30) as s:
        s.login(cfg['smtp_user'], cfg['smtp_pass'])
        s.send_message(em)


def send_sms(cfg, line):
    url = f"https://api.twilio.com/2010-04-01/Accounts/{cfg['twilio_sid']}/Messages.json"
    data = urllib.parse.urlencode({
        'To': cfg['sms_to'], 'From': cfg['twilio_from'], 'Body': line[:SMS_MAX],
    }).encode()
    auth = base64.b64encode(f"{cfg['twilio_sid']}:{cfg['twilio_token']}".encode()).decode()
    req = urllib.request.Request(url, data=data, headers={'Authorization': f'Basic {auth}'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        if resp.status >= 300:
            raise RuntimeError(f'Twilio HTTP {resp.status}')


def channels(cfg):
    out = []
    if cfg['sms_to'] and cfg['twilio_sid'] and cfg['twilio_token'] and cfg['twilio_from']:
        out.append(('sms', send_sms))
    if cfg['email_to'] and cfg['smtp_user'] and cfg['smtp_pass']:
        out.append(('email', send_email))
    return out


def deliver(cfg, line):
    """True if at least one channel accepted the alert."""
    ok = False
    for name, fn in channels(cfg):
        try:
            fn(cfg, line)
            ok = True
        except Exception as e:
            print(f'[reply_alert] {name} delivery failed: {type(e).__name__}', file=sys.stderr)
    return ok


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def fetch_recent(cfg):
    since = (datetime.now(timezone.utc) - timedelta(days=cfg['lookback_days'])).strftime('%d-%b-%Y')
    conn = imaplib.IMAP4_SSL(cfg['imap_server'], cfg['imap_port'])
    try:
        conn.login(cfg['imap_user'], cfg['imap_pass'])
        conn.select(cfg['imap_folder'], readonly=True)  # never marks mail as read
        typ, data = conn.uid('search', None, f'(SINCE {since})')
        if typ != 'OK':
            raise RuntimeError('IMAP search failed')
        for uid in (data[0] or b'').split():
            typ, parts = conn.uid('fetch', uid, '(BODY.PEEK[])')
            if typ == 'OK' and parts and isinstance(parts[0], tuple):
                yield uid.decode(), message_from_bytes(parts[0][1], policy=policy.default)
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def run(cfg, messages, state, dry_run=False, backfill=False):
    """Process (uid, msg) pairs. Returns the alert lines produced."""
    seen = set(state['seen'])
    baseline = not state['initialized'] and not backfill and not dry_run
    alerts = []
    for uid, msg in messages:
        key = message_key(msg, uid)
        if key in seen:
            continue
        label = classify(msg, cfg)
        if label is None:
            continue
        if baseline:
            seen.add(key)
            state['seen'].append(key)
            continue
        line = summarize(msg, label)
        if dry_run:
            print(line)
            alerts.append(line)
            continue
        if deliver(cfg, line):
            seen.add(key)
            state['seen'].append(key)
            alerts.append(line)
        # On delivery failure the reply stays unseen and is retried next run.
    if not dry_run:
        state['initialized'] = True
    return alerts


def main(argv=None):
    ap = argparse.ArgumentParser(description='Alert Jack on new replies to hello@ / Talha campaign.')
    ap.add_argument('--dry-run', action='store_true', help='print alerts; send and save nothing')
    ap.add_argument('--backfill', action='store_true', help='on first run, alert on recent replies too')
    args = ap.parse_args(argv)

    cfg = load_config()
    missing = [k for k in ('imap_user', 'imap_pass') if not cfg[k]]
    if not cfg['watch']:
        missing.append('REPLY_ALERT_HELLO_ADDRESSES / REPLY_ALERT_TALHA_ADDRESSES')
    if not args.dry_run and not channels(cfg):
        missing.append('a delivery channel (REPLY_ALERT_SMS_TO + TWILIO_* or REPLY_ALERT_EMAIL_TO + SMTP_*)')
    if missing:
        print('[reply_alert] not configured, missing: ' + ', '.join(missing), file=sys.stderr)
        return 2

    state = load_state()
    alerts = run(cfg, fetch_recent(cfg), state, dry_run=args.dry_run, backfill=args.backfill)
    if not args.dry_run:
        save_state(state)
    print(f'[reply_alert] {len(alerts)} new repl{"y" if len(alerts) == 1 else "ies"} alerted')
    return 0


if __name__ == '__main__':
    sys.exit(main())
