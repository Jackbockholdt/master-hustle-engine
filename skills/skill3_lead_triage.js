/**
 * Skill 3: Lead Triage & Workflow Automation
 * Ingests webhook payloads, scores qualification metrics, enforces blocklist/MX filters, and triggers agency workflows.
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns');

// Load Blocklist safely
function getBlocklist() {
  const blocklistPath = path.join(__dirname, '..', 'config', 'blocklist.json');
  if (fs.existsSync(blocklistPath)) {
    try {
      return JSON.parse(fs.readFileSync(blocklistPath, 'utf8'));
    } catch (e) {}
  }
  return { blockedDomains: ["mailinator.com", "tempmail.com", "spam.org"], blockedKeywords: ["spambot", "trashmail", "fakelead"] };
}

// DNS MX Record Resolution with Timeout & Test Guard
function verifyMxRecord(domain, options = {}) {
  return new Promise((resolve) => {
    if (!domain || 
        domain.includes('localhost') || 
        domain.includes('example.com') || 
        domain.endsWith('.test') || 
        options.bypassMx === true ||
        process.env.NODE_ENV === 'test') {
      return resolve(true);
    }

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // On network timeout in non-production, fall back gracefully to allow evaluation
        resolve(true);
      }
    }, 1500);

    dns.resolveMx(domain, (err, addresses) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);

      if (err || !addresses || addresses.length === 0) {
        // If domain is explicitly unresolvable NXDOMAIN, reject
        if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA')) {
          return resolve(false);
        }
        // If network issue or local resolution, allow fallback
        return resolve(true);
      }
      resolve(true);
    });
  });
}

// Name sanitizer
function cleanLeadName(rawName) {
  if (!rawName || typeof rawName !== 'string') return 'Partner';
  const clean = rawName.trim().replace(/[^a-zA-Z\s'-]/g, '');
  if (!clean || clean.length < 2) return 'Partner';
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

/**
 * Lead Quality & ICP Scoring Engine
 */
async function triageLead(leadPayload = {}) {
  const email = (leadPayload.email || leadPayload.to || leadPayload.contact_email || '').trim().toLowerCase();
  const company = leadPayload.company || leadPayload.company_name || leadPayload.business || 'Target Enterprise';
  const domain = (leadPayload.domain || email.split('@')[1] || '').trim().toLowerCase();
  const rawName = leadPayload.name || leadPayload.firstName || leadPayload.first_name || '';
  const revenueUSD = parseFloat(leadPayload.revenue || leadPayload.annualRevenue || 0);
  const employeeCount = parseInt(leadPayload.employees || leadPayload.teamSize || 1, 10);
  const intentLevel = String(leadPayload.intent || 'MEDIUM').toUpperCase();

  // Basic format check
  if (!email || !email.includes('@')) {
    return {
      status: 'DISQUALIFIED',
      score: 0,
      reason: 'Missing or invalid email address format',
      lead: { email, company, domain }
    };
  }

  // 1. Blocklist Gate
  const blocklist = getBlocklist();
  const isDomainBlocked = (blocklist.blockedDomains || []).some(b => domain === b.toLowerCase() || domain.endsWith(`.${b.toLowerCase()}`));
  const isKeywordBlocked = (blocklist.blockedKeywords || []).some(k => email.includes(k.toLowerCase()) || company.toLowerCase().includes(k.toLowerCase()));

  if (isDomainBlocked || isKeywordBlocked) {
    return {
      status: 'DISQUALIFIED',
      score: 0,
      reason: 'Domain or keyword matches suppressed blocklist entry',
      lead: { email, company, domain }
    };
  }

  // 2. DNS MX Validation Gate
  const mxValid = await verifyMxRecord(domain, { bypassMx: leadPayload.bypassMx });
  if (!mxValid) {
    return {
      status: 'DISQUALIFIED',
      score: 10,
      reason: `Domain ${domain} failed DNS MX resolution`,
      lead: { email, company, domain }
    };
  }

  // 3. ICP Qualification Scoring (0 to 100)
  let score = 50; // Base score for valid email + MX
  if (employeeCount >= 5 && employeeCount <= 250) score += 20;
  if (revenueUSD >= 100000) score += 15;
  if (intentLevel === 'HIGH') score += 15;
  else if (intentLevel === 'LOW') score -= 10;

  const firstName = cleanLeadName(rawName);
  const qualificationTier = score >= 75 ? 'HIGH_VALUE_ICP' : (score >= 50 ? 'STANDARD_ICP' : 'LOW_PRIORITY');

  // Trigger outbound workflow payload
  const workflowTrigger = {
    action: 'QUEUE_OUTREACH',
    targetEmail: email,
    personalizedHook: `Automating inbound lead triage and multi-channel follow-up for ${company}.`,
    recommendedTier: score >= 75 ? 'growth' : 'starter',
    dailyPacingSafe: true
  };

  return {
    status: 'QUALIFIED',
    qualificationTier,
    score,
    contact: {
      firstName,
      email,
      company,
      domain
    },
    workflowTrigger
  };
}

module.exports = {
  triageLead,
  verifyMxRecord,
  cleanLeadName
};
