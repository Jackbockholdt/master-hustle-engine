'use strict';

/**
 * lib/emailVerifier.js
 * Native Node DNS/MX Pre-Send Verification & RFC Syntax Gate
 * Protects Hostinger & Gmail SMTP reputation by pre-flight screening
 * all outbound targets before SMTP transport socket creation.
 */

const dns = require('dns');
const { promises: dnsPromises } = dns;

// Configure reliable DNS servers if Node defaults to localhost (common on Windows sandbox)
function ensureReliableResolvers() {
  try {
    const servers = dns.getServers();
    if (!servers || servers.length === 0 || (servers.length === 1 && servers[0] === '127.0.0.1')) {
      dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
    }
  } catch (err) {
    // Ignore resolver config errors
  }
}

// Initial resolver check
ensureReliableResolvers();

// Standard RFC 5322 compliant regex for practical email validation
const RFC_EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/**
 * Validates email against RFC syntax standards.
 * Ensures proper structure, no illegal characters, valid local and domain parts.
 * @param {string} email
 * @returns {{ valid: boolean, error?: string, normalizedEmail?: string }}
 */
function validateEmailSyntax(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email must be a non-empty string' };
  }

  const clean = email.replace(/^["']|["']$/g, '').trim();

  if (!clean || clean.length > 254) {
    return { valid: false, error: 'Email length exceeds RFC limits or is empty' };
  }

  // Must have exactly one @
  const atParts = clean.split('@');
  if (atParts.length !== 2) {
    return { valid: false, error: 'Email must contain exactly one @ symbol' };
  }

  const [localPart, domainPart] = atParts;

  if (!localPart || localPart.length > 64) {
    return { valid: false, error: 'Local part cannot be empty or exceed 64 characters' };
  }

  if (!domainPart || domainPart.length > 255) {
    return { valid: false, error: 'Domain part cannot be empty or exceed 255 characters' };
  }

  // Reject consecutive dots
  if (clean.includes('..')) {
    return { valid: false, error: 'Email cannot contain consecutive dots (..)' };
  }

  // Check RFC regex
  if (!RFC_EMAIL_REGEX.test(clean)) {
    return { valid: false, error: 'Email contains illegal characters or violates RFC syntax' };
  }

  // Validate domain part has valid TLD
  const domainLabels = domainPart.split('.');
  if (domainLabels.length < 2) {
    return { valid: false, error: 'Domain must contain at least one dot and a valid TLD' };
  }

  const tld = domainLabels[domainLabels.length - 1];
  if (tld.length < 2 || !/^[a-zA-Z]{2,}$/.test(tld)) {
    return { valid: false, error: 'Domain TLD must consist of at least 2 alphabetic characters' };
  }

  return { valid: true, normalizedEmail: clean.toLowerCase() };
}

/**
 * Resolves active MX records for a domain using Node's native dns.promises.resolveMx.
 * Includes Windows fail-safe fallback if Node's c-ares encounters local DNS socket refusal.
 * @param {string} domain
 * @returns {Promise<{ hasMx: boolean, records: Array<{exchange: string, priority: number}>, reason?: string }>}
 */
async function resolveMxRecords(domain) {
  if (!domain || typeof domain !== 'string') {
    return { hasMx: false, records: [], reason: 'Domain parameter is missing or invalid' };
  }

  const cleanDomain = domain.replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (!cleanDomain || !cleanDomain.includes('.')) {
    return { hasMx: false, records: [], reason: 'Domain format invalid' };
  }

  ensureReliableResolvers();

  try {
    const mx = await dnsPromises.resolveMx(cleanDomain);
    if (Array.isArray(mx) && mx.length > 0) {
      const sorted = mx.slice().sort((a, b) => a.priority - b.priority);
      return { hasMx: true, records: sorted };
    }
    return { hasMx: false, records: [], reason: 'NO_MX_RECORDS_FOUND' };
  } catch (err) {
    // If error is ECONNREFUSED / ESERVFAIL on Windows, attempt PowerShell Resolve-DnsName fallback
    if ((err.code === 'ECONNREFUSED' || err.code === 'ESERVFAIL' || err.code === 'ENODATA') && process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        const output = execSync(`powershell -NoProfile -Command "Resolve-DnsName -Name ${cleanDomain} -Type MX -ErrorAction SilentlyContinue | ConvertTo-Json"`, {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        if (output && output.trim()) {
          const parsed = JSON.parse(output);
          const records = Array.isArray(parsed) ? parsed : [parsed];
          const validRecords = records
            .filter(r => r && (r.NameExchange || r.Type === 15 || r.Type === 'MX'))
            .map(r => ({
              exchange: r.NameExchange || r.Name || cleanDomain,
              priority: r.Preference !== undefined ? r.Preference : 10
            }));
          if (validRecords.length > 0) {
            validRecords.sort((a, b) => a.priority - b.priority);
            return { hasMx: true, records: validRecords };
          }
        }
      } catch (psErr) {
        // Fallback failed, continue with original error
      }
    }

    return {
      hasMx: false,
      records: [],
      reason: err.code || err.message || 'MX_LOOKUP_FAILED'
    };
  }
}

/**
 * Pre-Send Verification Check.
 * Runs RFC syntax check, resolves MX records, and if MX fails,
 * marks lead as DISQUALIFIED_INVALID_MX in pipeline.db.
 * @param {object} params
 * @param {string} params.email - Recipient email
 * @param {string} [params.domain] - Optional domain override
 * @param {string} [params.leadId] - Optional lead ID in pipeline.db
 * @param {string} [params.company] - Optional company name
 * @param {boolean} [params.updateDb] - Whether to mark failure in pipeline.db (default: true)
 * @returns {Promise<{ valid: boolean, reason?: string, error?: string, email: string, domain: string, mxRecords: Array }>}
 */
async function verifyEmailPreFlight({ email, domain = null, leadId = null, company = '', updateDb = true } = {}) {
  // 1. Syntax Check
  const syntax = validateEmailSyntax(email);
  if (!syntax.valid) {
    const targetDomain = domain || (email && email.includes('@') ? email.split('@')[1] : '');
    return {
      valid: false,
      reason: 'DISQUALIFIED_INVALID_SYNTAX',
      error: syntax.error,
      email: email || '',
      domain: targetDomain,
      mxRecords: []
    };
  }

  const normalizedEmail = syntax.normalizedEmail;
  const targetDomain = (domain || normalizedEmail.split('@')[1]).trim().toLowerCase();

  // 2. DNS MX Check
  const mxResult = await resolveMxRecords(targetDomain);

  if (!mxResult.hasMx || mxResult.records.length === 0) {
    const failureReason = `MX resolution failed for domain '${targetDomain}' (${mxResult.reason || 'No active MX records'})`;

    // 3. Mark as DISQUALIFIED_INVALID_MX in pipeline.db
    if (updateDb) {
      try {
        const { markLeadDisqualifiedMx } = require('../skills/skill7_pipeline_manager');
        markLeadDisqualifiedMx({
          email: normalizedEmail,
          domain: targetDomain,
          leadId,
          company,
          reason: failureReason
        });
      } catch (dbErr) {
        console.warn(`[emailVerifier] Warning: Failed to update pipeline.db with DISQUALIFIED_INVALID_MX: ${dbErr.message}`);
      }
    }

    return {
      valid: false,
      reason: 'DISQUALIFIED_INVALID_MX',
      error: failureReason,
      email: normalizedEmail,
      domain: targetDomain,
      mxRecords: []
    };
  }

  return {
    valid: true,
    reason: 'PASSED_MX_AND_SYNTAX',
    email: normalizedEmail,
    domain: targetDomain,
    mxRecords: mxResult.records
  };
}

module.exports = {
  validateEmailSyntax,
  resolveMxRecords,
  verifyEmailPreFlight
};
