/**
 * server.js
 * 
 * Unified Backend Engine (Antigravity Autonomous Master Engine)
 * Running on Express, node-cron, and SQLite.
 * 
 * Exposes manual webhook POST endpoints and an automated 8:00 AM daily cron rotation
 * for 9 niches:
 * 1. Vintage Flipper
 * 2. KDP Books
 * 3. Inventor Pitches
 * 4. Voice Prompts
 * 5. Review Replies
 * 6. Local SEO
 * 7. Marketplace Ads
 * 8. Faceless Videos
 * 9. Client Proposals
 */

require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenAI } = require('@google/genai');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const Stripe = require('stripe');
const https = require('https');

// Environment audit runs before anything else touches process.env so the safe
// defaults it applies (PORT, send caps, batch sizing) are in place for the
// module-level config reads below.
const { auditEnv } = require('./config/env');
const ENV_REPORT = auditEnv();

// Single pricing authority — never hardcode a dollar figure in this file.
const { PRICING, quotableOffer } = require('./config/pricing');

// Stripe's constructor throws on a missing key, which used to take the whole
// process down at require time. Degrade instead: the webhook route returns 503
// and every other feature — cron, outreach, admin — keeps running.
const stripe = ENV_REPORT.features.stripe ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl === '/api/stripe-webhook') req.rawBody = buf;
  }
}));

const PORT = parseInt(process.env.PORT || '3005', 10);
// SQLite lives on the Render persistent disk so the suppression list, queues,
// and send history survive deploys. /data is the primary mount point; /var/data
// is also detected in case the disk was mounted there. A candidate only wins if
// it exists AND is writable, so a bad mount degrades to the next option instead
// of crashing. Final fallback is a repo-local file (local dev; ephemeral).
function pickDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  for (const dir of ['/data', '/var/data']) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) { /* not mounted or not writable — try next */ }
  }
  return '';
}
const DATA_DIR = pickDataDir();
const DB_PATH = process.env.DB_PATH ||
  (DATA_DIR ? path.join(DATA_DIR, 'my_database.db') : path.join(__dirname, 'transactions.sqlite'));
console.log(`[SQLite] Database path: ${DB_PATH}${DATA_DIR ? ' (persistent disk)' : ' (EPHEMERAL — no persistent disk found)'}`);

// B2B Sales Engine Config
const B2B_DEPLOYER_NAME  = process.env.INVENTOR_NAME || '';
const B2B_DEPLOYER_EMAIL = process.env.INVENTOR_EMAIL || process.env.ADMIN_EMAIL || '';
const B2B_OFFER_NAME     = process.env.INVENTION_NAME || PRICING.offerName;
const B2B_OFFER_SUMMARY  = process.env.INVENTION_SUMMARY || '';
const B2B_PROOF_URL      = process.env.PROOF_URL || 'https://master-hustle-engine.onrender.com/pitch';
// Monthly license fee. Sourced from config/pricing.json — DEPLOYMENT_FEE is kept
// only so an existing Render env var doesn't silently change the price on deploy.
const B2B_DEPLOYMENT_FEE = process.env.DEPLOYMENT_FEE || String(PRICING.monthly);
const B2B_PAYMENT_LINK   = process.env.STRIPE_PAYMENT_LINK || '';
const B2B_BATCH_HOURS    = parseInt(process.env.BATCH_INTERVAL_HOURS || '6');
// Warming cap: a new sending account tolerates 3-4 cold emails/day. Overflow is
// not dropped — it stays 'pending' in leads_queue and goes out on later batches.
const B2B_BATCH_SIZE     = parseInt(process.env.BATCH_SIZE || '4');
const B2B_INDUSTRIES     = (process.env.TARGET_INDUSTRIES ||
  'digital marketing agency,lead generation agency,marketing agency,seo agency,ppc agency,social media agency,growth agency,advertising agency')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Initialize SQLite database with the logs table
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[SQLite] Connection error:', err.message);
  } else {
    console.log('[SQLite] Connected to transactions database.');
    db.run(`CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_type TEXT,
      asset_generated TEXT,
      status TEXT,
      buyer_email TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS leads_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name  TEXT    NOT NULL,
      contact_email TEXT    NOT NULL,
      website       TEXT,
      industry      TEXT,
      phone         TEXT,
      status        TEXT    NOT NULL DEFAULT 'pending',
      added_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at  DATETIME,
      campaign      TEXT    DEFAULT '',
      first_name    TEXT    DEFAULT ''
    )`, () => {
      // Existing production DBs predate these columns — ALTER fails harmlessly when they exist.
      // Chained in the CREATE callback because sqlite3 runs queued statements in parallel.
      db.run(`ALTER TABLE leads_queue ADD COLUMN campaign TEXT DEFAULT ''`, () => {});
      db.run(`ALTER TABLE leads_queue ADD COLUMN first_name TEXT DEFAULT ''`, () => {});
    });
    db.run(`CREATE TABLE IF NOT EXISTS follow_ups (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id   TEXT    NOT NULL,
      company_name  TEXT    NOT NULL,
      contact_email TEXT    NOT NULL,
      step          INTEGER NOT NULL,
      subject       TEXT    NOT NULL,
      body          TEXT    NOT NULL,
      due_at        TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at       DATETIME
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS send_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      sent_to   TEXT    NOT NULL,
      campaign  TEXT,
      sent_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS do_not_contact (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      email    TEXT    NOT NULL UNIQUE,
      reason   TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS audit_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_timestamp TEXT    NOT NULL,
      skill_name          TEXT    NOT NULL,
      lead_id             TEXT,
      input_source        TEXT,
      operational_status  TEXT    NOT NULL,
      key_decisions       TEXT,
      error_message       TEXT,
      duration_ms         INTEGER,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // Records every time the primary Gemini model failed over to the intelligent
    // router pool — outcome is 'succeeded' or 'failed'. Powers the daily status email
    // so you can see whether the failover is actually firing (and earning its keep).
    db.run(`CREATE TABLE IF NOT EXISTS router_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      outcome   TEXT    NOT NULL,
      detail    TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

// Setup Nodemailer SMTP Transporter (fallback only — Render blocks outbound SMTP,
// so GMAIL_HTTP_URL/GMAIL_HTTP_KEY below is the path that actually works there)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Optional custom sender identity (a verified alias address). The relay's
// Apps Script must pass these through to GmailApp.sendEmail as {from, name}, and
// FROM_EMAIL must be a verified "Send mail as" alias on the relay's Google account
// — otherwise Gmail silently sends from the account's primary address.
const FROM_EMAIL = process.env.FROM_EMAIL || '';
const FROM_NAME  = process.env.FROM_NAME  || 'Jack Bockholdt';

// Send email via the Gmail HTTPS relay (Apps Script) if configured, else raw SMTP.
// The relay always returns HTTP 200 with {"success": bool, ...} — check the body, not the status.
async function sendEmailViaRelayOrSmtp(to, subject, htmlOrText) {
  const relayUrl = process.env.GMAIL_HTTP_URL;
  if (relayUrl) {
    const payload = { key: process.env.GMAIL_HTTP_KEY, to, subject, body: htmlOrText };
    if (FROM_EMAIL) { payload.from = FROM_EMAIL; payload.fromName = FROM_NAME; }
    const res = await fetch(relayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Gmail relay HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.success) throw new Error(`Gmail relay error: ${data.error || 'unknown'}`);
    return;
  }
  await transporter.sendMail({
    from: `"${FROM_NAME}" <${FROM_EMAIL || process.env.SMTP_USER}>`,
    to,
    subject,
    html: htmlOrText,
  });
}

// Reusable SQLite logging helper
function logTransaction(email, productType, status, assets = '') {
  db.run(
    `INSERT INTO logs (buyer_email, product_type, status, asset_generated) VALUES (?, ?, ?, ?)`,
    [email, productType, status, typeof assets === 'string' ? assets : JSON.stringify(assets)],
    (err) => {
      if (err) console.error('[SQLite] Failed to log transaction:', err.message);
    }
  );
}

// Reusable Helper: Send HTML email via the Gmail relay (or SMTP fallback)
async function sendHtmlEmail(to, subject, htmlContent) {
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      await sendEmailViaRelayOrSmtp(to, subject, htmlContent);
      console.log(`[Email] Sent successfully to ${to} (Attempt ${attempts})`);
      return true;
    } catch (err) {
      console.warn(`[Email] Attempt ${attempts} failed to send email to ${to}:`, err.message);
      if (attempts === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Reusable Helper: Send Error Alert to Admin with Full Stack Trace
async function sendAdminAlert(context, errorStack) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn('[Alert] No ADMIN_EMAIL defined in environment variables. Alert skipped.');
    return;
  }

  try {
    await sendEmailViaRelayOrSmtp(
      adminEmail,
      `🚨 Antigravity Engine Failure: ${context}`,
      `
        <div style="font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 25px; border: 1px solid #fda4af; background-color: #fff1f2; color: #9f1239; border-radius: 12px; max-width: 700px; margin: 0 auto; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
          <h2 style="margin-top: 0; font-size: 20px; font-weight: 700; color: #e11d48; display: flex; align-items: center; gap: 8px;">🚨 System Processing Failure Alert</h2>
          <p style="font-size: 15px; margin: 10px 0;"><strong>Context:</strong> <span style="color: #4c0519;">${context}</span></p>
          <p style="font-size: 15px; margin: 10px 0;"><strong>Time (Server):</strong> ${new Date().toISOString()}</p>
          <hr style="border: 0; border-top: 1px solid #fecdd3; margin: 20px 0;" />
          <h3 style="margin-top: 0; font-size: 16px; font-weight: 600; color: #be123c;">Full Stack Trace:</h3>
          <pre style="background: #ffe4e6; padding: 15px; border-radius: 8px; font-family: 'Courier New', Courier, monospace; font-size: 13px; white-space: pre-wrap; overflow-x: auto; border: 1px solid #fecdd3; color: #881337; line-height: 1.5;">${errorStack}</pre>
        </div>
      `
    );
    console.log('[Alert] Admin failure email sent successfully.');
  } catch (alertErr) {
    console.error('[Alert] Failed to send admin alert email:', alertErr.message);
  }
}

// Reusable Helper: Notify admin of a completed White-Label License purchase
// (the single White-Label offer — sold via a Stripe Payment Link with no
// "niche" metadata; the legacy niche product line is retired).
async function notifyAdminOfLicensePurchase(session, buyerEmail) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn('[Alert] No ADMIN_EMAIL defined in environment variables. Purchase notification skipped.');
    return;
  }
  const amount = session.amount_total != null ? (session.amount_total / 100).toFixed(2) : 'unknown';
  const currency = (session.currency || 'usd').toUpperCase();
  const buyerName = session.customer_details?.name || '(not provided)';

  try {
    await sendEmailViaRelayOrSmtp(
      adminEmail,
      `💰 New White-Label License Purchase — ${buyerEmail}`,
      `
        <div style="font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 25px; border: 1px solid #86efac; background-color: #f0fdf4; color: #14532d; border-radius: 12px; max-width: 700px; margin: 0 auto;">
          <h2 style="margin-top: 0; font-size: 20px; font-weight: 700; color: #16a34a;">💰 New White-Label AI Infrastructure License Purchase</h2>
          <p style="font-size: 15px; margin: 10px 0;"><strong>Buyer email:</strong> ${buyerEmail}</p>
          <p style="font-size: 15px; margin: 10px 0;"><strong>Buyer name:</strong> ${buyerName}</p>
          <p style="font-size: 15px; margin: 10px 0;"><strong>Amount:</strong> ${amount} ${currency}</p>
          <p style="font-size: 15px; margin: 10px 0;"><strong>Stripe session:</strong> ${session.id}</p>
          <p style="font-size: 15px; margin: 10px 0;"><strong>Time (Server):</strong> ${new Date().toISOString()}</p>
          <hr style="border: 0; border-top: 1px solid #bbf7d0; margin: 20px 0;" />
          <p style="font-size: 15px; margin: 10px 0;">Manual onboarding needed — reach out to the buyer to hand off white-label access.</p>
        </div>
      `
    );
    console.log('[Alert] Admin license-purchase notification sent successfully.');
  } catch (alertErr) {
    console.error('[Alert] Failed to send admin license-purchase notification:', alertErr.message);
  }
}

// Reusable Helper: Confirm the purchase to the buyer and set onboarding expectations.
async function sendLicenseWelcomeEmail(buyerEmail) {
  const deployerEmail = B2B_DEPLOYER_EMAIL || process.env.ADMIN_EMAIL || '';
  const emailHtml = `
    <div style="font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 25px; border: 1px solid #e5e7eb; background-color: #ffffff; color: #111827; border-radius: 12px; max-width: 700px; margin: 0 auto;">
      <h2 style="margin-top: 0; font-size: 20px; font-weight: 700; color: #111827;">You're in — welcome to the ${B2B_OFFER_NAME}</h2>
      <p style="font-size: 15px; line-height: 1.6;">Thanks for signing up. Your subscription is active.</p>
      <p style="font-size: 15px; line-height: 1.6;">Jack will personally reach out within 24 hours to hand off your white-label access and walk through onboarding. In the meantime, here's the proof page again for reference: <a href="${B2B_PROOF_URL}">${B2B_PROOF_URL}</a></p>
      <p style="font-size: 15px; line-height: 1.6;">Questions in the meantime? Just reply to this email${deployerEmail ? ` or reach out directly at ${deployerEmail}` : ''}.</p>
    </div>
  `;
  await sendHtmlEmail(buyerEmail, `Welcome to the ${B2B_OFFER_NAME}`, emailHtml);
}

// 3-Tier Intelligent Router — auto-loaded, used by callGemini for 429 fallback
const { routePrompt } = require('./agent.skills/intelligent-router');

// Reusable Helper: Call Gemini API with Retries and JSON parsing validation
// taskLabel is a short identifier for the caller ('pitch-email',
// 'followup-email', 'call-classify') and appears in the success log so a
// noisy run can be traced back to the code path that made the call.
async function callGemini(prompt, systemInstruction, taskLabel) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not defined in the environment.');
  }

  const ai = new GoogleGenAI({ apiKey });
  let parsedResponse = null;
  let attempts = 0;
  const maxAttempts = 2; // Strict try + 1 retry
  let lastError = null;

  const primaryModel  = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  // Retry on the flash-lite tier — when flash is congested (503 high demand),
  // retrying the same model just fails again; lite runs on separate capacity.
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest';

  while (attempts < maxAttempts && !parsedResponse) {
    attempts++;
    try {
      console.log(`[Gemini] Attempting content generation (Try ${attempts}/${maxAttempts})...`);

      const response = await ai.models.generateContent({
        model: attempts === 1 ? primaryModel : fallbackModel,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });

      const textOutput = response.text ? response.text.trim() : '';
      if (!textOutput) throw new Error('Empty response returned from Gemini.');

      const json = JSON.parse(textOutput);
      
      parsedResponse = json;
      console.log(`[Gemini] Generated response for '${taskLabel}'.`);
    } catch (err) {
      console.warn(`[Gemini] Attempt ${attempts} failed:`, err.message);
      lastError = err;
      // On rate limit or transient unavailability, try the router fallback pool immediately
      const isTransient = err.status === 429 || err.status === 503 ||
        /rate.?limit|quota|too many|high demand|unavailable/i.test(err.message);
      if (isTransient) {
        console.warn('[Gemini] Transient error hit — delegating to intelligent router fallback');
        try {
          const fullPrompt = systemInstruction ? `${systemInstruction}\n\n${prompt}` : prompt;
          const routerText = await routePrompt(fullPrompt);
          const json = JSON.parse(routerText.replace(/```json|```/g, '').trim());
          parsedResponse = json;
          console.log('[Router] Fallback succeeded');
          await logRouterEvent('succeeded', err.message);
          break;
        } catch (routerErr) {
          console.error('[Router] Fallback also failed:', routerErr.message);
          await logRouterEvent('failed', routerErr.message);
        }
      }
      if (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  if (!parsedResponse) {
    throw lastError; // Throw the actual error so caller can report stack trace
  }

  return parsedResponse;
}

// Helper to wrap async routes for global error handling
function wrapAsync(fn) {
  return function (req, res, next) {
    fn(req, res, next).catch(next);
  };
}

// Admin Route: View Logs
app.get('/api/admin/logs', (req, res) => {
  db.all('SELECT * FROM logs ORDER BY timestamp DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.status(200).json({ logs: rows });
  });
});

// =============================================================================
// STRIPE WEBHOOK — White-Label License purchase → notify + welcome
// =============================================================================

app.post('/api/stripe-webhook', async (req, res) => {
  // Degraded mode: no STRIPE_SECRET_KEY means no client to verify with. Say so
  // explicitly — Stripe retries a 503, so nothing is lost once the key is set.
  if (!stripe) {
    console.warn('[Stripe Webhook] Received a webhook but STRIPE_SECRET_KEY is not set — cannot verify signature.');
    return res.status(503).json({ error: 'Stripe is not configured on this instance.' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const buyerEmail = session.customer_details?.email;
    const niche = session.metadata?.niche;

    const fields = {};
    if (Array.isArray(session.custom_fields)) {
      session.custom_fields.forEach(f => {
        fields[f.key] = f.text?.value || '';
      });
    }

    console.log(`[Stripe Webhook] Purchase complete — niche: ${niche || '(none — license purchase)'}, buyer: ${buyerEmail}`);

    if (!buyerEmail) {
      console.error('[Stripe Webhook] Missing buyer email in session:', session.id);
      return res.json({ received: true });
    }

    if (niche) {
      // The legacy one-off niche products are retired — there is no generator
      // left to fulfil this. No live payment link sets metadata.niche, so
      // arriving here means a stale link or a hand-built session. Do NOT fall
      // through to license onboarding: a niche purchase is not a license
      // purchase, and sending a welcome email for a product they did not buy
      // is worse than sending nothing. Alert for manual handling instead.
      console.warn(`[Stripe Webhook] Purchase carried retired niche '${niche}' — no deliverable generated for ${buyerEmail}.`);
      logTransaction(buyerEmail, `retired:${niche}`, 'failure', JSON.stringify({ session: session.id, amount_total: session.amount_total }));
      sendAdminAlert(
        `Stripe purchase arrived with retired niche '${niche}'`,
        `Buyer: ${buyerEmail}\nSession: ${session.id}\n\nThe niche product line is retired and nothing was generated. Refund or fulfil manually, then remove the niche metadata from that payment link.`
      ).catch(() => { /* best-effort — never mask the original event */ });
    } else {
      // No "niche" metadata means this came through the White-Label Agency AI
      // Infrastructure payment link (see config/pricing.js), not one of the
      // legacy one-off niche tools. Notify Jack for manual onboarding and
      // confirm receipt to the buyer.
      logTransaction(buyerEmail, 'white-label-license', 'success', JSON.stringify({ session: session.id, amount_total: session.amount_total }));
      Promise.all([
        notifyAdminOfLicensePurchase(session, buyerEmail),
        sendLicenseWelcomeEmail(buyerEmail),
      ]).catch(async (err) => {
        console.error('[Stripe Webhook] License purchase notification error:', err);
        await sendAdminAlert(`License purchase notification failed — buyer: ${buyerEmail}`, err.stack || err.message);
      });
    }
  }

  res.json({ received: true });
});

// =============================================================================
// B2B SALES ENGINE — OpenPhone SMS, Lead Queue, Invention Outreach
// =============================================================================

// Low-level HTTPS POST helper (no extra dependencies)
function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Send SMS via OpenPhone API
async function sendSms(to, body) {
  const apiKey = process.env.OPENPHONE_API_KEY;
  const from = process.env.OPENPHONE_FROM_NUMBER;
  if (!apiKey) {
    console.warn('[SMS] OPENPHONE_API_KEY not configured — skipping SMS to', to);
    return;
  }
  const res = await httpsPost(
    'https://api.openphone.com/v1/messages',
    { content: body, from, to: [to] },
    { Authorization: apiKey }
  );
  if (![200, 201, 202].includes(res.status)) {
    throw new Error(`OpenPhone ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

// Send plain-text pitch email — routes through Gmail HTTPS relay first (bypasses Render's SMTP block),
// falls back to direct SMTP only if relay is not configured.
async function sendPitchEmail(toEmail, subject, body, campaignId = '') {
  // No mailer configured — fail loudly but with a typed error the schedulers can
  // recognise, so a queued lead stays pending instead of being burned as 'failed'.
  if (!ENV_REPORT.features.outboundEmail) {
    const err = new Error('Outbound email is not configured (set GMAIL_HTTP_URL or SMTP_USER + SMTP_PASS).');
    err.code = 'MAILER_NOT_CONFIGURED';
    throw err;
  }
  await sendEmailViaRelayOrSmtp(toEmail, subject, body);
  await dbRun('INSERT INTO send_log (sent_to, campaign) VALUES (?, ?)', [toEmail, campaignId])
    .catch(err => console.warn('[Send Log] Failed to record send:', err.message));
  console.log(`[Pitch Email] Sent → ${toEmail} | ${subject}`);
}

// Shared daily outbound cap — counts every pitch/follow-up send across ALL campaigns,
// so adding a campaign never doubles total volume. Follow-ups and queued leads that
// hit the cap stay pending and go out on later runs.
// Counts every outbound send for the day, follow-ups included — they leave the
// same mailbox and carry the same reputation risk as a first-touch pitch.
const DAILY_SEND_CAP = parseInt(process.env.DAILY_SEND_CAP || '4');

async function sendsToday() {
  const row = await dbGetOne(
    "SELECT COUNT(*) AS c FROM send_log WHERE sent_at >= datetime('now', 'start of day')"
  );
  return row ? row.c : 0;
}

// Records a router-fallback event (outcome 'succeeded' | 'failed'). Best-effort —
// never let telemetry failure break a live generation.
async function logRouterEvent(outcome, detail = '') {
  await dbRun('INSERT INTO router_events (outcome, detail) VALUES (?, ?)', [outcome, detail])
    .catch(err => console.warn('[Router Event] Failed to record:', err.message));
}

async function underDailyCap() {
  return (await sendsToday()) < DAILY_SEND_CAP;
}

// Do-not-contact (suppression) list — checked before EVERY outbound pitch/follow-up
// send, on every campaign. Adding an email also cancels its pending follow-ups and
// queued leads immediately, so a "stop" reply mid-sequence halts steps 2/3.
function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

async function isDoNotContact(email) {
  const row = await dbGetOne('SELECT 1 FROM do_not_contact WHERE email = ?', [normalizeEmail(email)]);
  return !!row;
}

async function addDoNotContact(email, reason) {
  const e = normalizeEmail(email);
  if (!e || !e.includes('@')) return { email: e, added: false, error: 'invalid email' };
  await dbRun('INSERT OR IGNORE INTO do_not_contact (email, reason) VALUES (?, ?)', [e, reason || '']);
  const fu = await dbRun(
    "UPDATE follow_ups SET status='suppressed', sent_at=CURRENT_TIMESTAMP WHERE contact_email = ? AND status='pending'", [e]
  );
  const lq = await dbRun(
    "UPDATE leads_queue SET status='suppressed', processed_at=CURRENT_TIMESTAMP WHERE contact_email = ? AND status='pending'", [e]
  );
  console.log(`[DNC] Added ${e} — cancelled ${fu.changes} pending follow-ups, ${lq.changes} queued leads`);
  return { email: e, added: true, follow_ups_cancelled: fu.changes, queued_leads_cancelled: lq.changes };
}

async function removeDoNotContact(email) {
  const e = normalizeEmail(email);
  const result = await dbRun('DELETE FROM do_not_contact WHERE email = ?', [e]);
  return { email: e, removed: result.changes > 0 };
}

// Promise wrappers around SQLite callbacks
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function dbGetOne(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

// Lead queue DB helpers
async function queueLeads(leads) {
  let inserted = 0;
  for (const lead of leads) {
    const email = (lead.contact_email || '').trim().toLowerCase();
    if (!email) continue;
    const invalid = validateLeadFields({ ...lead, contact_email: email });
    if (invalid) {
      console.warn(`[Lead Queue] Rejected lead on import: ${invalid}`);
      continue;
    }
    const lowQuality = screenLeadQuality({ ...lead, contact_email: email });
    if (lowQuality) {
      console.warn(`[Lead Queue] Rejected lead on import (${email}): ${lowQuality}`);
      continue;
    }
    const exists = await dbGetOne('SELECT 1 FROM leads_queue WHERE contact_email = ?', [email]);
    if (exists) continue;
    await dbRun(
      'INSERT INTO leads_queue (company_name, contact_email, website, industry, phone, campaign, first_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [lead.company_name || '', email, lead.website || '', lead.industry || '', lead.phone || '', lead.campaign || '', lead.first_name || '']
    );
    inserted++;
  }
  return inserted;
}

async function fetchPendingLeads(limit) {
  return dbAll(
    "SELECT id, company_name, contact_email, website, industry, phone, campaign, first_name FROM leads_queue WHERE status = 'pending' ORDER BY id ASC LIMIT ?",
    [limit || B2B_BATCH_SIZE]
  );
}

async function markLead(id, status) {
  await dbRun('UPDATE leads_queue SET status=?, processed_at=CURRENT_TIMESTAMP WHERE id=?', [status, id]);
}

async function queueStats() {
  const rows = await dbAll('SELECT status, COUNT(*) as count FROM leads_queue GROUP BY status');
  const stats = { pending: 0, sent: 0, disqualified: 0, failed: 0 };
  for (const row of rows) stats[row.status] = (row.count || 0);
  return stats;
}

async function queueFollowUp(campaignId, companyName, contactEmail, step, subject, body, dueAt) {
  await dbRun(
    'INSERT INTO follow_ups (campaign_id, company_name, contact_email, step, subject, body, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [campaignId, companyName, contactEmail, step, subject, body, dueAt.toISOString()]
  );
}

async function fetchDueFollowUps(limit) {
  const now = new Date().toISOString();
  return dbAll(
    "SELECT id, campaign_id, company_name, contact_email, step, subject, body FROM follow_ups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?",
    [now, limit || 25]
  );
}

async function markFollowUp(id, status) {
  await dbRun('UPDATE follow_ups SET status=?, sent_at=CURRENT_TIMESTAMP WHERE id=?', [status, id]);
}

async function followUpStats() {
  const rows = await dbAll('SELECT status, COUNT(*) as count FROM follow_ups GROUP BY status');
  const stats = { pending: 0, sent: 0, failed: 0 };
  for (const row of rows) stats[row.status] = (row.count || 0);
  return stats;
}

// Normalize US phone number to E.164 (+1XXXXXXXXXX)
function toE164(phone) {
  if (!phone) return phone;
  if (phone.startsWith('+') && /^\+\d{11,}$/.test(phone)) return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone;
}

// Payload validation — catches unresolved scraper merge variables (e.g. Gumloop's
// "${Valid Emails__NODE_ID__:...}") and malformed addresses at the door, before
// any Gemini call or send attempt.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLACEHOLDER_RE = /\$\{[^}]*\}|\{\{[^}]*\}\}/;

function validateLeadFields(lead) {
  for (const field of ['company_name', 'contact_email', 'website', 'industry', 'first_name', 'phone']) {
    const val = lead[field];
    if (typeof val === 'string' && PLACEHOLDER_RE.test(val)) {
      return `field '${field}' contains an unresolved template placeholder: ${val}`;
    }
  }
  if (!EMAIL_RE.test((lead.contact_email || '').trim())) {
    return `contact_email '${lead.contact_email}' is not a valid email address`;
  }
  return null;
}

// Filter leads by target industry list
function qualifyLead(companyName, industry) {
  if (!industry) return { qualified: true, reason: 'industry not provided — passing through' };
  const ind = industry.trim().toLowerCase();
  for (const q of B2B_INDUSTRIES) {
    if (q.includes(ind) || ind.includes(q)) return { qualified: true, reason: `matched: ${q}` };
  }
  return { qualified: false, reason: `industry '${industry}' not in qualified list` };
}

// Generate AI cold pitch email copy for one company
async function generatePitchCopy(company, deployerName, deployerEmail, proofUrl, fee, offerName, offerSummary) {
  const ctaLinks = `proof link: ${proofUrl}${B2B_PAYMENT_LINK ? ' and payment/booking link: ' + B2B_PAYMENT_LINK : ''} and contact email ${deployerEmail}`;
  const systemInstruction = (
    'You are an elite B2B sales copywriter. Write a cold outreach email selling a white-label AI infrastructure license to a marketing/lead-gen agency owner who will resell it to their own local business clients. ' +
    'Return JSON only: {"subject":"string max 60 chars","body":"string max 220 words"}. ' +
    'Rules: 1. The body MUST name the target company. 2. Frame this as a REVENUE LINE for their agency, not a tech purchase. ' +
    '3. Lead with the math: resell to 3-5 clients at $500-$1,000/month each covers the license; everything after is pure margin. ' +
    '4. Present the offer as a complete 9-skill AI infrastructure backend (call catching, voice agent, lead sorting, web pages, email handling) they can resell tonight — no dev team, no build time. ' +
    '5. Include exactly 3 value bullets: (a) the resell math/break-even, (b) zero dev/maintenance burden, (c) sticky recurring revenue. ' +
    `6. End CTA: request a 15-min screen-share demo. Close with ${ctaLinks}. ` +
    '7. No buzzwords, no hype. Direct, peer-to-peer, confident tone. ' +
    `8. PRICING IS FIXED — there is exactly one offer: ${PRICING.display.headline}. ` +
    'If you mention price at all, state it in exactly those terms. Never invent a discount, ' +
    'a free trial, a waived setup fee, a tiered menu, or any other number.'
  );
  const prompt = `Deployer: ${deployerName}. Offer: ${offerName}. Summary: ${offerSummary}. Price: ${PRICING.display.headline}. Monthly fee: $${fee}. Target company: ${company}.`;
  const pitch = await callGemini(prompt, systemInstruction, 'pitch-email');
  if (!(pitch.body || '').toLowerCase().includes(company.toLowerCase())) {
    pitch.body = `I'm reaching out to ${company} specifically because ${pitch.body}`;
  }
  pitch.body = (pitch.body || '').replace('{{DEPLOYER_EMAIL}}', deployerEmail);
  return pitch;
}

// Generate Day 5 (step 2) or Day 10 (step 3) follow-up copy
async function generateFollowupCopy(step, company, deployerName, deployerEmail, proofUrl, fee, offerName, offerSummary) {
  const angles = {
    2: 'Social proof follow-up. Share a believable, concrete example of another agency reselling this to local business clients and hitting break-even fast. Slightly stronger CTA than first touch.',
    3: 'Final follow-up. Give them permission to walk away, note this is the last email, and add light urgency about being first in their market. Offer to stop future emails on reply.',
  };
  const ctaLinks = `proof link: ${proofUrl}${B2B_PAYMENT_LINK ? ' and payment/booking link: ' + B2B_PAYMENT_LINK : ''} and contact email ${deployerEmail}`;
  const systemInstruction = (
    `You are an elite B2B sales copywriter writing follow-up email #${step} in a 3-email cold outreach sequence — the prospect has not replied yet. ` +
    'Return JSON only: {"subject":"string max 60 chars","body":"string max 180 words"}. ' +
    `${angles[step]} ` +
    'The body MUST name the target company. Frame the offer as a white-label AI infrastructure license the agency resells to its own local business clients as a new revenue line. ' +
    `Close with ${ctaLinks}. No buzzwords, no hype. Direct, peer-to-peer tone. ` +
    `PRICING IS FIXED — there is exactly one offer: ${PRICING.display.headline}. ` +
    'If you mention price at all, state it in exactly those terms. Never invent a discount, ' +
    'a free trial, a waived setup fee, a tiered menu, or any other number.'
  );
  const prompt = `Deployer: ${deployerName}. Offer: ${offerName}. Summary: ${offerSummary}. Price: ${PRICING.display.headline}. Monthly fee: $${fee}. Target company: ${company}.`;
  const result = await callGemini(prompt, systemInstruction, 'followup-email');
  return { subject: result.subject, body: result.body };
}

// Run full invention outreach: AI pitch → email lead → queue Day-5 and Day-10 follow-ups
async function runInventionOutreach(payload) {
  const offerName     = payload.invention_name    || B2B_OFFER_NAME;
  let   offerSummary  = payload.invention_summary || B2B_OFFER_SUMMARY;
  const deployerName  = payload.inventor_name     || B2B_DEPLOYER_NAME;
  const deployerEmail = payload.inventor_email    || B2B_DEPLOYER_EMAIL;
  const targetCos     = (payload.target_companies || []).slice(0, 5);
  const campaignId    = payload.campaign_id       || 'unknown';
  const proofUrl      = payload.proof_url         || B2B_PROOF_URL;
  const fee           = payload.deployment_fee    || B2B_DEPLOYMENT_FEE;
  const contactEmail  = payload.contact_email     || '';

  if ((offerSummary || '').split(' ').length < 10) {
    offerSummary = (
      `${offerName} is a complete, production-ready 9-skill AI infrastructure backend (call catching, voice agent, ` +
      `web page creation, lead sorting, email handling, and more) that agencies white-label under their own brand and ` +
      `resell to local business clients. ${PRICING.display.headline}. Agencies resell access to 3-5 clients ` +
      `at $500-$1,000/month each — break-even from month one, pure margin after. No dev team, no build time, no maintenance. Proof: ${proofUrl}`
    );
  }

  const companies = targetCos.length > 0 ? targetCos : ['a leading agency in this space'];
  const pitches = [];
  for (const company of companies) {
    const pitch = await generatePitchCopy(company, deployerName, deployerEmail, proofUrl, fee, offerName, offerSummary);
    pitch.company = company;
    pitches.push(pitch);
  }

  let emailSent = false;
  let emailError = '';
  if (contactEmail && pitches.length > 0) {
    try {
      await sendPitchEmail(contactEmail, pitches[0].subject, pitches[0].body);
      emailSent = true;
      const company = pitches[0].company;
      const now = new Date();
      for (const [step, days] of [[2, 5], [3, 10]]) {
        const { subject, body } = await generateFollowupCopy(step, company, deployerName, deployerEmail, proofUrl, fee, offerName, offerSummary);
        const dueAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
        await queueFollowUp(campaignId, company, contactEmail, step, subject, body, dueAt);
      }
      console.log(`[Invention Outreach] Pitch sent + follow-ups queued for ${contactEmail}`);
    } catch (err) {
      emailError = err.message;
      console.error('[Invention Outreach] Pitch email failed for', contactEmail, ':', err.message);
      await sendAdminAlert(`Pitch email FAILED — ${contactEmail}`, err.stack || err.message);
    }
  }

  return { campaign_id: campaignId, offer_name: offerName, deployer_name: deployerName, pitches, email_sent: emailSent, email_error: emailError };
}

// =============================================================================
// TEMPLATE CAMPAIGNS — fixed-copy sequences (no AI generation), same follow-up
// scheduler as the AI campaign: step 1 sends immediately, later steps are queued
// into follow_ups and dispatched by the hourly scheduler.
// =============================================================================

const TEMPLATE_CAMPAIGNS = {
  'antigravity-saas': {
    steps: [
      {
        step: 1,
        day: 0,
        subject: 'White-label AI services for {{company_name}}\'s clients?',
        body:
          'Hi {{first_name}},\n\n' +
          'I build an AI automation engine that agencies white-label and resell to their own clients under their own brand — document generation, content and media, and workflow automation.\n\n' +
          "Your clients get the AI services they're already asking for. You keep the margin. Zero dev work on your side — I handle the build and the hosting.\n\n" +
          'Agencies are charging clients around $500/mo for this and keeping most of it. Three clients and it pays for itself.\n\n' +
          'Worth 15 minutes to see it running under your brand?\n\n' +
          'Jack Bockholdt\n\n' +
          'P.S. Not interested? Reply "unsubscribe" and you won\'t hear from me again.',
      },
      {
        step: 2,
        day: 3,
        subject: 'Re: White-label AI services for {{company_name}}\'s clients?',
        body:
          'Hi {{first_name}},\n\n' +
          'Quick follow-up. The model is simple: you license the engine once, rebrand it as your own AI service, and sell it to your client roster at a monthly rate. You keep the margin — you never touch code.\n\n' +
          'For an agency whose clients are already asking about AI, that\'s new recurring revenue with no new headcount.\n\n' +
          'Happy to show you the live system running under a white-label demo.\n\n' +
          'Jack Bockholdt\n\n' +
          'P.S. Reply "unsubscribe" to opt out of future emails.',
      },
      {
        step: 3,
        day: 7,
        subject: 'Closing the loop',
        body:
          'Hi {{first_name}},\n\n' +
          "Last note from me. If reselling AI services to your clients isn't a priority this quarter, no problem.\n\n" +
          "If it is: I'm onboarding a limited number of agency partners now, and I'd rather it be you than a competitor in your market.\n\n" +
          'If timing changes, reply anytime.\n\n' +
          'Jack Bockholdt\n\n' +
          'P.S. Reply "unsubscribe" and I won\'t contact you again.',
      },
    ],
  },
};

function renderTemplate(step, ctx) {
  const fill = (s) => s
    .replace(/\{\{first_name\}\}/g, ctx.first_name)
    .replace(/\{\{company_name\}\}/g, ctx.company_name);
  return { subject: fill(step.subject), body: fill(step.body) };
}

// Send step 1 now, queue the remaining steps into the existing follow_ups table
async function runTemplateOutreach(campaignKey, lead) {
  const campaign = TEMPLATE_CAMPAIGNS[campaignKey];
  if (!campaign) throw new Error(`Unknown template campaign: ${campaignKey}`);
  const ctx = {
    first_name: (lead.first_name || '').trim() || 'there',
    company_name: lead.company_name || '',
  };
  const [initial, ...followUps] = campaign.steps;
  const rendered = renderTemplate(initial, ctx);
  await sendPitchEmail(lead.contact_email, rendered.subject, rendered.body, campaignKey);
  const now = Date.now();
  for (const step of followUps) {
    const r = renderTemplate(step, ctx);
    const dueAt = new Date(now + step.day * 24 * 60 * 60 * 1000);
    await queueFollowUp(campaignKey, lead.company_name || '', lead.contact_email, step.step, r.subject, r.body, dueAt);
  }
  console.log(`[Template Campaign] ${campaignKey} → ${lead.contact_email} | initial sent, ${followUps.length} follow-ups queued`);
  return { campaign_id: campaignKey, email_sent: true, follow_ups_queued: followUps.length };
}

// Run call catcher: classify missed call intent → send SMS text-back via OpenPhone
async function runCallCatcher(payload) {
  const rawPhone     = payload.caller_phone || payload.customer_phone || '';
  const callerPhone  = toE164(rawPhone);
  const transcript   = payload.voicemail_transcript || '';
  const businessName = payload.business_name || 'the team';

  if (!callerPhone || !callerPhone.startsWith('+')) {
    throw new Error(`ERR_PAYLOAD_INVALID: could not normalize '${rawPhone}' to E.164`);
  }

  let urgency = 'UNKNOWN';
  let primaryNeed = 'General Inquiry';
  try {
    const systemInstruction = 'Analyze the voicemail transcript and return JSON only: {"urgency":"HIGH|MEDIUM|LOW","primary_need":"string max 15 words","confidence":0.0}';
    const parsed = await callGemini(transcript || 'No voicemail left.', systemInstruction, 'call-classify');
    if (parseFloat(parsed.confidence || 0) >= 0.65) {
      urgency     = parsed.urgency      || 'UNKNOWN';
      primaryNeed = parsed.primary_need || 'General Inquiry';
    }
  } catch (err) {
    console.warn('[Call Catcher] LLM classification failed — using defaults:', err.message);
  }

  const smsBody = urgency === 'HIGH'
    ? `Hi! You called ${businessName}. We know this is urgent — someone calls you back within 15 min. Reply now if needed.`
    : `Hi! You called ${businessName}. We missed you but we're on it. We'll be in touch shortly — reply here if you need us now.`;

  await sendSms(callerPhone, smsBody.slice(0, 320));
  return { lead_id: callerPhone, urgency, primary_need: primaryNeed, sms_sent: true };
}

// Pull pending leads from SQLite and run invention outreach on each
async function processLeadQueue(batchSize) {
  const leads = await fetchPendingLeads(batchSize || B2B_BATCH_SIZE);
  if (!leads.length) {
    console.log('[Lead Queue] No pending leads.');
    return { processed: 0, sent: 0, disqualified: 0, suppressed: 0, failed: 0 };
  }
  let sent = 0, disq = 0, supp = 0, failed = 0;
  for (const lead of leads) {
    const { id, company_name, contact_email, industry } = lead;
    try {
      const invalidLead = validateLeadFields(lead);
      if (invalidLead) {
        await markLead(id, 'invalid');
        failed++;
        console.warn(`[Lead Queue] Marked lead ${id} invalid: ${invalidLead}`);
        continue;
      }
      const { qualified, reason } = qualifyLead(company_name, industry || '');
      if (!qualified) {
        await markLead(id, 'disqualified');
        disq++;
        console.log(`[Lead Queue] Disqualified ${company_name}: ${reason}`);
        continue;
      }
      const lowQuality = screenLeadQuality(lead);
      if (lowQuality) {
        await markLead(id, 'disqualified');
        disq++;
        console.log(`[Lead Queue] Disqualified ${company_name}: ${lowQuality}`);
        continue;
      }
      if (await isDoNotContact(contact_email)) {
        await markLead(id, 'suppressed');
        supp++;
        console.log(`[Lead Queue] Suppressed ${contact_email} (do-not-contact list)`);
        continue;
      }
      if (!(await underDailyCap())) {
        console.log(`[Lead Queue] Daily send cap (${DAILY_SEND_CAP}) reached — leaving remaining leads pending`);
        break;
      }
      if (lead.campaign && TEMPLATE_CAMPAIGNS[lead.campaign]) {
        await runTemplateOutreach(lead.campaign, lead);
      } else {
        await runInventionOutreach({ ...lead, target_companies: [company_name], contact_email });
      }
      await markLead(id, 'sent');
      sent++;
    } catch (err) {
      console.error(`[Lead Queue] Failed for ${contact_email}:`, err.message);
      await markLead(id, 'failed');
      failed++;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`[Lead Queue] Batch done — sent=${sent} disq=${disq} supp=${supp} failed=${failed}`);
  return { processed: leads.length, sent, disqualified: disq, suppressed: supp, failed };
}

// =============================================================================
// EMAIL FINDER — scrape a company website for a real contact email
// =============================================================================

const GENERIC_EMAIL_PREFIXES = ['info', 'hello', 'contact', 'support', 'team', 'admin', 'sales', 'hi', 'help', 'office', 'mail'];

// =============================================================================
// LEAD QUALITY SCREEN — keep the daily send cap pointed at real decision-makers
// =============================================================================

const ALLOW_FREEMAIL     = process.env.ALLOW_FREEMAIL === 'true';
const MAX_EMPLOYEE_COUNT = parseInt(process.env.MAX_EMPLOYEE_COUNT || '50', 10);
const BLOCKED_DOMAINS    = new Set((process.env.BLOCKED_DOMAINS || '')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean));

// Permanent do-not-send list — every address and domain that hard-bounced, was
// blocked by an admin, or whose domain is dead. Entries never come off. This is
// the file the outbound history is written into; see config/blocklist.json.
//
// A missing or unreadable file must NOT take the process down, but it does mean
// suppression is off, so it is logged loudly rather than swallowed. Sending to a
// known blocker is a spam signal against the account.
const BLOCKLIST_PATH = path.join(__dirname, 'config', 'blocklist.json');
const { blocklistAddresses: BLOCKLIST_ADDRESSES, blocklistDomains: BLOCKLIST_DOMAINS } = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(BLOCKLIST_PATH, 'utf8'));
    const addresses = new Map(Object.entries(raw.addresses || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const domains   = new Map(Object.entries(raw.domains   || {}).map(([k, v]) => [k.toLowerCase(), v]));
    console.log(`[Blocklist] Loaded ${addresses.size} address(es), ${domains.size} domain(s) from config/blocklist.json`);
    return { blocklistAddresses: addresses, blocklistDomains: domains };
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'file not found' : err.message;
    console.warn(`[Blocklist] ⚠️  NOT LOADED (${why}) — suppression by blocklist is OFF. ` +
                 `Known bad addresses will not be caught. Restore ${BLOCKLIST_PATH}.`);
    return { blocklistAddresses: new Map(), blocklistDomains: new Map() };
  }
})();

// Returns the matching blocklist entry (with how it matched), or null.
function blocklistHit(email) {
  const addr = (email || '').trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  const byAddress = BLOCKLIST_ADDRESSES.get(addr);
  if (byAddress) return { scope: 'address', key: addr, entry: byAddress };
  const domain = addr.slice(at + 1);
  const byDomain = BLOCKLIST_DOMAINS.get(domain) || BLOCKLIST_DOMAINS.get(rootDomain(domain));
  if (byDomain) return { scope: 'domain', key: domain, entry: byDomain };
  return null;
}

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'protonmail.com',
  'proton.me', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com',
  'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'cox.net', 'bellsouth.net',
]);

const ROLE_MAILBOXES = new Set([
  ...GENERIC_EMAIL_PREFIXES,
  'noreply', 'no-reply', 'donotreply', 'webmaster', 'marketing', 'press',
  'careers', 'jobs', 'hr', 'billing', 'accounts', 'accounting', 'legal', 'privacy',
]);

// Registrable domain, with common two-level public suffixes (co.uk, com.au, ...)
const TWO_LEVEL_TLD_LABELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);
function rootDomain(host) {
  const labels = (host || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const take = (labels[labels.length - 1].length === 2 && TWO_LEVEL_TLD_LABELS.has(labels[labels.length - 2])) ? 3 : 2;
  return labels.slice(-take).join('.');
}

// Accepts numbers or range strings ("51-200", "10,001+"); uses the range's lower bound
function parseEmployeeCount(size) {
  if (typeof size === 'number') return size;
  const m = String(size).replace(/,/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// Returns null when the lead looks sendable, else a human-readable rejection reason.
// Syntax problems are validateLeadFields' job — this screens for the WRONG lead:
// anything on the permanent blocklist, generic mailboxes, personal freemail, contacts
// whose email belongs to a different company than the one being pitched, and companies
// too big to buy the license.
function screenLeadQuality(lead) {
  const email = (lead.contact_email || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const prefix = email.slice(0, at);
  const domain = email.slice(at + 1);

  // Checked first: a permanent failure outranks every other judgement here.
  const blocked = blocklistHit(email);
  if (blocked) {
    const { status, last_seen: lastSeen } = blocked.entry || {};
    const when = lastSeen ? `, last seen ${lastSeen}` : '';
    return blocked.scope === 'address'
      ? `blocklisted address — ${status || 'permanent failure'}${when}`
      : `blocklisted domain '${blocked.key}' — ${status || 'permanent failure'}${when}`;
  }

  if (ROLE_MAILBOXES.has(prefix)) {
    return `generic mailbox '${prefix}@' — needs a real person's address`;
  }
  if (BLOCKED_DOMAINS.has(domain) || BLOCKED_DOMAINS.has(rootDomain(domain))) {
    return `domain '${domain}' is on the blocked-domains list`;
  }
  if (!ALLOW_FREEMAIL && FREEMAIL_DOMAINS.has(domain)) {
    return `free email provider '${domain}' — needs a company address (set ALLOW_FREEMAIL=true to allow)`;
  }

  const website = (lead.website || '').trim().toLowerCase();
  if (website && !FREEMAIL_DOMAINS.has(domain)) {
    const siteHost = website.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
    const siteRoot = rootDomain(siteHost);
    const emailRoot = rootDomain(domain);
    if (siteRoot && emailRoot && siteRoot !== emailRoot) {
      return `email domain '${emailRoot}' does not match company website '${siteRoot}' — likely the wrong contact`;
    }
  }

  const size = (lead.employee_count != null && lead.employee_count !== '') ? lead.employee_count : lead.company_size;
  if (size != null && size !== '') {
    const n = parseEmployeeCount(size);
    if (n != null && n > MAX_EMPLOYEE_COUNT) {
      return `company size '${size}' is over the ${MAX_EMPLOYEE_COUNT}-employee ceiling`;
    }
  }
  return null;
}

function extractEmails(html, domain) {
  const found = [];
  const regex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const e = m[0].toLowerCase();
    if (!e.includes(domain.toLowerCase())) continue;
    const prefix = e.split('@')[0];
    if (GENERIC_EMAIL_PREFIXES.includes(prefix)) continue;
    if (!found.includes(e)) found.push(e);
  }
  return found;
}

async function scrapePageForEmail(url, domain) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-bot/1.0)' },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const html = await resp.text();
    return extractEmails(html, domain);
  } catch {
    return [];
  }
}

function normalizeDomain(raw) {
  try {
    const url = raw.startsWith('http') ? raw : `https://${raw}`;
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  }
}

function companyNameToDomain(name) {
  const slug = name.toLowerCase()
    .replace(/\b(agency|inc|llc|ltd|co|corp|group|digital|studio|media|marketing|solutions|services|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
  return `${slug}.com`;
}

async function findEmailForCompany(companyName, website) {
  const raw = website || companyNameToDomain(companyName);
  const domain = normalizeDomain(raw);
  const base = `https://${domain}`;
  const pagesToTry = [base, `${base}/contact`, `${base}/about`, `${base}/team`, `${base}/contact-us`];
  for (const page of pagesToTry) {
    const emails = await scrapePageForEmail(page, domain);
    if (emails.length) return { email: emails[0], domain };
  }
  // Fall back to generic contact email if nothing found
  const generic = `contact@${domain}`;
  return { email: null, domain, generic };
}

// =============================================================================
// B2B ENDPOINTS
// =============================================================================

// OpenPhone webhook — missed call → instant SMS text-back
// Inbound call events. /webhook/openphone is the path OpenPhone is configured to
// hit; /api/inbound is an alias on the same handler so the /api/* surface is
// consistent. Both must keep working — changing OpenPhone's configured URL is a
// separate, coordinated change.
app.post(['/webhook/openphone', '/api/inbound'], wrapAsync(async (req, res) => {
  const { type: eventType, data } = req.body;
  const obj = (data && data.object) ? data.object : (data || {});
  console.log(`[OpenPhone] event=${eventType}`);
  if (!['call.completed', 'call.missed', 'call.ringing'].includes(eventType)) {
    return res.json({ received: true, action: 'ignored', event: eventType });
  }
  const callerPhone = obj.from || obj.caller || '';
  const callStatus  = obj.status || '';
  const transcript  = (obj.transcription && typeof obj.transcription === 'object') ? (obj.transcription.text || '') : '';
  if (!['missed', 'no-answer', 'canceled', ''].includes(callStatus) && eventType !== 'call.missed') {
    return res.json({ received: true, action: 'ignored', reason: `call status '${callStatus}' not a missed call` });
  }
  if (!callerPhone) {
    return res.json({ received: true, action: 'skipped', reason: 'no caller_phone in payload' });
  }
  const result = await runCallCatcher({
    caller_phone: callerPhone,
    voicemail_transcript: transcript,
    business_name: B2B_DEPLOYER_NAME || 'the team',
  });
  res.json({ received: true, status: 'SUCCESS', result });
}));

// Direct lead intake — qualify and pitch immediately.
// /webhook/lead is the path Gumloop is configured to POST to; /api/ingest is an
// alias on the same handler. Both must keep working — do not retire
// /webhook/lead without updating the Gumloop pipeline first.
app.post(['/webhook/lead', '/api/ingest'], wrapAsync(async (req, res) => {
  const body = req.body;
  if (!body.contact_email && body.email) body.contact_email = body.email;
  const missing = ['company_name', 'contact_email', 'website'].filter(f => !body[f]);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  const invalid = validateLeadFields(body);
  if (invalid) {
    console.warn(`[Lead Intake] Rejected invalid payload: ${invalid}`);
    return res.status(400).json({ received: false, status: 'INVALID', error: invalid });
  }
  const { qualified, reason } = qualifyLead(body.company_name, body.industry || '');
  if (!qualified) return res.json({ received: true, status: 'DISQUALIFIED', reason });
  const lowQuality = screenLeadQuality(body);
  if (lowQuality) {
    console.log(`[Lead Intake] Disqualified ${body.company_name}: ${lowQuality}`);
    return res.json({ received: true, status: 'DISQUALIFIED', reason: lowQuality });
  }
  if (await isDoNotContact(body.contact_email)) {
    return res.json({ received: true, status: 'SUPPRESSED', reason: 'email is on the do-not-contact list' });
  }
  if (!(await underDailyCap())) {
    await queueLeads([body]);
    return res.json({ received: true, status: 'QUEUED', reason: `daily send cap (${DAILY_SEND_CAP}) reached — lead queued for next batch` });
  }
  if (body.campaign && TEMPLATE_CAMPAIGNS[body.campaign]) {
    const result = await runTemplateOutreach(body.campaign, body);
    return res.json({ received: true, status: 'SUCCESS', result });
  }
  const campaignId = body.campaign_id || `lead-${body.company_name.toLowerCase().replace(/\s+/g, '-')}`;
  const result = await runInventionOutreach({
    target_companies: [body.company_name],
    contact_email: body.contact_email,
    website: body.website,
    proof_url: B2B_PROOF_URL,
    deployment_fee: B2B_DEPLOYMENT_FEE,
    campaign_id: campaignId,
  });
  res.json({ received: true, status: 'SUCCESS', result });
}));

// Build marker so a deploy can be verified from outside
app.get('/version', (req, res) => {
  res.json({ build: 'lead-quality-screen-persistent-db-2026-07-20' });
});

// Public sales one-pager — text this URL to prospects
app.get('/pitch', (req, res) => {
  res.sendFile(path.join(__dirname, 'pitch.html'));
});


// Root status page (ported from local main's "Fix root route" commit)
app.get('/', (req, res) => {
  res.json({
    status: '✅ Running',
    name: 'Master Hustle Engine',
    version: '1.0.0',
    endpoints: {
      ingest: 'POST /webhook/lead  (alias: POST /api/ingest)',
      inbound: 'POST /webhook/openphone  (alias: POST /api/inbound)',
      status: 'GET /admin/status',
      health: 'GET /health',
      logs: 'GET /api/admin/logs'
    },
    // The single offer. Sourced from config/pricing.js — the buyout is a sales
    // anchor, not a purchasable option, so it is deliberately absent here.
    offer: quotableOffer(),
    message: 'Lead ingestion and outbound dispatch active.'
  });
});

// Machine-readable health check — reports which features are live vs degraded so
// a missing key is visible from outside the box without reading deploy logs.
app.get('/health', (req, res) => {
  const degraded = ENV_REPORT.missing.length > 0;
  res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'ok',
    port: PORT,
    uptime_seconds: Math.round(process.uptime()),
    features: ENV_REPORT.features,
    mailer: ENV_REPORT.mailer,
    missing_config: ENV_REPORT.missing,
    defaults_applied: ENV_REPORT.defaultsApplied,
    offer: quotableOffer(),
    timestamp: new Date().toISOString(),
  });
});

// Admin form — paste company names, engine finds emails and sends pitches
app.get('/admin/pitch', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Antigravity — Send Pitches</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #eee; padding: 24px; }
    h1 { font-size: 22px; margin-bottom: 6px; color: #fff; }
    p { color: #aaa; font-size: 13px; margin-bottom: 20px; }
    label { font-size: 13px; color: #ccc; display: block; margin-bottom: 6px; }
    textarea, select, input[type=text] {
      width: 100%; padding: 10px; background: #1a1a1a; border: 1px solid #333;
      border-radius: 6px; color: #eee; font-size: 14px; margin-bottom: 16px;
    }
    textarea { height: 200px; resize: vertical; }
    button {
      background: #2563eb; color: #fff; border: none; padding: 12px 28px;
      border-radius: 6px; font-size: 15px; cursor: pointer; width: 100%;
    }
    button:hover { background: #1d4ed8; }
    #result { margin-top: 20px; background: #1a1a1a; border-radius: 6px; padding: 16px; font-size: 13px; white-space: pre-wrap; display: none; }
  </style>
</head>
<body>
  <h1>Antigravity — Bulk Pitch Sender</h1>
  <p>Paste company names below (one per line). Add website after a comma if you have it. Engine finds emails and sends pitches automatically.</p>
  <form id="form">
    <label>Industry (used for qualification)</label>
    <select id="industry">
      <option value="digital marketing agency">Digital Marketing Agency</option>
      <option value="lead generation agency">Lead Generation Agency</option>
      <option value="seo agency">SEO Agency</option>
      <option value="ppc agency">PPC Agency</option>
      <option value="social media agency">Social Media Agency</option>
      <option value="marketing agency">Marketing Agency</option>
      <option value="saas">SaaS / Software Company</option>
      <option value="tech startup">Tech Startup</option>
      <option value="digital agency">Digital Agency</option>
      <option value="growth agency">Growth Agency</option>
    </select>
    <label>Company Names (one per line — add website after comma if known)</label>
    <textarea id="companies" placeholder="Acme Marketing Agency, acmemarketing.com&#10;Blue Ocean SEO&#10;Growth Lab Digital, growthlabdigital.com"></textarea>
    <label>Override contact email (optional — leave blank to auto-find from website)</label>
    <input type="text" id="override_email" placeholder="Leave blank to auto-find">
    <button type="submit" id="btn">Send Pitches</button>
  </form>
  <div id="result"></div>
  <script>
    document.getElementById('form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('btn');
      btn.disabled = true; btn.textContent = 'Working...';
      const lines = document.getElementById('companies').value.trim().split('\\n').filter(Boolean);
      const industry = document.getElementById('industry').value;
      const override_email = document.getElementById('override_email').value.trim();
      const companies = lines.map(l => {
        const parts = l.split(',').map(s => s.trim());
        return { name: parts[0], website: parts[1] || '', industry, override_email };
      });
      const res = await fetch('/admin/bulk-pitch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies })
      });
      const data = await res.json();
      const el = document.getElementById('result');
      el.style.display = 'block';
      el.textContent = JSON.stringify(data, null, 2);
      btn.disabled = false; btn.textContent = 'Send Pitches';
    });
  </script>
</body>
</html>`);
});

// Bulk pitch — takes company names, finds emails, fires pitches
app.post('/admin/bulk-pitch', wrapAsync(async (req, res) => {
  const { companies = [] } = req.body;
  if (!companies.length) return res.status(400).json({ error: 'No companies provided' });
  const results = [];
  for (const c of companies) {
    const companyName = (c.name || c.company_name || '').trim();
    if (!companyName) continue;
    const industry = c.industry || 'digital marketing agency';
    const { qualified, reason } = qualifyLead(companyName, industry);
    if (!qualified) {
      results.push({ company: companyName, status: 'disqualified', reason });
      continue;
    }
    if (!(await underDailyCap())) {
      results.push({ company: companyName, status: 'capped', reason: `daily send cap (${DAILY_SEND_CAP}) reached` });
      continue;
    }
    let email = c.override_email || c.contact_email || '';
    let website = c.website || '';
    let domain = '';
    if (!email) {
      const found = await findEmailForCompany(companyName, website);
      domain = found.domain;
      if (!website) website = `https://${domain}`;
      email = found.email;
      if (!email) {
        results.push({ company: companyName, website, status: 'no_email_found', domain });
        continue;
      }
    }
    const invalidBulk = validateLeadFields({ company_name: companyName, contact_email: email, website });
    if (invalidBulk) {
      results.push({ company: companyName, email, status: 'invalid', reason: invalidBulk });
      continue;
    }
    // override_email is a deliberate human choice — skip the quality screen for it
    if (!c.override_email) {
      const lowQualityBulk = screenLeadQuality({ company_name: companyName, contact_email: email, website });
      if (lowQualityBulk) {
        results.push({ company: companyName, email, status: 'disqualified', reason: lowQualityBulk });
        continue;
      }
    }
    if (await isDoNotContact(email)) {
      results.push({ company: companyName, email, status: 'suppressed', reason: 'email is on the do-not-contact list' });
      continue;
    }
    try {
      const campaignId = `bulk-${companyName.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
      await runInventionOutreach({
        target_companies: [companyName],
        contact_email: email,
        website: website || `https://${domain}`,
        proof_url: B2B_PROOF_URL,
        deployment_fee: B2B_DEPLOYMENT_FEE,
        campaign_id: campaignId,
      });
      results.push({ company: companyName, email, website, status: 'pitched' });
    } catch (err) {
      results.push({ company: companyName, email, status: 'failed', error: err.message });
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  const summary = {
    total: companies.length,
    pitched: results.filter(r => r.status === 'pitched').length,
    no_email: results.filter(r => r.status === 'no_email_found').length,
    disqualified: results.filter(r => r.status === 'disqualified').length,
    capped: results.filter(r => r.status === 'capped').length,
    suppressed: results.filter(r => r.status === 'suppressed').length,
    failed: results.filter(r => r.status === 'failed').length,
  };
  res.json({ summary, results });
}));

// Bulk import leads into the queue
app.post('/admin/leads', wrapAsync(async (req, res) => {
  const body = req.body;
  const leads = Array.isArray(body) ? body : (body.leads || []);
  if (!leads.length) return res.status(400).json({ error: 'Send a JSON array of leads or {"leads": [...]}' });
  const inserted = await queueLeads(leads);
  const stats = await queueStats();
  res.json({ imported: inserted, skipped: leads.length - inserted, queue: stats });
}));

// Immediately process the next batch of pending leads
app.post('/admin/run-now', wrapAsync(async (req, res) => {
  const requested = parseInt((req.body && req.body.batch_size) || B2B_BATCH_SIZE);
  // A manual run must not outrun the warming cap. Clamp rather than reject so a
  // large batch_size still sends what the cap allows; the rest stays pending.
  const size = Math.max(1, Math.min(requested || B2B_BATCH_SIZE, B2B_BATCH_SIZE));
  const result = await processLeadQueue(size);
  if (size < requested) result.clamped_from = requested;
  result.batch_size = size;
  result.queue = await queueStats();
  res.json(result);
}));

// Lead queue + follow-up status dashboard
app.get('/admin/status', wrapAsync(async (req, res) => {
  const [queue, follow_ups, sent_today, dnc] = await Promise.all([
    queueStats(), followUpStats(), sendsToday(),
    dbGetOne('SELECT COUNT(*) AS c FROM do_not_contact'),
  ]);
  res.json({
    queue,
    follow_ups,
    sends: { today: sent_today, daily_cap: DAILY_SEND_CAP },
    do_not_contact: dnc ? dnc.c : 0,
    config: { batch_size: B2B_BATCH_SIZE, interval_hours: B2B_BATCH_HOURS, campaigns: Object.keys(TEMPLATE_CAMPAIGNS) },
  });
}));

// Do-not-contact list management
app.get('/admin/do-not-contact', wrapAsync(async (req, res) => {
  const rows = await dbAll('SELECT email, reason, added_at FROM do_not_contact ORDER BY added_at DESC');
  res.json({ count: rows.length, entries: rows });
}));

// Add one email ({"email": "..."}) or several ({"emails": ["...", ...]}); optional "reason"
app.post('/admin/do-not-contact', wrapAsync(async (req, res) => {
  const body = req.body || {};
  const emails = Array.isArray(body.emails) ? body.emails : (body.email ? [body.email] : []);
  if (!emails.length) return res.status(400).json({ error: 'Send {"email": "..."} or {"emails": ["...", ...]}' });
  const results = [];
  for (const email of emails) {
    results.push(await addDoNotContact(email, body.reason || ''));
  }
  res.json({ added: results.filter(r => r.added).length, results });
}));

app.delete('/admin/do-not-contact', wrapAsync(async (req, res) => {
  const email = (req.body && req.body.email) || '';
  if (!email) return res.status(400).json({ error: 'Send {"email": "..."}' });
  res.json(await removeDoNotContact(email));
}));

// ─── Daily Engine Status Email ────────────────────────────────────────────────
// A once-a-day health digest emailed to ADMIN_EMAIL so you can see the machine's
// state without curling /admin/status: sends vs. cap, queue depth, follow-ups,
// suppression-list size, router-fallback hits (is the failover earning its keep?),
// and any failures logged in the last 24h.

async function collectEngineStats() {
  const [queue, follow_ups, sent_today, dncRow, routerRows, errRow] = await Promise.all([
    queueStats(),
    followUpStats(),
    sendsToday(),
    dbGetOne('SELECT COUNT(*) AS c FROM do_not_contact'),
    dbAll("SELECT outcome, COUNT(*) AS c FROM router_events WHERE created_at >= datetime('now', 'start of day') GROUP BY outcome"),
    dbGetOne("SELECT COUNT(*) AS c FROM logs WHERE status = 'failure' AND timestamp >= datetime('now', '-24 hours')"),
  ]);
  const router = { succeeded: 0, failed: 0 };
  for (const r of routerRows) router[r.outcome] = r.c || 0;
  return {
    date: new Date().toISOString().slice(0, 10),
    sends: { today: sent_today, daily_cap: DAILY_SEND_CAP, remaining: Math.max(0, DAILY_SEND_CAP - sent_today) },
    queue,
    follow_ups,
    do_not_contact: dncRow ? dncRow.c : 0,
    router_fallbacks_today: router,
    failures_24h: errRow ? errRow.c : 0,
  };
}

function renderStatusEmailHtml(s) {
  const row = (label, value) =>
    `<tr><td style="padding:8px 14px;border-bottom:1px solid #e5e7eb;color:#374151;font-size:14px;">${label}</td>
     <td style="padding:8px 14px;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;font-weight:600;text-align:right;">${value}</td></tr>`;
  const routerLine = `${s.router_fallbacks_today.succeeded} recovered, ${s.router_fallbacks_today.failed} failed`;
  const failColor = s.failures_24h > 0 ? '#dc2626' : '#16a34a';
  return `
    <div style="font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;padding:25px;border:1px solid #e5e7eb;background:#ffffff;color:#111827;border-radius:12px;max-width:640px;margin:0 auto;">
      <h2 style="margin:0 0 4px;font-size:20px;font-weight:700;">📊 Antigravity Engine — Daily Status</h2>
      <p style="margin:0 0 18px;color:#6b7280;font-size:13px;">${s.date} · master-hustle-engine.onrender.com</p>
      <table style="width:100%;border-collapse:collapse;">
        ${row('Emails sent today', `${s.sends.today} / ${s.sends.daily_cap} cap`)}
        ${row('Send capacity remaining', s.sends.remaining)}
        ${row('Leads queued (pending)', s.queue.pending || 0)}
        ${row('Leads sent (all-time)', s.queue.sent || 0)}
        ${row('Leads disqualified (all-time)', s.queue.disqualified || 0)}
        ${row('Follow-ups pending', s.follow_ups.pending || 0)}
        ${row('Follow-ups failed (all-time)', s.follow_ups.failed || 0)}
        ${row('Do-not-contact list size', s.do_not_contact)}
        ${row('Router fallbacks today', routerLine)}
        <tr><td style="padding:8px 14px;color:#374151;font-size:14px;">Failures (last 24h)</td>
         <td style="padding:8px 14px;color:${failColor};font-size:14px;font-weight:700;text-align:right;">${s.failures_24h}</td></tr>
      </table>
      <p style="margin:18px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">
        "Router fallbacks" counts times the primary Gemini model failed over to the intelligent-router pool.
        Zero here with steady send volume means the primary is healthy — not that the failover is broken.
      </p>
    </div>`;
}

async function sendEngineStatusEmail() {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn('[Status Email] No ADMIN_EMAIL set — daily status email skipped.');
    return { sent: false, reason: 'no ADMIN_EMAIL' };
  }
  const stats = await collectEngineStats();
  await sendEmailViaRelayOrSmtp(
    adminEmail,
    `📊 Antigravity Engine Daily Status — ${stats.date}`,
    renderStatusEmailHtml(stats)
  );
  console.log('[Status Email] Daily status email sent to', adminEmail);
  return { sent: true, to: adminEmail, stats };
}

// Manual trigger (also handy for testing) — sends the digest on demand.
app.post('/admin/status-email', wrapAsync(async (req, res) => {
  res.json(await sendEngineStatusEmail());
}));

// Raw stats as JSON, no email — a superset of /admin/status.
app.get('/admin/status-report', wrapAsync(async (req, res) => {
  res.json(await collectEngineStats());
}));

// Arm the daily status-email cron. Override the time with STATUS_EMAIL_CRON
// (5-field cron, UTC); set STATUS_EMAIL_ENABLED=false to disable.
const STATUS_EMAIL_CRON = process.env.STATUS_EMAIL_CRON || '0 7 * * *';
const STATUS_EMAIL_ENABLED = (process.env.STATUS_EMAIL_ENABLED || 'true').toLowerCase() !== 'false';
if (STATUS_EMAIL_ENABLED && cron.validate(STATUS_EMAIL_CRON)) {
  cron.schedule(STATUS_EMAIL_CRON, async () => {
    try {
      await sendEngineStatusEmail();
    } catch (err) {
      console.error('[Status Email] Cron send failed:', err.message);
      await sendAdminAlert('Daily Status Email', err.stack || err.message);
    }
  });
  console.log(`[Status Email] Daily digest armed — cron '${STATUS_EMAIL_CRON}' (UTC)`);
} else if (!STATUS_EMAIL_ENABLED) {
  console.log('[Status Email] Disabled via STATUS_EMAIL_ENABLED=false');
} else {
  console.warn(`[Status Email] Invalid STATUS_EMAIL_CRON '${STATUS_EMAIL_CRON}' — daily digest not armed`);
}

// Global Express Error Handler Middleware to email stack trace on endpoint failure
app.use(async (err, req, res, next) => {
  console.error('[Global Error Handler] Caught exception:', err);
  const buyer_email = req.body ? req.body.buyer_email : null;
  const product_type = req.path.replace('/api/', '');

  logTransaction(buyer_email || 'unknown', product_type, 'failure', err.message);

  await sendAdminAlert(`Webhook endpoint failure on ${req.method} ${req.path}`, err.stack || err.message);

  if (!res.headersSent) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Outbound needs both a mailer and a model. Without either, the batch loops would
// just burn queued leads on guaranteed failures every tick, so they idle instead.
const OUTBOUND_READY = ENV_REPORT.features.outboundEmail && ENV_REPORT.features.ai;

// Background: process lead queue every BATCH_INTERVAL_HOURS hours
setInterval(async () => {
  if (!OUTBOUND_READY) {
    console.warn('[Lead Scheduler] Skipped — outbound is degraded (see GET /health). Queue left untouched.');
    return;
  }
  console.log('[Lead Scheduler] Firing lead batch run');
  try {
    await processLeadQueue();
  } catch (err) {
    console.error('[Lead Scheduler] Error:', err.message);
    await sendAdminAlert('Lead Queue Batch Run Failed', err.stack || err.message);
  }
}, B2B_BATCH_HOURS * 60 * 60 * 1000);
console.log(`[Lead Scheduler] Armed — runs every ${B2B_BATCH_HOURS}h${OUTBOUND_READY ? '' : ' (IDLE — outbound degraded)'}`);

// Background: send due follow-ups every hour
setInterval(async () => {
  if (!OUTBOUND_READY) {
    console.warn('[Follow-up Scheduler] Skipped — outbound is degraded (see GET /health). Due follow-ups stay pending.');
    return;
  }
  try {
    const due = await fetchDueFollowUps();
    for (const fu of due) {
      if (!(await underDailyCap())) {
        console.log(`[Follow-up Scheduler] Daily send cap (${DAILY_SEND_CAP}) reached — remaining follow-ups stay pending until next run`);
        break;
      }
      if (await isDoNotContact(fu.contact_email)) {
        await markFollowUp(fu.id, 'suppressed');
        console.log(`[Follow-up Scheduler] Suppressed step ${fu.step} → ${fu.contact_email} (do-not-contact list)`);
        continue;
      }
      try {
        await sendPitchEmail(fu.contact_email, fu.subject, fu.body, fu.campaign_id);
        await markFollowUp(fu.id, 'sent');
        console.log(`[Follow-up Scheduler] Sent step ${fu.step} → ${fu.contact_email}`);
      } catch (err) {
        // A config gap isn't this lead's fault — leave it pending so it goes out
        // once the mailer is set, rather than marking it permanently failed.
        if (err.code === 'MAILER_NOT_CONFIGURED') {
          console.warn(`[Follow-up Scheduler] Mailer unconfigured — step ${fu.step} → ${fu.contact_email} stays pending.`);
          break;
        }
        await markFollowUp(fu.id, 'failed');
        console.error(`[Follow-up Scheduler] Failed → ${fu.contact_email}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error('[Follow-up Scheduler] Error:', err.message);
  }
}, 60 * 60 * 1000);
console.log('[Follow-up Scheduler] Armed — checks every 1h');

// Background: trigger Gumloop lead scraper every 6 hours if configured
const GUMLOOP_API_KEY    = process.env.GUMLOOP_API_KEY;
const GUMLOOP_USER_ID    = process.env.GUMLOOP_USER_ID;
const GUMLOOP_ITEM_ID    = process.env.GUMLOOP_SAVED_ITEM_ID;
const GUMLOOP_INTERVAL_H = parseInt(process.env.GUMLOOP_INTERVAL_HOURS || '6');

async function triggerGumloopScraper() {
  if (!GUMLOOP_API_KEY || !GUMLOOP_USER_ID || !GUMLOOP_ITEM_ID) return;
  try {
    const resp = await fetch('https://api.gumloop.com/api/v1/start_pipeline', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GUMLOOP_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: GUMLOOP_USER_ID,
        saved_item_id: GUMLOOP_ITEM_ID,
        pipeline_inputs: [],
      }),
    });
    const data = await resp.json();
    if (data.run_id) {
      console.log(`[Gumloop] Pipeline triggered — run_id=${data.run_id}`);
    } else {
      console.error('[Gumloop] Trigger failed:', JSON.stringify(data));
    }
  } catch (err) {
    console.error('[Gumloop] Trigger error:', err.message);
  }
}

if (GUMLOOP_API_KEY && GUMLOOP_USER_ID && GUMLOOP_ITEM_ID) {
  setInterval(triggerGumloopScraper, GUMLOOP_INTERVAL_H * 60 * 60 * 1000);
  console.log(`[Gumloop] Scraper auto-trigger armed — fires every ${GUMLOOP_INTERVAL_H}h`);
  // Fire once on startup after a short delay (let server fully init)
  setTimeout(triggerGumloopScraper, 30 * 1000);
}

// Start Server
app.listen(PORT, () => {
  console.log(`[Server] Antigravity Master Engine running on port ${PORT}`);
  console.log(`[Server] Local: http://localhost:${PORT}  |  Health: http://localhost:${PORT}/health`);
  console.log(`[Offer]  ${PRICING.display.headline}`);
});
