#!/usr/bin/env node
/**
 * tools/load-leads.js
 *
 * Load a lead file into the live engine's queue WITHOUT Gumloop.
 * Accepts either:
 *   - an Outscraper Google Maps export (CSV or JSON): name, site, phone,
 *     category, email_1, email_1_full_name, … — one best email is picked per
 *     business by lib/leadSourcing.js
 *   - the engine's own template (tools/leads-template.csv):
 *     company_name, contact_email, website, industry, phone, campaign, first_name
 *
 * The file never leaves your machine except as JSON POSTed to /admin/leads,
 * in chunks of 100, with the admin key. The server re-runs validation, the ICP
 * filter, the quality screen and the duplicate check on every row.
 *
 *   node tools/load-leads.js leads.csv                       # dry run: shows what would load
 *   node tools/load-leads.js leads.csv --send                # actually POST
 *   node tools/load-leads.js leads.csv --send --limit 200    # first 200 only
 *   node tools/load-leads.js leads.csv --out clean.json      # write the converted rows
 *
 * Env / flags:
 *   ENGINE_URL   (default https://master-hustle-engine.onrender.com)   --engine URL
 *   ADMIN_KEY    (required with --send)                                  --key KEY
 *   --allow-freemail   keep gmail/yahoo addresses (default: drop)
 *   --campaign NAME    stamp every lead with a campaign key
 *
 * Exit codes: 0 ok, 1 nothing loadable, 2 usage/IO/HTTP error.
 */

const fs = require('fs');
const path = require('path');
const ls = require(path.join(__dirname, '..', 'lib', 'leadSourcing'));

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };

if (!file) {
  console.error('usage: node tools/load-leads.js <leads.csv|leads.json> [--send] [--limit N] [--out file.json] [--engine URL] [--key ADMIN_KEY] [--allow-freemail] [--campaign NAME]');
  process.exit(2);
}

const ENGINE = (opt('engine', process.env.ENGINE_URL || 'https://master-hustle-engine.onrender.com')).replace(/\/+$/, '');
const KEY = opt('key', process.env.ADMIN_KEY || '');
const SEND = flag('send');
const LIMIT = parseInt(opt('limit', '0'), 10) || 0;
const OUT = opt('out', '');
const CAMPAIGN = opt('campaign', '');
const ALLOW_FREEMAIL = flag('allow-freemail');

let raw;
try { raw = fs.readFileSync(file, 'utf8'); }
catch (err) { console.error(`cannot read ${file}: ${err.message}`); process.exit(2); }

// Detect format from contents, not extension.
let records;
const trimmed = raw.replace(/^﻿/, '').trim();
if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
  const parsed = JSON.parse(trimmed);
  records = Array.isArray(parsed) ? parsed : (parsed.leads || parsed.data || []);
  // Outscraper JSON is [[places for query 1], [places for query 2], ...]
  if (records.length && Array.isArray(records[0])) records = records.flat();
} else {
  records = ls.parseCsv(trimmed);
}
if (!records.length) { console.error('no rows found'); process.exit(1); }

// Template rows already carry contact_email; Outscraper rows carry email_1 etc.
// recordToLead handles both because collectEmails() also reads a bare `email`
// column — so map the template's contact_email onto that first.
const normalised = records.map(r => {
  if (r.contact_email && !r.email && !r.email_1) return { ...r, email: r.contact_email, site: r.site || r.website };
  return r;
});

const { leads, skipped } = ls.recordsToLeads(normalised, { allowFreemail: ALLOW_FREEMAIL, campaign: CAMPAIGN });
const chosen = LIMIT ? leads.slice(0, LIMIT) : leads;

console.log(`rows: ${records.length}  loadable: ${leads.length}  skipped: ${skipped.length}${LIMIT ? `  sending first ${chosen.length}` : ''}`);
const reasons = {};
for (const s of skipped) { const k = s.reason.replace(/[^:]*: /, '').slice(0, 40); reasons[k] = (reasons[k] || 0) + 1; }
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  skip ${String(v).padStart(4)}  ${k}`);
console.log('sample:');
for (const l of chosen.slice(0, 8)) console.log(`  ${l.company_name}  <${l.contact_email}>  ${l.website}  ${l.industry || '-'}  ${l.first_name ? 'first_name=' + l.first_name : ''}`);

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ leads: ls.toQueuePayload(chosen) }, null, 2));
  console.log(`wrote ${chosen.length} leads → ${OUT}`);
}

if (!chosen.length) process.exit(1);
if (!SEND) { console.log('\ndry run — add --send to load into the engine'); process.exit(0); }
if (!KEY) { console.error('--send needs ADMIN_KEY (env) or --key'); process.exit(2); }

(async () => {
  const payload = ls.toQueuePayload(chosen);
  const totals = { imported: 0, skipped: 0 };
  for (let i = 0; i < payload.length; i += 100) {
    const chunk = payload.slice(i, i + 100);
    const resp = await fetch(`${ENGINE}/admin/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': KEY },
      body: JSON.stringify({ leads: chunk }),
    });
    const text = await resp.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!resp.ok) { console.error(`chunk ${i / 100 + 1}: HTTP ${resp.status} ${text.slice(0, 300)}`); process.exit(2); }
    totals.imported += body.imported || 0;
    totals.skipped += body.skipped || 0;
    console.log(`chunk ${i / 100 + 1}: imported ${body.imported} skipped ${body.skipped}  queue now ${JSON.stringify(body.queue)}`);
  }
  console.log(`\ndone — imported ${totals.imported}, server-skipped ${totals.skipped} (duplicates / failed screen)`);
})().catch(err => { console.error(err.message); process.exit(2); });
