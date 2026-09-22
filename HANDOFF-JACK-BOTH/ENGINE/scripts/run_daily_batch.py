#!/usr/bin/env python3
"""Pace-send Master Hustle Engine cold batch from hello@."""
from __future__ import annotations
import json, os, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BATCH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "batches" / "2026-09-21-monday-25.json"
SENDER = HERE / "send_hello_smtp.py"
PITCHED = ROOT / "batches" / "already-pitched-emails.txt"
RESULTS = ROOT / "logs" / f"results-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
GAP = 50
LANDING = "https://www.master-hustle-engine.com/"
DEMO = "https://master-hustle-engine.onrender.com/demo"

TMPL = """Hi {agency} — {note}

Most AI shops are still selling chatbots. Agencies that win next are selling a digital workforce under their own brand.

I license a private-label 9-skill AI SDR/outreach layer: multi-LLM failover when providers flake, plus outbound reply guardrails so client domains stay clean.

Overview + live console:
{landing}
{demo}

Open to a quick look? Reply and I'll send two times that work.

Jack Bockholdt
Master Hustle Engine
"""

def main():
    if not os.environ.get("HOSTINGER_HELLO_MAIL_PASSWORD"):
        sys.exit("Export HOSTINGER_HELLO_MAIL_PASSWORD first.")
    data = json.loads(BATCH.read_text())
    leads = data["leads"] if isinstance(data, dict) else data
    pitched = set()
    if PITCHED.exists():
        pitched = {l.strip().lower() for l in PITCHED.read_text().splitlines() if l.strip()}
    out = {"batch": str(BATCH), "sent": [], "skipped": [], "failed": []}
    RESULTS.parent.mkdir(parents=True, exist_ok=True)
    for i, lead in enumerate(leads):
        email = lead["email"].strip().lower()
        agency = lead.get("agency") or lead.get("company") or email
        if email in pitched:
            out["skipped"].append({"email": email, "reason": "already_pitched"})
            print("skip", email)
            continue
        note = lead.get("note") or "saw your agency work and thought this fit."
        body = TMPL.format(agency=agency, note=note, landing=LANDING, demo=DEMO)
        if "$" in body or "stripe" in body.lower():
            out["failed"].append({"email": email, "reason": "forbidden_content"})
            continue
        body_path = ROOT / "logs" / f"_body_{i}.txt"
        body_path.write_text(body)
        subject = f"{agency} — private-label AI workforce (quick look?)"
        r = subprocess.run(
            [sys.executable, str(SENDER), "--to", email, "--subject", subject, "--body-file", str(body_path)],
            capture_output=True, text=True,
        )
        row = {
            "email": email, "agency": agency,
            "ts": datetime.now(timezone.utc).isoformat(),
            "code": r.returncode, "stdout": r.stdout.strip(), "stderr": r.stderr.strip(),
        }
        if r.returncode == 0:
            out["sent"].append(row)
            pitched.add(email)
            print("sent", email)
        else:
            out["failed"].append(row)
            print("FAIL", email, r.stderr or r.stdout)
        RESULTS.write_text(json.dumps(out, indent=2))
        PITCHED.write_text("\n".join(sorted(pitched)) + "\n")
        if i < len(leads) - 1:
            time.sleep(GAP)
    print("done sent", len(out["sent"]), "skipped", len(out["skipped"]), "failed", len(out["failed"]))
    print("results", RESULTS)

if __name__ == "__main__":
    main()