'use strict';

/**
 * Skill 1: Gatekeeping Engine
 * Enterprise Rate-Limiting, Payload Sanitization, Threat Screening & Address Filtering
 * 
 * Capabilities:
 *  - IP/Token rate limiting (Sliding window bucket)
 *  - Threat screening (SQLi, XSS, prompt injection, jailbreak attempts)
 *  - Sanitization (HTML strip, control character removal, null byte elimination)
 *  - Role mailbox rejection (info@, support@, hello@, admin@, etc.)
 *  - Blocklisted domain & email rejection (via config/blocklist.json)
 *  - Fail-closed safety gate
 */

const fs = require('fs');
const path = require('path');

const rateLimitStore = new Map();
const WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_REQUESTS_PER_WINDOW = 60; // 60 req/min per IP/token

const THREAT_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /system\s+prompt\s+override/i,
  /you\s+are\s+now\s+in\s+DAN\s+mode/i,
  /jailbreak/i,
  /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
  /(union\s+select|select\s+.*\s+from|drop\s+table|insert\s+into)/i,
  /\b(exec|execute|eval)\s*\(/i,
  /\x00/
];

const ROLE_PREFIXES = new Set([
  'info', 'hello', 'hi', 'contact', 'contactus', 'sales', 'support', 'help', 'admin',
  'office', 'team', 'inquiries', 'enquiries', 'press', 'media', 'jobs', 'careers',
  'billing', 'accounts', 'accounting', 'legal', 'privacy', 'marketing', 'noreply',
  'no-reply', 'donotreply', 'webmaster', 'postmaster', 'mail', 'email', 'service',
  'services', 'customerservice', 'newsletter', 'partnerships', 'partners', 'general'
]);

// Load blocklist
let blocklistData = { addresses: [], domains: [] };
try {
  const blocklistPath = path.join(__dirname, '..', 'config', 'blocklist.json');
  if (fs.existsSync(blocklistPath)) {
    blocklistData = JSON.parse(fs.readFileSync(blocklistPath, 'utf8'));
  }
} catch (e) {
  console.warn('[Gatekeeping] Could not load blocklist.json:', e.message);
}
const blocklistAddresses = new Set((blocklistData.addresses || []).map(a => a.toLowerCase().trim()));
const blocklistDomains = new Set((blocklistData.domains || []).map(d => d.toLowerCase().trim()));

/**
 * Sanitizes input strings
 */
function sanitizeInput(val) {
  if (typeof val !== 'string') return val;
  return val
    .replace(/\0/g, '') // remove null bytes
    .replace(/<[^>]*>?/gm, '') // strip HTML tags
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // strip control chars
    .trim();
}

/**
 * Deep sanitization of objects
 */
function sanitizeObject(obj) {
  if (obj === null || typeof obj !== 'object') {
    return sanitizeInput(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }
  const sanitized = {};
  for (const [key, val] of Object.entries(obj)) {
    sanitized[sanitizeInput(key)] = sanitizeObject(val);
  }
  return sanitized;
}

/**
 * Screens for prompt injection or malicious payloads
 */
function screenThreats(text) {
  if (typeof text !== 'string') return { safe: true };
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(text)) {
      return { safe: false, matchedRule: pattern.toString() };
    }
  }
  return { safe: true };
}

/**
 * Checks if an email is generic/role based
 */
function isRoleMailbox(email = '') {
  if (!email || !email.includes('@')) return false;
  const prefix = email.split('@')[0].toLowerCase().trim();
  return ROLE_PREFIXES.has(prefix);
}

/**
 * Checks if an email or domain is on the blocklist
 */
function isBlocklisted(email = '', domain = '') {
  const normEmail = email.toLowerCase().trim();
  const normDomain = (domain || (normEmail.includes('@') ? normEmail.split('@')[1] : '')).toLowerCase().trim();

  if (normEmail && blocklistAddresses.has(normEmail)) return true;
  if (normDomain && blocklistDomains.has(normDomain)) return true;
  return false;
}

/**
 * Gatekeeps an incoming payload
 */
function gatekeepRequest({ identifier = 'global', payload = {} } = {}) {
  const now = Date.now();

  // 1. Rate Limiting Check
  let bucket = rateLimitStore.get(identifier);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    bucket = { windowStart: now, count: 1 };
    rateLimitStore.set(identifier, bucket);
  } else {
    bucket.count++;
    if (bucket.count > MAX_REQUESTS_PER_WINDOW) {
      return {
        passed: false,
        statusCode: 429,
        error: 'ERR_RATE_LIMIT_EXCEEDED',
        message: `Too many requests. Maximum ${MAX_REQUESTS_PER_WINDOW} requests per minute allowed.`
      };
    }
  }

  // 2. Threat Screening
  const payloadString = JSON.stringify(payload);
  const threatCheck = screenThreats(payloadString);
  if (!threatCheck.safe) {
    return {
      passed: false,
      statusCode: 403,
      error: 'ERR_SECURITY_THREAT_DETECTED',
      message: 'Malicious payload or prompt injection detected.',
      rule: threatCheck.matchedRule
    };
  }

  // 3. Sanitization
  const sanitizedPayload = sanitizeObject(payload);

  // 4. Role Mailbox & Blocklist Check (if email or domain present in payload)
  const email = sanitizedPayload.email || sanitizedPayload.contact_email || sanitizedPayload.contactEmail;
  const domain = sanitizedPayload.domain || sanitizedPayload.website;

  if (email && isRoleMailbox(email)) {
    return {
      passed: false,
      statusCode: 422,
      error: 'ERR_ROLE_MAILBOX_REJECTED',
      message: `Generic role mailbox '${email}' rejected. Decision-maker direct address required.`,
      email
    };
  }

  if (isBlocklisted(email, domain)) {
    return {
      passed: false,
      statusCode: 422,
      error: 'ERR_BLOCKLISTED_ENTITY',
      message: `Address or domain is on permanent blocklist.`,
      email,
      domain
    };
  }

  return {
    passed: true,
    statusCode: 200,
    sanitizedPayload,
    rateLimit: {
      remaining: Math.max(0, MAX_REQUESTS_PER_WINDOW - bucket.count),
      resetInSeconds: Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000)
    }
  };
}

module.exports = {
  gatekeepRequest,
  sanitizeInput,
  sanitizeObject,
  screenThreats,
  isRoleMailbox,
  isBlocklisted,
  ROLE_PREFIXES
};
