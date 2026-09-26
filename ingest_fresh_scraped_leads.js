/**
 * ingest_fresh_scraped_leads.js
 * Master Hustle Engine — Operational Runbook Ingestion & Qualification Processor
 */

const fs = require('fs');
const path = require('path');
const { 
  loadBlocklist, 
  screenLeadQuality, 
  hasValidMX, 
  sanitizeFirstName, 
  runBatchDispatch 
} = require('./trigger_batch_dispatch');

const SCRATCH_CSV_PATH = path.join(__dirname, '..', 'verified_leads.csv');
const ENGINE_VERIFIED_CSV_PATH = path.join(__dirname, 'verified_leads.csv');

// Helper: Parse CSV row supporting quotes
function parseCSVRow(text) {
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

async function processIngestionRunbook() {
  console.log('===================================================================');
  console.log('⚡ MASTER HUSTLE ENGINE — INGESTION & QUALIFICATION RUNBOOK');
  console.log('===================================================================\n');

  const blocklist = loadBlocklist();
  console.log(`[Step 1] Loaded blocklist: ${blocklist.emails.size} emails, ${blocklist.domains.size} domains.`);

  if (!fs.existsSync(SCRATCH_CSV_PATH)) {
    console.error(`❌ Source CSV not found at: ${SCRATCH_CSV_PATH}`);
    return;
  }

  const rawLines = fs.readFileSync(SCRATCH_CSV_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  if (rawLines.length <= 1) {
    console.log('No lead rows found in source CSV.');
    return;
  }

  const headerCols = parseCSVRow(rawLines[0]).map(h => h.replace(/^["']|["']$/g, '').toLowerCase());
  const emailIdx = headerCols.indexOf('email');
  const companyIdx = headerCols.indexOf('company_name');
  const firstNameIdx = headerCols.indexOf('first_name');
  const domainIdx = headerCols.indexOf('domain');
  const industryIdx = headerCols.indexOf('industry_tag');

  console.log(`[Step 1] Found ${rawLines.length - 1} raw targets in source file.`);

  // Load existing emails in verified_leads.csv
  const existingEmails = new Set();
  if (fs.existsSync(ENGINE_VERIFIED_CSV_PATH)) {
    const existingLines = fs.readFileSync(ENGINE_VERIFIED_CSV_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    existingLines.forEach(l => {
      const parts = parseCSVRow(l);
      if (parts[1]) existingEmails.add(parts[1].replace(/^["']|["']$/g, '').trim().toLowerCase());
    });
  }

  const cleanIngestedLeads = [];
  const rejectedReport = [];

  for (let i = 1; i < rawLines.length; i++) {
    const cols = parseCSVRow(rawLines[i]).map(c => c.replace(/^["']|["']$/g, '').trim());
    const email = (cols[emailIdx] || '').toLowerCase();
    const domain = (cols[domainIdx] || email.split('@')[1] || '').toLowerCase();
    const rawFirstName = cols[firstNameIdx] || '';
    const company = cols[companyIdx] || domain;
    const industry = cols[industryIdx] || 'B2B Services';

    if (!email || !email.includes('@')) {
      rejectedReport.push({ email, reason: 'Invalid email syntax' });
      continue;
    }

    if (existingEmails.has(email)) {
      rejectedReport.push({ email, reason: 'Duplicate — already present in verified_leads.csv' });
      continue;
    }

    // 1. Blocklist Gate
    const screenRes = screenLeadQuality(email, domain, blocklist);
    if (screenRes.status === 'DISQUALIFIED') {
      console.log(`[BLOCKLIST REJECT] ${email} — ${screenRes.reason}`);
      rejectedReport.push({ email, reason: `Blocklist: ${screenRes.reason}` });
      continue;
    }

    // 2. DNS MX Pre-Verification Gate
    const validMX = await hasValidMX(domain);
    if (!validMX) {
      console.log(`[MX REJECT] ${email} — domain ${domain} has no active MX records`);
      rejectedReport.push({ email, reason: `[MX REJECT] Domain ${domain} failed MX resolution` });
      continue;
    }

    // 3. Name Sanitization
    const sanitizedName = sanitizeFirstName(rawFirstName);

    cleanIngestedLeads.push({
      tier: 'A',
      email: email,
      domain: domain,
      email_status: 'valid',
      validator_detail: 'DNS MX & Blocklist Verified',
      contact_type: sanitizedName === 'there' ? 'role inbox' : 'named person',
      company_cap: domain,
      status: 'READY',
      notes: `Company: ${company} | Industry: ${industry} | First Name: ${sanitizedName}`
    });
    existingEmails.add(email);
  }

  console.log(`\n[Qualification Audit Summary]`);
  console.log(` Raw Evaluated:   ${rawLines.length - 1}`);
  console.log(` Rejected/Dropped: ${rejectedReport.length}`);
  console.log(` Ingested Clean:  ${cleanIngestedLeads.length}`);

  if (cleanIngestedLeads.length > 0) {
    let csvAppend = '';
    cleanIngestedLeads.forEach(l => {
      csvAppend += `${l.tier},${l.email},${l.domain},${l.email_status},${l.validator_detail},${l.contact_type},${l.company_cap},${l.status},"${l.notes}"\n`;
    });
    fs.appendFileSync(ENGINE_VERIFIED_CSV_PATH, csvAppend);
    console.log(`\n✅ Appended ${cleanIngestedLeads.length} qualified leads to master-hustle-engine/verified_leads.csv`);
  }

  // Execute Sandbox Dry-Run Audit
  console.log('\n===================================================================');
  console.log('🚀 EXECUTING SANDBOX SIMULATION DRY-RUN AUDIT');
  console.log('===================================================================\n');

  const dryRun = await runBatchDispatch({ isLive: false });
  return {
    ingested: cleanIngestedLeads.length,
    rejected: rejectedReport,
    dryRun
  };
}

if (require.main === module) {
  processIngestionRunbook().catch(err => {
    console.error('Ingestion runbook failed:', err);
  });
}

module.exports = { processIngestionRunbook };
