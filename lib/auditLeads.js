'use strict';

const path = require('path');
const fs = require('fs');
const https = require('https');

let dbInstance = null;
let dbPathInUse = null;

function getDbPath() {
  if (process.env.PIPELINE_DB_PATH) return process.env.PIPELINE_DB_PATH;
  return path.join(__dirname, '..', 'pipeline.db');
}

function getDatabase() {
  const wanted = getDbPath();
  if (dbInstance && dbPathInUse === wanted) return dbInstance;
  if (dbInstance) {
    try { dbInstance.close(); } catch (_) {}
    dbInstance = null;
  }

  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(wanted), { recursive: true });
  dbInstance = new DatabaseSync(wanted);
  dbPathInUse = wanted;

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS audit_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT NOT NULL,
      business TEXT,
      answers TEXT,
      score INTEGER NOT NULL,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_leads_created_at ON audit_leads (created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_leads_email ON audit_leads (email);
  `);

  return dbInstance;
}

/**
 * RFC-compliant email validation
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  const regex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return regex.test(trimmed);
}

// ─── IP Rate Limiting ──────────────────────────────────────────────
// Default: 5 submissions per 15 minutes per IP
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const ipSubmissions = new Map();

function checkRateLimit(ip) {
  const clientIp = (ip || 'unknown').trim();
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  const timestamps = (ipSubmissions.get(clientIp) || []).filter(t => t > windowStart);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    const oldest = timestamps[0];
    const resetMs = Math.max(0, (oldest + RATE_LIMIT_WINDOW_MS) - now);
    return {
      allowed: false,
      remaining: 0,
      resetMs,
      limit: RATE_LIMIT_MAX
    };
  }

  timestamps.push(now);
  ipSubmissions.set(clientIp, timestamps);

  // Periodically clean stale IPs
  if (ipSubmissions.size > 1000) {
    for (const [key, list] of ipSubmissions.entries()) {
      const valid = list.filter(t => t > windowStart);
      if (valid.length === 0) ipSubmissions.delete(key);
      else ipSubmissions.set(key, valid);
    }
  }

  return {
    allowed: true,
    remaining: RATE_LIMIT_MAX - timestamps.length,
    resetMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX
  };
}

function resetRateLimit() {
  ipSubmissions.clear();
}

/**
 * Save an audit lead record into SQLite
 */
function saveAuditLead({ name, email, business, answers, score, ip }) {
  const db = getDatabase();
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanName = (name || '').trim();
  const cleanBusiness = (business || '').trim();
  const cleanIp = (ip || '').trim();
  const numericScore = typeof score === 'number' ? Math.round(score) : parseInt(score || '0', 10);
  const answersJson = typeof answers === 'string' ? answers : JSON.stringify(answers || {});

  const stmt = db.prepare(`
    INSERT INTO audit_leads (name, email, business, answers, score, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const result = stmt.run(cleanName, cleanEmail, cleanBusiness, answersJson, numericScore, cleanIp);
  const id = Number(result.lastInsertRowid);

  return {
    id,
    name: cleanName,
    email: cleanEmail,
    business: cleanBusiness,
    answers: answersJson,
    score: numericScore,
    ip_address: cleanIp
  };
}

/**
 * Retrieve captured leads for admin viewer
 */
function getAuditLeads({ limit = 100, offset = 0 } = {}) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT id, name, email, business, answers, score, ip_address, created_at
    FROM audit_leads
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(limit, offset);
}

function getAuditLeadCount() {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM audit_leads').get();
  return row ? row.count : 0;
}

/**
 * Send notification email to hello@master-hustle-engine.com
 */
async function sendAuditNotification(lead, { relayUrl, relayKey } = {}) {
  const targetEmail = 'hello@master-hustle-engine.com';
  const url = relayUrl || process.env.GMAIL_HTTP_URL;
  const key = relayKey || process.env.GMAIL_HTTP_KEY;

  const subject = `[Lead Leak Audit] ${lead.business || lead.name || lead.email} - Score: ${lead.score}/100`;

  let parsedAnswers = {};
  try {
    parsedAnswers = typeof lead.answers === 'string' ? JSON.parse(lead.answers) : (lead.answers || {});
  } catch (_) {
    parsedAnswers = { raw: lead.answers };
  }

  const answersHtml = Object.entries(parsedAnswers)
    .map(([q, a]) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-weight:600;color:#334155;">${escapeHtml(q)}</td><td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;color:#0f172a;">${escapeHtml(typeof a === 'object' ? JSON.stringify(a) : String(a))}</td></tr>`)
    .join('');

  const htmlBody = `
    <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #0f172a;">
      <div style="background: #0f172a; padding: 18px 24px; border-radius: 12px 12px 0 0; color: #fff;">
        <h2 style="margin: 0; font-size: 20px;">New Lead Leak Audit Submission</h2>
        <p style="margin: 4px 0 0; font-size: 13px; color: #94a3b8;">Captured via master-hustle-engine.com/audit</p>
      </div>
      <div style="background: #f8fafc; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
        <div style="background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin-bottom: 20px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 15px;">
            <tr><td style="padding: 6px 0; color: #64748b; width: 120px;"><strong>Audit Score:</strong></td><td style="padding: 6px 0; font-size: 20px; font-weight: 800; color: ${lead.score >= 75 ? '#15803d' : lead.score >= 50 ? '#ea580c' : '#b91c1c'};">${lead.score} / 100</td></tr>
            <tr><td style="padding: 6px 0; color: #64748b;"><strong>Name:</strong></td><td style="padding: 6px 0; font-weight: 600;">${escapeHtml(lead.name || 'Not provided')}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748b;"><strong>Email:</strong></td><td style="padding: 6px 0; font-weight: 600;"><a href="mailto:${escapeHtml(lead.email)}" style="color: #ea580c;">${escapeHtml(lead.email)}</a></td></tr>
            <tr><td style="padding: 6px 0; color: #64748b;"><strong>Business:</strong></td><td style="padding: 6px 0; font-weight: 600;">${escapeHtml(lead.business || 'Not provided')}</td></tr>
            <tr><td style="padding: 6px 0; color: #64748b;"><strong>IP Address:</strong></td><td style="padding: 6px 0; color: #64748b; font-size: 13px;">${escapeHtml(lead.ip_address || 'unknown')}</td></tr>
          </table>
        </div>

        <h3 style="margin: 18px 0 8px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em; color: #475569;">Quiz Answers Breakdown</h3>
        <table style="width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px;">
          <thead>
            <tr style="background: #f1f5f9; text-align: left;">
              <th style="padding: 8px 10px; border-bottom: 1px solid #cbd5e1; color: #475569;">Question</th>
              <th style="padding: 8px 10px; border-bottom: 1px solid #cbd5e1; color: #475569;">Response</th>
            </tr>
          </thead>
          <tbody>
            ${answersHtml || '<tr><td colspan="2" style="padding:10px;color:#94a3b8;text-align:center;">No answers supplied</td></tr>'}
          </tbody>
        </table>

        <div style="margin-top: 24px; text-align: center;">
          <a href="mailto:${escapeHtml(lead.email)}?subject=Your%20Lead%20Leak%20Audit%20Results%20(${lead.score}%2F100)" style="display: inline-block; background: #ea580c; color: #fff; text-decoration: none; font-weight: 700; padding: 12px 20px; border-radius: 8px; font-size: 14px;">Reply to Prospect</a>
        </div>
      </div>
    </div>
  `;

  if (!url) {
    console.log(`[AUDIT NOTIFICATION LOG] To: ${targetEmail} | Lead: ${lead.email} | Score: ${lead.score} (GMAIL_HTTP_URL not configured)`);
    return { sent: false, reason: 'relay_unconfigured', recipient: targetEmail };
  }

  // Dispatch via Apps Script relay
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(url);
      const payload = JSON.stringify({
        key: key,
        to: targetEmail,
        subject: subject,
        html: htmlBody,
        name: 'Master Hustle Engine Audit Bot'
      });

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log(`[AUDIT NOTIFICATION DISPATCHED] To: ${targetEmail} for ${lead.email} (HTTP ${res.statusCode})`);
          resolve({ sent: true, statusCode: res.statusCode, recipient: targetEmail });
        });
      });

      req.on('error', (err) => {
        console.warn(`[AUDIT NOTIFICATION WARNING] Relay error: ${err.message}`);
        resolve({ sent: false, error: err.message, recipient: targetEmail });
      });

      req.on('timeout', () => {
        req.destroy();
        console.warn(`[AUDIT NOTIFICATION TIMEOUT] Relay timed out`);
        resolve({ sent: false, error: 'Relay timed out', recipient: targetEmail });
      });

      req.write(payload);
      req.end();
    } catch (e) {
      console.warn(`[AUDIT NOTIFICATION EXCEPTION] ${e.message}`);
      resolve({ sent: false, error: e.message, recipient: targetEmail });
    }
  });
}

function escapeHtml(str) {
  return String(str === null || str === undefined ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render admin HTML view
 */
function renderAdminAuditLeadsHtml(leads, totalCount, adminKey) {
  const rows = leads.map(l => {
    let answersPretty = '';
    try {
      const parsed = typeof l.answers === 'string' ? JSON.parse(l.answers) : l.answers;
      answersPretty = Object.entries(parsed)
        .map(([k, v]) => `<div style="margin-bottom:2px;"><strong>${escapeHtml(k)}:</strong> <span style="color:#cbd5e1;">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</span></div>`)
        .join('');
    } catch (_) {
      answersPretty = escapeHtml(l.answers || '—');
    }

    const scoreColor = l.score >= 75 ? '#4ade80' : l.score >= 50 ? '#fb923c' : '#f87171';

    return `
      <tr>
        <td style="font-family:monospace;color:#94a3b8;">#${l.id}</td>
        <td style="white-space:nowrap;color:#94a3b8;font-size:0.82rem;">${escapeHtml(l.created_at || '—')}</td>
        <td><strong>${escapeHtml(l.name || '—')}</strong></td>
        <td><a href="mailto:${escapeHtml(l.email)}" style="color:#38bdf8;text-decoration:none;">${escapeHtml(l.email)}</a></td>
        <td>${escapeHtml(l.business || '—')}</td>
        <td style="text-align:center;">
          <span style="display:inline-block;padding:2px 8px;border-radius:999px;font-weight:800;background:rgba(255,255,255,0.06);color:${scoreColor};border:1px solid ${scoreColor};">
            ${l.score}/100
          </span>
        </td>
        <td style="font-size:0.8rem;max-width:340px;word-break:break-word;">${answersPretty || '—'}</td>
        <td style="font-family:monospace;font-size:0.75rem;color:#64748b;">${escapeHtml(l.ip_address || '—')}</td>
      </tr>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Audit Leads Admin | Master Hustle Engine</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0b0d10; color: #e6e8eb; line-height: 1.5; }
    main { max-width: 1280px; margin: 0 auto; padding: 28px 20px 60px; }
    header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #1f242c; }
    h1 { font-size: 1.4rem; margin: 0; font-weight: 800; }
    .badge { background: #ea580c; color: #fff; font-size: 0.8rem; font-weight: 700; padding: 3px 10px; border-radius: 999px; }
    .stats { display: flex; gap: 14px; }
    .stat-box { background: #12151a; border: 1px solid #1f242c; border-radius: 10px; padding: 12px 18px; }
    .stat-val { font-size: 1.5rem; font-weight: 800; color: #fff; }
    .stat-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8a919c; }
    .table-wrap { overflow-x: auto; background: #12151a; border: 1px solid #1f242c; border-radius: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; text-align: left; }
    th { background: #181c22; color: #8a919c; font-weight: 700; font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.04em; padding: 12px 14px; border-bottom: 1px solid #1f242c; }
    td { padding: 12px 14px; border-bottom: 1px solid #1f242c; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .empty { padding: 48px 16px; text-align: center; color: #8a919c; font-size: 1rem; }
    .nav-links a { color: #8a919c; text-decoration: none; font-size: 0.88rem; margin-left: 14px; }
    .nav-links a:hover { color: #fff; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div style="display:flex;align-items:center;gap:10px;">
          <h1>Lead Leak Audit Captures</h1>
          <span class="badge">Admin Only</span>
        </div>
        <p style="margin:4px 0 0;font-size:0.86rem;color:#8a919c;">Live leads captured via POST /api/audit-lead</p>
      </div>
      <div class="nav-links">
        <a href="/admin/status?key=${encodeURIComponent(adminKey || '')}">System Status</a>
        <a href="/report?key=${encodeURIComponent(adminKey || '')}">Client Reports</a>
        <a href="/savings?key=${encodeURIComponent(adminKey || '')}">Router Savings</a>
      </div>
    </header>

    <div class="stats" style="margin-bottom:20px;">
      <div class="stat-box">
        <div class="stat-val">${totalCount}</div>
        <div class="stat-label">Total Leads Captured</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${leads.length}</div>
        <div class="stat-label">Showing Most Recent</div>
      </div>
    </div>

    <div class="table-wrap">
      ${leads.length === 0 ? `
        <div class="empty">No audit leads have been captured yet. Submissions from <code>/audit</code> will appear here automatically.</div>
      ` : `
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Date</th>
              <th>Name</th>
              <th>Email</th>
              <th>Business</th>
              <th>Score</th>
              <th>Answers Breakdown</th>
              <th>IP Address</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      `}
    </div>
  </main>
</body>
</html>`;
}

module.exports = {
  getDatabase,
  isValidEmail,
  checkRateLimit,
  resetRateLimit,
  saveAuditLead,
  getAuditLeads,
  getAuditLeadCount,
  sendAuditNotification,
  renderAdminAuditLeadsHtml
};
