'use strict';

/**
 * lib/outreachEvents.js
 * Persistence for outreach events posted by the laptop sender (mhe-send):
 * type "sent" | "reply" | "bounce", keyed by type + email + timestamp.
 *
 * Storage: outreach_events.db in the same folder as ROUTER_USAGE_DB_PATH
 * (so it lands on the same persistent disk on Render), else data/.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'data');
const TYPES = new Set(['sent', 'reply', 'bounce']);
const MAX_BATCH = 1000;
const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

let db = null;
let dbPathInUse = null;

function dbFilePath() {
  const usage = process.env.ROUTER_USAGE_DB_PATH;
  const dir = usage ? path.dirname(usage) : DEFAULT_DIR;
  return path.join(dir, 'outreach_events.db');
}

function getDb() {
  const wanted = dbFilePath();
  if (db && dbPathInUse === wanted) return db;
  if (db) { db.close(); db = null; }
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(wanted), { recursive: true });
  db = new DatabaseSync(wanted);
  dbPathInUse = wanted;
  db.exec(`
    CREATE TABLE IF NOT EXISTS outreach_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT,
      campaign TEXT NOT NULL,
      venture_key TEXT,
      category TEXT,
      timestamp TEXT NOT NULL,
      received_at TEXT NOT NULL,
      UNIQUE (type, email, timestamp)
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_events_ts ON outreach_events (timestamp);
  `);
  return db;
}

function closeDb() {
  if (db) db.close();
  db = null;
  dbPathInUse = null;
}

/**
 * Validate one raw event. Returns { ok: true, event } with normalized fields,
 * or { ok: false, reason }.
 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
  const type = String(raw.type || '').toLowerCase();
  if (!TYPES.has(type)) return { ok: false, reason: 'type must be sent, reply or bounce' };
  const email = String(raw.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { ok: false, reason: 'invalid email' };
  const ms = Date.parse(raw.timestamp);
  if (Number.isNaN(ms)) return { ok: false, reason: 'invalid timestamp' };
  const campaign = String(raw.campaign || '').trim();
  if (!campaign) return { ok: false, reason: 'campaign is required' };
  const clip = (v) => (v === undefined || v === null ? null : String(v).slice(0, 300));
  return {
    ok: true,
    event: {
      type,
      email,
      company: clip(raw.company),
      campaign: campaign.slice(0, 300),
      venture_key: clip(raw.venture_key),
      category: clip(raw.category),
      timestamp: new Date(ms).toISOString()
    }
  };
}

/**
 * Insert a batch. Duplicates (same type + email + timestamp) are skipped.
 * Returns { received, inserted, duplicates, rejected: [{index, reason}] }.
 */
function insertEvents(rawEvents, now = new Date()) {
  if (!Array.isArray(rawEvents)) throw new Error('body must be a JSON array of events');
  if (rawEvents.length > MAX_BATCH) throw new Error(`batch too large (max ${MAX_BATCH})`);
  const handle = getDb();
  const stmt = handle.prepare(`
    INSERT OR IGNORE INTO outreach_events
      (type, email, company, campaign, venture_key, category, timestamp, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const receivedAt = now.toISOString();
  const result = { received: rawEvents.length, inserted: 0, duplicates: 0, rejected: [] };
  handle.exec('BEGIN');
  try {
    rawEvents.forEach((raw, index) => {
      const n = normalizeEvent(raw);
      if (!n.ok) { result.rejected.push({ index, reason: n.reason }); return; }
      const e = n.event;
      const info = stmt.run(e.type, e.email, e.company, e.campaign, e.venture_key, e.category, e.timestamp, receivedAt);
      if (info.changes > 0) result.inserted++; else result.duplicates++;
    });
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
  return result;
}

/** Read events, optionally filtered by type. Returns plain objects with the public field names. */
function readEvents({ types } = {}) {
  const handle = getDb();
  const rows = types && types.length
    ? handle.prepare(`SELECT * FROM outreach_events WHERE type IN (${types.map(() => '?').join(',')}) ORDER BY timestamp`).all(...types)
    : handle.prepare('SELECT * FROM outreach_events ORDER BY timestamp').all();
  return rows.map((r) => ({
    type: r.type, email: r.email, company: r.company, campaign: r.campaign,
    venture_key: r.venture_key, category: r.category, timestamp: r.timestamp
  }));
}

module.exports = { insertEvents, readEvents, normalizeEvent, dbFilePath, closeDb, MAX_BATCH };
