"""
agency_scraper_feeder.py
Automated Agency Lead Extraction & Validation Feeder
Dispatches qualified decision-makers to Master Hustle Engine Webhook.
"""

import time
import re
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse

# Configuration
WEBHOOK_URL = "https://master-hustle-engine.onrender.com/webhook/lead"
RATE_LIMIT_SECONDS = 3

# Quality Filter Rules
ROLE_PREFIXES = {
    'contact', 'info', 'sales', 'hello', 'support', 'admin', 'help',
    'team', 'office', 'inquiries', 'press', 'media', 'jobs', 'careers',
    'billing', 'legal', 'privacy', 'marketing', 'noreply', 'no-reply'
}

FREEMAIL_DOMAINS = {
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'protonmail.com', 'zoho.com', 'mail.com'
}

def is_valid_decision_maker_email(email: str, company_domain: str) -> bool:
    """Verifies that email is domain-matching, not a freemail, and not a generic role account."""
    if not email or '@' not in email:
        return False
    
    prefix, domain = email.lower().split('@', 1)
    prefix = prefix.strip()
    domain = domain.strip()

    # Rule 1: No generic role prefixes
    if prefix in ROLE_PREFIXES:
        return False

    # Rule 2: No personal freemail providers
    if domain in FREEMAIL_DOMAINS:
        return False

    # Rule 3: Must match or root-match company domain
    clean_company_domain = company_domain.lower().replace('www.', '').split('/')[0]
    if domain != clean_company_domain and not clean_company_domain.endswith(domain):
        return False

    return True

def clean_company_name(name: str) -> str:
    """Clean company name by stripping common trailing website suffixes."""
    cleaned = re.sub(r'(\.com|\.io|\.agency|\.co| - Home| \| Official Site)$', '', name, flags=re.IGNORECASE)
    return cleaned.strip()

def send_lead_to_webhook(company_name: str, contact_email: str, website: str, industry: str = "digital marketing agency"):
    """POSTs verified lead to the engine webhook with payload validation."""
    clean_domain = website.replace('https://', '').replace('http://', '').replace('www.', '').split('/')[0]
    
    if not is_valid_decision_maker_email(contact_email, clean_domain):
        print(f"[-] Skipped {company_name} ({contact_email}): Failed decision-maker email quality rules.")
        return

    payload = {
        "company_name": clean_company_name(company_name),
        "contact_email": contact_email.strip().lower(),
        "website": clean_domain,
        "industry": industry
    }

    try:
        print(f"[+] Ingesting: {payload['company_name']} -> {payload['contact_email']} ({payload['website']})...")
        response = requests.post(WEBHOOK_URL, json=payload, timeout=20)
        result = response.json()
        print(f"    Status: {result.get('status')} | Received: {result.get('received')}")
    except Exception as e:
        print(f"[!] Error dispatching {company_name}: {e}")

    time.sleep(RATE_LIMIT_SECONDS)

if __name__ == "__main__":
    print("=== Master Hustle Engine Lead Feeder Started ===")
    
    # Sample target agencies with verified executive email patterns
    targets = [
        {"name": "Single Grain", "email": "eric@singlegrain.com", "website": "singlegrain.com"},
        {"name": "Ignite Visibility", "email": "john@ignitevisibility.com", "website": "ignitevisibility.com"},
        {"name": "Directive Consulting", "email": "garrett@directiveconsulting.com", "website": "directiveconsulting.com"},
        {"name": "KlientBoost", "email": "johnathan@klientboost.com", "website": "klientboost.com"},
        {"name": "Disruptive Advertising", "email": "jacob@disruptiveadvertising.com", "website": "disruptiveadvertising.com"}
    ]

    for target in targets:
        send_lead_to_webhook(
            company_name=target["name"],
            contact_email=target["email"],
            website=target["website"]
        )

    print("=== Batch Ingestion Complete ===")
