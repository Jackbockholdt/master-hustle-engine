/**
 * test_inbound_triage.js
 * Comprehensive Verification Suite for Inbound Reply Listener,
 * Outbound Circuit Breaker, and Deal Desk Triage Drafter.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { classifyIntent, handleSuppression, generateDraftResponse } = require('./lib/triageClassifier');
const { initTriageDb, getTriageStats, getStagedReplies, getInboundReplies } = require('./lib/inboundTriageDb');
const { processSingleInboundMessage, getInboxTriageTelemetry, pollInboundReplies } = require('./lib/inboundReplyListener');
const { getDatabase, upsertLead } = require('./skills/skill7_pipeline_manager');
const { sendSingleEmail } = require('./trigger_batch_dispatch');

async function runTests() {
  console.log('===================================================================');
  console.log('  TESTING INBOUND REPLY LISTENER, CIRCUIT BREAKER & DEAL DESK      ');
  console.log('===================================================================');

  // -----------------------------------------------------------------
  // TEST 1: Intent Classification
  // -----------------------------------------------------------------
  console.log('\n[Test 1] Testing Intent Classification (classifyIntent)...');

  const positiveSample = "Hey Jack, thanks for reaching out. We would love to see a demo of this system. Are you free for a call Thursday?";
  const pricingSample = "What does this cost? Can you share your pricing and setup fees before we jump on a call?";
  const techSample = "We already use an in-house proprietary AI tool that our developers built. Not looking to switch.";
  const unsubSample = "Please unsubscribe and remove me from your list. Stop emailing.";

  assert.strictEqual(classifyIntent(positiveSample), 'POSITIVE_INTEREST', 'Positive sample should classify as POSITIVE_INTEREST');
  assert.strictEqual(classifyIntent(pricingSample), 'OBJECTION_PRICING', 'Pricing inquiry should classify as OBJECTION_PRICING');
  assert.strictEqual(classifyIntent(techSample), 'OBJECTION_EXISTING_TECH', 'Existing stack should classify as OBJECTION_EXISTING_TECH');
  assert.strictEqual(classifyIntent(unsubSample), 'UNSUBSCRIBE_NOT_INTERESTED', 'Unsubscribe should classify as UNSUBSCRIBE_NOT_INTERESTED');

  console.log('  ✅ PASS: All 4 intent categories classified accurately.');

  // -----------------------------------------------------------------
  // TEST 2: Suppression & Blocklist Sync
  // -----------------------------------------------------------------
  console.log('\n[Test 2] Testing Unsubscribe Suppression (handleSuppression)...');

  const testUnsubEmail = `optout-${Date.now()}@unsub-agency-test.com`;
  const testUnsubDomain = 'unsub-agency-test.com';

  const suppResult = handleSuppression(testUnsubEmail, testUnsubDomain);
  assert.strictEqual(suppResult.success, true, 'Suppression should succeed');

  const blocklistPath = path.join(__dirname, 'config', 'blocklist.json');
  const blocklistData = JSON.parse(fs.readFileSync(blocklistPath, 'utf8'));
  assert.ok(blocklistData.addresses.includes(testUnsubEmail), 'Email must be in blocklist addresses');
  assert.ok(blocklistData.domains.includes(testUnsubDomain), 'Domain must be in blocklist domains');

  console.log(`  ✅ PASS: ${testUnsubEmail} permanently suppressed in config/blocklist.json.`);

  // -----------------------------------------------------------------
  // TEST 3: Deal Desk Response Generation ($4k + $1.5k/mo Retainer Copy)
  // -----------------------------------------------------------------
  console.log('\n[Test 3] Testing Deal Desk Response Drafter (generateDraftResponse)...');

  const positiveDraft = generateDraftResponse('POSITIVE_INTEREST', 'Alex Vance', 'Black Mesa Media');
  assert.ok(positiveDraft.body.includes('$4,000'), 'Positive copy must include $4,000 setup');
  assert.ok(positiveDraft.body.includes('$1,500/mo'), 'Positive copy must include $1,500/mo retainer');
  assert.ok(positiveDraft.body.includes('Black Mesa Media'), 'Positive copy must be customized with company name');
  assert.ok(positiveDraft.body.includes('Hi Alex'), 'Positive copy must address lead by first name');

  const pricingDraft = generateDraftResponse('OBJECTION_PRICING', 'Gordon Freeman', 'Lambda Growth');
  assert.ok(pricingDraft.body.includes('$4,000'), 'Pricing copy must include $4,000 setup');
  assert.ok(pricingDraft.body.includes('$1,500/month'), 'Pricing copy must include $1,500/mo retainer');
  assert.ok(pricingDraft.body.includes('Lambda Growth'), 'Pricing copy must address company');

  const techDraft = generateDraftResponse('OBJECTION_EXISTING_TECH', 'Eli Vance', 'Aperture Labs');
  assert.ok(techDraft.body.includes('$4,000 setup / $1,500/mo retainer'), 'Tech objection must include retainer structure');
  assert.ok(techDraft.body.includes('autonomous orchestration layer'), 'Tech objection must differentiate orchestration layer');

  const unsubDraft = generateDraftResponse('UNSUBSCRIBE_NOT_INTERESTED', 'Barney Calhoun', 'Citadel Digital');
  assert.ok(unsubDraft.body.includes('removed from all future outreach'), 'Unsub response must confirm removal');

  console.log('  ✅ PASS: Deal desk copy cleanly generated across all categories with locked $4k/$1.5k commercial terms.');

  // -----------------------------------------------------------------
  // TEST 4: Database Schema, Circuit Breaker Trip & Staged Drafts
  // -----------------------------------------------------------------
  console.log('\n[Test 4] Testing Pipeline Lead Matching, Circuit Breaker & Staging in SQLite...');

  initTriageDb();
  const db = getDatabase();

  // Seed a test lead in 'contacted' stage
  const testLeadId = `TEST-LEAD-${Date.now().toString(36).toUpperCase()}`;
  const testLeadEmail = `lead-${Date.now()}@triagetestagency.com`;
  upsertLead({
    id: testLeadId,
    name: 'Samantha Carter',
    title: 'Managing Partner',
    company: 'Stargate Digital',
    email: testLeadEmail,
    stage: 'contacted'
  });

  // Verify lead is currently 'contacted'
  let leadInDb = db.prepare('SELECT stage FROM pipeline_leads WHERE id = ?').get(testLeadId);
  assert.strictEqual(leadInDb.stage, 'contacted', 'Lead must be initially in contacted stage');

  // Process inbound reply from Samantha Carter expressing positive interest
  const inboundReply = {
    fromEmail: testLeadEmail,
    fromName: 'Samantha Carter',
    toEmail: 'jack@missedcallproject.com',
    subject: 'Re: white-label AI for Stargate Digital',
    bodyText: 'Hi Jack, we received your note. This sounds like something our clients could benefit from. Can we schedule 15 mins tomorrow at 2pm?',
    messageId: `<inbound-test-${Date.now()}@triagetestagency.com>`
  };

  const processResult = await processSingleInboundMessage(inboundReply);

  assert.strictEqual(processResult.success, true, 'Message processing should succeed');
  assert.strictEqual(processResult.circuitBreakerTripped, true, 'Circuit breaker MUST trip for contacted lead');
  assert.strictEqual(processResult.classification, 'POSITIVE_INTEREST', 'Should classify as POSITIVE_INTEREST');

  // Verify lead stage in SQLite flipped to 'contacted_replied'
  leadInDb = db.prepare('SELECT stage FROM pipeline_leads WHERE id = ?').get(testLeadId);
  assert.strictEqual(leadInDb.stage, 'contacted_replied', 'Lead stage MUST flip to contacted_replied');

  // Verify staged_replies entry created
  const staged = getStagedReplies('PENDING_APPROVAL');
  const matchedDraft = staged.find(s => s.to_email === testLeadEmail);
  assert.ok(matchedDraft, 'A draft response must be staged for Samantha Carter');
  assert.strictEqual(matchedDraft.status, 'PENDING_APPROVAL', 'Draft status must be PENDING_APPROVAL');
  assert.ok(matchedDraft.draft_body.includes('$4,000'), 'Draft body must contain $4,000 terms');

  console.log(`  ✅ PASS: Circuit breaker tripped! Lead stage flipped to 'contacted_replied' and draft #${matchedDraft.id} staged.`);

  // -----------------------------------------------------------------
  // TEST 5: Outbound Circuit Breaker Enforcement Gate
  // -----------------------------------------------------------------
  console.log('\n[Test 5] Verifying Outbound Batch Dispatcher Circuit Breaker Gate...');

  // Attempt to send a cold outreach email to this lead who already replied
  const dispatchAttempt = await sendSingleEmail({
    id: testLeadId,
    email: testLeadEmail,
    company: 'Stargate Digital',
    first_name: 'Samantha',
    last_name: 'Carter'
  });

  assert.strictEqual(dispatchAttempt.success, false, 'Dispatch to replied lead MUST be blocked');
  assert.strictEqual(dispatchAttempt.statusCode, 422, 'Blocked dispatch should return 422');
  assert.ok(dispatchAttempt.error.includes('ERR_CIRCUIT_BREAKER_TRIPPED'), 'Error must specify ERR_CIRCUIT_BREAKER_TRIPPED');

  console.log(`  ✅ PASS: Outbound dispatch was hard-blocked by circuit breaker: ${dispatchAttempt.error}`);

  // -----------------------------------------------------------------
  // TEST 6: Telemetry Integrity
  // -----------------------------------------------------------------
  console.log('\n[Test 6] Testing getInboxTriageTelemetry()...');

  const telemetry = getInboxTriageTelemetry();
  assert.strictEqual(telemetry.status, 'ACTIVE', 'Telemetry status must be ACTIVE');
  assert.ok(telemetry.totalInboundReplies >= 1, 'Total inbound replies must be >= 1');
  assert.ok(telemetry.circuitBreakersTripped >= 1, 'Circuit breakers tripped must be >= 1');
  assert.ok(telemetry.pendingDraftsCount >= 1, 'Pending drafts count must be >= 1');
  assert.ok(telemetry.triagedBreakdown.POSITIVE_INTEREST >= 1, 'Breakdown must count positive replies');

  console.log('  ✅ PASS: Inbound triage telemetry successfully generated:');
  console.log(JSON.stringify({
    totalReplies: telemetry.totalInboundReplies,
    circuitBreakersTripped: telemetry.circuitBreakersTripped,
    pendingDraftsCount: telemetry.pendingDraftsCount,
    breakdown: telemetry.triagedBreakdown
  }, null, 2));

  console.log('\n===================================================================');
  console.log('  ALL INBOUND TRIAGE, CIRCUIT BREAKER & DEAL DESK TESTS PASSED!    ');
  console.log('===================================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ Test Error:', err);
  process.exit(1);
});
