/**
 * lib/inboundReplyListener.js
 * Inbound Reply Listener, Outbound Circuit Breaker, and Deal Desk Triage Poller.
 * Connects via IMAP to Hostinger, polls unseen inbox messages, matches senders against pipeline_leads,
 * trips circuit breakers to immediately halt cold dispatches, updates blocklist for opt-outs,
 * and stages $4k setup + $1.5k/mo retainer deal desk response drafts in pipeline.db.
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { getDatabase, transitionStage } = require('../skills/skill7_pipeline_manager');
const { 
  initTriageDb, 
  hasProcessedMessageId, 
  recordInboundReply, 
  stageDraftReply, 
  getTriageStats 
} = require('./inboundTriageDb');
const { 
  classifyIntent, 
  handleSuppression, 
  generateDraftResponse 
} = require('./triageClassifier');

let lastPolledAt = null;
let isPollingActive = false;

/**
 * Creates configured ImapFlow client for Hostinger IMAP
 */
function createImapClient() {
  const host = process.env.IMAP_SERVER || 'imap.hostinger.com';
  const port = parseInt(process.env.IMAP_PORT || '993', 10);
  const user = process.env.HOSTINGER_SMTP_USER || process.env.IMAP_USER || process.env.SMTP_USER || 'jack@missedcallproject.com';
  const pass = process.env.HOSTINGER_SMTP_PASS || process.env.IMAP_PASS || process.env.SMTP_PASS || '';

  return new ImapFlow({
    host,
    port,
    secure: port === 993 || port === 465,
    auth: { user, pass },
    logger: false
  });
}

/**
 * Matches an incoming email sender against pipeline_leads
 */
function findMatchingLead(fromEmail) {
  if (!fromEmail) return null;
  const db = getDatabase();
  const normEmail = fromEmail.toLowerCase().trim();
  
  // 1. Exact email match
  let lead = db.prepare(`SELECT * FROM pipeline_leads WHERE LOWER(email) = ? LIMIT 1`).get(normEmail);
  if (lead) return lead;

  // 2. Domain match (fallback for colleagues from same agency)
  const domain = normEmail.split('@')[1];
  if (domain && !['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com', 'icloud.com'].includes(domain)) {
    lead = db.prepare(`SELECT * FROM pipeline_leads WHERE LOWER(domain) = ? LIMIT 1`).get(domain);
    if (lead) return lead;
  }

  return null;
}

/**
 * Processes a single inbound message through classification and the circuit breaker
 */
async function processSingleInboundMessage(messageData) {
  const fromEmail = (messageData.fromEmail || '').toLowerCase().trim();
  const fromName = messageData.fromName || 'Decision Maker';
  const toEmail = (messageData.toEmail || '').toLowerCase().trim();
  const subject = messageData.subject || '';
  const bodyText = messageData.bodyText || '';
  const messageId = messageData.messageId || null;
  const receivedAt = messageData.receivedAt || new Date().toISOString();

  // Deduplication check
  if (messageId && hasProcessedMessageId(messageId)) {
    return { skipped: true, reason: 'ALREADY_PROCESSED', messageId };
  }

  // 1. Match against pipeline_leads
  const lead = findMatchingLead(fromEmail);
  const domain = fromEmail.split('@')[1] || '';
  let circuitBreakerTripped = false;
  let leadStageBefore = null;
  let leadStageAfter = null;

  // 2. Circuit Breaker Execution:
  // If matched, immediately flip stage to 'contacted_replied' to halt any cold dispatches
  if (lead) {
    leadStageBefore = lead.stage;
    try {
      transitionStage(lead.id, 'contacted_replied', `Outbound circuit breaker tripped by inbound reply: "${subject}"`);
      leadStageAfter = 'contacted_replied';
      circuitBreakerTripped = true;
      console.log(`[Circuit Breaker] TRIPPED for ${fromEmail} (Lead ${lead.id}). Stage moved from '${leadStageBefore}' -> 'contacted_replied'. Cold dispatches halted.`);
    } catch (err) {
      console.error(`[Circuit Breaker Error] Failed transitioning lead ${lead.id}:`, err.message);
      leadStageAfter = leadStageBefore;
    }
  } else {
    leadStageAfter = 'unknown_inbound';
  }

  // 3. Classify Intent
  const classification = classifyIntent(bodyText);
  console.log(`[Triage Classifier] Classified reply from ${fromEmail} as: ${classification}`);

  // 4. Handle Unsubscribe vs Positive/Objection
  let stagedDraft = null;

  if (classification === 'UNSUBSCRIBE_NOT_INTERESTED') {
    // Immediate suppression in config/blocklist.json and do-not-send-list.csv
    handleSuppression(fromEmail, domain);
  } else {
    // Generate $4k setup + $1.5k/mo retainer tailored response draft
    const leadName = lead ? lead.name : fromName;
    const companyName = lead ? lead.company : (domain || 'your agency');
    const responseDraft = generateDraftResponse(classification, leadName, companyName);

    // Stage draft in staged_replies table for Deal Desk review
    const stageResult = stageDraftReply({
      leadId: lead ? lead.id : null,
      toEmail: fromEmail,
      toName: leadName,
      company: companyName,
      classification,
      subject: responseDraft.subject,
      draftBody: responseDraft.body,
      pricingTerms: '$4k setup + $1.5k/mo retainer',
      status: 'PENDING_APPROVAL'
    });
    stagedDraft = { id: stageResult.id, ...responseDraft };
    console.log(`[Deal Desk Drafter] Staged ${classification} response draft for ${fromEmail} (Draft ID: ${stageResult.id}).`);
  }

  // 5. Record to inbound_replies database table
  const inboundRecord = recordInboundReply({
    messageId,
    leadId: lead ? lead.id : null,
    fromEmail,
    fromName,
    toEmail,
    subject,
    bodyText,
    classification,
    circuitBreakerTripped: circuitBreakerTripped ? 1 : 0,
    leadStageBefore,
    leadStageAfter,
    receivedAt
  });

  return {
    success: true,
    inboundReplyId: inboundRecord.id,
    fromEmail,
    leadMatched: !!lead,
    leadId: lead ? lead.id : null,
    classification,
    circuitBreakerTripped,
    stagedDraft
  };
}

/**
 * Polls Hostinger IMAP inbox for unseen messages
 */
async function pollInboundReplies(options = {}) {
  if (isPollingActive) {
    console.log('[IMAP Listener] Poll already in progress, skipping duplicate cycle.');
    return { success: false, reason: 'POLL_IN_PROGRESS' };
  }

  isPollingActive = true;
  lastPolledAt = new Date().toISOString();
  initTriageDb();

  // Test / Synthetic mock injection mode
  if (options.mockMessages && Array.isArray(options.mockMessages)) {
    const results = [];
    let trippedCount = 0;
    for (const msg of options.mockMessages) {
      const res = await processSingleInboundMessage(msg);
      if (res.circuitBreakerTripped) trippedCount++;
      results.push(res);
    }
    isPollingActive = false;
    return {
      success: true,
      mode: 'MOCK',
      processedCount: results.length,
      circuitBreakersTripped: trippedCount,
      results
    };
  }

  const pass = process.env.HOSTINGER_SMTP_PASS || process.env.IMAP_PASS || process.env.SMTP_PASS;
  if (!pass) {
    console.log('[IMAP Listener] No IMAP password provided in environment. Poller standing by.');
    isPollingActive = false;
    return { success: false, reason: 'NO_IMAP_CREDENTIALS', processedCount: 0 };
  }

  const client = createImapClient();
  const processed = [];
  let circuitBreakersTripped = 0;

  try {
    console.log('[IMAP Listener] Connecting to Hostinger IMAP (imap.hostinger.com:993)...');
    await client.connect();

    const lock = await client.getMailboxLock('INBOX');
    try {
      console.log('[IMAP Listener] Checking for unseen messages in INBOX...');
      
      for await (const message of client.fetch({ seen: false }, { envelope: true, source: true, flags: true })) {
        try {
          const parsed = await simpleParser(message.source);
          const fromEmail = parsed.from?.value?.[0]?.address || '';
          const fromName = parsed.from?.value?.[0]?.name || parsed.from?.text || 'Decision Maker';
          const toEmail = parsed.to?.value?.[0]?.address || '';
          const subject = parsed.subject || '';
          const bodyText = parsed.text || '';
          const messageId = parsed.messageId || `${message.uid}@hostinger.mail`;

          const result = await processSingleInboundMessage({
            fromEmail,
            fromName,
            toEmail,
            subject,
            bodyText,
            messageId,
            receivedAt: parsed.date ? parsed.date.toISOString() : new Date().toISOString()
          });

          if (!result.skipped) {
            processed.push(result);
            if (result.circuitBreakerTripped) {
              circuitBreakersTripped++;
            }
          }

          // Mark message as seen so it is not re-processed
          if (message.uid) {
            await client.messageFlagsAdd({ uid: message.uid }, ['\\Seen']);
          }
        } catch (msgErr) {
          console.error(`[IMAP Listener Error] Failed parsing message ${message.seq}:`, msgErr.message);
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
    console.log(`[IMAP Listener] Cycle complete: processed ${processed.length} new replies. Circuit breakers tripped: ${circuitBreakersTripped}.`);
    return {
      success: true,
      processedCount: processed.length,
      circuitBreakersTripped,
      processed
    };
  } catch (err) {
    console.error('[IMAP Listener Error] IMAP connection failure:', err.message);
    return {
      success: false,
      error: err.message,
      processedCount: processed.length
    };
  } finally {
    isPollingActive = false;
  }
}

/**
 * Exports real-time inbox triage telemetry
 */
function getInboxTriageTelemetry() {
  try {
    const stats = getTriageStats();
    return {
      status: "ACTIVE",
      lastPolledAt: lastPolledAt || new Date().toISOString(),
      totalInboundReplies: stats.totalInboundReplies,
      circuitBreakersTripped: stats.circuitBreakersTripped,
      pendingDraftsCount: stats.pendingDraftsCount,
      triagedBreakdown: stats.triagedBreakdown,
      pendingDrafts: stats.pendingDrafts
    };
  } catch (err) {
    return {
      status: "DEGRADED",
      error: err.message,
      lastPolledAt: lastPolledAt || null
    };
  }
}

module.exports = {
  createImapClient,
  findMatchingLead,
  processSingleInboundMessage,
  pollInboundReplies,
  getInboxTriageTelemetry
};
