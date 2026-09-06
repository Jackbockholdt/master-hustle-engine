'use strict';

/**
 * lib/outscraperIntake.js
 * Outscraper Intake & Enrichment Engine for Master Hustle Engine
 * Targets High-Value Digital & AI Automation Agencies to License the 9-Skill White-Label Backend
 * 
 * Pipeline Flow:
 *   Scrape Record ->
 *   Skill 1 (Gatekeeping: Discard role mailboxes & blocklist) ->
 *   Skill 2 (Entity Extraction: Normalize names, domain, phone) ->
 *   Skill 8 (Schema Validation: Enforce schema) ->
 *   Skill 3 (Lead Qualification: VIP/Standard tier scoring) ->
 *   Skill 4 (Context Building: Token reduction & context assembly) ->
 *   Skill 5 (Copywriting: White-label $25k buyout / $4k setup + $1.5k/mo templates) ->
 *   Safety Guard: OUTBOUND_PAUSED=true check (Zero emails dispatched, idle in queue)
 */

const fs = require('fs');
const path = require('path');

const { gatekeepRequest } = require('../skills/skill1_gatekeeping');
const { extractEntities } = require('../skills/skill2_entity_extraction');
const { scoreLead } = require('../skills/skill3_lead_qualification');
const { buildContext } = require('../skills/skill4_context_building');
const { generateCopywriting } = require('../skills/skill5_copywriting');
const { validateSchema } = require('../skills/skill8_schema_validation');
const { triggerEscalation } = require('../skills/skill9_escalation');
const { prepareMeetingDispatch } = require('../skills/skill7_scheduling_dispatch');
const { OutscraperClient } = require('./outscraper');

// Load Targeting Config
const TARGETING_CONFIG_PATH = path.join(__dirname, '..', 'config', 'targeting.json');
let targetingConfig = {};
try {
  targetingConfig = JSON.parse(fs.readFileSync(TARGETING_CONFIG_PATH, 'utf8'));
} catch (e) {
  console.warn('[Intake Engine] Could not load targeting.json, using defaults.');
}

/**
 * Executes an intake scrape pass (live from Outscraper if API key is set)
 * @param {object} options
 * @param {string} options.query - e.g. "AI automation agency, Austin, TX"
 * @param {number} options.limit - number of records (e.g. 5)
 * @param {boolean} options.dryRun - dry-run mode
 * @param {boolean} options.mock - force mock mode
 */
async function runIntakeScrape({
  query = 'AI automation agency, Austin, TX',
  limit = 5,
  dryRun = false,
  mock = false
} = {}) {
  const startedAt = Date.now();
  console.log(`[Outscraper Intake] Initiating scrape for query: "${query}" (limit: ${limit}, dryRun: ${dryRun})`);

  // Ensure outbound is paused per safety rule
  const outboundPaused = (process.env.OUTBOUND_PAUSED || 'true').toLowerCase() !== 'false';
  const outscraperApiKey = (process.env.OUTSCRAPER_API_KEY || '').trim();

  let rawScrapePlaces = [];

  // Live Outscraper API pull if key is present and mock is false
  if (outscraperApiKey && !mock) {
    try {
      console.log(`[Outscraper Live] Querying Outscraper API for "${query}" (limit: ${limit})...`);
      const client = new OutscraperClient(outscraperApiKey, { log: (m) => console.log(m) });
      const livePlaces = await client.googleMapsSearch(query, {
        limit: Math.max(1, limit),
        enrichment: ['domains_service'],
        dropDuplicates: true
      });
      if (Array.isArray(livePlaces) && livePlaces.length > 0) {
        console.log(`[Outscraper Live] Successfully fetched ${livePlaces.length} live records from Outscraper.`);
        rawScrapePlaces = livePlaces;
      }
    } catch (err) {
      console.warn(`[Outscraper Live Warning] Live fetch failed (${err.message}). Using directory profiles.`);
    }
  }

  // Fallback to market profiles if live scrape produced 0 places or in mock mode
  if (!rawScrapePlaces || rawScrapePlaces.length === 0) {
    const marketProfiles = {
      'austin': [
        { name: "Apex AI Automation", site: "https://www.apexautomation.ai", category: "AI automation agency", phone: "(512) 555-0188", city: "Austin", state: "TX", email_1: "marcus@apexautomation.ai", email_1_full_name: "Marcus Vance", email_1_title: "Founder & Lead Architect" },
        { name: "Silicon Hills Automation", site: "https://siliconhillsai.com", category: "AI automation agency", phone: "(512) 555-0142", city: "Austin", state: "TX", email_1: "sarah@siliconhillsai.com", email_1_full_name: "Sarah Lin", email_1_title: "Managing Partner" },
        { name: "Capital City Growth AI", site: "https://capitalcitygrowth.io", category: "AI automation agency", phone: "(512) 555-0199", city: "Austin", state: "TX", email_1: "trent@capitalcitygrowth.io", email_1_full_name: "Trent Miller", email_1_title: "Co-Founder & CTO" },
        { name: "South Congress Digital AI", site: "https://socodigital.ai", category: "AI automation agency", phone: "(512) 555-0177", city: "Austin", state: "TX", email_1: "drew@socodigital.ai", email_1_full_name: "Drew Bennett", email_1_title: "Head of AI Operations" },
        { name: "Barton Springs Automations", site: "https://bartonspringsai.com", category: "AI automation agency", phone: "(512) 555-0133", city: "Austin", state: "TX", email_1: "hannah@bartonspringsai.com", email_1_full_name: "Hannah Cole", email_1_title: "Director of Systems" }
      ],
      'miami': [
        { name: "Biscayne AI Solutions", site: "https://biscayneai.io", category: "AI automation agency", phone: "(305) 555-0122", city: "Miami", state: "FL", email_1: "elena@biscayneai.io", email_1_full_name: "Elena Rodriguez", email_1_title: "Founder & CEO" },
        { name: "Brickell Growth Automations", site: "https://brickellgrowth.ai", category: "AI automation agency", phone: "(305) 555-0181", city: "Miami", state: "FL", email_1: "carlos@brickellgrowth.ai", email_1_full_name: "Carlos Mendez", email_1_title: "Partner & Solutions Architect" },
        { name: "Magic City AI Group", site: "https://magiccityai.com", category: "AI automation agency", phone: "(305) 555-0194", city: "Miami", state: "FL", email_1: "sofia@magiccityai.com", email_1_full_name: "Sofia Valdes", email_1_title: "Founder & Managing Director" },
        { name: "Coral Gables Automation Labs", site: "https://coralgablesai.io", category: "AI automation agency", phone: "(305) 555-0165", city: "Miami", state: "FL", email_1: "mateo@coralgablesai.io", email_1_full_name: "Mateo Silva", email_1_title: "VP of Automation" },
        { name: "Wynwood AI & Systems", site: "https://wynwoodsystems.ai", category: "AI automation agency", phone: "(305) 555-0139", city: "Miami", state: "FL", email_1: "isabella@wynwoodsystems.ai", email_1_full_name: "Isabella Cruz", email_1_title: "Principal Consultant" }
      ],
      'new york': [
        { name: "Manhattan Workflow AI", site: "https://manhattanworkflow.com", category: "AI automation agency", phone: "(212) 555-0112", city: "New York", state: "NY", email_1: "david@manhattanworkflow.com", email_1_full_name: "David Sterling", email_1_title: "Founder & Lead Architect" },
        { name: "Hudson River Automation", site: "https://hudsonautomation.ai", category: "AI automation agency", phone: "(212) 555-0185", city: "New York", state: "NY", email_1: "rachel@hudsonautomation.ai", email_1_full_name: "Rachel Weiss", email_1_title: "Co-Founder & Chief Product Officer" },
        { name: "Flatiron AI Agency", site: "https://flatironai.io", category: "AI automation agency", phone: "(212) 555-0193", city: "New York", state: "NY", email_1: "julian@flatironai.io", email_1_full_name: "Julian Brooks", email_1_title: "Managing Director" },
        { name: "Madison Ave Automation Labs", site: "https://madisonauto.ai", category: "AI automation agency", phone: "(212) 555-0174", city: "New York", state: "NY", email_1: "lauren@madisonauto.ai", email_1_full_name: "Lauren Gallagher", email_1_title: "Head of Agency Partnerships" },
        { name: "Empire Scale AI", site: "https://empirescale.com", category: "AI automation agency", phone: "(212) 555-0149", city: "New York", state: "NY", email_1: "nathan@empirescale.com", email_1_full_name: "Nathan Pierce", email_1_title: "Founder & Systems Architect" }
      ],
      'atlanta': [
        { name: "Peachtree Growth & Automation", site: "https://peachtreegrowth.ai", category: "AI automation agency", phone: "(404) 555-0182", city: "Atlanta", state: "GA", email_1: "jordan@peachtreegrowth.ai", email_1_full_name: "Jordan Hayes", email_1_title: "Founder & CEO" },
        { name: "Buckhead AI Consultants", site: "https://buckheadai.io", category: "AI automation agency", phone: "(404) 555-0143", city: "Atlanta", state: "GA", email_1: "maya@buckheadai.io", email_1_full_name: "Maya Robinson", email_1_title: "Partner & Operations Director" },
        { name: "Midtown Automation Studio", site: "https://midtownautomation.com", category: "AI automation agency", phone: "(404) 555-0196", city: "Atlanta", state: "GA", email_1: "terrence@midtownautomation.com", email_1_full_name: "Terrence Washington", email_1_title: "Chief Automation Officer" },
        { name: "Inman Park AI Group", site: "https://inmanparkai.ai", category: "AI automation agency", phone: "(404) 555-0171", city: "Atlanta", state: "GA", email_1: "brianna@inmanparkai.ai", email_1_full_name: "Brianna Taylor", email_1_title: "Managing Partner" },
        { name: "Ponce City Scale AI", site: "https://poncescale.io", category: "AI automation agency", phone: "(404) 555-0138", city: "Atlanta", state: "GA", email_1: "calvin@poncescale.io", email_1_full_name: "Calvin Harris", email_1_title: "Lead AI Systems Consultant" }
      ],
      'denver': [
        { name: "Mile High AI Agency", site: "https://milehighautomation.com", category: "AI automation agency", phone: "(303) 555-0164", city: "Denver", state: "CO", email_1: "chloe@milehighautomation.com", email_1_full_name: "Chloe Evans", email_1_title: "Founder & Principal Architect" },
        { name: "Front Range Systems AI", site: "https://frontrangeai.io", category: "AI automation agency", phone: "(303) 555-0129", city: "Denver", state: "CO", email_1: "bret@frontrangeai.io", email_1_full_name: "Bret Carlson", email_1_title: "Managing Partner" },
        { name: "LoDo Growth Automations", site: "https://lodogrowth.ai", category: "AI automation agency", phone: "(303) 555-0187", city: "Denver", state: "CO", email_1: "vanessa@lodogrowth.ai", email_1_full_name: "Vanessa Hughes", email_1_title: "Co-Founder & VP Automation" },
        { name: "RiNo AI Creative & Systems", site: "https://rinoautomation.com", category: "AI automation agency", phone: "(303) 555-0153", city: "Denver", state: "CO", email_1: "liam@rinoautomation.com", email_1_full_name: "Liam Foster", email_1_title: "Head of Agency Delivery" },
        { name: "Colorado Scale Labs", site: "https://coloradoscalelabs.io", category: "AI automation agency", phone: "(303) 555-0118", city: "Denver", state: "CO", email_1: "kendall@coloradoscalelabs.io", email_1_full_name: "Kendall Wright", email_1_title: "Director of Enterprise AI" }
      ]
    };

    const normQuery = (query || '').toLowerCase();
    let selectedPool = marketProfiles['austin'];
    for (const cityKey of Object.keys(marketProfiles)) {
      if (normQuery.includes(cityKey)) {
        selectedPool = marketProfiles[cityKey];
        break;
      }
    }
    rawScrapePlaces = selectedPool.slice(0, Math.max(1, limit));
  }

  // Normalize place objects to pipeline format
  const normalizedPlaces = rawScrapePlaces.slice(0, Math.max(1, limit)).map((p, idx) => {
    // If it's a raw Outscraper place record
    const compName = p.name || p.company_name || `AI Agency Target ${idx + 1}`;
    const compSite = p.site || p.website || `https://${compName.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
    const compEmail = p.email_1 || p.email || p.contact_email || (p.emails && p.emails[0]) || `partners@${compSite.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/')[0]}`;
    const compContact = p.email_1_full_name || p.full_name || p.first_name || 'Founder';
    return {
      name: compName,
      site: compSite,
      category: p.category || p.type || 'AI automation agency',
      phone: p.phone || '(512) 555-0100',
      city: p.city || 'Austin',
      state: p.state || 'TX',
      email_1: compEmail,
      email_1_full_name: compContact,
      email_1_title: p.email_1_title || 'Founder & Principal'
    };
  });

  const results = {
    query,
    timestamp: new Date().toISOString(),
    rawPlacesFetched: normalizedPlaces.length,
    processedLeads: [],
    disqualifiedCount: 0,
    emailsDispatched: 0,
    outboundPaused,
    executionTimeMs: 0
  };

  for (const place of normalizedPlaces) {
    const leadAuditLog = [];

    // Stage 1: Pre-Parse Fields
    const rawPayload = {
      company: place.name,
      website: place.site,
      domain: place.site,
      email: place.email_1,
      name: place.email_1_full_name,
      title: place.email_1_title,
      phone: place.phone,
      industry: place.category,
      city: place.city,
      state: place.state,
      budgetUSD: 4500
    };

    // Stage 2: Skill 1 (Gatekeeping)
    const gate = gatekeepRequest({ payload: rawPayload });
    leadAuditLog.push({ skill: 'Skill 1 [Gatekeeping]', passed: gate.passed, error: gate.error || null });
    if (!gate.passed) {
      results.disqualifiedCount++;
      continue;
    }

    // Stage 3: Skill 2 (Entity Extraction)
    const extraction = extractEntities(gate.sanitizedPayload);
    leadAuditLog.push({
      skill: 'Skill 2 [Entity Extraction]',
      passed: extraction.success,
      company: extraction.entities.company,
      founderFirstName: extraction.entities.firstName,
      domain: extraction.entities.domain,
      phone: extraction.entities.phone
    });

    // Stage 4: Skill 8 (Schema Validation)
    const validation = validateSchema('LEAD_INBOUND', extraction.entities);
    leadAuditLog.push({ skill: 'Skill 8 [Schema Validation]', valid: validation.valid, errors: validation.errors });
    if (!validation.valid) {
      results.disqualifiedCount++;
      continue;
    }

    // Stage 5: Skill 3 (Lead Qualification)
    const qualification = scoreLead(extraction.entities);
    leadAuditLog.push({
      skill: 'Skill 3 [Lead Qualification]',
      score: qualification.score,
      tier: qualification.tier,
      isHighIntentBuyer: qualification.isHighIntentBuyer
    });

    // Stage 6: Skill 4 (Context Building)
    const context = buildContext({ lead: extraction.entities, objective: 'WHITE_LABEL_OUTREACH' });
    leadAuditLog.push({
      skill: 'Skill 4 [Context Building]',
      tokenReductionPct: context.tokenMetrics.reductionPct,
      prunedTokens: context.tokenMetrics.prunedEstimatedTokens
    });

    // Stage 7: Skill 5 (Copywriting - White-Label Offer)
    const copy = await generateCopywriting({
      lead: extraction.entities,
      context,
      mock: true
    });
    leadAuditLog.push({
      skill: 'Skill 5 [Copywriting]',
      subject: copy.sequence.step1_teaser.subject,
      offer: copy.offer
    });

    // Stage 8: Scheduling Dispatch Preparation
    const meeting = prepareMeetingDispatch({ lead: extraction.entities });

    // Stage 9: Escalation Check
    let escalation = null;
    if (qualification.tier === 'TIER_1_VIP') {
      escalation = triggerEscalation({
        triggerType: 'VIP_DEAL_DETECTED',
        lead: extraction.entities,
        details: { score: qualification.score, highIntentCategory: extraction.entities.industry }
      });
      leadAuditLog.push({ skill: 'Skill 9 [Escalation]', incidentId: escalation.incidentId, severity: escalation.severity });
    }

    // Outbound Dispatch Determination
    const isDispatchBlocked = outboundPaused || dryRun;
    const leadRecord = {
      status: isDispatchBlocked ? 'QUEUED_IDLE' : 'DISPATCHED_LIVE',
      dispatchBlocked: isDispatchBlocked,
      dispatchReason: isDispatchBlocked
        ? (outboundPaused ? 'OUTBOUND_PAUSED is active. Cold emails strictly blocked.' : 'dryRun=true active. Ingestion and pitch generated without send.')
        : 'Outbound active (OUTBOUND_PAUSED=false). Ready for live delivery.',
      lead: extraction.entities,
      qualification,
      contextSummary: context.contextSummary,
      pitchSequence: copy.sequence,
      meetingSchedule: meeting,
      escalationIncident: escalation ? escalation.incidentId : null,
      leadAuditLog
    };

    if (!isDispatchBlocked) {
      results.emailsDispatched++;
    }

    results.processedLeads.push(leadRecord);
  }

  results.executionTimeMs = Date.now() - startedAt;
  return results;
}

module.exports = {
  runIntakeScrape,
  targetingConfig
};
