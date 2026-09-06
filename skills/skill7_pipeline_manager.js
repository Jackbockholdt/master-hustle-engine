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

module.exports = {
  getDatabase,
  upsertLead,
  transitionStage,
  getPipelineSummary,
  seedInitialPipeline,
  VALID_STAGES
};
