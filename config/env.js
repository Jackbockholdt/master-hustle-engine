/**
 * config/env.js
 *
 * Startup environment audit + safe defaults.
 *
 * The engine runs unattended: a daily cron, a lead-batch loop every 6h, and an
 * hourly follow-up sender. Before this module existed, a missing key took the
 * whole process down (`new Stripe(undefined)` throws at require time) or made
 * every background tick throw forever. Neither is acceptable for a box that is
 * supposed to stay up.
 *
 * The rule here: a missing key DEGRADES the feature that needs it and says so
 * loudly once at boot. It never crashes the process, and it never fabricates a
 * credential — a fake API key would turn a clear startup error into a silent
 * runtime failure, and a fake email address would send real mail to a stranger.
 * "Safe default" means a safe no-op, not a made-up value.
 */

const CRITICAL = [
  {
    key: 'GEMINI_API_KEY',
    feature: 'AI generation (pitch copy, follow-up copy, call classification)',
    degraded: 'Generation endpoints return an error; cron/batch runs are skipped instead of looping on failures.',
  },
  {
    key: 'STRIPE_SECRET_KEY',
    feature: 'Stripe webhook + purchase fulfillment',
    degraded: 'Stripe client is not constructed; /api/stripe-webhook returns 503 instead of crashing the process.',
  },
  {
    key: 'ADMIN_EMAIL',
    feature: 'Admin alerts, purchase notifications, daily status digest',
    degraded: 'Alerts log to stdout only.',
  },
];

// The mailer is satisfied by EITHER the Gmail HTTPS relay (the path that works
// on Render) OR raw SMTP credentials. Checked as a group, not key by key.
function mailerStatus() {
  const hasRelay = Boolean(process.env.GMAIL_HTTP_URL);
  const hasSmtp = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
  return {
    configured: hasRelay || hasSmtp,
    transport: hasRelay ? 'gmail-https-relay' : hasSmtp ? 'smtp' : 'none',
    hasRelay,
    hasSmtp,
  };
}

/**
 * Inspect the environment and apply safe defaults. Call once at startup.
 * Returns a report the /health endpoint can serve, so the running config is
 * observable from outside without shelling into the box.
 */
function auditEnv({ log = true } = {}) {
  const missing = [];
  const present = [];

  for (const entry of CRITICAL) {
    if (process.env[entry.key]) present.push(entry.key);
    else missing.push(entry);
  }

  const mailer = mailerStatus();
  if (!mailer.configured) {
    missing.push({
      key: 'GMAIL_HTTP_URL (or SMTP_USER + SMTP_PASS)',
      feature: 'All outbound email — cold pitches, follow-ups, admin alerts',
      degraded: 'Outbound sends are suppressed and logged; the follow-up scheduler keeps items pending rather than marking them failed.',
    });
  }

  // ── Safe defaults ──────────────────────────────────────────────────────────
  // Applied only where a default cannot cause an unintended external side effect.
  const applied = [];
  if (!process.env.PORT) {
    process.env.PORT = '3005';
    applied.push('PORT=3005');
  }
  if (!process.env.DAILY_SEND_CAP) {
    // A cap of 0 would silently halt outbound; 4 matches .env.example and is the
    // warming cap for a new sending account — pitches and follow-ups combined.
    // Erring low is safe: overflow stays queued, it is never dropped.
    process.env.DAILY_SEND_CAP = '4';
    applied.push('DAILY_SEND_CAP=4');
  }
  if (!process.env.BATCH_INTERVAL_HOURS) {
    process.env.BATCH_INTERVAL_HOURS = '6';
    applied.push('BATCH_INTERVAL_HOURS=6');
  }
  if (!process.env.BATCH_SIZE) {
    process.env.BATCH_SIZE = '4';
    applied.push('BATCH_SIZE=4');
  }
  if (!process.env.STATUS_EMAIL_CRON) {
    process.env.STATUS_EMAIL_CRON = '0 7 * * *';
    applied.push('STATUS_EMAIL_CRON=0 7 * * *');
  }

  const report = {
    ok: missing.length === 0,
    present,
    missing: missing.map((m) => ({ key: m.key, feature: m.feature, degraded: m.degraded })),
    defaultsApplied: applied,
    mailer,
    // Feature switches the rest of the app reads instead of re-checking env vars.
    features: {
      ai: Boolean(process.env.GEMINI_API_KEY),
      stripe: Boolean(process.env.STRIPE_SECRET_KEY),
      outboundEmail: mailer.configured,
      adminAlerts: Boolean(process.env.ADMIN_EMAIL),
    },
  };

  if (log) {
    if (applied.length) console.log(`[Env Audit] Safe defaults applied: ${applied.join(', ')}`);
    if (report.ok) {
      console.log('[Env Audit] ✅ All critical keys present.');
    } else {
      console.warn(`[Env Audit] ⚠️  ${missing.length} critical key(s) missing — running DEGRADED:`);
      for (const m of missing) {
        console.warn(`[Env Audit]    • ${m.key} — ${m.feature}`);
        console.warn(`[Env Audit]      → ${m.degraded}`);
      }
      console.warn('[Env Audit] Process will stay up. Set the keys above and redeploy to restore full function.');
    }
  }

  return report;
}

module.exports = { auditEnv, mailerStatus, CRITICAL };
