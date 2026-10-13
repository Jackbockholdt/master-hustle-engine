/**
 * lib/inboundTriageDb.js
 * Database Schema Extension & Persistence for Inbound Reply Triage and Staged Drafter.
 * Stores inbound email events, circuit-breaker flags, and deal desk response drafts in pipeline.db.
 */

const path = require('path');
const { getDatabase } = require('../skills/skill7_pipeline_manager');

/**
 * Initializes tables for inbound email triage & staged drafts
 */
function initTriageDb(db = null) {
  const database = db || getDatabase();

  database.exec(`
    CREATE TABLE IF NOT EXISTS inbound_replies (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      lead_id TEXT,
      from_email TEXT NOT NULL,
      from_name TEXT,
      to_email TEXT,
      subject TEXT,
      body_text TEXT,
      classification TEXT NOT NULL,
      circuit_breaker_tripped INTEGER DEFAULT 1,
      lead_stage_before TEXT,
      lead_stage_after TEXT,
      received_at TEXT,
      created_at TEXT,
      FOREIGN KEY (lead_id) REFERENCES pipeline_leads(id)
    );

    CREATE TABLE IF NOT EXISTS staged_replies (
      id TEXT PRIMARY KEY,
      inbound_reply_id TEXT,
      lead_id TEXT,
      to_email TEXT NOT NULL,
      to_name TEXT,
      company TEXT,
      classification TEXT NOT NULL,
      subject TEXT,
      draft_body TEXT NOT NULL,
      pricing_terms TEXT DEFAULT '$4k setup + $1.5k/mo retainer',
      status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (inbound_reply_id) REFERENCES inbound_replies(id),
      FOREIGN KEY (lead_id) REFERENCES pipeline_leads(id)
    );

    CREATE INDEX IF NOT EXISTS idx_inbound_from_email ON inbound_replies(from_email);
    CREATE INDEX IF NOT EXISTS idx_inbound_msg_id ON inbound_replies(message_id);
    CREATE INDEX IF NOT EXISTS idx_staged_status ON staged_replies(status);
    CREATE INDEX IF NOT EXISTS idx_staged_to_email ON staged_replies(to_email);
  `);

  return database;
}

/**
 * Checks if a specific message ID has already been recorded
 */
function hasProcessedMessageId(messageId) {
  if (!messageId) return false;
  const db = initTriageDb();
  const row = db.prepare(`SELECT id FROM inbound_replies WHERE message_id = ? LIMIT 1`).get(messageId);
  return !!row;
}

/**
 * Records an inbound reply in inbound_replies
 */
function recordInboundReply(entry = {}) {
  const db = initTriageDb();
  const id = entry.id || `INBOUND-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO inbound_replies (
      id, message_id, lead_id, from_email, from_name, to_email,
      subject, body_text, classification, circuit_breaker_tripped,
      lead_stage_before, lead_stage_after, received_at, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `);

  stmt.run(
    id,
    entry.messageId || entry.message_id || null,
    entry.leadId || entry.lead_id || null,
    (entry.fromEmail || entry.from_email || '').toLowerCase().trim(),
    entry.fromName || entry.from_name || null,
    (entry.toEmail || entry.to_email || '').toLowerCase().trim(),
    entry.subject || null,
    entry.bodyText || entry.body_text || null,
    entry.classification || 'UNKNOWN',
    entry.circuitBreakerTripped !== undefined ? (entry.circuitBreakerTripped ? 1 : 0) : 1,
    entry.leadStageBefore || entry.lead_stage_before || null,
    entry.leadStageAfter || entry.lead_stage_after || 'contacted_replied',
    entry.receivedAt || entry.received_at || now,
    entry.createdAt || entry.created_at || now
  );

  return { id, success: true };
}

/**
 * Stages a response draft for human review and deal desk triage
 */
function stageDraftReply(draft = {}) {
  const db = initTriageDb();
  const id = draft.id || `DRAFT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO staged_replies (
      id, inbound_reply_id, lead_id, to_email, to_name,
      company, classification, subject, draft_body,
      pricing_terms, status, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `);

  stmt.run(
    id,
    draft.inboundReplyId || draft.inbound_reply_id || null,
    draft.leadId || draft.lead_id || null,
    (draft.toEmail || draft.to_email || '').toLowerCase().trim(),
    draft.toName || draft.to_name || 'Decision Maker',
    draft.company || 'your agency',
    draft.classification || 'POSITIVE_INTEREST',
    draft.subject || 'Re: white-label AI for your clients?',
    draft.draftBody || draft.draft_body || '',
    draft.pricingTerms || draft.pricing_terms || '$4k setup + $1.5k/mo retainer',
    draft.status || 'PENDING_APPROVAL',
    draft.createdAt || draft.created_at || now,
    draft.updatedAt || draft.updated_at || now
  );

  return { id, success: true };
}

/**
 * Retrieves staged replies by status
 */
function getStagedReplies(status = 'PENDING_APPROVAL', limit = 50) {
  const db = initTriageDb();
  let stmt;
  if (status) {
    stmt = db.prepare(`
      SELECT * FROM staged_replies 
      WHERE status = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `);
    return stmt.all(status, limit);
  } else {
    stmt = db.prepare(`
      SELECT * FROM staged_replies 
      ORDER BY created_at DESC 
      LIMIT ?
    `);
    return stmt.all(limit);
  }
}

/**
 * Updates status of a staged reply (e.g. APPROVED, SENT, REJECTED)
 */
function updateStagedReplyStatus(id, newStatus) {
  const db = initTriageDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE staged_replies 
    SET status = ?, updated_at = ? 
    WHERE id = ?
  `);
  stmt.run(newStatus, now, id);
  return { id, status: newStatus, updatedAt: now };
}

/**
 * Retrieves all inbound replies
 */
function getInboundReplies(limit = 50) {
  const db = initTriageDb();
  return db.prepare(`
    SELECT * FROM inbound_replies 
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(limit);
}

/**
 * Aggregates summary telemetry for inbound triage
 */
function getTriageStats() {
  const db = initTriageDb();

  const totalReplies = db.prepare(`SELECT count(*) as count FROM inbound_replies`).get()?.count || 0;
  const circuitBreakers = db.prepare(`SELECT count(*) as count FROM inbound_replies WHERE circuit_breaker_tripped = 1`).get()?.count || 0;

  const classRows = db.prepare(`
    SELECT classification, count(*) as count 
    FROM inbound_replies 
    GROUP BY classification
  `).all();

  const triagedBreakdown = {
    POSITIVE_INTEREST: 0,
    OBJECTION_PRICING: 0,
    OBJECTION_EXISTING_TECH: 0,
    UNSUBSCRIBE_NOT_INTERESTED: 0,
    OTHER: 0
  };

  classRows.forEach(r => {
    if (triagedBreakdown[r.classification] !== undefined) {
      triagedBreakdown[r.classification] = r.count;
    } else {
      triagedBreakdown.OTHER = (triagedBreakdown.OTHER || 0) + r.count;
    }
  });

  const pendingDrafts = getStagedReplies('PENDING_APPROVAL', 25);

  return {
    totalInboundReplies: totalReplies,
    circuitBreakersTripped: circuitBreakers,
    triagedBreakdown,
    pendingDraftsCount: pendingDrafts.length,
    pendingDrafts
  };
}

module.exports = {
  initTriageDb,
  hasProcessedMessageId,
  recordInboundReply,
  stageDraftReply,
  getStagedReplies,
  updateStagedReplyStatus,
  getInboundReplies,
  getTriageStats
};
