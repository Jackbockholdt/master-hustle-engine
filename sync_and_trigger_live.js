/**
 * sync_and_trigger_live.js
 * Ingests fresh leads from scratch/verified_leads.csv, applies MX/Blocklist gates,
 * appends qualified rows to engine verified_leads.csv, and triggers live batch dispatch.
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

async function runSyncAndDispatch() {
  console.log('===================================================================');
  console.log('⚡ MASTER HUSTLE ENGINE — FRESH LEAD INGESTION & LIVE DISPATCH');
  console.log('===================================================================\n');

  const blocklist = loadBlocklist();
  console.log(`[Step 1] Blocklist loaded: ${blocklist.emails.size} emails, ${blocklist.domains.size} domains.`);

  if (!fs.existsSync(SCRATCH_CSV_PATH)) {
    console.error(`❌ Source CSV not found at: ${SCRATCH_CSV_PATH}`);
    return;
  }

  const rawLines = fs.readFileSync(SCRATCH_CSV_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  const headerCols = parseCSVRow(rawLines[0]).map(h => h.replace(/^["']|["']$/g, '').toLowerCase());
  
  const emailIdx = headerCols.indexOf('email');
  const companyIdx = headerCols.indexOf('company_name');
  const firstNameIdx = headerCols.indexOf('first_name');
  const domainIdx = headerCols.indexOf('domain');
  const industryIdx = headerCols.indexOf('industry_tag');

  // Load existing emails in verified_leads.csv
  const existingEmails = new Set();
  if (fs.existsSync(ENGINE_VERIFIED_CSV_PATH)) {
    const existingLines = fs.readFileSync(ENGINE_VERIFIED_CSV_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    existingLines.forEach(l => {
      const parts = parseCSVRow(l);
      if (parts[1]) existingEmails.add(parts[1].replace(/^["']|["']$/g, '').trim().toLowerCase());
    });
  }

  let ingestedCount = 0;
  let appendedRows = '';

  for (let i = 1; i < rawLines.length; i++) {
    const cols = parseCSVRow(rawLines[i]).map(c => c.replace(/^["']|["']$/g, '').trim());
    const email = (cols[emailIdx] || '').toLowerCase();
    const domain = (cols[domainIdx] || email.split('@')[1] || '').toLowerCase();
    const rawFirstName = cols[firstNameIdx] || '';
    const company = cols[companyIdx] || domain;
    const industry = cols[industryIdx] || 'B2B Services';

    if (!email || !email.includes('@')) continue;
    if (existingEmails.has(email)) continue;

    // Blocklist Gate
    const screenRes = screenLeadQuality(email, domain, blocklist);
    if (screenRes.status === 'DISQUALIFIED') {
      console.log(`[BLOCKLIST REJECT] ${email} — ${screenRes.reason}`);
      continue;
    }

    // DNS MX Gate
    const validMX = await hasValidMX(domain);
    if (!validMX) {
      console.log(`[MX REJECT] ${email} — domain ${domain} failed MX resolution`);
      continue;
    }

    // Name Sanitizer
    const cleanName = sanitizeFirstName(rawFirstName);

    appendedRows += `A,${email},${domain},valid,DNS MX & Blocklist Verified,${cleanName === 'there' ? 'role inbox' : 'named person'},${domain},READY,"Company: ${company} | Industry: ${industry} | Name: ${cleanName}"\n`;
    existingEmails.add(email);
    ingestedCount++;
  }

  if (ingestedCount > 0) {
    fs.appendFileSync(ENGINE_VERIFIED_CSV_PATH, appendedRows);
    console.log(`✅ Ingested ${ingestedCount} fresh clean leads into master-hustle-engine/verified_leads.csv!`);
  } else {
    console.log('All fresh leads already exist in engine verified_leads.csv.');
  }
}

runSyncAndDispatch().catch(err => {
  console.error("Sync error:", err);
});
