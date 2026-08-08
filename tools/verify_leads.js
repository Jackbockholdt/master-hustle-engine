#!/usr/bin/env node
/**
 * tools/verify_leads.js
 *
 * Pre-send verification for a lead file. Zero external dependencies — built-in
 * `dns` only. Run this BEFORE POST /admin/leads so bad rows never reach the queue.
 *
 *   node tools/verify_leads.js leads.csv
 *   node tools/verify_leads.js leads.json --out clean.json --rejects rejects.csv
 *
 * Accepts either a CSV (header row required) or the JSON body /admin/leads takes
 * ({"leads":[...]} or a bare array). Format is detected from the file contents,
 * not the extension.
 *
 * Each lead is checked, in order, against:
 *   1. config/blocklist.json — address and domain do-not-send list. Permanent.
 *   2. Syntax — a parseable address, no unresolved [template] placeholders.
 *   3. Role mailbox — info@, support@, hello@ and friends.
 *   4. DNS — the domain must resolve MX records (falling back to A/AAAA, which
 *      is what a real MTA does before giving up).
 *
 * WHAT THIS DOES NOT DO: prove a mailbox exists. DNS says the domain can accept
 * mail; it says nothing about whether `firstname@` is a real person there. Rule
 * 3 still applies — run a real verifier, and expect roughly 1-in-15 addresses
 * that pass everything here to hard-bounce anyway.
 *
 * Exit codes: 0 all passed, 1 some rejected, 2 usage/IO error.
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const LEAD_FIELDS = ['company_name', 'contact_email', 'website', 'industry', 'phone', 'campaign', 'first_name'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLACEHOLDER_RE = /\[[^\]]+\]|\{\{[^}]+\}\}|<[^>]+>/;

// Mirrors ROLE_MAILBOXES in server.js. Usable for small businesses but low
// priority, so they are flagged rather than dropped unless --strict-role.
const ROLE_MAILBOXES = new Set([
  'info', 'support', 'hello', 'contact', 'sales', 'admin', 'help', 'team',
  'office', 'mail', 'inquiries', 'enquiries', 'hi', 'hey', 'noreply',
  'no-reply', 'donotreply', 'billing', 'careers', 'jobs', 'press', 'marketing',
]);

const DNS_TIMEOUT_MS = 8000;
const CONCURRENCY = 8;

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(`Usage: node ${path.basename(__filename)} <leads.csv|leads.json> [options]

  --out <file>       write passing leads as JSON ({"leads":[...]}) ready to POST
  --rejects <file>   write rejected rows as CSV, with a reason column
  --strict-role      reject role mailboxes instead of warning
  --no-dns           skip DNS resolution (syntax + blocklist only)
  --blocklist <file> override config/blocklist.json`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { file: null, out: null, rejects: null, strictRole: false, dns: true, blocklist: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--rejects') opts.rejects = argv[++i];
    else if (a === '--blocklist') opts.blocklist = argv[++i];
    else if (a === '--strict-role') opts.strictRole = true;
    else if (a === '--no-dns') opts.dns = false;
    else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('-')) usage(`unknown option ${a}`);
    else if (!opts.file) opts.file = a;
    else usage('more than one input file given');
  }
  if (!opts.file) usage('no input file given');
  return opts;
}

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
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Detect and parse CSV or JSON. Returns an array of lead objects. */
function loadLeads(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  if (!text) throw new Error(`${file} is empty`);

  if (text[0] === '{' || text[0] === '[') {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : data.leads;
    if (!Array.isArray(arr)) throw new Error('JSON must be an array or {"leads": [...]}');
    return arr;
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = splitRow(lines.shift());
  if (!header.includes('contact_email')) {
    throw new Error(`CSV header has no contact_email column (found: ${header.join(', ')})`);
  }
  return lines.map((line) => {
    const vals = splitRow(line);
    const lead = {};
    header.forEach((col, i) => { if (LEAD_FIELDS.includes(col) && vals[i]) lead[col] = vals[i]; });
    return lead;
  });
}

function loadBlocklist(file) {
  if (!fs.existsSync(file)) {
    console.error(`Warning: no blocklist at ${file} — proceeding without do-not-send checks.`);
    return { addresses: {}, domains: {} };
  }
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { addresses: b.addresses || {}, domains: b.domains || {} };
}

/** Registrable-ish root domain. Good enough to catch a blocked parent domain. */
function rootDomain(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]);
}

/** Can this domain accept mail? MX first, then A/AAAA, as an MTA would. */
async function resolveMailHost(domain) {
  try {
    const mx = await withTimeout(dns.resolveMx(domain), DNS_TIMEOUT_MS, 'MX lookup');
    if (mx && mx.length) {
      const best = mx.slice().sort((a, b) => a.priority - b.priority)[0];
      return { ok: true, via: 'MX', detail: `${best.exchange} (priority ${best.priority})` };
    }
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA' || err.code === 'NXDOMAIN') {
      // Fall through to A/AAAA — a domain with no MX may still accept mail.
    } else if (/timed out/.test(err.message)) {
      return { ok: false, inconclusive: true, detail: err.message };
    }
  }
  try {
    const a = await withTimeout(dns.resolve4(domain), DNS_TIMEOUT_MS, 'A lookup');
    if (a && a.length) return { ok: true, via: 'A', detail: `${a[0]} (no MX — implicit mail host)` };
  } catch (_) { /* fall through */ }
  try {
    const aaaa = await withTimeout(dns.resolve6(domain), DNS_TIMEOUT_MS, 'AAAA lookup');
    if (aaaa && aaaa.length) return { ok: true, via: 'AAAA', detail: `${aaaa[0]} (no MX — implicit mail host)` };
  } catch (err) {
    if (/timed out/.test(err.message)) return { ok: false, inconclusive: true, detail: err.message };
  }
  return { ok: false, detail: 'domain has no MX, A or AAAA record — cannot receive mail' };
}

/** Run `worker` over `items` with bounded concurrency, preserving order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const blocklistPath = opts.blocklist || path.join(__dirname, '..', 'config', 'blocklist.json');

  let leads;
  try {
    leads = loadLeads(opts.file);
  } catch (err) {
    console.error(`Error reading ${opts.file}: ${err.message}`);
    process.exit(2);
  }
  const blocklist = loadBlocklist(blocklistPath);

  console.error(`Checking ${leads.length} lead(s) from ${opts.file}`);
  console.error(`Blocklist: ${Object.keys(blocklist.addresses).length} address(es), ${Object.keys(blocklist.domains).length} domain(s)`);
  if (!opts.dns) console.error('DNS checks disabled (--no-dns)');

  // Cache per domain — a list is usually many rows across few domains.
  const dnsCache = new Map();
  const seen = new Set();

  const checked = await mapLimit(leads, CONCURRENCY, async (lead, idx) => {
    const row = idx + 2;
    const raw = (lead.contact_email || '').trim();
    const email = raw.toLowerCase();
    const rej = (reason) => ({ lead, email, ok: false, reason, row });

    const placeholder = LEAD_FIELDS.find((f) => typeof lead[f] === 'string' && PLACEHOLDER_RE.test(lead[f]));
    if (placeholder) return rej(`unresolved placeholder in ${placeholder}: ${lead[placeholder]}`);
    if (!email) return rej('missing contact_email');
    if (!EMAIL_RE.test(email)) return rej(`malformed contact_email '${raw}'`);

    if (seen.has(email)) return rej('duplicate contact_email in this file');
    seen.add(email);

    const domain = email.slice(email.lastIndexOf('@') + 1);
    const root = rootDomain(domain);

    const hitAddr = blocklist.addresses[email];
    if (hitAddr) return rej(`blocklisted address (${hitAddr.status}, last seen ${hitAddr.last_seen})`);
    const hitDom = blocklist.domains[domain] || blocklist.domains[root];
    if (hitDom) return rej(`blocklisted domain ${domain} (${hitDom.status}, last seen ${hitDom.last_seen})`);

    const prefix = email.slice(0, email.lastIndexOf('@'));
    const isRole = ROLE_MAILBOXES.has(prefix);
    if (isRole && opts.strictRole) return rej(`role mailbox '${prefix}@' (--strict-role)`);

    const warnings = [];
    if (isRole) warnings.push(`role mailbox '${prefix}@' — low priority, not a named person`);

    // Mirrors screenLeadQuality(): an email domain that disagrees with the
    // company website is usually the wrong contact.
    const site = (lead.website || '').trim().toLowerCase();
    if (site) {
      const siteRoot = rootDomain(site.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]);
      if (siteRoot && siteRoot !== root) {
        return rej(`email domain '${root}' does not match website '${siteRoot}'`);
      }
    }

    if (!opts.dns) return { lead, email, ok: true, warnings, dns: 'skipped' };

    if (!dnsCache.has(domain)) dnsCache.set(domain, resolveMailHost(domain));
    const res = await dnsCache.get(domain);
    if (!res.ok) {
      if (res.inconclusive) {
        warnings.push(`DNS inconclusive: ${res.detail}`);
        return { lead, email, ok: true, warnings, dns: 'inconclusive' };
      }
      return rej(`DNS: ${res.detail}`);
    }
    return { lead, email, ok: true, warnings, dns: `${res.via} ${res.detail}` };
  });

  const passed = checked.filter((c) => c.ok);
  const rejected = checked.filter((c) => !c.ok);

  if (rejected.length) {
    console.error(`\nRejected ${rejected.length}:`);
    for (const r of rejected) console.error(`  row ${r.row} ${r.email || '(no email)'} — ${r.reason}`);
  }
  const warned = passed.filter((p) => p.warnings && p.warnings.length);
  if (warned.length) {
    console.error(`\nPassed with warnings (${warned.length}):`);
    for (const w of warned) console.error(`  ${w.email} — ${w.warnings.join('; ')}`);
  }

  console.error(`\n${passed.length} passed, ${rejected.length} rejected, of ${leads.length}.`);
  if (passed.length) {
    console.error('Reminder: DNS proves the domain accepts mail, not that the mailbox exists.');
  }

  const body = JSON.stringify({ leads: passed.map((p) => ({ ...p.lead, contact_email: p.email })) }, null, 2) + '\n';
  if (opts.out) {
    fs.writeFileSync(opts.out, body);
    console.error(`Wrote ${passed.length} lead(s) to ${opts.out}`);
  } else {
    process.stdout.write(body);
  }

  if (opts.rejects && rejected.length) {
    const cols = ['row', 'contact_email', 'company_name', 'reason'];
    const lines = [cols.join(',')].concat(
      rejected.map((r) => [r.row, r.email, r.lead.company_name || '', r.reason].map(csvCell).join(','))
    );
    fs.writeFileSync(opts.rejects, lines.join('\n') + '\n');
    console.error(`Wrote ${rejected.length} reject(s) to ${opts.rejects}`);
  }

  process.exit(rejected.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`Unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
