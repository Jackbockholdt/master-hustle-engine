'use strict';

/**
 * Skill 2: Entity Extraction Engine
 * Data Normalization, Field Parsing & Firmographic Extraction
 * 
 * Capabilities:
 *  - Contact name parsing (first, last, title extraction)
 *  - E.164 phone normalization & validation
 *  - Clean email parsing & domain extraction
 *  - Company name & industry categorization
 *  - Budget / burn / revenue numeric parsing
 */

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_CLEAN_REGEX = /[^\d+]/g;

function normalizeDomain(rawUrl) {
  if (!rawUrl) return '';
  return String(rawUrl)
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/)?(?:www\.)?/i, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0];
}

function normalizePhone(rawPhone) {
  if (!rawPhone) return '';
  const cleaned = String(rawPhone).replace(PHONE_CLEAN_REGEX, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  return cleaned.length >= 7 ? `+${cleaned}` : cleaned;
}

function extractNameParts(rawName = '') {
  const parts = String(rawName).trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { fullName: '', firstName: '', lastName: '' };
  if (parts.length === 1) return { fullName: parts[0], firstName: parts[0], lastName: '' };
  return {
    fullName: parts.join(' '),
    firstName: parts[0],
    lastName: parts.slice(1).join(' ')
  };
}

function parseCurrency(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  const cleaned = String(val).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Main Entity Extraction Function
 */
function extractEntities(rawPayload = {}) {
  const payload = typeof rawPayload === 'string' ? { text: rawPayload } : { ...rawPayload };

  // 1. Email Extraction
  let email = (payload.email || payload.contact_email || payload.contactEmail || '').trim().toLowerCase();
  if (!email && payload.text) {
    const match = payload.text.match(EMAIL_REGEX);
    if (match) email = match[0].toLowerCase();
  }

  // 2. Domain Extraction
  let domain = normalizeDomain(payload.domain || payload.website || payload.site || '');
  if (!domain && email.includes('@')) {
    domain = email.split('@')[1];
  }

  // 3. Name Parsing
  const rawName = payload.name || payload.contactName || payload.contact_name || payload.clientName || '';
  const { fullName, firstName, lastName } = extractNameParts(rawName);

  // 4. Company & Industry
  let company = (payload.company || payload.companyName || payload.company_name || payload.agencyName || '').trim();
  if (!company && domain) {
    const base = domain.split('.')[0];
    company = base.charAt(0).toUpperCase() + base.slice(1);
  }
  const industry = (payload.industry || payload.category || payload.vertical || 'Agency / B2B Services').trim();
  const title = (payload.title || payload.role || payload.position || 'Decision Maker').trim();

  // 5. Phone Normalization
  const rawPhone = payload.phone || payload.phoneNumber || payload.phone_number || payload.tel || '';
  const phone = normalizePhone(rawPhone);

  // 6. Financial Entities (Budget / LLM Burn)
  const budget = parseCurrency(payload.budget || payload.monthlyBurn || payload.monthlyBurnUSD || payload.burn || 0);

  return {
    success: true,
    entities: {
      fullName,
      firstName,
      lastName,
      title,
      email,
      phone,
      company,
      domain,
      industry,
      budgetUSD: budget,
      isCorporateEmail: !['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'].includes(domain)
    },
    raw: rawPayload
  };
}

module.exports = {
  extractEntities,
  normalizeDomain,
  normalizePhone,
  extractNameParts,
  parseCurrency
};
