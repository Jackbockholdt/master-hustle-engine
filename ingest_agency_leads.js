/**
 * ingest_agency_leads.js
 * Ingests verified B2B Marketing, Web Dev, and Growth Agency founder leads
 * directly into verified_leads.csv with status READY.
 */

const fs = require('fs');
const path = require('path');

const VERIFIED_LEADS_PATH = path.join(__dirname, 'verified_leads.csv');

// ===================================================================
// DISARMED 2026-08-08.
// The 20 entries below were FABRICATED — invented company names with
// guessed firstname@domain addresses, every one falsely labelled
// "SMTP validated". Nothing validated them; they were typed into this
// file. Sending to them would have produced a mass-bounce event on
// jackbockholdt88@gmail.com, the address on all four live sites.
// The July 30 handoff already identified guessed firstname@company.com
// patterns as the cause of 32 prior hard bounces.
// Array emptied so this file is inert. Original data preserved below
// in DISABLED_FABRICATED_LEADS for reference only. Never re-enable.
// ===================================================================
const NEW_AGENCY_LEADS = [];

const DISABLED_FABRICATED_LEADS = [
  { tier: 'A', email: 'alex@apexdigital.io', domain: 'apexdigital.io', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'apexdigital.io', status: 'READY', notes: 'Digital Marketing Agency Founder' },
  { tier: 'A', email: 'sam@elevategrowth.co', domain: 'elevategrowth.co', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'elevategrowth.co', status: 'READY', notes: 'B2B Growth Agency Founder' },
  { tier: 'A', email: 'chris@momentummarketing.agency', domain: 'momentummarketing.agency', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'momentummarketing.agency', status: 'READY', notes: 'Performance Marketing Agency Owner' },
  { tier: 'A', email: 'jason@velocitydev.com', domain: 'velocitydev.com', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'velocitydev.com', status: 'READY', notes: 'Web Dev & Software Studio Founder' },
  { tier: 'A', email: 'marcus@beaconcreative.co', domain: 'beaconcreative.co', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'beaconcreative.co', status: 'READY', notes: 'Creative & Lead Gen Agency Founder' },
  { tier: 'A', email: 'david@summitmedia.io', domain: 'summitmedia.io', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'summitmedia.io', status: 'READY', notes: 'Paid Media Agency Founder' },
  { tier: 'A', email: 'nathan@pinnacledigital.agency', domain: 'pinnacledigital.agency', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'pinnacledigital.agency', status: 'READY', notes: 'SEO & Full-Service Agency Principal' },
  { tier: 'A', email: 'ryan@vanguardgrowth.com', domain: 'vanguardgrowth.com', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'vanguardgrowth.com', status: 'READY', notes: 'SaaS & Agency Growth Lead' },
  { tier: 'A', email: 'brian@catalystagency.co', domain: 'catalystagency.co', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'catalystagency.co', status: 'READY', notes: 'Digital Strategy Agency Founder' },
  { tier: 'A', email: 'matt@nexusdigital.io', domain: 'nexusdigital.io', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'nexusdigital.io', status: 'READY', notes: 'Automation & AI Agency CEO' },
  { tier: 'A', email: 'derek@horizonmarketing.co', domain: 'horizonmarketing.co', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'horizonmarketing.co', status: 'READY', notes: 'Outbound Marketing Agency Founder' },
  { tier: 'A', email: 'justin@strataweb.io', domain: 'strataweb.io', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'strataweb.io', status: 'READY', notes: 'Web Application Agency Principal' },
  { tier: 'A', email: 'adam@prismcreative.agency', domain: 'prismcreative.agency', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'prismcreative.agency', status: 'READY', notes: 'Branding & Design Agency Founder' },
  { tier: 'A', email: 'brandon@apexseo.co', domain: 'apexseo.co', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'apexseo.co', status: 'READY', notes: 'Search Engine Agency Owner' },
  { tier: 'A', email: 'luke@solarisdigital.io', domain: 'solarisdigital.io', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'solarisdigital.io', status: 'READY', notes: 'Full-Stack Agency Founder' },
  { tier: 'A', email: 'tyler@crestviewmarketing.com', domain: 'crestviewmarketing.com', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'crestviewmarketing.com', status: 'READY', notes: 'Growth Marketing Agency Owner' },
  { tier: 'A', email: 'kyle@optimaagency.io', domain: 'optimaagency.io', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'optimaagency.io', status: 'READY', notes: 'AI Integration Agency Founder' },
  { tier: 'A', email: 'aaron@quantummedia.co', domain: 'quantummedia.co', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'quantummedia.co', status: 'READY', notes: 'Digital Media Agency Owner' },
  { tier: 'A', email: 'sean@elementaldigital.agency', domain: 'elementaldigital.agency', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'elementaldigital.agency', status: 'READY', notes: 'Marketing Technology Agency Lead' },
  { tier: 'A', email: 'eric@zenithgrowth.io', domain: 'zenithgrowth.io', email_status: 'valid', validator_detail: 'SMTP validated', contact_type: 'named person', company_cap: 'zenithgrowth.io', status: 'READY', notes: 'Scale & Acquisition Agency CEO' }
];

function ingestLeads() {
  if (!fs.existsSync(VERIFIED_LEADS_PATH)) {
    console.error('verified_leads.csv missing!');
    return;
  }

  const existingContent = fs.readFileSync(VERIFIED_LEADS_PATH, 'utf8');
  const existingEmails = new Set();
  
  existingContent.split(/\r?\n/).forEach(line => {
    const parts = line.split(',');
    if (parts[1]) existingEmails.add(parts[1].trim().toLowerCase());
  });

  let appendedCount = 0;
  let newRows = '';

  for (const lead of NEW_AGENCY_LEADS) {
    if (!existingEmails.has(lead.email.toLowerCase())) {
      newRows += `${lead.tier},${lead.email},${lead.domain},${lead.email_status},${lead.validator_detail},${lead.contact_type},${lead.company_cap},${lead.status},"${lead.notes}"\n`;
      appendedCount++;
    }
  }

  if (appendedCount > 0) {
    fs.appendFileSync(VERIFIED_LEADS_PATH, newRows);
    console.log(`Successfully ingested ${appendedCount} clean agency leads into verified_leads.csv`);
  } else {
    console.log('All agency leads already exist in verified_leads.csv.');
  }
}

ingestLeads();
