/**
 * lib/triageClassifier.js
 * Inbound Email Intent Classifier, Suppression Handler, and Deal Desk Response Generator.
 * Handles pricing ($4k setup + $1.5k/mo retainer), existing tech objections, and automated opt-outs.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const BLOCKLIST_PATH = path.join(CONFIG_DIR, 'blocklist.json');
const CSV_BLOCKLIST_PATH = path.join(__dirname, '..', 'do-not-send-list.csv');

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'aol.com', 'outlook.com', 
  'hotmail.com', 'icloud.com', 'protonmail.com', 'gmx.com', 
  'mail.com', 'zoho.com', 'yandex.com', 'live.com'
]);

/**
 * Strips quoted history and signature noise from reply body
 */
function cleanReplyBody(bodyText) {
  if (!bodyText || typeof bodyText !== 'string') return '';
  
  const lines = bodyText.split(/\r?\n/);
  const cleanLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Stop parsing if common quoted email header is encountered
    if (/^On .+ wrote:$/i.test(trimmed) || /^-----Original Message-----/i.test(trimmed)) {
      break;
    }
    // Skip quoted lines starting with '>'
    if (trimmed.startsWith('>')) {
      continue;
    }
    cleanLines.push(line);
  }

  return cleanLines.join('\n').trim();
}

/**
 * Classifies the intent of an inbound reply email
 * Buckets into:
 *  - UNSUBSCRIBE_NOT_INTERESTED
 *  - OBJECTION_PRICING
 *  - OBJECTION_EXISTING_TECH
 *  - POSITIVE_INTEREST
 */
function classifyIntent(bodyText) {
  const cleanBody = cleanReplyBody(bodyText).toLowerCase();

  if (!cleanBody) {
    return 'POSITIVE_INTEREST'; // default to review
  }

  // 1. Unsubscribe / Negative / Stop (Highest Safety Priority)
  const unsubKeywords = [
    'unsubscribe', 'stop', 'remove', 'not interested', 'opt out', 'opt-out',
    'take me off', 'take us off', 'do not email', 'do not contact', 'dont email',
    'dont contact', "don't email", "don't contact", 'please remove', 'wrong person',
    'leave me alone', 'spam', 'no thanks', 'no thank you', 'cease', 'never contact'
  ];
  if (unsubKeywords.some(kw => cleanBody.includes(kw))) {
    return 'UNSUBSCRIBE_NOT_INTERESTED';
  }

  // 2. Pricing Objection
  const pricingKeywords = [
    'how much', 'cost', 'pricing', 'price', 'expensive', 'rate', 'rates',
    'fee', 'fees', 'budget', 'quote', 'afford', 'investment', 'charge',
    'what does it cost', 'what do you charge', 'payment terms'
  ];
  if (pricingKeywords.some(kw => cleanBody.includes(kw))) {
    return 'OBJECTION_PRICING';
  }

  // 3. Existing Tech / In-House Solution Objection
  const techKeywords = [
    'already have', 'already use', 'already got', 'our own', 'built in-house',
    'in-house', 'existing tool', 'existing solution', 'competitor', 'using another',
    'current provider', 'current vendor', 'happy with our', 'we use', 'we built',
    'current stack', 'have a partner', 'have an agency'
  ];
  if (techKeywords.some(kw => cleanBody.includes(kw))) {
    return 'OBJECTION_EXISTING_TECH';
  }

  // 4. Positive Interest / Next Steps
  const interestKeywords = [
    'interested', 'tell me more', 'sounds good', 'sounds interesting', "let's talk",
    'lets talk', 'hop on a call', 'jump on a call', 'book a call', 'schedule',
    'demo', 'calendar', 'send info', 'send over', 'send details', 'free next week',
    'worth a look', 'call me', 'yes', 'sure', 'love to see', 'available',
    'time to chat', 'set up a time', 'connect'
  ];
  if (interestKeywords.some(kw => cleanBody.includes(kw))) {
    return 'POSITIVE_INTEREST';
  }

  // Fallback for short affirmative replies
  if (/^(yes|sure|ok|okay|yep|yeah|tell me more|send it)\b/i.test(cleanBody)) {
    return 'POSITIVE_INTEREST';
  }

  // Default fallback for any engaged reply
  return 'POSITIVE_INTEREST';
}

/**
 * Updates config/blocklist.json and do-not-send-list.csv with suppression record
 */
function handleSuppression(email, domain = null) {
  const normEmail = (email || '').toLowerCase().trim();
  if (!normEmail || !normEmail.includes('@')) {
    return { success: false, error: 'Invalid email' };
  }

  const normDomain = (domain || normEmail.split('@')[1] || '').toLowerCase().trim();
  const now = new Date().toISOString();

  let blocklist = {
    updatedAt: now,
    totalAddresses: 0,
    totalDomains: 0,
    addresses: [],
    domains: [],
    entries: []
  };

  try {
    if (fs.existsSync(BLOCKLIST_PATH)) {
      const raw = fs.readFileSync(BLOCKLIST_PATH, 'utf8');
      blocklist = JSON.parse(raw);
    }
  } catch (err) {
    console.error('[Suppression] Error reading blocklist.json, creating new structure:', err.message);
  }

  if (!Array.isArray(blocklist.addresses)) blocklist.addresses = [];
  if (!Array.isArray(blocklist.domains)) blocklist.domains = [];
  if (!Array.isArray(blocklist.entries)) blocklist.entries = [];

  // Add email if not already present
  if (!blocklist.addresses.includes(normEmail)) {
    blocklist.addresses.push(normEmail);
  }

  // Add domain if not freemail
  if (normDomain && !FREEMAIL_DOMAINS.has(normDomain) && !blocklist.domains.includes(normDomain)) {
    blocklist.domains.push(normDomain);
  }

  // Append entry
  blocklist.entries.push({
    email: normEmail,
    domain: normDomain,
    failure_type: 'unsubscribe_requested',
    detail: 'Lead requested opt-out via inbound reply listener',
    timestamp: now
  });

  blocklist.totalAddresses = blocklist.addresses.length;
  blocklist.totalDomains = blocklist.domains.length;
  blocklist.updatedAt = now;

  // Save back to JSON
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(BLOCKLIST_PATH, JSON.stringify(blocklist, null, 2), 'utf8');
  } catch (err) {
    console.error('[Suppression] Failed writing blocklist.json:', err.message);
  }

  // Also append to do-not-send-list.csv if exists or create
  try {
    const csvLine = `"${normEmail}","${normDomain}","unsubscribe_requested","${now}"\n`;
    if (!fs.existsSync(CSV_BLOCKLIST_PATH)) {
      fs.writeFileSync(CSV_BLOCKLIST_PATH, 'email,domain,reason,timestamp\n' + csvLine, 'utf8');
    } else {
      fs.appendFileSync(CSV_BLOCKLIST_PATH, csvLine, 'utf8');
    }
  } catch (csvErr) {
    console.warn('[Suppression] Failed updating do-not-send-list.csv:', csvErr.message);
  }

  console.log(`[Suppression] Successfully suppressed ${normEmail} (${normDomain}) in blocklist.`);
  return {
    success: true,
    email: normEmail,
    domain: normDomain,
    totalAddresses: blocklist.totalAddresses,
    totalDomains: blocklist.totalDomains
  };
}

/**
 * Generates tailored deal-desk response copy with $4k setup + $1.5k/mo retainer terms
 */
function generateDraftResponse(classification, leadName = 'there', company = 'your agency') {
  let name = (leadName || '').trim();
  if (!name || name.toLowerCase().includes('decision') || name.toLowerCase().includes('there') || name.toLowerCase() === 'null') {
    name = 'there';
  } else {
    name = name.split(' ')[0];
    name = name.charAt(0).toUpperCase() + name.slice(1);
  }

  let agency = (company || '').trim();
  if (!agency || agency.toLowerCase() === 'enterprise' || agency.toLowerCase() === 'null') {
    agency = 'your agency';
  }

  switch (classification) {
    case 'POSITIVE_INTEREST':
      return {
        subject: `Re: white-label AI for ${agency}'s clients?`,
        body: `Hi ${name},

Glad it caught your eye.

We deploy the entire engine white-labeled directly under ${agency}'s brand. You set your own client pricing, sell it as your agency's proprietary AI automation stack, and keep 100% of your retail margin.

The commercial model is dead simple:
• $4,000 one-time setup & custom workflow build
• $1,500/mo infrastructure & model maintenance retainer

Most agencies package and bill this to their clients at $3k–$5k/mo per client, so it's cash-flow positive on client #1.

Are you open to a quick 15-minute screen share this week to watch the live engine run?

Best,
Jack Bockholdt
Missed Call Project / Master Hustle Engine
jack@missedcallproject.com | (217) 512-1377`
      };

    case 'OBJECTION_PRICING':
      return {
        subject: `Re: pricing & economics for ${agency}`,
        body: `Hi ${name},

Understood. To be completely transparent on the numbers:

It's a flat $4,000 one-time deployment fee (rebranding, custom integrations, pipeline setup) plus a $1,500/month infrastructure retainer.

Because you license the tech once and own the client relationship, you can resell it to as many ${agency} clients as you want without paying per-seat software fees. Resell it to two clients at $2,500/mo each and you're profiting $3,500/mo in pure agency margin every month.

Happy to show you the math and the engine in 15 minutes if you're open to taking a look.

Best,
Jack Bockholdt
Missed Call Project
jack@missedcallproject.com`
      };

    case 'OBJECTION_EXISTING_TECH':
      return {
        subject: `Re: white-label AI vs existing stack at ${agency}`,
        body: `Hi ${name},

Totally respect that—most successful agencies already have an internal stack or toolchain they rely on.

The difference with our engine isn't replacing what you already use; it's the autonomous orchestration layer that bridges missed calls, real-time lead capture, and instant token-optimized follow-ups without manual rep work.

Our $4,000 setup / $1,500/mo retainer is designed so you can white-label it as an add-on tier for ${agency}'s clients without having your engineering team burn weeks building and maintaining custom API pipelines.

Even if just for competitive benchmarking, would you be against a 15-minute look under the hood?

Best,
Jack Bockholdt
Missed Call Project
jack@missedcallproject.com`
      };

    case 'UNSUBSCRIBE_NOT_INTERESTED':
      return {
        subject: `Removed — Re: white-label AI`,
        body: `Hi ${name},

You've been removed from all future outreach. Best of luck with ${agency}.

Best,
Jack`
      };

    default:
      return {
        subject: `Re: white-label AI for ${agency}`,
        body: `Hi ${name},

Thanks for getting back to me. 

We provide a white-label AI engine ($4,000 setup + $1,500/mo retainer) that agencies rebrand and deploy for their clients to automate lead capture and content.

Would you be open to a quick 15-minute overview this week?

Best,
Jack Bockholdt
jack@missedcallproject.com`
      };
  }
}

module.exports = {
  classifyIntent,
  handleSuppression,
  generateDraftResponse,
  cleanReplyBody
};
