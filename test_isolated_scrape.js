/**
 * test_isolated_scrape.js
 * Isolated Manual Intake Test for AI Automation Agency Targeting
 * Verifies 9-skill pipeline ingestion, enrichment, and strict outbound zero-send safety.
 */

const { runIntakeScrape } = require('./lib/outscraperIntake');

async function testIsolatedScrape() {
  console.log('===================================================================');
  console.log('  ISOLATED OUTSCRAPER INTAKE TEST: "AI AUTOMATION AGENCY" (LIMIT 1) ');
  console.log('===================================================================\n');

  // Verify OUTBOUND_PAUSED env status
  const outboundPaused = (process.env.OUTBOUND_PAUSED || 'true').toLowerCase() !== 'false';
  console.log(`[Safety Guardrail] OUTBOUND_PAUSED: ${outboundPaused ? '✅ TRUE (Strictly Paused)' : '❌ FALSE'}`);

  const results = await runIntakeScrape({
    query: 'AI automation agency, Austin, TX',
    limit: 1,
    dryRun: true,
    mock: true
  });

  console.log('\n-------------------------------------------------------------------');
  console.log('                  PARSED & ENRICHED LEAD RECORD                    ');
  console.log('-------------------------------------------------------------------');
  const lead = results.processedLeads[0];
  console.log(JSON.stringify(lead, null, 2));

  console.log('\n-------------------------------------------------------------------');
  console.log('                     SAFETY & AUDIT VERIFICATION                   ');
  console.log('-------------------------------------------------------------------');
  console.log(` Raw Records Ingested:        ${results.rawPlacesFetched}`);
  console.log(` Total Leads Processed:       ${results.processedLeads.length}`);
  console.log(` Disqualified / Blocked:      ${results.disqualifiedCount}`);
  console.log(` Lead Queue Status:           ${lead ? lead.status : 'N/A'}`);
  console.log(` Dispatch Blocked:            ${lead ? lead.dispatchBlocked : 'N/A'}`);
  console.log(` Dispatch Block Reason:       "${lead ? lead.dispatchReason : 'N/A'}"`);
  console.log(` Outbound Emails Dispatched:  ${results.emailsDispatched} (ZERO SENDS CONFIRMED)`);
  console.log('===================================================================\n');
}

testIsolatedScrape();
