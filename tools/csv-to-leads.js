#!/usr/bin/env node
/**
 * tools/csv-to-leads.js
 *
 * Convert a lead CSV into the JSON body that POST /admin/leads expects.
 *
 *   node tools/csv-to-leads.js leads.csv > leads.json
 *   curl -X POST http://localhost:3005/admin/leads \
 *     -H 'Content-Type: application/json' --data @leads.json
 *
 * Columns must match the leads_queue schema. Anything else is dropped with a
 * warning on stderr so a stray Gumloop column never silently becomes a field
 * the server ignores.
 *
 * This does NOT verify deliverability. The server re-runs validateLeadFields()
 * and screenLeadQuality() on import and rejects bad rows there — this script
 * only reshapes the file and gives you the rejects before you POST.
 */

const fs = require('fs');
const path = require('path');

// Mirrors the leads_queue columns written by queueLeads() in server.js.
const LEAD_FIELDS = [
  'company_name',
  'contact_email',
  'website',
  'industry',
  'phone',
  'campaign',
  'first_name',
];

const REQUIRED = ['company_name', 'contact_email'];

// Kept in sync with EMAIL_RE / PLACEHOLDER_RE in server.js. The server is the
// authority; these only surface problems earlier.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLACEHOLDER_RE = /\[[^\]]+\]|\{\{[^}]+\}\}|<[^>]+>/;

/** Split one CSV line, honouring quoted fields and doubled quotes. */
function splitRow(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { header: [], rows: [] };
  return { header: splitRow(lines.shift()), rows: lines.map(splitRow) };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error(`Usage: node ${path.relative(process.cwd(), __filename)} <leads.csv> > leads.json`);
    process.exit(1);
  }

  const { header, rows } = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!header.length) {
    console.error('CSV is empty — nothing to convert.');
    process.exit(1);
  }

  const unknown = header.filter((h) => h && !LEAD_FIELDS.includes(h));
  if (unknown.length) {
    console.error(`Warning: dropping column(s) the engine does not store: ${unknown.join(', ')}`);
    console.error(`Recognised columns: ${LEAD_FIELDS.join(', ')}`);
  }
  const missingRequired = REQUIRED.filter((f) => !header.includes(f));
  if (missingRequired.length) {
    console.error(`Error: CSV is missing required column(s): ${missingRequired.join(', ')}`);
    process.exit(1);
  }

  const leads = [];
  const rejected = [];

  rows.forEach((vals, i) => {
    const lineNo = i + 2; // header is line 1
    const lead = {};
    header.forEach((col, c) => {
      if (LEAD_FIELDS.includes(col) && vals[c]) lead[col] = vals[c];
    });

    const email = (lead.contact_email || '').toLowerCase();
    const placeholder = LEAD_FIELDS.find(
      (f) => typeof lead[f] === 'string' && PLACEHOLDER_RE.test(lead[f])
    );

    if (!lead.company_name) {
      rejected.push({ line: lineNo, email, reason: 'missing company_name' });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      rejected.push({ line: lineNo, email, reason: `invalid contact_email '${lead.contact_email || ''}'` });
      return;
    }
    if (placeholder) {
      rejected.push({ line: lineNo, email, reason: `unresolved placeholder in '${placeholder}': ${lead[placeholder]}` });
      return;
    }

    lead.contact_email = email;
    leads.push(lead);
  });

  // Same dedupe key the server uses, applied here so the counts line up.
  const seen = new Set();
  const deduped = leads.filter((l) => {
    if (seen.has(l.contact_email)) {
      rejected.push({ line: null, email: l.contact_email, reason: 'duplicate contact_email in file' });
      return false;
    }
    seen.add(l.contact_email);
    return true;
  });

  if (rejected.length) {
    console.error(`\nRejected ${rejected.length} row(s):`);
    for (const r of rejected) {
      console.error(`  ${r.line ? `line ${r.line}` : 'dupe'}: ${r.reason}`);
    }
  }
  console.error(`\n${deduped.length} lead(s) ready to POST /admin/leads.`);

  process.stdout.write(JSON.stringify({ leads: deduped }, null, 2) + '\n');
}

main();
