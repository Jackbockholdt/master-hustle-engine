'use strict';
/**
 * lib/leadSourcing.js
 *
 * Turns raw Outscraper Google Maps records (API JSON or CSV export rows) into
 * the lead shape the engine queues: { company_name, contact_email, website,
 * industry, phone, first_name }.
 *
 * This module chooses ONE best email per business and applies the standing
 * outreach rules that are cheap to apply before the server's own screen:
 *   - never a generic/role mailbox (info@, hello@, sales@ …)
 *   - never a freemail address (gmail, yahoo …) unless allowFreemail
 *   - the email's domain must belong to the business's own website
 *   - a first name comes ONLY from a name Outscraper actually found for that
 *     address (email_N_full_name / email_N_first_name). It is never inferred
 *     from the address prefix — "john@" does not make someone John.
 *
 * The server still re-runs validateLeadFields(), qualifyLead() and
 * screenLeadQuality() on insert; this is a pre-filter, not the authority.
 */

const ROLE_PREFIXES = new Set([
  'info', 'hello', 'hi', 'contact', 'contactus', 'sales', 'support', 'help', 'admin',
  'office', 'team', 'inquiries', 'enquiries', 'press', 'media', 'jobs', 'careers',
  'billing', 'accounts', 'accounting', 'legal', 'privacy', 'marketing', 'noreply',
  'no-reply', 'donotreply', 'webmaster', 'postmaster', 'mail', 'email', 'service',
  'services', 'customerservice', 'newsletter', 'partnerships', 'partners', 'general',
  'welcome', 'orders', 'booking', 'bookings', 'reception', 'hr', 'recruiting',
]);

const FREEMAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'me.com', 'live.com', 'msn.com', 'protonmail.com', 'proton.me', 'zoho.com',
  'mail.com', 'ymail.com', 'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLACEHOLDER_RE = /\$\{[^}]*\}|\{\{[^}]*\}\}|\[[^\]]+\]/;

function hostOf(url) {
  return String(url || '').trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
}

// "agency.co.uk" -> "agency.co.uk", "mail.agency.com" -> "agency.com"
function rootDomain(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const twoLevelTld = /^(co|com|org|net|gov|edu|ac)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2;
  return parts.slice(twoLevelTld ? -3 : -2).join('.');
}

function cleanEmail(e) {
  const s = String(e || '').trim().toLowerCase().replace(/^mailto:/, '');
  return EMAIL_RE.test(s) && !PLACEHOLDER_RE.test(s) ? s : '';
}

/**
 * Collect every email candidate on a record, with any name Outscraper attached.
 * Handles: email, email_1..email_N (+ _full_name/_first_name/_last_name/_title),
 * emails (array or comma string), and nested { emails_and_contacts: {...} }.
 */
function collectEmails(rec) {
  const out = [];
  const seen = new Set();
  const push = (email, meta = {}) => {
    const e = cleanEmail(email);
    if (!e || seen.has(e)) return;
    seen.add(e);
    out.push({ email: e, ...meta });
  };
  const src = { ...rec, ...(rec.emails_and_contacts && typeof rec.emails_and_contacts === 'object' ? rec.emails_and_contacts : {}) };
  for (const key of Object.keys(src)) {
    const m = /^email(?:_(\d+))?$/i.exec(key);
    if (!m) continue;
    const base = key;
    const full = src[`${base}_full_name`] || '';
    const first = src[`${base}_first_name`] || (full ? String(full).trim().split(/\s+/)[0] : '');
    push(src[key], {
      full_name: String(full || '').trim(),
      first_name: String(first || '').trim(),
      title: String(src[`${base}_title`] || '').trim(),
    });
  }
  const list = src.emails;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') {
        const full = item.full_name || item.name || '';
        push(item.value || item.email, {
          full_name: String(full).trim(),
          first_name: String(item.first_name || (full ? String(full).split(/\s+/)[0] : '')).trim(),
          title: String(item.title || '').trim(),
        });
      }
    }
  } else if (typeof list === 'string') {
    for (const part of list.split(/[,;\s]+/)) push(part);
  }
  return out;
}

/**
 * Pick the single best address for a business, or null with a reason.
 * Preference: named person on the company domain > unnamed on the company domain.
 * Role mailboxes and freemail are rejected outright.
 */
function pickEmail(rec, { allowFreemail = false } = {}) {
  const site = hostOf(rec.site || rec.website || rec.domain || '');
  const siteRoot = rootDomain(site);
  const candidates = collectEmails(rec);
  if (!candidates.length) return { email: null, reason: 'no email on record' };

  const reasons = [];
  const ranked = [];
  for (const c of candidates) {
    const at = c.email.lastIndexOf('@');
    const prefix = c.email.slice(0, at);
    const domain = c.email.slice(at + 1);
    if (ROLE_PREFIXES.has(prefix.replace(/[._-]/g, ''))) { reasons.push(`${c.email}: role mailbox`); continue; }
    if (!allowFreemail && FREEMAIL.has(domain)) { reasons.push(`${c.email}: freemail`); continue; }
    if (siteRoot && rootDomain(domain) !== siteRoot) { reasons.push(`${c.email}: domain ≠ site ${siteRoot}`); continue; }
    if (!siteRoot && FREEMAIL.has(domain)) { reasons.push(`${c.email}: freemail, no site to match`); continue; }
    ranked.push({ ...c, score: (c.full_name ? 2 : 0) + (c.title ? 1 : 0) });
  }
  if (!ranked.length) return { email: null, reason: reasons.join('; ') || 'no usable email' };
  ranked.sort((a, b) => b.score - a.score);
  return { ...ranked[0], reason: null };
}

/** Outscraper's category text -> engine industry string (Path 1 of qualifyLead). */
function industryOf(rec) {
  const raw = rec.category || rec.type || rec.industry || '';
  const first = String(raw).split(/[,|;]/)[0].trim().toLowerCase();
  return first;
}

/**
 * Convert one Outscraper record into an engine lead.
 * Returns { lead } or { skip: reason }.
 */
function recordToLead(rec, opts = {}) {
  const name = String(rec.name || rec.company_name || rec.title || '').trim();
  const site = rec.site || rec.website || '';
  const host = hostOf(site);
  if (!name) return { skip: 'no business name' };
  if (!host) return { skip: 'no website' };

  const picked = pickEmail(rec, opts);
  if (!picked.email) return { skip: picked.reason, company: name };

  const employees = rec.employees || rec.employee_count || rec.company_size || '';
  const lead = {
    company_name: name,
    contact_email: picked.email,
    website: host,
    industry: industryOf(rec),
    phone: String(rec.phone || rec.phone_1 || '').trim(),
    // A first_name supplied on the row itself (engine template CSV) is a human
    // choice and is kept; otherwise only a name Outscraper attached to the address.
    first_name: picked.first_name || String(rec.first_name || '').trim(),
    campaign: opts.campaign || String(rec.campaign || '').trim(),
  };
  if (employees !== '' && employees != null) lead.employee_count = employees;
  // Provenance — not a queue column, but useful in dry-run output / CSV audits.
  lead._source = {
    contact_name: picked.full_name || '',
    contact_title: picked.title || '',
    place_id: rec.place_id || rec.google_id || '',
    query: rec.query || '',
    city: rec.city || '',
    state: rec.state || rec.us_state || '',
    reviews: rec.reviews != null ? rec.reviews : '',
  };
  return { lead };
}

/**
 * Convert a batch of records. Dedupes by email AND by root domain (one contact
 * per company), keeping the first seen. Returns { leads, skipped: [{company, reason}] }.
 */
function recordsToLeads(records, opts = {}) {
  const leads = [];
  const skipped = [];
  const seenEmail = new Set();
  const seenDomain = new Set();
  for (const rec of records || []) {
    const r = recordToLead(rec, opts);
    if (r.skip) { skipped.push({ company: r.company || rec.name || '', reason: r.skip }); continue; }
    const { lead } = r;
    const dom = rootDomain(lead.website);
    if (seenEmail.has(lead.contact_email)) { skipped.push({ company: lead.company_name, reason: 'duplicate email in batch' }); continue; }
    if (seenDomain.has(dom)) { skipped.push({ company: lead.company_name, reason: `second contact for ${dom} in batch` }); continue; }
    seenEmail.add(lead.contact_email);
    seenDomain.add(dom);
    leads.push(lead);
  }
  return { leads, skipped };
}

/** Strip provenance before POSTing to /admin/leads. */
function toQueuePayload(leads) {
  return leads.map(({ _source, ...rest }) => rest);
}

// ── CSV (Outscraper export) ─────────────────────────────────────────────────

function splitCsvLine(line) {
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
  return out;
}

/** Parse CSV text (quoted fields, embedded newlines) into row objects keyed by header. */
function parseCsv(text) {
  const rows = [];
  const lines = [];
  let cur = '';
  let quoted = false;
  const src = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') { quoted = !quoted; cur += ch; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      lines.push(cur); cur = '';
    } else cur += ch;
  }
  if (cur.length) lines.push(cur);
  const nonEmpty = lines.filter(l => l.trim().length);
  if (!nonEmpty.length) return rows;
  const header = splitCsvLine(nonEmpty[0]).map(h => h.trim());
  for (const line of nonEmpty.slice(1)) {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

module.exports = {
  ROLE_PREFIXES, FREEMAIL,
  hostOf, rootDomain, cleanEmail,
  collectEmails, pickEmail, industryOf,
  recordToLead, recordsToLeads, toQueuePayload,
  parseCsv,
};
