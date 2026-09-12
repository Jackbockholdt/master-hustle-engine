/**
 * Skill 7: Pipeline State & SQLite Lifecycle Tracker
 * Tracks lead lifecycle stages: 'discovered' -> 'triaged' -> 'contacted' -> 'proposed' -> 'converted'
 * Built with native Node 24 SQLite (node:sqlite) for zero-dependency persistence.
 */

const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'pipeline.db');
const JSON_CRM_PATH = path.join(__dirname, '..', 'crm_leads_tracker.json');

const VALID_STAGES = ['discovered', 'triaged', 'contacted', 'proposed', 'converted', 'disqualified'];

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

      CREATE TABLE IF NOT EXISTS pipeline_followups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT,
        campaign_id TEXT DEFAULT 'default',
        email TEXT NOT NULL,
        step INTEGER DEFAULT 1,
        subject TEXT,
        body TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        suppress_reason TEXT,
        due_at TEXT,
        sent_at TEXT,
        created_at TEXT,
        FOREIGN KEY (lead_id) REFERENCES pipeline_leads(id)
      );
    `);

    // Ensure last_contacted_at column exists in pipeline_leads
    try {
      dbInstance.exec(`ALTER TABLE pipeline_leads ADD COLUMN last_contacted_at TEXT;`);
    } catch (e) {
      // Column already exists
    }
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
  const lastContacted = lead.lastContactedAt || lead.last_contacted_at || null;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO pipeline_leads (
      id, name, title, company, domain, email, industry, stage,
      qualification_score, qualification_tier, estimated_burn,
      deal_value, selected_package, stripe_payment_link, last_contacted_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      last_contacted_at=COALESCE(excluded.last_contacted_at, pipeline_leads.last_contacted_at),
      updated_at=excluded.updated_at
  `);

  stmt.run(
    id, name, title, company, domain, email, industry, stage,
    score, tier, burn, dealValue, pkg, stripeLink, lastContacted, now, now
  );

  return { id, company, email, stage, lastContactedAt: lastContacted };
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
    disqualified: 0
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
    recentLeads
  };
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

// =============================================================================
// FOLLOW-UP DEDUPLICATION & 48-HOUR QUIET GAP GUARDRAILS
// Ported from followup-dedupe.patch for Enterprise 9-Skill modern architecture
// =============================================================================

const FOLLOWUP_MIN_GAP_HOURS = Number(process.env.FOLLOWUP_MIN_GAP_HOURS || 48);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIVE_DB_PATH = process.env.LIVE_DB_PATH || process.env.DB_PATH || path.join(__dirname, '..', 'transactions.sqlite');

let liveDbInstance = null;

function getLiveDatabase() {
  if (liveDbInstance) return liveDbInstance;

  try {
    const { DatabaseSync } = require('node:sqlite');
    liveDbInstance = new DatabaseSync(LIVE_DB_PATH);
    liveDbInstance.exec(`
      CREATE TABLE IF NOT EXISTS send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sent_to TEXT NOT NULL,
        campaign TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS follow_ups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        company_name TEXT,
        contact_email TEXT,
        step INTEGER,
        subject TEXT,
        body TEXT,
        due_at TEXT,
        status TEXT DEFAULT 'pending',
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS leads_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_name TEXT,
        contact_email TEXT,
        status TEXT DEFAULT 'pending',
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME
      );
    `);
  } catch (err) {
    console.error('[Live SQLite Init Error] Failed initializing live database:', err.message);
    throw err;
  }

  return liveDbInstance;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Evaluates whether a follow-up is eligible to be scheduled or dispatched.
 * Enforces:
 *  1. Syntax validation (RFC check)
 *  2. Duplicate suppression (active pending/processing task in pipeline_followups or live follow_ups/leads_queue)
 *  3. 48-Hour quiet gap (from lastContactedAt, pipeline_followups sent records, or live send_log)
 */
function evaluateFollowUpEligibility({ leadId = null, email = '', campaignId = 'default', step = 1, lastContactedAt = null } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !EMAIL_REGEX.test(normalized)) {
    return {
      eligible: false,
      status: 'DROPPED_INVALID_FORMAT',
      reason: 'Failed RFC-compliant email syntax check',
      email: normalized
    };
  }

  const db = getDatabase();
  const liveDb = getLiveDatabase();

  // 1. Check duplicate pending/processing tasks for this address in pipeline.db
  const checkDupeStmt = db.prepare(`
    SELECT id, campaign_id, step, status, created_at
      FROM pipeline_followups
     WHERE LOWER(email) = ? AND status IN ('pending', 'processing')
     ORDER BY id ASC LIMIT 1
  `);
  const activeDupe = checkDupeStmt.get(normalized);
  if (activeDupe) {
    return {
      eligible: false,
      status: 'SUPPRESSED_DUPLICATE',
      reason: `Duplicate recipient address detected within campaign window (Task #${activeDupe.id} already ${activeDupe.status} for step ${activeDupe.step})`,
      existingTaskId: activeDupe.id,
      email: normalized
    };
  }

  // Check duplicate pending/processing sequences or queue in live store
  try {
    const liveFu = liveDb.prepare(`
      SELECT id, status, step FROM follow_ups
       WHERE LOWER(contact_email) = ? AND status IN ('pending', 'processing')
       ORDER BY id ASC LIMIT 1
    `).get(normalized);
    if (liveFu) {
      return {
        eligible: false,
        status: 'SUPPRESSED_DUPLICATE',
        reason: `Duplicate recipient address detected in live follow_ups (Step ${liveFu.step || 1} already ${liveFu.status})`,
        email: normalized
      };
    }
  } catch (e) {}

  try {
    const liveQ = liveDb.prepare(`
      SELECT id, status FROM leads_queue
       WHERE LOWER(contact_email) = ? AND status IN ('pending', 'queued', 'processing')
       ORDER BY id ASC LIMIT 1
    `).get(normalized);
    if (liveQ) {
      return {
        eligible: false,
        status: 'SUPPRESSED_DUPLICATE',
        reason: `Recipient address already queued in live leads_queue (${liveQ.status})`,
        email: normalized
      };
    }
  } catch (e) {}

  // 2. Check 48-Hour Quiet Gap
  let contactTimestamp = lastContactedAt;
  if (!contactTimestamp && leadId) {
    const leadStmt = db.prepare(`SELECT last_contacted_at FROM pipeline_leads WHERE id = ?`);
    const l = leadStmt.get(leadId);
    if (l && l.last_contacted_at) contactTimestamp = l.last_contacted_at;
  }
  if (!contactTimestamp) {
    // Check latest sent follow-up in pipeline_followups
    const sentStmt = db.prepare(`
      SELECT sent_at FROM pipeline_followups
       WHERE LOWER(email) = ? AND status = 'sent'
       ORDER BY sent_at DESC LIMIT 1
    `);
    const lastSent = sentStmt.get(normalized);
    if (lastSent && lastSent.sent_at) contactTimestamp = lastSent.sent_at;
  }
  if (!contactTimestamp) {
    // Check live send_log (ground truth for "we emailed this person")
    try {
      const liveSentStmt = liveDb.prepare(`
        SELECT sent_at FROM send_log
         WHERE LOWER(sent_to) = ?
         ORDER BY id DESC LIMIT 1
      `);
      const liveSent = liveSentStmt.get(normalized);
      if (liveSent && liveSent.sent_at) contactTimestamp = liveSent.sent_at;
    } catch (e) {}
  }
  if (!contactTimestamp) {
    // Check live follow_ups sent_at
    try {
      const liveFuSent = liveDb.prepare(`
        SELECT sent_at FROM follow_ups
         WHERE LOWER(contact_email) = ? AND status = 'sent' AND sent_at IS NOT NULL
         ORDER BY id DESC LIMIT 1
      `);
      const liveFuSentRow = liveFuSent.get(normalized);
      if (liveFuSentRow && liveFuSentRow.sent_at) contactTimestamp = liveFuSentRow.sent_at;
    } catch (e) {}
  }

  if (contactTimestamp) {
    let contactedMs = new Date(contactTimestamp).getTime();
    if (isNaN(contactedMs) && typeof contactTimestamp === 'string') {
      contactedMs = new Date(contactTimestamp.replace(' ', 'T') + 'Z').getTime();
    }
    if (!isNaN(contactedMs)) {
      const elapsedHours = (Date.now() - contactedMs) / (1000 * 60 * 60);
      if (elapsedHours < FOLLOWUP_MIN_GAP_HOURS) {
        const remainingHours = Math.max(0, +(FOLLOWUP_MIN_GAP_HOURS - elapsedHours).toFixed(1));
        return {
          eligible: false,
          status: 'SUPPRESSED_QUIET_GAP',
          reason: `Suppressed: Recipient contacted ${elapsedHours.toFixed(1)}h ago; inside mandatory ${FOLLOWUP_MIN_GAP_HOURS}h quiet gap window`,
          elapsedHours: +elapsedHours.toFixed(1),
          remainingGapHours: remainingHours,
          enforcedQuietGapHours: FOLLOWUP_MIN_GAP_HOURS,
          lastContactedAt: contactTimestamp,
          email: normalized
        };
      }
    }
  }

  return {
    eligible: true,
    status: 'CLEARED_FOR_DISPATCH',
    reason: 'Passed syntax, deduping, and 48-hour quiet gap guardrails',
    enforcedQuietGapHours: FOLLOWUP_MIN_GAP_HOURS,
    email: normalized
  };
}

/**
 * Queues a follow-up task with deduplication and quiet gap guardrail enforcement
 */
function queueFollowUpTask({ leadId = null, email = '', campaignId = 'default', step = 1, subject = '', body = '', dueAt = null, lastContactedAt = null } = {}) {
  const db = getDatabase();
  const normalized = normalizeEmail(email);
  const evaluation = evaluateFollowUpEligibility({ leadId, email: normalized, campaignId, step, lastContactedAt });
  const now = new Date().toISOString();
  const scheduledDue = dueAt || now;

  const insertStmt = db.prepare(`
    INSERT INTO pipeline_followups (
      lead_id, campaign_id, email, step, subject, body,
      status, suppress_reason, due_at, sent_at, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
    )
  `);

  if (!evaluation.eligible) {
    const res = insertStmt.run(
      leadId, campaignId, normalized, step, subject, body,
      'suppressed', evaluation.reason, scheduledDue, now
    );
    return {
      taskId: Number(res.lastInsertRowid),
      eligible: false,
      status: evaluation.status,
      reason: evaluation.reason,
      details: evaluation
    };
  }

  const res = insertStmt.run(
    leadId, campaignId, normalized, step, subject, body,
    'pending', null, scheduledDue, now
  );

  return {
    taskId: Number(res.lastInsertRowid),
    eligible: true,
    status: 'CLEARED_FOR_DISPATCH',
    reason: evaluation.reason,
    dueAt: scheduledDue
  };
}

/**
 * Fetches due follow-ups enforcing at most ONE row per ADDRESS per run (MIN(id) selection)
 */
function fetchDueFollowUps(limit = 25) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    SELECT id, lead_id, campaign_id, email, step, subject, body, due_at
      FROM pipeline_followups
     WHERE status = 'pending' AND due_at <= ?
       AND id IN (SELECT MIN(id) FROM pipeline_followups
                   WHERE status = 'pending' AND due_at <= ?
                   GROUP BY LOWER(email))
     ORDER BY due_at ASC LIMIT ?
  `);
  return stmt.all(now, now, limit || 25);
}

/**
 * Marks follow-up task status
 */
function markFollowUpTask(id, status, error = null) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE pipeline_followups
       SET status = ?,
           sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
           suppress_reason = ?
     WHERE id = ?
  `);
  stmt.run(status, status, now, error || null, id);
}

/**
 * One-time / boot cleanup: for any address holding pending follow-ups under more
 * than one campaign, keep the earliest campaign and suppress the rest.
 */
function retireDuplicateSequences() {
  const db = getDatabase();
  const dupeRows = db.prepare(`
    SELECT LOWER(email) AS email, COUNT(DISTINCT campaign_id) AS campaigns
      FROM pipeline_followups
     WHERE status = 'pending'
     GROUP BY LOWER(email) HAVING campaigns > 1
  `).all();

  let retired = 0;
  for (const d of dupeRows) {
    const keep = db.prepare(`
      SELECT campaign_id FROM pipeline_followups
       WHERE status = 'pending' AND LOWER(email) = ?
       ORDER BY id ASC LIMIT 1
    `).get(d.email);
    if (!keep) continue;

    const r = db.prepare(`
      UPDATE pipeline_followups
         SET status = 'suppressed',
             suppress_reason = 'Duplicate campaign sequence retired by retireDuplicateSequences'
       WHERE status = 'pending' AND LOWER(email) = ? AND campaign_id != ?
    `).run(d.email, keep.campaign_id);

    retired += Number(r.changes || 0);
  }

  return {
    success: true,
    totalAddressesWithDupes: dupeRows.length,
    retiredSequences: retired
  };
}

module.exports = {
  getDatabase,
  getLiveDatabase,
  LIVE_DB_PATH,
  upsertLead,
  transitionStage,
  getPipelineSummary,
  seedInitialPipeline,
  evaluateFollowUpEligibility,
  queueFollowUpTask,
  fetchDueFollowUps,
  markFollowUpTask,
  retireDuplicateSequences,
  FOLLOWUP_MIN_GAP_HOURS,
  VALID_STAGES
};
