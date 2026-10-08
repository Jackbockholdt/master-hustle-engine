'use strict';

/**
 * lib/agencyReport.js
 * Per-agency-account client report data (last 30 days, America/Chicago days).
 *
 * Attribution: an agency account owns one or more outreach CAMPAIGN names (sends)
 * and one or more reply VENTURE keys (replies). Sources are the app's existing
 * JSONL logs. A metric whose source file is missing, or that has no attribution
 * key configured, is reported as "not tracked yet" rather than as a number.
 *
 * Not tracked anywhere in the app today: leads found per account and meetings booked.
 * Both always report "not tracked yet".
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'agency_accounts.json');
const NOT_TRACKED = 'not tracked yet';
const DAY_COUNT = 30;
const SEND_OK_STATUSES = new Set(['SENT', 'SUCCESS']);
const POSITIVE_CLASSIFICATIONS = new Set(['HIGH_INTEREST', 'POSITIVE_INTEREST']);
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

// ─── Timezone helpers ─────────────────────────────────────────────────────────
function zonedParts(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

function zoneOffsetMs(ms, tz) {
  const w = zonedParts(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

// Convert a wall-clock time in tz to a UTC epoch ms (DST-aware).
function wallClockToMs(y, m, d, h, mi, s, tz) {
  const asUtc = Date.UTC(y, m - 1, d, h, mi, s);
  const guess = asUtc - zoneOffsetMs(asUtc, tz);
  return asUtc - zoneOffsetMs(guess, tz);
}

function dayKeyOf(ms, tz) {
  const w = zonedParts(ms, tz);
  return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

// ISO strings with an offset/Z are exact. Naive strings are treated as Chicago wall time
// (the Python senders write local time with no offset).
function parseLogTimestamp(value, tz) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const str = value.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(str)) return Date.parse(str);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!m) return NaN;
  return wallClockToMs(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, tz);
}

// ─── Config ───────────────────────────────────────────────────────────────────
function resolveRepoPath(p) {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

function loadAgencyConfig(configPath = process.env.AGENCY_ACCOUNTS_CONFIG || DEFAULT_CONFIG_PATH) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const timezone = raw.timezone || 'America/Chicago';
  const sources = raw.sources || {};
  const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  const seen = new Set();
  const cleaned = accounts.map((a, i) => {
    if (!a || typeof a.id !== 'string' || !ACCOUNT_ID_RE.test(a.id)) {
      throw new Error(`accounts[${i}].id must be 3-64 chars: lowercase letters, digits, hyphens`);
    }
    if (seen.has(a.id)) throw new Error(`duplicate account id "${a.id}"`);
    seen.add(a.id);
    if (typeof a.name !== 'string' || !a.name.trim()) throw new Error(`account "${a.id}" needs a name`);
    const campaigns = Array.isArray(a.campaigns) ? a.campaigns.map(String) : [];
    const ventures = Array.isArray(a.ventures) ? a.ventures.map(String) : [];
    return { id: a.id, name: a.name.trim(), campaigns, ventures };
  });
  return {
    timezone,
    outreachLogs: (Array.isArray(sources.outreachLogs) ? sources.outreachLogs : []).map(resolveRepoPath),
    replyLog: sources.replyLog ? resolveRepoPath(sources.replyLog) : null,
    accounts: cleaned
  };
}

// ─── Source readers ───────────────────────────────────────────────────────────
// Returns { exists, rows }. A missing file means the source is not tracked on this server.
function readJsonlSource(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { exists: false, rows: [] };
  const rows = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch (e) { /* skip malformed line */ }
  }
  return { exists: true, rows };
}

// ─── Report builder ───────────────────────────────────────────────────────────
function windowDayKeys(nowMs, tz, days = DAY_COUNT) {
  const today = zonedParts(nowMs, tz);
  const keys = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.y, today.m - 1, today.d - i));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return keys;
}

function emptyDays(keys) {
  return keys.map((date) => ({ date, emailsSent: 0, replies: 0, positiveReplies: 0 }));
}

/**
 * Build the report for one account.
 * sources: { outreach: [{exists, rows}], reply: {exists, rows} | null } (pre-read, see collectSources)
 */
function buildAccountReport(account, cfg, sources, nowMs = Date.now()) {
  const tz = cfg.timezone;
  const keys = windowDayKeys(nowMs, tz);
  const keySet = new Set(keys);
  const days = emptyDays(keys);
  const dayIndex = new Map(keys.map((k, i) => [k, i]));

  const outreachPresent = sources.outreach.some((s) => s.exists);
  const emailsTracked = outreachPresent && account.campaigns.length > 0;
  const repliesTracked = !!(sources.reply && sources.reply.exists) && account.ventures.length > 0;

  let emailsSent = 0;
  if (emailsTracked) {
    const campaigns = new Set(account.campaigns);
    for (const src of sources.outreach) {
      for (const row of src.rows) {
        if (!campaigns.has(row.campaign)) continue;
        if (!SEND_OK_STATUSES.has(String(row.status || '').toUpperCase())) continue;
        if (String(row.mode || 'LIVE').toUpperCase() === 'DRY_RUN') continue;
        const ms = parseLogTimestamp(row.timestamp || row.sentAt, tz);
        if (Number.isNaN(ms)) continue;
        const key = dayKeyOf(ms, tz);
        if (!keySet.has(key)) continue;
        days[dayIndex.get(key)].emailsSent++;
        emailsSent++;
      }
    }
  }

  let replies = 0;
  let positiveReplies = 0;
  if (repliesTracked) {
    const ventures = new Set(account.ventures);
    for (const row of sources.reply.rows) {
      if (!ventures.has(row.venture_key)) continue;
      const ms = parseLogTimestamp(row.timestamp, tz);
      if (Number.isNaN(ms)) continue;
      const key = dayKeyOf(ms, tz);
      if (!keySet.has(key)) continue;
      const idx = dayIndex.get(key);
      days[idx].replies++;
      replies++;
      if (POSITIVE_CLASSIFICATIONS.has(String(row.classification || '').toUpperCase())) {
        days[idx].positiveReplies++;
        positiveReplies++;
      }
    }
  }

  const metricReason = {
    emailsSent: emailsTracked ? null
      : (account.campaigns.length === 0 ? 'No outreach campaign assigned to this account' : 'Outreach send log not found on this server'),
    replies: repliesTracked ? null
      : (account.ventures.length === 0 ? 'No reply venture assigned to this account' : 'Reply triage log not found on this server'),
    leadsFound: 'Leads are not linked to an account in the app yet',
    meetingsBooked: 'Meetings are not recorded anywhere in the app yet'
  };

  const pick = (tracked, value) => (tracked ? value : NOT_TRACKED);
  return {
    account: { id: account.id, name: account.name },
    timezone: tz,
    window: { from: keys[0], to: keys[keys.length - 1], days: DAY_COUNT },
    generatedAt: new Date(nowMs).toISOString(),
    totals: {
      leadsFound: NOT_TRACKED,
      emailsSent: pick(emailsTracked, emailsSent),
      replies: pick(repliesTracked, replies),
      positiveReplies: pick(repliesTracked, positiveReplies),
      meetingsBooked: NOT_TRACKED
    },
    tracked: {
      leadsFound: false,
      emailsSent: emailsTracked,
      replies: repliesTracked,
      positiveReplies: repliesTracked,
      meetingsBooked: false
    },
    reasons: metricReason,
    days: days.map((d) => ({
      date: d.date,
      emailsSent: emailsTracked ? d.emailsSent : null,
      replies: repliesTracked ? d.replies : null,
      positiveReplies: repliesTracked ? d.positiveReplies : null
    }))
  };
}

// Read every source once; reports for all accounts reuse the same reads.
// Events posted by the laptop sender (lib/outreachEvents.js), merged with the JSONL logs.
// An event already present in a JSONL log (same address and same CT day, same kind) is
// counted once, from the JSONL log, so posting a send that is also in a log cannot double it.
function readOutreachDb(cfg, jsonlSends, jsonlReplies) {
  const { readEvents, dbFilePath } = require('./outreachEvents');
  const exists = fs.existsSync(dbFilePath());
  if (!exists) return { sends: { exists: false, rows: [] }, replies: { exists: false, rows: [] } };
  const tz = cfg.timezone;
  const dayOf = (ts) => { const ms = parseLogTimestamp(ts, tz); return Number.isNaN(ms) ? null : dayKeyOf(ms, tz); };
  // Real log keys: sends use recipient_email (saas/shovel logs), replies use sender_email
  // (inbound triage log). Dry runs never went out, so they cannot cover a real send.
  const sendKeys = new Set(jsonlSends.flatMap((r) => {
    if (String(r.mode || 'LIVE').toUpperCase() === 'DRY_RUN') return [];
    const addr = String(r.recipient_email || r.email || r.to || r.recipient || '').trim().toLowerCase();
    const d = dayOf(r.timestamp || r.sentAt);
    return addr && d ? [`${addr}|${d}`] : [];
  }));
  const replyKeys = new Set(jsonlReplies.flatMap((r) => {
    const addr = String(r.sender_email || r.from_email || r.email || '').trim().toLowerCase();
    const d = dayOf(r.timestamp);
    return addr && d ? [`${addr}|${d}`] : [];
  }));
  const events = readEvents({ types: ['sent', 'reply'] });
  const sends = [];
  const replies = [];
  for (const e of events) {
    const d = dayOf(e.timestamp);
    if (!d) continue;
    if (e.type === 'sent') {
      if (sendKeys.has(`${e.email}|${d}`)) continue;
      sends.push({ campaign: e.campaign, status: 'SENT', mode: 'LIVE', timestamp: e.timestamp });
    } else {
      if (replyKeys.has(`${e.email}|${d}`)) continue;
      replies.push({ venture_key: e.venture_key, timestamp: e.timestamp, classification: e.category });
    }
  }
  return { sends: { exists: true, rows: sends }, replies: { exists: true, rows: replies } };
}

function collectSources(cfg) {
  const outreach = cfg.outreachLogs.map(readJsonlSource);
  const reply = cfg.replyLog ? readJsonlSource(cfg.replyLog) : { exists: false, rows: [] };
  const jsonlSends = outreach.flatMap((s) => s.rows);
  const dbPart = readOutreachDb(cfg, jsonlSends, reply.rows || []);
  return {
    outreach: [...outreach, dbPart.sends],
    reply: reply.exists || dbPart.replies.exists
      ? { exists: true, rows: [...(reply.rows || []), ...dbPart.replies.rows] }
      : { exists: false, rows: [] }
  };
}

function buildAccountReports(cfg, nowMs = Date.now()) {
  const sources = collectSources(cfg);
  return cfg.accounts.map((a) => buildAccountReport(a, cfg, sources, nowMs));
}

// ─── Shareable read-only links ────────────────────────────────────────────────
function shareSecret() {
  return process.env.REPORT_SHARE_SECRET || process.env.ADMIN_KEY || '';
}

function shareToken(accountId, secret = shareSecret()) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`agency-report:${accountId}`).digest('hex').slice(0, 48);
}

// Returns the account whose share token matches, or null.
function findAccountByShareToken(token, cfg, secret = shareSecret()) {
  if (!secret || typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const given = Buffer.from(token);
  for (const account of cfg.accounts) {
    const expected = Buffer.from(shareToken(account.id, secret));
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return account;
  }
  return null;
}

module.exports = {
  NOT_TRACKED,
  DAY_COUNT,
  loadAgencyConfig,
  readJsonlSource,
  parseLogTimestamp,
  dayKeyOf,
  windowDayKeys,
  buildAccountReport,
  buildAccountReports,
  collectSources,
  shareToken,
  findAccountByShareToken,
  shareSecret,
  DEFAULT_CONFIG_PATH
};
