/**
 * Skill 7: Pipeline State & SQLite Lifecycle Tracker
 * Tracks lead lifecycle stages: 'discovered' -> 'triaged' -> 'contacted' -> 'proposed' -> 'converted'
 * Built with native Node 24 SQLite (node:sqlite) for zero-dependency persistence.
 */

const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'pipeline.db');
const JSON_CRM_PATH = path.join(__dirname, '..', 'crm_leads_tracker.json');

const VALID_STAGES = ['discovered', 'triaged', 'contacted', 'proposed', 'converted', 'disqualified', 'disqualified_invalid_mx'];

let dbInstance = null;

/**
 * Initializes SQLite database connection & schema
 */
function getDatabase() {
  if (dbInstance) return dbInstance;

  try {
    const { DatabaseSync } = require('node:sqlite');
    dbInstance = new DatabaseSync(DB_PATH);

    // Create Tables
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_leads (
        id TEXT PRIMARY KEY,
        name TEXT,
        title TEXT,
        company TEXT,
        domain TEXT,
        email TEXT,
        industry TEXT,
        stage TEXT NOT NULL DEFAULT 'discovered',
        qualification_score INTEGER DEFAULT 0,
        qualification_tier TEXT DEFAULT 'STANDARD_ICP',
        estimated_burn REAL DEFAULT 0,
        deal_value REAL DEFAULT 0,
        selected_package TEXT,
        stripe_payment_link TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS lifecycle_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT,
        from_stage TEXT,
        to_stage TEXT,
        event_name TEXT,
        detail TEXT,
        timestamp TEXT,
        FOREIGN KEY (lead_id) REFERENCES pipeline_leads(id)
      );

      CREATE TABLE IF NOT EXISTS review_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT,
        email TEXT NOT NULL,
        company TEXT,
        reason TEXT NOT NULL,
        error_code TEXT,
        subject TEXT,
        message_snippet TEXT,
        status TEXT NOT NULL DEFAULT 'PAUSED_NEEDS_REVIEW',
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS daily_dispatch_state (
        date TEXT PRIMARY KEY,
        sent_today INTEGER DEFAULT 0,
        daily_limit INTEGER DEFAULT 35,
        status TEXT DEFAULT 'ACTIVE',
        last_dispatch_at TEXT,
        updated_at TEXT
      );
    `);
  } catch (err) {
    console.error('[SQLite Init Error] Failed initializing SQLite database:', err.message);
    throw err;
  }

  return dbInstance;
}

/**
 * Upserts a lead into SQLite
 */
function upsertLead(lead = {}) {
  const db = getDatabase();
  const id = lead.id || `LEAD-${Date.now().toString(36).toUpperCase()}`;
  const name = lead.name || 'Decision Maker';
  const title = lead.title || 'Executive';
  const company = lead.company || 'Enterprise';
  const domain = lead.domain || (lead.email ? lead.email.split('@')[1] : '');
  const email = lead.email || '';
  const industry = lead.industry || 'Digital Agency';
  const stage = VALID_STAGES.includes(lead.stage) ? lead.stage : 'discovered';
  const score = parseInt(lead.qualificationScore || lead.score || 0, 10);
  const tier = lead.qualificationTier || 'STANDARD_ICP';
  const burn = parseFloat(lead.estimatedMonthlyLLMBurnUSD || lead.estimated_burn || 0);
  const dealValue = parseFloat(lead.dealValueUSD || lead.deal_value || 0);
  const pkg = lead.selectedPackage || lead.tier || 'retainer';
  const stripeLink = lead.stripePaymentLink || '';
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO pipeline_leads (
      id, name, title, company, domain, email, industry, stage,
      qualification_score, qualification_tier, estimated_burn,
      deal_value, selected_package, stripe_payment_link, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      title=excluded.title,
      company=excluded.company,
      domain=excluded.domain,
      email=excluded.email,
      industry=excluded.industry,
      stage=excluded.stage,
      qualification_score=excluded.qualification_score,
      qualification_tier=excluded.qualification_tier,
      estimated_burn=excluded.estimated_burn,
      deal_value=excluded.deal_value,
      selected_package=excluded.selected_package,
      stripe_payment_link=excluded.stripe_payment_link,
      updated_at=excluded.updated_at
  `);

  stmt.run(
    id, name, title, company, domain, email, industry, stage,
    score, tier, burn, dealValue, pkg, stripeLink, now, now
  );

  return { id, company, email, stage };
}

/**
 * Transitions lead lifecycle stage with audit logging
 */
function transitionStage(leadId, targetStage, detail = '') {
  const db = getDatabase();
  const normalizedStage = String(targetStage).toLowerCase().trim();

  if (!VALID_STAGES.includes(normalizedStage)) {
    throw new Error(`Invalid stage '${targetStage}'. Must be one of: ${VALID_STAGES.join(', ')}`);
  }

  const queryStmt = db.prepare(`SELECT * FROM pipeline_leads WHERE id = ?`);
  const currentLead = queryStmt.get(leadId);

  if (!currentLead) {
    throw new Error(`Lead ID '${leadId}' not found in SQLite pipeline.`);
  }

  const prevStage = currentLead.stage;
  const now = new Date().toISOString();

  // Update stage
  const updateStmt = db.prepare(`
    UPDATE pipeline_leads 
    SET stage = ?, updated_at = ? 
    WHERE id = ?
  `);
  updateStmt.run(normalizedStage, now, leadId);

  // Insert Audit Log
  const auditStmt = db.prepare(`
    INSERT INTO lifecycle_audit_log (lead_id, from_stage, to_stage, event_name, detail, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  auditStmt.run(leadId, prevStage, normalizedStage, `STAGE_TRANSITION_${normalizedStage.toUpperCase()}`, detail || `Moved from ${prevStage} to ${normalizedStage}`, now);

  return {
    success: true,
    leadId,
    company: currentLead.company,
    previousStage: prevStage,
    currentStage: normalizedStage,
    timestamp: now
  };
}

/**
 * Retrieves full pipeline statistics and metrics
 */
function getPipelineSummary() {
  const db = getDatabase();

  const countQuery = db.prepare(`
    SELECT stage, COUNT(*) as count, SUM(deal_value) as total_value
    FROM pipeline_leads
    GROUP BY stage
  `);
  const rows = countQuery.all();

  const stageCounts = {
    discovered: 0,
    triaged: 0,
    contacted: 0,
    proposed: 0,
    converted: 0,
    disqualified: 0,
    disqualified_invalid_mx: 0
  };

  let totalPipelineValueUSD = 0;
  let totalConvertedValueUSD = 0;

  for (const r of rows) {
    if (stageCounts[r.stage] !== undefined) {
      stageCounts[r.stage] = Number(r.count);
    }
    const val = Number(r.total_value || 0);
    totalPipelineValueUSD += val;
    if (r.stage === 'converted') {
      totalConvertedValueUSD += val;
    }
  }

  const allLeadsStmt = db.prepare(`SELECT * FROM pipeline_leads ORDER BY updated_at DESC LIMIT 50`);
  const recentLeads = allLeadsStmt.all();

  const reviewThreadsStmt = db.prepare(`SELECT * FROM review_threads WHERE status = 'PAUSED_NEEDS_REVIEW' ORDER BY updated_at DESC`);
  const flaggedForReview = reviewThreadsStmt.all();

  return {
    success: true,
    database: "SQLite (node:sqlite)",
    dbPath: DB_PATH,
    stageCounts,
    totalLeads: Object.values(stageCounts).reduce((a, b) => a + b, 0),
    financials: {
      totalPipelineValueUSD,
      totalConvertedValueUSD
    },
    flaggedForReview,
    recentLeads
  };
}

/**
 * Marks a lead as DISQUALIFIED_INVALID_MX in pipeline.db.
 * If lead exists, updates its stage and tier; otherwise inserts a disqualified record.
 */
function markLeadDisqualifiedMx({ email, domain = null, leadId = null, company = '', reason = '' } = {}) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanDomain = (domain || (cleanEmail.includes('@') ? cleanEmail.split('@')[1] : '')).trim().toLowerCase();

  let existing = null;
  if (leadId) {
    existing = db.prepare('SELECT * FROM pipeline_leads WHERE id = ?').get(leadId);
  }
  if (!existing && cleanEmail) {
    existing = db.prepare('SELECT * FROM pipeline_leads WHERE LOWER(email) = ?').get(cleanEmail);
  }

  const targetId = existing ? existing.id : (leadId || `LEAD-DISQ-MX-${Date.now().toString(36).toUpperCase()}`);
  const targetCompany = existing ? existing.company : (company || cleanDomain || 'Unknown');
  const targetName = existing ? existing.name : 'Unknown';
  const targetTitle = existing ? existing.title : 'Executive';
  const targetIndustry = existing ? existing.industry : 'Digital Agency';

  if (existing) {
    db.prepare(`
      UPDATE pipeline_leads
      SET stage = 'disqualified_invalid_mx',
          qualification_tier = 'DISQUALIFIED_INVALID_MX',
          updated_at = ?
      WHERE id = ?
    `).run(now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO pipeline_leads (
        id, name, title, company, domain, email, industry, stage,
        qualification_score, qualification_tier, estimated_burn,
        deal_value, selected_package, stripe_payment_link, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'disqualified_invalid_mx', 0, 'DISQUALIFIED_INVALID_MX', 0, 0, 'none', '', ?, ?)
    `).run(targetId, targetName, targetTitle, targetCompany, cleanDomain, cleanEmail, targetIndustry, now, now);
  }

  db.prepare(`
    INSERT INTO lifecycle_audit_log (lead_id, from_stage, to_stage, event_name, detail, timestamp)
    VALUES (?, ?, 'disqualified_invalid_mx', 'PRE_SEND_MX_DISQUALIFIED', ?, ?)
  `).run(targetId, existing ? existing.stage : 'discovered', reason || 'Domain failed active DNS MX resolution', now);

  return { id: targetId, email: cleanEmail, stage: 'disqualified_invalid_mx', status: 'DISQUALIFIED_INVALID_MX' };
}

/**
 * Flags a thread for human review and pauses outbound dispatch for this thread.
 */
function flagThreadForReview({ email, leadId = null, company = '', reason = 'INBOUND_REPLY', errorCode = null, subject = '', messageSnippet = '' } = {}) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const cleanEmail = (email || '').trim().toLowerCase();

  // If lead exists in pipeline_leads, tag it
  if (cleanEmail) {
    const existing = db.prepare('SELECT id, company FROM pipeline_leads WHERE LOWER(email) = ?').get(cleanEmail);
    if (existing) {
      if (!leadId) leadId = existing.id;
      if (!company) company = existing.company;
      db.prepare(`
        UPDATE pipeline_leads
        SET qualification_tier = 'NEEDS_HUMAN_REVIEW',
            updated_at = ?
        WHERE id = ?
      `).run(now, existing.id);
    }
  }

  // Insert or update review_threads
  const existingThread = cleanEmail 
    ? db.prepare("SELECT id FROM review_threads WHERE LOWER(email) = ? AND status = 'PAUSED_NEEDS_REVIEW'").get(cleanEmail)
    : null;

  if (existingThread) {
    db.prepare(`
      UPDATE review_threads
      SET reason = ?, error_code = ?, subject = ?, message_snippet = ?, updated_at = ?
      WHERE id = ?
    `).run(reason, errorCode || null, subject || '', messageSnippet || '', now, existingThread.id);
  } else {
    db.prepare(`
      INSERT INTO review_threads (
        lead_id, email, company, reason, error_code, subject, message_snippet, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PAUSED_NEEDS_REVIEW', ?, ?)
    `).run(leadId || null, cleanEmail, company || 'Unknown', reason, errorCode || null, subject || '', messageSnippet || '', now, now);
  }

  if (leadId) {
    db.prepare(`
      INSERT INTO lifecycle_audit_log (lead_id, from_stage, to_stage, event_name, detail, timestamp)
      VALUES (?, 'active', 'paused_review', 'THREAD_PAUSED_FOR_REVIEW', ?, ?)
    `).run(leadId, `Reason: ${reason}. Error: ${errorCode || 'None'}`, now);
  }

  return {
    success: true,
    email: cleanEmail,
    status: 'PAUSED_NEEDS_REVIEW',
    reason,
    paused: true
  };
}

/**
 * Gets all threads currently paused and flagged for review.
 */
function getFlaggedThreadsForReview() {
  const db = getDatabase();
  try {
    const stmt = db.prepare("SELECT * FROM review_threads WHERE status = 'PAUSED_NEEDS_REVIEW' ORDER BY updated_at DESC");
    return stmt.all();
  } catch (e) {
    return [];
  }
}

/**
 * Checks if a specific recipient thread is paused for review.
 */
function isThreadPaused(email) {
  if (!email) return false;
  const db = getDatabase();
  try {
    const cleanEmail = email.trim().toLowerCase();
    const row = db.prepare("SELECT id FROM review_threads WHERE LOWER(email) = ? AND status = 'PAUSED_NEEDS_REVIEW'").get(cleanEmail);
    return !!row;
  } catch (e) {
    return false;
  }
}

/**
 * Unpauses a thread after human review.
 */
function unpauseThread(email, newStatus = 'RESOLVED') {
  if (!email) return false;
  const db = getDatabase();
  const cleanEmail = email.trim().toLowerCase();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE review_threads
    SET status = ?, updated_at = ?
    WHERE LOWER(email) = ? AND status = 'PAUSED_NEEDS_REVIEW'
  `).run(newStatus, now, cleanEmail);
  return true;
}

/**
 * Seed or sync leads from INITIAL_AGENCY_TARGETS
 */
function seedInitialPipeline(targets = []) {
  const seeded = [];
  for (const t of targets) {
    const id = `AGENCY-${t.company.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}`;
    const result = upsertLead({
      id,
      name: t.name,
      title: t.title,
      company: t.company,
      domain: t.domain,
      email: t.email,
      industry: t.industry,
      stage: 'discovered',
      qualificationScore: 85,
      qualificationTier: 'HIGH_VALUE_ICP',
      estimatedMonthlyLLMBurnUSD: t.estimatedMonthlyLLMBurnUSD || 4000,
      dealValueUSD: 25000,
      selectedPackage: 'buyout'
    });
    seeded.push(result);
  }
  return seeded;
}

/**
 * Returns current date string in Central Standard Time (America/Chicago) YYYY-MM-DD
 */
function getCstDateString(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/**
 * Retrieves current daily dispatch counter state from SQLite database.
 * If no record exists for today's CST date, initializes one with sent_today = 0.
 */
function getDailyDispatchState(targetDate = null) {
  const db = getDatabase();
  const dateKey = targetDate || getCstDateString();
  const dailyLimit = parseInt(process.env.DAILY_DISPATCH_LIMIT || '35', 10);
  const now = new Date().toISOString();

  let row = db.prepare('SELECT * FROM daily_dispatch_state WHERE date = ?').get(dateKey);
  if (!row) {
    db.prepare(`
      INSERT INTO daily_dispatch_state (date, sent_today, daily_limit, status, last_dispatch_at, updated_at)
      VALUES (?, 0, ?, 'ACTIVE', NULL, ?)
    `).run(dateKey, dailyLimit, now);
    row = {
      date: dateKey,
      sent_today: 0,
      daily_limit: dailyLimit,
      status: 'ACTIVE',
      last_dispatch_at: null,
      updated_at: now
    };
  }

  const sentToday = Number(row.sent_today || 0);
  const limit = Number(row.daily_limit || dailyLimit);
  const status = sentToday >= limit ? 'CAP_REACHED' : (row.status || 'ACTIVE');

  return {
    date: row.date,
    sentToday,
    dailyLimit: limit,
    remainingToday: Math.max(0, limit - sentToday),
    status,
    lastDispatchAt: row.last_dispatch_at
  };
}

/**
 * Increments sent_today in SQLite daily_dispatch_state for today's CST date.
 */
function recordDailySend(count = 1) {
  const db = getDatabase();
  const dateKey = getCstDateString();
  const dailyLimit = parseInt(process.env.DAILY_DISPATCH_LIMIT || '35', 10);
  const now = new Date().toISOString();

  getDailyDispatchState(dateKey);

  db.prepare(`
    UPDATE daily_dispatch_state
    SET sent_today = sent_today + ?,
        last_dispatch_at = ?,
        updated_at = ?
    WHERE date = ?
  `).run(count, now, now, dateKey);

  const updated = db.prepare('SELECT * FROM daily_dispatch_state WHERE date = ?').get(dateKey);
  const sentToday = Number(updated.sent_today || 0);
  if (sentToday >= dailyLimit) {
    db.prepare(`UPDATE daily_dispatch_state SET status = 'CAP_REACHED' WHERE date = ?`).run(dateKey);
  }

  return getDailyDispatchState(dateKey);
}

/**
 * Resets sent_today back to zero in the database and clears daily send gates.
 * Runs automatically at 00:00 midnight CST.
 */
function resetDailySendCounter(targetDate = null) {
  const db = getDatabase();
  const dateKey = targetDate || getCstDateString();
  const dailyLimit = parseInt(process.env.DAILY_DISPATCH_LIMIT || '35', 10);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO daily_dispatch_state (date, sent_today, daily_limit, status, last_dispatch_at, updated_at)
    VALUES (?, 0, ?, 'ACTIVE', NULL, ?)
    ON CONFLICT(date) DO UPDATE SET
      sent_today = 0,
      status = 'ACTIVE',
      updated_at = excluded.updated_at
  `).run(dateKey, dailyLimit, now);

  db.prepare(`
    INSERT INTO lifecycle_audit_log (lead_id, from_stage, to_stage, event_name, detail, timestamp)
    VALUES (NULL, 'CAP_REACHED', 'ACTIVE', 'DAILY_SEND_COUNTER_RESET', ?, ?)
  `).run(`Daily send counter reset to 0 for date ${dateKey} at midnight CST. Gates cleared.`, now);

  return {
    success: true,
    date: dateKey,
    sentToday: 0,
    dailyLimit,
    remainingToday: dailyLimit,
    status: 'ACTIVE',
    clearedAt: now
  };
}

module.exports = {
  getDatabase,
  upsertLead,
  transitionStage,
  getPipelineSummary,
  seedInitialPipeline,
  markLeadDisqualifiedMx,
  flagThreadForReview,
  getFlaggedThreadsForReview,
  isThreadPaused,
  unpauseThread,
  getCstDateString,
  getDailyDispatchState,
  recordDailySend,
  resetDailySendCounter,
  VALID_STAGES
};
