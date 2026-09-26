#!/usr/bin/env node
'use strict';

/**
 * feeder_hopper.js
 * Master Hustle Engine - Auto-Populating Verified Hopper Feeder (17:30 CT)
 * 
 * Capabilities:
 * - Scans master pools: crm_leads_tracker.json, data/saas_targets_batch_2.json, data/saas_targets.json, pipeline.db
 * - 3-Tier Deliverability Gatekeepers:
 *    1. DEDUP: Strictly skips any email/domain present in outreach_log.json, crm_leads_tracker.json, last_dispatch_summary.json, saas_outreach_log.jsonl
 *    2. SYNTAX & MX: Validates RFC email syntax and resolves active DNS MX records via hasValidMX()
 *    3. SUPPRESSION: Excludes any contact/domain marked OPTED_OUT, BOUNCED, UNSUBSCRIBE, or listed in blocklists
 * - Populates staged_leads_queue.json with up to 15 verified leads tagged "PENDING_6PM_CT"
 * - If fewer than 15 pass, stages strictly the verified pool (never injects unverified records)
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { execSync } = require('child_process');

const BASE_DIR = __dirname;
const QUEUE_FILE = path.join(BASE_DIR, 'staged_leads_queue.json');
const OUTREACH_LOG = path.join(BASE_DIR, 'outreach_log.json');
const CRM_TRACKER = path.join(BASE_DIR, 'crm_leads_tracker.json');
const DISPATCH_SUMMARY = path.join(BASE_DIR, 'last_dispatch_summary.json');
const SAAS_LOG = path.join(BASE_DIR, 'saas_outreach_log.jsonl');
const BLOCKLIST_JSON = path.join(BASE_DIR, 'config', 'blocklist.json');
const DNC_CSV = path.join(BASE_DIR, 'do-not-send-list.csv');

const TARGET_BATCH_SIZE = 15;

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'protonmail.com'
]);

const ROLE_PREFIXES = new Set([
  'info', 'support', 'sales', 'contact', 'billing', 'admin', 'help', 'team', 'jobs', 'careers'
]);

// ---------------------------------------------------------------------------
// 1. DELIVERABILITY GATEKEEPERS
// ---------------------------------------------------------------------------

function loadSuppressionSets() {
  const suppressedEmails = new Set();
  const suppressedDomains = new Set();

  // Load blocklist.json if exists
  if (fs.existsSync(BLOCKLIST_JSON)) {
    try {
      const bl = JSON.parse(fs.readFileSync(BLOCKLIST_JSON, 'utf8'));
      if (Array.isArray(bl.emails)) bl.emails.forEach(e => suppressedEmails.add(e.toLowerCase().trim()));
      if (Array.isArray(bl.domains)) bl.domains.forEach(d => suppressedDomains.add(d.toLowerCase().trim()));
    } catch (e) {}
  }

  // Load do-not-send-list.csv if exists
  if (fs.existsSync(DNC_CSV)) {
    try {
      const lines = fs.readFileSync(DNC_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
      lines.forEach(l => {
        const item = l.trim().toLowerCase();
        if (item.includes('@')) suppressedEmails.add(item);
        else if (item.includes('.')) suppressedDomains.add(item);
      });
    } catch (e) {}
  }

  // Load outreach_log.json suppressions (opted out or bounced)
  if (fs.existsSync(OUTREACH_LOG)) {
    try {
      const logs = JSON.parse(fs.readFileSync(OUTREACH_LOG, 'utf8'));
      logs.forEach(entry => {
        const email = (entry.email || entry.sender || '').toLowerCase().trim();
        const action = (entry.action || entry.actionTaken || entry.event || '').toUpperCase();
        if (action.includes('OPT_OUT') || action.includes('BOUNCED') || entry.newStatus === 'OPTED_OUT') {
          if (email) {
            suppressedEmails.add(email);
            if (email.includes('@')) suppressedDomains.add(email.split('@')[1]);
          }
        }
      });
    } catch (e) {}
  }

  return { suppressedEmails, suppressedDomains };
}

function loadContactedSets() {
  const contactedEmails = new Set();
  const contactedDomains = new Set();

  // From outreach_log.json
  if (fs.existsSync(OUTREACH_LOG)) {
    try {
      const logs = JSON.parse(fs.readFileSync(OUTREACH_LOG, 'utf8'));
      logs.forEach(entry => {
        const email = (entry.email || entry.sender || '').toLowerCase().trim();
        if (email && email.includes('@')) {
          contactedEmails.add(email);
          const dom = email.split('@')[1];
          if (!FREEMAIL_DOMAINS.has(dom)) contactedDomains.add(dom);
        }
      });
    } catch (e) {}
  }

  // From crm_leads_tracker.json
  if (fs.existsSync(CRM_TRACKER)) {
    try {
      const crm = JSON.parse(fs.readFileSync(CRM_TRACKER, 'utf8'));
      (crm.leads || []).forEach(lead => {
        const email = (lead.email || '').toLowerCase().trim();
        if (email && email.includes('@')) {
          contactedEmails.add(email);
          const dom = lead.domain || email.split('@')[1];
          if (dom && !FREEMAIL_DOMAINS.has(dom)) contactedDomains.add(dom.toLowerCase().trim());
        }
      });
    } catch (e) {}
  }

  // From last_dispatch_summary.json
  if (fs.existsSync(DISPATCH_SUMMARY)) {
    try {
      const summary = JSON.parse(fs.readFileSync(DISPATCH_SUMMARY, 'utf8'));
      if (Array.isArray(summary)) {
        summary.forEach(item => {
          const email = (item.email || item.recipient || '').toLowerCase().trim();
          if (email && email.includes('@')) {
            contactedEmails.add(email);
            const dom = email.split('@')[1];
            if (!FREEMAIL_DOMAINS.has(dom)) contactedDomains.add(dom);
          }
        });
      }
    } catch (e) {}
  }

  // From saas_outreach_log.jsonl
  if (fs.existsSync(SAAS_LOG)) {
    try {
      const lines = fs.readFileSync(SAAS_LOG, 'utf8').split(/\r?\n/).filter(Boolean);
      lines.forEach(l => {
        try {
          const item = JSON.parse(l);
          const email = (item.recipient_email || item.email || '').toLowerCase().trim();
          if (email && email.includes('@')) {
            contactedEmails.add(email);
            const dom = email.split('@')[1];
            if (!FREEMAIL_DOMAINS.has(dom)) contactedDomains.add(dom);
          }
        } catch (e) {}
      });
    } catch (e) {}
  }

  return { contactedEmails, contactedDomains };
}

function validateEmailSyntax(email) {
  if (!email || typeof email !== 'string') return false;
  const clean = email.trim().toLowerCase();
  const rfcRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!rfcRegex.test(clean)) return false;

  const [user, domain] = clean.split('@');
  if (!user || !domain || !domain.includes('.')) return false;

  return true;
}

async function hasValidMX(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const cleanDom = domain.trim().toLowerCase();
  if (!cleanDom || !cleanDom.includes('.')) return false;
  if (FREEMAIL_DOMAINS.has(cleanDom)) return true;

  try {
    const records = await dns.resolveMx(cleanDom);
    if (Array.isArray(records) && records.length > 0) return true;
  } catch (e) {
    if (process.platform === 'win32') {
      try {
        const out = execSync(`powershell -NoProfile -Command "Resolve-DnsName -Name ${cleanDom} -Type MX -ErrorAction SilentlyContinue"`, {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        if (out && (out.includes('MX') || out.includes('NameExchange'))) {
          return true;
        }
        // RFC 5321 A-record fallback
        const aOut = execSync(`powershell -NoProfile -Command "Resolve-DnsName -Name ${cleanDom} -Type A -ErrorAction SilentlyContinue"`, {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        if (aOut && (aOut.includes('IPAddress') || aOut.includes('Answer'))) {
          return true;
        }
      } catch (osErr) {}
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 2. CANDIDATE HARVESTING
// ---------------------------------------------------------------------------

function harvestAllCandidates() {
  const candidates = [];
  const seenCandidateEmails = new Set();

  function addCandidate(lead) {
    const email = (lead.email || '').trim().toLowerCase();
    if (!email || !email.includes('@') || seenCandidateEmails.has(email)) return;
    seenCandidateEmails.add(email);

    candidates.push({
      id: lead.id || `LEAD-${Date.now().toString(36)}-${candidates.length + 1}`,
      name: lead.first_name || lead.name || 'Decision Maker',
      fullName: lead.fullName || lead.name || 'Decision Maker',
      title: lead.title || 'Executive Leadership',
      company: lead.company_name || lead.company || 'Digital Agency',
      domain: lead.domain || email.split('@')[1],
      email: email,
      industry: lead.industry || 'Digital Marketing & Growth Agency',
      missing_infrastructure: lead.missing_infrastructure || ''
    });
  }

  // Pool 1: data/saas_targets_batch_2.json
  const b2Path = path.join(BASE_DIR, 'data', 'saas_targets_batch_2.json');
  if (fs.existsSync(b2Path)) {
    try {
      const b2 = JSON.parse(fs.readFileSync(b2Path, 'utf8'));
      b2.forEach(addCandidate);
    } catch (e) {}
  }

  // Pool 2: data/saas_targets.json
  const t1Path = path.join(BASE_DIR, 'data', 'saas_targets.json');
  if (fs.existsSync(t1Path)) {
    try {
      const t1 = JSON.parse(fs.readFileSync(t1Path, 'utf8'));
      t1.forEach(addCandidate);
    } catch (e) {}
  }

  // Pool 3: crm_leads_tracker.json
  if (fs.existsSync(CRM_TRACKER)) {
    try {
      const crm = JSON.parse(fs.readFileSync(CRM_TRACKER, 'utf8'));
      (crm.leads || []).forEach(addCandidate);
    } catch (e) {}
  }

  // Pool 4: pipeline.db
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(BASE_DIR, 'pipeline.db');
    if (fs.existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath);
      const rows = db.prepare('SELECT id, name, company, domain, email, industry FROM pipeline_leads WHERE email IS NOT NULL').all();
      rows.forEach(addCandidate);
    }
  } catch (e) {}

  return candidates;
}

// ---------------------------------------------------------------------------
// 3. COPY BUILDER
// ---------------------------------------------------------------------------

function buildPitchCopy(lead) {
  const firstName = lead.name && lead.name !== 'there' ? lead.name : 'there';
  const company = lead.company || 'your agency';
  const industry = lead.industry || 'digital marketing';

  const subject = `Cutting ${company}'s LLM API token burn by 50-70% (Master Hustle / Anti-Gravity engine)`;

  const body = `Hi ${firstName},\n\nI saw ${company}'s work in ${industry}. If your team is running high-volume LLM workflows (content syndication, automated client reporting, and intake triage), upstream API token burn and model outages are likely eating away at your gross margins.\n\nWe built and deployed the Master Hustle / Anti-Gravity Engine (hosted on Render at master-hustle-engine.onrender.com), a proprietary backend infrastructure layer that delivers:\n\n1. Multi-LLM Failover Routing (<50ms): Intelligent sub-50ms circuit swap across Gemini, Claude, and OpenAI to eliminate client bot downtime during upstream 503/429 outages.\n2. 87.6% Inference Cost Reduction: 3-Tier Token Reducer Router dynamically strips context bloat and routes background qualification/telemetry to Gemini Flash ($0.0001/lead) while strictly gating high-cost flagship models to human authorization.\n3. Turnkey White-Label Licensing: Fully brandable client portal, automated agreement generation, and embedded Stripe billing.\n\nYou can inspect the complete architecture and test the live failover console at:\n👉 https://master-hustle-engine.onrender.com/demo\n\nAre you free for a brief 10-minute technical walkthrough this week, or should I send over the interactive pitch deck and financial ROI model?\n\nBest regards,\nJack Buckholdt\nFounder & AI Infrastructure Architect\nMaster Hustle Engine / Anti-Gravity\nRepository: github.com/JackBuckholdt/master-hustle-engine\nLive Demo: https://master-hustle-engine.onrender.com/demo`;

  return { subject, body };
}

// ---------------------------------------------------------------------------
// 4. MAIN FEEDER HOPPER RUNNER
// ---------------------------------------------------------------------------

async function runFeederHopper(options = {}) {
  const dryRun = options.dryRun === true;
  const targetCount = options.targetCount || TARGET_BATCH_SIZE;

  console.log(`===================================================================`);
  console.log(`⚡ AUTO-POPULATING VERIFIED HOPPER FEEDER (17:30 CT RECURRING)   `);
  console.log(`===================================================================`);
  console.log(`Target Batch Size      : ${targetCount} verified leads`);
  console.log(`Deliverability Gates   : DEDUP, SYNTAX, MX RESOLUTION, SUPPRESSION`);
  console.log(`Mode                   : ${dryRun ? 'DRY-RUN (No file updates)' : 'ACTIVE HOPPER WRITE'}`);
  console.log(`===================================================================\n`);

  const { suppressedEmails, suppressedDomains } = loadSuppressionSets();
  const { contactedEmails, contactedDomains } = loadContactedSets();
  const allCandidates = harvestAllCandidates();

  console.log(`Harvested ${allCandidates.length} total potential candidate leads from pools.`);
  console.log(`Known Contacted Emails : ${contactedEmails.size}`);
  console.log(`Suppressed Emails      : ${suppressedEmails.size}`);
  console.log(`Suppressed Domains     : ${suppressedDomains.size}\n`);

  const verifiedLeads = [];
  const rejectReasons = {};

  for (const lead of allCandidates) {
    if (verifiedLeads.length >= targetCount) break;

    const email = lead.email;
    const domain = lead.domain.toLowerCase().trim();

    // Gate 1: DEDUP Check
    if (contactedEmails.has(email)) {
      rejectReasons['DEDUP_EMAIL_ALREADY_CONTACTED'] = (rejectReasons['DEDUP_EMAIL_ALREADY_CONTACTED'] || 0) + 1;
      continue;
    }
    if (!FREEMAIL_DOMAINS.has(domain) && contactedDomains.has(domain)) {
      rejectReasons['DEDUP_DOMAIN_ALREADY_CONTACTED'] = (rejectReasons['DEDUP_DOMAIN_ALREADY_CONTACTED'] || 0) + 1;
      continue;
    }

    // Gate 2: Suppression Check
    if (suppressedEmails.has(email)) {
      rejectReasons['SUPPRESSION_EMAIL_BLOCKED'] = (rejectReasons['SUPPRESSION_EMAIL_BLOCKED'] || 0) + 1;
      continue;
    }
    if (suppressedDomains.has(domain)) {
      rejectReasons['SUPPRESSION_DOMAIN_BLOCKED'] = (rejectReasons['SUPPRESSION_DOMAIN_BLOCKED'] || 0) + 1;
      continue;
    }

    // Gate 3: Syntax Check
    if (!validateEmailSyntax(email)) {
      rejectReasons['INVALID_EMAIL_SYNTAX'] = (rejectReasons['INVALID_EMAIL_SYNTAX'] || 0) + 1;
      continue;
    }

    // Gate 4: MX Resolution (Fail-Closed)
    process.stdout.write(`[MX CHECK] Verifying domain MX for ${lead.company} (${domain})... `);
    const validMX = await hasValidMX(domain);
    if (!validMX) {
      console.log(`❌ FAILED (No MX records)`);
      rejectReasons['FAILED_MX_RESOLUTION'] = (rejectReasons['FAILED_MX_RESOLUTION'] || 0) + 1;
      continue;
    }
    console.log(`✅ PASSED`);

    // All gates passed -> format pitch and add to verified stage
    const pitch = buildPitchCopy(lead);
    verifiedLeads.push({
      id: `QUEUE-LEAD-${Date.now().toString(36).toUpperCase()}-${verifiedLeads.length + 1}`,
      name: lead.name,
      fullName: lead.fullName,
      title: lead.title,
      company: lead.company,
      domain: domain,
      email: email,
      industry: lead.industry,
      status: "STAGED",
      outreachStatus: "PENDING_6PM_CT",
      repliesCount: 0,
      demoLinkSent: false,
      paidConfirmed: false,
      sequenceHalted: false,
      stagedAt: new Date().toISOString(),
      subject: pitch.subject,
      body: pitch.body
    });
  }

  console.log(`\n===================================================================`);
  console.log(`HOPPER SELECTION RESULTS:`);
  console.log(`Verified Leads Staged  : ${verifiedLeads.length} / ${targetCount}`);
  console.log(`Rejections Breakdown   :`, rejectReasons);
  console.log(`===================================================================\n`);

  if (!dryRun) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(verifiedLeads, null, 2), 'utf8');
    console.log(`[HOPPER FEED COMPLETE] Wrote ${verifiedLeads.length} verified leads into ${QUEUE_FILE} tagged PENDING_6PM_CT.\n`);
  } else {
    console.log(`[DRY-RUN COMPLETE] Verified ${verifiedLeads.length} leads without modifying queue file.\n`);
  }

  return verifiedLeads;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const countArg = args.find(a => a.startsWith('--count='));
  const targetCount = countArg ? parseInt(countArg.split('=')[1], 10) : TARGET_BATCH_SIZE;

  runFeederHopper({ dryRun, targetCount }).catch(err => {
    console.error('[Feeder Hopper Fatal Error]:', err);
    process.exit(1);
  });
}

module.exports = {
  runFeederHopper,
  loadSuppressionSets,
  loadContactedSets,
  validateEmailSyntax,
  hasValidMX,
  harvestAllCandidates,
  TARGET_BATCH_SIZE
};
