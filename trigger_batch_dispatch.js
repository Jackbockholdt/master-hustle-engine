/**
 * trigger_batch_dispatch.js
 * Master Hustle Engine - Batch Dispatcher & Token Governance Execution Loop
 * Cross-references contacts against partner_outreach_log.csv and do-not-send-list.csv by header name.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const { verifyEmailPreFlight, validateEmailSyntax, resolveMxRecords } = require('./lib/emailVerifier');
const { isThreadPaused, flagThreadForReview, markLeadDisqualifiedMx, getPipelineSummary, recordDailySend, getDailyDispatchState, resetDailySendCounter } = require('./skills/skill7_pipeline_manager');

const BASE_DIR = __dirname;
const DAILY_CAP = 35;
const POSSIBLE_VERIFIED_PATHS = [
  path.join(BASE_DIR, '..', 'verified_leads.csv'),
  path.join(BASE_DIR, 'verified_leads.csv')
];

const POSSIBLE_PARTNER_LOG_PATHS = [
  path.join(BASE_DIR, 'partner_outreach_log.csv'),
  path.join(BASE_DIR, '..', 'partner_outreach_log.csv'),
  path.join(BASE_DIR, '..', 'gtm-infrastructure', 'knowledge', 'partner_outreach_log.csv')
];

const POSSIBLE_BLOCKLIST_PATHS = [
  path.join(BASE_DIR, 'config', 'blocklist.json'),
  path.join(BASE_DIR, 'do-not-send-list.csv'),
  path.join(BASE_DIR, '..', 'do-not-send-list.csv')
];

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'aol.com', 'outlook.com', 
  'hotmail.com', 'icloud.com', 'protonmail.com', 'gmx.com', 
  'mail.com', 'zoho.com', 'yandex.com', 'live.com'
]);

const DOMAIN_BLOCK_FAILURE_TYPES = new Set([
  'blocked_by_admin',
  'blocked_domain',
  'dns_failure',
  'domain_nonexistent'
]);

// Helper: Calculate randomized humanized stagger delay between min and max seconds (default 180s - 420s)
function getRandomStaggerMs(minSec = 180, maxSec = 420) {
  const minMs = minSec * 1000;
  const maxMs = maxSec * 1000;
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// Helper: Check dailySendCounter from server.js (or fallback SQLite pipeline) before every single dispatch
async function checkDailySendCounter(port = 3005) {
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/api/daily-send-counter',
        method: 'GET',
        timeout: 2500
      }, (r) => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
    if (res && res.dailySendCounter) {
      return res.dailySendCounter;
    }
  } catch (err) {
    // Server endpoint not reachable, fallback to direct module check
  }

  try {
    const { getDailySendCounter } = require('./server');
    if (typeof getDailySendCounter === 'function') {
      return getDailySendCounter();
    }
  } catch (e) {}

  try {
    const summary = getPipelineSummary();
    const sentToday = (summary.stageCounts?.contacted || 0) + (summary.stageCounts?.proposed || 0) + (summary.stageCounts?.converted || 0);
    return {
      dailyLimit: DAILY_CAP,
      sentToday,
      remainingToday: Math.max(0, DAILY_CAP - sentToday),
      status: sentToday >= DAILY_CAP ? "CAP_REACHED" : "ACTIVE"
    };
  } catch (e) {}

  return { dailyLimit: DAILY_CAP, sentToday: 0, remainingToday: DAILY_CAP, status: "ACTIVE" };
}

// Helper: DNS MX Pre-verification gate using native Node resolveMx
async function hasValidMX(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const cleanDom = domain.replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (!cleanDom || !cleanDom.includes('.')) return false;
  if (FREEMAIL_DOMAINS.has(cleanDom)) return true;
  const res = await resolveMxRecords(cleanDom);
  return res.hasMx;
}

// Helper: Clean First Name Sanitizer (No bracket placeholders, no lowercase, clean fallback to 'there')
function sanitizeFirstName(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'there';
  let clean = rawName.replace(/^["']|["']$/g, '').trim();
  if (clean.includes('[') || clean.includes(']') || clean.includes('{') || clean.includes('}') || 
      clean.toLowerCase().includes('owner') || clean.toLowerCase().includes('founder') || 
      clean.toLowerCase().includes('agency') || clean.toLowerCase().includes('there')) {
    return 'there';
  }
  clean = clean.replace(/[^a-zA-Z'\-]/g, '');
  if (clean.length <= 1) return 'there';
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

// Helper: Parse CSV Line supporting quotes
function parseCSVLine(text) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

// Helper: Map CSV headers to column indices
function parseCSVHeaderMap(headerLine) {
  const cols = parseCSVLine(headerLine);
  const map = {};
  cols.forEach((col, idx) => {
    const cleaned = col.replace(/^["']|["']$/g, '').trim().toLowerCase();
    map[cleaned] = idx;
  });
  return map;
}

// 1. Load Blocklist dynamically (JSON or CSV) with Fail-Closed Enforcement
function loadBlocklist(options = {}) {
  const failClosed = options.failClosed !== false; // Default: Fail-Closed active
  const blocklistEmails = new Set();
  const blocklistDomains = new Set();
  let loadedPath = null;

  for (const blockPath of POSSIBLE_BLOCKLIST_PATHS) {
    if (!fs.existsSync(blockPath)) continue;

    try {
      if (blockPath.endsWith('.json')) {
        const raw = fs.readFileSync(blockPath, 'utf8');
        const parsed = JSON.parse(raw);
        const addrs = parsed.addresses || parsed.emails || [];
        const doms = parsed.domains || [];

        addrs.forEach(em => {
          if (em && typeof em === 'string') blocklistEmails.add(em.trim().toLowerCase());
        });

        doms.forEach(d => {
          if (d && typeof d === 'string' && !FREEMAIL_DOMAINS.has(d.trim().toLowerCase())) {
            blocklistDomains.add(d.trim().toLowerCase());
          }
        });

        if (Array.isArray(parsed.entries)) {
          parsed.entries.forEach(entry => {
            if (entry.email) blocklistEmails.add(entry.email.trim().toLowerCase());
            if (entry.domain && !FREEMAIL_DOMAINS.has(entry.domain.trim().toLowerCase()) && DOMAIN_BLOCK_FAILURE_TYPES.has(entry.failure_type)) {
              blocklistDomains.add(entry.domain.trim().toLowerCase());
            }
          });
        }
        loadedPath = blockPath;
        break;
      } else if (blockPath.endsWith('.csv')) {
        const lines = fs.readFileSync(blockPath, 'utf8').split(/\r?\n/).filter(Boolean);
        if (lines.length > 0) {
          const headerMap = parseCSVHeaderMap(lines[0]);
          const emailIdx = headerMap['email'] !== undefined ? headerMap['email'] : 0;
          const domainIdx = headerMap['domain'] !== undefined ? headerMap['domain'] : 1;
          const failureTypeIdx = headerMap['failure_type'] !== undefined ? headerMap['failure_type'] : 2;

          for (let i = 1; i < lines.length; i++) {
            const cols = parseCSVLine(lines[i]);
            if (emailIdx < cols.length && cols[emailIdx]) {
              const em = cols[emailIdx].replace(/^["']|["']$/g, '').trim().toLowerCase();
              if (em) blocklistEmails.add(em);
            }
            if (domainIdx < cols.length && cols[domainIdx]) {
              const dom = cols[domainIdx].replace(/^["']|["']$/g, '').trim().toLowerCase();
              const failureType = failureTypeIdx < cols.length ? cols[failureTypeIdx].replace(/^["']|["']$/g, '').trim().toLowerCase() : '';

              if (dom && !FREEMAIL_DOMAINS.has(dom) && (DOMAIN_BLOCK_FAILURE_TYPES.has(failureType) || !failureType)) {
                blocklistDomains.add(dom);
              }
            }
          }
          loadedPath = blockPath;
          break;
        }
      }
    } catch (e) {
      console.error(`[Blocklist Load Warning] Error reading ${blockPath}: ${e.message}`);
    }
  }

  // FAIL-CLOSED SAFETY ENFORCEMENT:
  // If no blocklist file is found or if loaded sets are empty, refuse to dispatch emails.
  if (!loadedPath || (blocklistEmails.size === 0 && blocklistDomains.size === 0)) {
    if (failClosed) {
      throw new Error(
        `ERR_BLOCKLIST_MISSING_FAIL_CLOSED: Blocklist suppression file missing or empty (${POSSIBLE_BLOCKLIST_PATHS.map(p=>path.basename(p)).join(', ')}). Outbound dispatch HALTED to protect domain reputation.`
      );
    } else {
      console.warn(`[FAIL-OPEN WARNING] Blocklist file missing/empty. Proceeding without suppression screening.`);
    }
  }

  return { emails: blocklistEmails, domains: blocklistDomains, sourcePath: loadedPath };
}

// Helper: Lead Quality Screening Function
function screenLeadQuality(email, domain, blocklist) {
  if (!email || !email.includes('@')) {
    return { status: 'DISQUALIFIED', reason: 'Invalid or missing email address structure' };
  }

  const emailLower = email.trim().toLowerCase();
  const domainLower = (domain || email.split('@')[1] || '').trim().toLowerCase();

  if (blocklist && blocklist.emails && blocklist.emails.has(emailLower)) {
    return { status: 'DISQUALIFIED', reason: 'Email explicitly suppressed in blocklist' };
  }

  if (blocklist && blocklist.domains && domainLower && !FREEMAIL_DOMAINS.has(domainLower) && blocklist.domains.has(domainLower)) {
    return { status: 'DISQUALIFIED', reason: `Domain ${domainLower} suppressed due to domain-level bounce/block history` };
  }

  return { status: 'PASSED', email: emailLower, domain: domainLower };
}

// 2. Load Existing Outreach History dynamically by header name
function loadOutreachHistory() {
  const dispatchedEmails = new Set();
  const contactedCompanyCaps = new Set();

  for (const logPath of POSSIBLE_PARTNER_LOG_PATHS) {
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) continue;

      const headerMap = parseCSVHeaderMap(lines[0]);
      const emailIdx = headerMap['email'];
      const domainIdx = headerMap['domain'];
      const companyCapIdx = headerMap['company_cap'] !== undefined ? headerMap['company_cap'] : domainIdx;

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (emailIdx !== undefined && emailIdx < cols.length && cols[emailIdx]) {
          const email = cols[emailIdx].replace(/^["']|["']$/g, '').trim().toLowerCase();
          if (email && email.includes('@')) {
            dispatchedEmails.add(email);
          }
        }
        if (companyCapIdx !== undefined && companyCapIdx < cols.length && cols[companyCapIdx]) {
          const cap = cols[companyCapIdx].replace(/^["']|["']$/g, '').trim().toLowerCase();
          if (cap && !FREEMAIL_DOMAINS.has(cap)) contactedCompanyCaps.add(cap);
        }
      }
    }
  }
  return { emails: dispatchedEmails, companyCaps: contactedCompanyCaps };
}

// 3. Load Verified Leads dynamically by header name
function loadVerifiedLeads() {
  try {
    const ingestPath = path.join(__dirname, 'ingest_agency_leads.js');
    if (fs.existsSync(ingestPath)) {
      delete require.cache[require.resolve('./ingest_agency_leads')];
      require('./ingest_agency_leads');
    }
  } catch (e) {}
  let verifiedPath = null;
  for (const p of POSSIBLE_VERIFIED_PATHS) {
    if (fs.existsSync(p)) {
      verifiedPath = p;
      break;
    }
  }

  if (!verifiedPath) {
    throw new Error('verified_leads.csv not found in local or parent directory.');
  }

  const lines = fs.readFileSync(verifiedPath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  const headerMap = parseCSVHeaderMap(lines[0]);
  const validStatuses = new Set(['READY', 'FOLLOWUP_DUE']);
  const leads = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);

    const getVal = (name) => {
      const idx = headerMap[name];
      if (idx !== undefined && idx < cols.length) {
        return cols[idx].replace(/^["']|["']$/g, '').trim();
      }
      return '';
    };

    const status = getVal('status').toUpperCase();

    // Only load rows where status === "READY" or status === "FOLLOWUP_DUE"
    if (!validStatuses.has(status)) {
      continue;
    }

    const email = getVal('email').toLowerCase();
    if (email && email.includes('@')) {
      const domain = getVal('domain') || (email.split('@')[1] || '');
      const companyCap = getVal('company_cap') || domain;
      leads.push({
        id: getVal('id') || `lead_${i}`,
        company: getVal('company') || getVal('company_name') || companyCap,
        first_name: getVal('first_name') || '',
        last_name: getVal('last_name') || '',
        email: email,
        email_status: getVal('email_status') || 'valid',
        domain: domain,
        company_cap: companyCap,
        status: status,
        tier: getVal('tier') || 'A',
        phone: getVal('phone') || '',
        location: getVal('location') || '',
        industry: getVal('industry') || '',
        intent: getVal('intent') || 'High'
      });
    }
  }
  return leads;
}

// Single Email Dispatch API Call to http://localhost:3005/api/send-single-email
async function sendSingleEmail(lead) {
  const emailLower = (lead.email || '').toLowerCase().trim();
  const domainLower = (lead.domain || emailLower.split('@')[1] || '').toLowerCase().trim();

  // THREAD PAUSE GATE (NON-BYPASSABLE)
  if (isThreadPaused(emailLower)) {
    console.log(`[PAUSED] ${lead.email} — thread paused for human review`);
    return { lead, success: false, statusCode: 422, error: `ERR_THREAD_PAUSED: Thread ${lead.email} is paused for human review` };
  }

  // HARD BLOCKLIST GATE (NON-BYPASSABLE)
  const blocklist = loadBlocklist();
  if (blocklist.emails.has(emailLower) || (domainLower && !FREEMAIL_DOMAINS.has(domainLower) && blocklist.domains.has(domainLower))) {
    console.log(`[BLOCKED] ${lead.email} — hard blocklist hit`);
    return { lead, success: false, statusCode: 422, error: `ERR_HARD_BLOCKLIST_HIT: ${lead.email} hard blocklisted` };
  }

  // MX & RFC SYNTAX PRE-VERIFICATION GATE (NON-BYPASSABLE)
  const preFlight = await verifyEmailPreFlight({
    email: emailLower,
    domain: domainLower,
    leadId: lead.id,
    company: lead.company,
    updateDb: true
  });
  if (!preFlight.valid) {
    console.log(`[PRE-FLIGHT DROP] ${lead.email} — ${preFlight.reason} (${preFlight.error || 'Dropped before SMTP transport'})`);
    return { lead, success: false, statusCode: 422, error: `ERR_${preFlight.reason}: ${preFlight.error || 'Failed pre-flight verification'}` };
  }

  return new Promise((resolve) => {
    const firstName = sanitizeFirstName(lead.first_name);
    const company = lead.company || domainLower || 'your agency';
    const payload = JSON.stringify({
      to: lead.email,
      from: 'jack@missedcallproject.com',
      senderName: 'Jack Bockholdt | Missed Call Project',
      subject: `white-label AI for ${company}'s clients?`,
      body: `Hi ${firstName},\n\nI license an AI engine that agencies rebrand and resell to their own clients — content generation, document automation, and instant lead response.\n\nYou license it once, put your name on it, set your own client pricing, and keep the margin. I stay invisible.\n\nHappy to show you the live system in 15 minutes. No deck, no pitch — you'd just watch it run.\n\nWorth a look?\n\nJack Bockholdt\nMissed Call Project\njack@missedcallproject.com\n(217) 512-1377\n\nReply "stop" and I won't contact you again.`
    });

    const req = http.request({
      hostname: 'localhost',
      port: 3005,
      path: '/api/send-single-email',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ lead, success: parsed.success === true, statusCode: res.statusCode, response: parsed });
        } catch (e) {
          resolve({ lead, success: false, statusCode: res.statusCode, error: e.message });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ lead, success: false, statusCode: 500, error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

// Append new dispatch record to partner_outreach_log.csv
function recordOutreachLog(lead, outcome = 'delivered awaiting reply', status = 'AWAITING_REPLY') {
  const todayStr = new Date().toISOString().split('T')[0];
  const rowStr = `${lead.email},${lead.domain},${todayStr},${todayStr},1,${outcome},${status}\n`;

  for (const logPath of POSSIBLE_PARTNER_LOG_PATHS) {
    if (fs.existsSync(logPath)) {
      fs.appendFileSync(logPath, rowStr);
    }
  }

  try {
    recordDailySend(1);
  } catch (e) {}
}

// Main Batch Dispatch Function
async function runBatchDispatch(options = {}) {
  const isLive = options.isLive || process.argv.includes('--live');
  const isSyntheticTest = options.isSyntheticTest || process.argv.includes('--test-synthetic');
  const skipPacing = options.skipPacing || false;
  const batchLimit = Math.min(parseInt(options.batchLimit || options.dailyCap || DAILY_CAP, 10), DAILY_CAP);

  const logs = [];
  const log = (msg) => {
    console.log(msg);
    logs.push(msg);
  };

  log("===================================================================");
  log("  MASTER HUSTLE ENGINE - BATCH DISPATCH & TOKEN GOVERNANCE LOOP    ");
  log("===================================================================");

  // Safety Catch: Check process.env.OUTBOUND_PAUSED
  if (process.env.OUTBOUND_PAUSED === 'true') {
    log("[ABORT] OUTBOUND_PAUSED is set to true. No emails will be dispatched to protect domain reputation.");
    return {
      success: true,
      executionMode: "SUSPENDED_OUTBOUND_PAUSED",
      evaluated: 0,
      skips: [],
      sends: [],
      logs
    };
  }

  const blocklist = loadBlocklist();
  const outreachHistory = loadOutreachHistory();

  log(`[Audit] Blocklist loaded: ${blocklist.emails.size} emails, ${blocklist.domains.size} domains.`);
  log(`[Audit] Outreach history loaded: ${outreachHistory.emails.size} emails.`);

  let rawLeads = [];
  if (isSyntheticTest) {
    log(`[Mode] Using 3 Synthetic Test Rows for Rule Verification.`);
    rawLeads = [
      {
        id: 'synth_1',
        company: 'Google',
        first_name: 'Jack',
        last_name: 'Bockholdt',
        email: 'jackbockholdt88@gmail.com',
        email_status: 'valid',
        domain: 'gmail.com',
        company_cap: 'gmail.com',
        status: 'READY',
        tier: 'A'
      },
      {
        id: 'synth_2',
        company: 'Catalyst Gets It',
        first_name: 'Ted',
        last_name: 'Kucinsky',
        email: 'tkucinsky@catalystgetsit.com',
        email_status: 'valid',
        domain: 'catalystgetsit.com',
        company_cap: 'catalystgetsit.com',
        status: 'READY',
        tier: 'A'
      },
      {
        id: 'synth_3',
        company: 'Hunter',
        first_name: 'Eric',
        last_name: 'Hunter',
        email: 'eric@gethunter.com',
        email_status: 'valid',
        domain: 'gethunter.com',
        company_cap: 'gethunter.com',
        status: 'READY',
        tier: 'A'
      }
    ];
  } else {
    rawLeads = loadVerifiedLeads();
    log(`[Audit] Verified leads loaded (READY / FOLLOWUP_DUE only): ${rawLeads.length} entries.`);
  }

  const executionMode = isLive ? "PRODUCTION_LIVE" : "SANDBOX_SIMULATION_ISOLATED";
  log(`[Mode] Execution mode set to: ${executionMode}`);

  const currentBatchCompanyCaps = new Set();
  const evaluationResults = [];
  const leadsToSend = [];

  for (const lead of rawLeads) {
    const emailLower = lead.email.toLowerCase();
    const domainLower = lead.domain ? lead.domain.toLowerCase() : '';
    const capLower = lead.company_cap ? lead.company_cap.toLowerCase() : domainLower;

    // Check 0: Thread Paused for Human Review
    if (isThreadPaused(emailLower)) {
      const reason = "Thread is paused for human review";
      log(`[SKIP] ${lead.email} — THREAD_PAUSED (${reason})`);
      evaluationResults.push({ lead, status: 'THREAD_PAUSED', reason });
      continue;
    }

    // Check 1: Blocklist via screenLeadQuality
    const screenRes = screenLeadQuality(lead.email, lead.domain, blocklist);
    if (screenRes.status === 'DISQUALIFIED') {
      const reason = `Suppressed by blocklist (${screenRes.reason})`;
      log(`[SKIP] ${lead.email} — DISQUALIFIED (${reason})`);
      evaluationResults.push({ lead, status: 'DISQUALIFIED', reason });
      continue;
    }

    // Check 1.5: Pre-Send RFC Syntax and DNS/MX Verification Gate
    const preFlight = await verifyEmailPreFlight({
      email: lead.email,
      domain: domainLower,
      leadId: lead.id,
      company: lead.company,
      updateDb: true
    });
    if (!preFlight.valid) {
      const reason = preFlight.error || `Pre-flight validation failed (${preFlight.reason})`;
      log(`[SKIP] ${lead.email} — ${preFlight.reason} (${reason})`);
      evaluationResults.push({ lead, status: preFlight.reason, reason });
      continue;
    }

    // Check 2: Outreach Log
    if (outreachHistory.emails.has(emailLower)) {
      const reason = "Already present in partner_outreach_log.csv";
      log(`[SKIP] ${lead.email} — SKIP (${reason})`);
      evaluationResults.push({ lead, status: 'SKIP', reason });
      continue;
    }

    // Check 3: One contact per company enforcement (ignoring freemail providers)
    if (capLower && !FREEMAIL_DOMAINS.has(capLower) && (outreachHistory.companyCaps.has(capLower) || currentBatchCompanyCaps.has(capLower))) {
      const reason = `Company cap reached for ${capLower} (one contact per company rule enforced)`;
      log(`[SKIP] ${lead.email} — SKIP (${reason})`);
      evaluationResults.push({ lead, status: 'SKIP', reason });
      continue;
    }

    // Passed all checks!
    if (capLower && !FREEMAIL_DOMAINS.has(capLower)) currentBatchCompanyCaps.add(capLower);
    leadsToSend.push(lead);

    if (leadsToSend.length >= batchLimit) {
      log(`[Cap] Daily cap of ${batchLimit} reached for this run.`);
      break;
    }
  }

  log(`\n[Execution] Clean leads queued for dispatch: ${leadsToSend.length}`);

  const sendResults = [];
  let dispatchedCount = 0;

  for (let i = 0; i < leadsToSend.length; i++) {
    const lead = leadsToSend[i];

    // Check dailySendCounter from server.js before every single send
    const counter = await checkDailySendCounter();
    if (counter.sentToday >= DAILY_CAP || counter.status === 'CAP_REACHED') {
      log(`[DAILY CAP REACHED] dailySendCounter sentToday (${counter.sentToday}) reached or exceeded daily limit of ${DAILY_CAP}. Stopping the queue cleanly until tomorrow.`);
      break;
    }

    // Check thread paused
    if (isThreadPaused(lead.email)) {
      log(`[SKIP] ${lead.email} — THREAD_PAUSED (Thread is paused for human review)`);
      evaluationResults.push({ lead, status: 'THREAD_PAUSED', reason: 'Thread is paused for human review' });
      continue;
    }

    if (!isLive) {
      const msg = `[DRY-RUN] ${lead.email} — WOULD SEND (Dry-run mode active, 0 emails dispatched)`;
      log(msg);
      sendResults.push({ lead, status: 'DRY_RUN', sent: false });
      continue;
    }

    // Live send mode: Humanized stagger 180 to 420 seconds (randomized)
    if (i > 0 && !skipPacing) {
      const staggerMs = options.testStaggerMs || getRandomStaggerMs(180, 420);
      const staggerSec = Math.round(staggerMs / 1000);
      log(`[Pacing] Humanized delay: waiting ${staggerSec}s (${(staggerSec / 60).toFixed(1)} mins) before next dispatch...`);
      await new Promise(r => setTimeout(r, staggerMs));
    }

    log(`[SENDING] Dispatching to ${lead.email}...`);
    const sendRes = await sendSingleEmail(lead);

    if (sendRes.success) {
      dispatchedCount++;
      const msgId = sendRes.response?.messageId || 'N/A';
      const confirmed = sendRes.response?.deliveryConfirmed ? 'CONFIRMED' : 'UNCONFIRMED';
      log(`[SEND] ${lead.email} — SEND (Status: 200 OK, messageId: ${msgId}, deliveryConfirmed: ${confirmed})`);
      recordOutreachLog(lead);
      sendResults.push({ lead, status: 'SEND', sent: true, response: sendRes.response });
    } else {
      const errStr = String(sendRes.error || sendRes.response?.error || '');
      const isBadAddress = errStr.includes('INVALID_MX') || 
                           errStr.includes('INVALID_SYNTAX') || 
                           errStr.includes('INVALID_RECIPIENT') || 
                           errStr.includes('DISQUALIFIED') || 
                           errStr.includes('BLOCKLIST') ||
                           sendRes.statusCode === 400;

      if (!isBadAddress) {
        // Flag for human review in /admin/status and pause that specific thread
        flagThreadForReview({
          email: lead.email,
          leadId: lead.id,
          company: lead.company,
          reason: 'OUTBOUND_SEND_FAILURE',
          errorCode: errStr || 'SMTP_DISPATCH_ERROR',
          subject: `Outreach to ${lead.company}`,
          messageSnippet: sendRes.response?.message || errStr || 'Non-address send error'
        });
        log(`[ESCALATION] Flagged for review in /admin/status and thread paused: ${lead.email} (${errStr})`);
      }

      log(`[FAIL] ${lead.email} — FAILED (${sendRes.error || sendRes.response?.message || 'Unknown error'})`);
      sendResults.push({ lead, status: 'FAILED', sent: false, error: sendRes.error });
    }
  }

  log("\n===================================================================");
  log("              DISPATCH EXECUTION SUMMARY REPORT                   ");
  log("===================================================================");
  log(` Mode:               ${executionMode}`);
  log(` Total Evaluated:    ${rawLeads.length}`);
  log(` Skips:              ${evaluationResults.length}`);
  log(` Dispatched Count:   ${dispatchedCount}`);
  log("===================================================================\n");

  return {
    success: true,
    executionMode,
    evaluated: rawLeads.length,
    skips: evaluationResults,
    sends: sendResults,
    logs
  };
}

if (require.main === module) {
  runBatchDispatch().catch(err => {
    console.error('[Batch Error]', err);
    process.exit(1);
  });
}

module.exports = {
  runBatchDispatch,
  loadBlocklist,
  screenLeadQuality,
  hasValidMX,
  sanitizeFirstName,
  loadOutreachHistory,
  loadVerifiedLeads,
  getRandomStaggerMs,
  checkDailySendCounter,
  DAILY_CAP
};
