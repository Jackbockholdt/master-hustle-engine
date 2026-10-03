'use strict';

/**
 * run_50_agency_campaign.js
 * 
 * 50-Agency Outbound Campaign across Austin, TX & Denver, CO
 * 1. Live Outscraper search for AI & Digital agencies (50 targets total).
 * 2. Ingest through the 9-Skill Enterprise Pipeline (Gatekeeping, Extraction, Scoring, Pruning, Copywriting, Scheduling).
 * 3. Dispatch Step-1 White-Label Agency Pitch via Gmail SMTP with a 90-second delay between sends.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const { OutscraperClient } = require('./lib/outscraper');
const { recordToLead } = require('./lib/leadSourcing');
const { gatekeepRequest } = require('./skills/skill1_gatekeeping');
const { extractEntities } = require('./skills/skill2_entity_extraction');
const { scoreLead } = require('./skills/skill3_lead_qualification');
const { buildContext } = require('./skills/skill4_context_building');
const { generateCopywriting } = require('./skills/skill5_copywriting');
const { validateSchema } = require('./skills/skill8_schema_validation');
const { triggerEscalation } = require('./skills/skill9_escalation');
const { prepareMeetingDispatch } = require('./skills/skill7_scheduling_dispatch');
const { sendSmtpEmail } = require('./lib/smtpDispatcher');

const DELAY_BETWEEN_SENDS_SECONDS = 90;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCampaign() {
  console.log('===================================================================');
  console.log('   50-AGENCY OUTBOUND CAMPAIGN: AUSTIN, TX & DENVER, CO            ');
  console.log('   Architecture: 9-Skill Master Hustle Engine                      ');
  console.log('   Outbound Cooldown: 90 Seconds Between Sends                     ');
  console.log('===================================================================\n');

  const apiKey = (process.env.OUTSCRAPER_API_KEY || '').trim();
  if (!apiKey) {
    console.error('❌ OUTSCRAPER_API_KEY is missing from .env');
    process.exit(1);
  }

  const outboundPaused = (process.env.OUTBOUND_PAUSED || 'true').toLowerCase() === 'true';
  console.log(`[Configuration] Outbound Paused: ${outboundPaused ? 'PAUSED' : 'ACTIVE (Sends Enabled)'}`);
  console.log(`[Configuration] SMTP User:       ${process.env.SMTP_USER || 'jbockholdt4@gmail.com'}`);
  console.log(`[Configuration] Cooldown:        ${DELAY_BETWEEN_SENDS_SECONDS}s between dispatches\n`);

  const client = new OutscraperClient(apiKey, { log: (m) => console.log(m) });

  const queryBatches = [
    { city: 'Austin, TX', query: 'AI automation agency, Austin, TX', limit: 15 },
    { city: 'Austin, TX', query: 'digital agency, Austin, TX', limit: 10 },
    { city: 'Denver, CO', query: 'AI automation agency, Denver, CO', limit: 15 },
    { city: 'Denver, CO', query: 'digital agency, Denver, CO', limit: 10 }
  ];

  console.log('>>> Step 1: Querying Outscraper Google Maps API with Domain Enrichment...');
  const allRawPlaces = [];

  for (const q of queryBatches) {
    console.log(`  -> Fetching ${q.limit} places for "${q.query}"...`);
    try {
      const places = await client.googleMapsSearch(q.query, {
        limit: q.limit,
        enrichment: ['domains_service'],
        dropDuplicates: true
      });
      console.log(`     Fetched ${places.length} places from Outscraper.`);
      places.forEach(p => {
        p._searchCity = q.city;
        p._searchQuery = q.query;
      });
      allRawPlaces.push(...places);
    } catch (err) {
      console.warn(`     Warning: Query "${q.query}" error: ${err.message}`);
    }
  }

  console.log(`\n>>> Total Raw Places Ingested: ${allRawPlaces.length}\n`);

  console.log('>>> Step 2: Processing Places Through 9-Skill Enterprise Pipeline...\n');
  const qualifiedLeads = [];
  const disqualifiedLeads = [];

  for (let i = 0; i < allRawPlaces.length; i++) {
    const place = allRawPlaces[i];
    const company = place.name || place.company_name || 'Unknown Agency';

    // Convert using leadSourcing rules (pre-filters role mailboxes and freemail)
    const sourced = recordToLead(place);
    if (!sourced.lead) {
      disqualifiedLeads.push({ company, reason: sourced.skip || 'Missing valid company or website' });
      continue;
    }

    const rawPayload = {
      company: sourced.lead.company_name,
      website: sourced.lead.website,
      domain: sourced.lead.website,
      email: sourced.lead.contact_email,
      name: sourced.lead.first_name ? `${sourced.lead.first_name} (Founder)` : 'Founder',
      title: 'Founder & Principal',
      phone: sourced.lead.phone || place.phone || '',
      industry: sourced.lead.industry || 'AI automation agency',
      city: place._searchCity || 'Austin, TX',
      budgetUSD: 4500
    };

    // Skill 1: Gatekeeping
    const gate = gatekeepRequest({ payload: rawPayload });
    if (!gate.passed) {
      disqualifiedLeads.push({ company, reason: gate.error || 'Gatekeeping rejection' });
      continue;
    }

    // Skill 2: Entity Extraction
    const extraction = extractEntities(gate.sanitizedPayload);

    // Skill 8: Schema Validation
    const validation = validateSchema('LEAD_INBOUND', extraction.entities);
    if (!validation.valid) {
      disqualifiedLeads.push({ company, reason: 'Schema validation failed: ' + validation.errors.join(', ') });
      continue;
    }

    // Skill 3: Lead Qualification
    const qualification = scoreLead(extraction.entities);

    // Skill 4: Context Building & Token Reduction
    const context = buildContext({ lead: extraction.entities, objective: 'WHITE_LABEL_OUTREACH' });

    // Skill 5: Copywriting (White-Label Agency Licensing Offer)
    const copy = await generateCopywriting({
      lead: extraction.entities,
      context,
      mock: true
    });

    // Skill 7: Scheduling Link Dispatch Preparation
    const meeting = prepareMeetingDispatch({ lead: extraction.entities });

    // Skill 9: Escalation Trap
    let escalation = null;
    if (qualification.tier === 'TIER_1_VIP') {
      escalation = triggerEscalation({
        triggerType: 'VIP_DEAL_DETECTED',
        lead: extraction.entities,
        details: { score: qualification.score, category: extraction.entities.industry }
      });
    }

    qualifiedLeads.push({
      lead: extraction.entities,
      qualification,
      contextMetrics: context.tokenMetrics,
      pitchSequence: copy.sequence,
      meetingSchedule: meeting,
      escalationIncident: escalation ? escalation.incidentId : null
    });
  }

  console.log('-------------------------------------------------------------------');
  console.log('                  PIPELINE QUALIFICATION SUMMARY                  ');
  console.log('-------------------------------------------------------------------');
  console.log(` Raw Places Fetched:     ${allRawPlaces.length}`);
  console.log(` Qualified Agency Leads: ${qualifiedLeads.length}`);
  console.log(` Disqualified / Screened: ${disqualifiedLeads.length}`);
  console.log('-------------------------------------------------------------------\n');

  if (qualifiedLeads.length === 0) {
    console.log('No leads met the strict corporate email and domain criteria.');
    return;
  }

  console.log('>>> Qualified Agencies to Receive White-Label Pitch:');
  qualifiedLeads.forEach((q, idx) => {
    console.log(`  [${idx + 1}] ${q.lead.company} (${q.lead.email}) | Score: ${q.qualification.score} [${q.qualification.tier}]`);
  });
  console.log('');

  if (outboundPaused) {
    console.log('⚠️ OUTBOUND_PAUSED is set to true. Senders are in holding pattern.');
    console.log('No emails were dispatched. Exiting safely.');
    return;
  }

  console.log('===================================================================');
  console.log('>>> Step 3: DISPATCHING LIVE PITCHES VIA GMAIL SMTP');
  console.log(`    Delay Between Sends: ${DELAY_BETWEEN_SENDS_SECONDS} Seconds`);
  console.log('===================================================================\n');

  const dispatchResults = [];

  for (let idx = 0; idx < qualifiedLeads.length; idx++) {
    const item = qualifiedLeads[idx];
    const email = item.lead.email;
    const company = item.lead.company;
    const step1 = item.pitchSequence.step1_teaser;

    console.log(`[${idx + 1}/${qualifiedLeads.length}] Dispatching to: ${item.lead.firstName || 'Founder'} at ${company}`);
    console.log(`  -> Recipient: ${email}`);
    console.log(`  -> Subject:   ${step1.subject}`);

    try {
      const sendRes = await sendSmtpEmail({
        to: email,
        subject: step1.subject,
        bodyText: step1.body
      });

      console.log(`  ✅ SUCCESS: Delivered via Gmail SMTP (Receipt: ${sendRes.serverReceipt})`);
      dispatchResults.push({
        status: 'SUCCESS',
        company,
        email,
        subject: step1.subject,
        sentAt: new Date().toISOString(),
        serverReceipt: sendRes.serverReceipt
      });
    } catch (sendErr) {
      console.error(`  ❌ FAILED: ${sendErr.message}`);
      dispatchResults.push({
        status: 'FAILED',
        company,
        email,
        subject: step1.subject,
        error: sendErr.message,
        attemptedAt: new Date().toISOString()
      });
    }

    // Cooldown delay between sends (unless last item)
    if (idx < qualifiedLeads.length - 1) {
      console.log(`  ⏳ Starting ${DELAY_BETWEEN_SENDS_SECONDS}s cooldown to protect sender reputation...`);
      for (let remaining = DELAY_BETWEEN_SENDS_SECONDS; remaining > 0; remaining -= 15) {
        process.stdout.write(`     ${remaining}s remaining... \r`);
        await sleep(Math.min(15, remaining) * 1000);
      }
      console.log('     Cooldown complete. Proceeding to next agency.\n');
    }
  }

  const resultsPath = path.join(__dirname, 'campaign_50_agency_results.json');
  fs.writeFileSync(resultsPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalFetched: allRawPlaces.length,
    qualifiedCount: qualifiedLeads.length,
    disqualifiedCount: disqualifiedLeads.length,
    dispatches: dispatchResults
  }, null, 2));

  console.log('\n===================================================================');
  console.log('            CAMPAIGN RUN COMPLETE                                  ');
  console.log('===================================================================');
  console.log(`Dispatches Completed: ${dispatchResults.filter(r => r.status === 'SUCCESS').length}/${qualifiedLeads.length}`);
  console.log(`Detailed audit logged to: ${resultsPath}\n`);
}

runCampaign().catch(err => {
  console.error('[Campaign Fatal Error]', err);
  process.exit(1);
});
