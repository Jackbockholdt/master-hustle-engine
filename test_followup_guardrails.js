'use strict';

/**
 * test_followup_guardrails.js
 * Verification of modern Enterprise 9-Skill follow-up deduplication & 48-hour quiet gap guardrails.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  getDatabase,
  upsertLead,
  evaluateFollowUpEligibility,
  queueFollowUpTask,
  fetchDueFollowUps,
  markFollowUpTask,
  retireDuplicateSequences,
  FOLLOWUP_MIN_GAP_HOURS
} = require('./skills/skill7_pipeline_manager');

async function runTests() {
  console.log('======================================================================');
  console.log('   RUNNING TEST SUITE: Enterprise 9-Skill Follow-up Guardrails        ');
  console.log('======================================================================\n');

  console.log(`[Config Check] FOLLOWUP_MIN_GAP_HOURS = ${FOLLOWUP_MIN_GAP_HOURS} hours`);
  assert.strictEqual(FOLLOWUP_MIN_GAP_HOURS, 48, 'FOLLOWUP_MIN_GAP_HOURS must default to 48');

  const db = getDatabase();
  // Clear test records
  db.exec(`DELETE FROM pipeline_followups WHERE email LIKE '%@test-agency.com';`);
  db.exec(`DELETE FROM pipeline_leads WHERE email LIKE '%@test-agency.com';`);

  // ---------------------------------------------------------------------------
  // TEST 1: Clean lead ingestion & first follow-up queuing
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 1: Initial Clean Follow-up Queuing ---');
  const testEmail1 = 'sarah@test-agency.com';
  const lead1 = upsertLead({
    id: 'LEAD-TEST-1',
    name: 'Sarah Connor',
    company: 'Apex Test Agency',
    email: testEmail1,
    stage: 'contacted'
  });

  const queueResult1 = queueFollowUpTask({
    leadId: lead1.id,
    email: testEmail1,
    campaignId: 'agency_campaign_a',
    step: 1,
    subject: 'Follow-up step 1',
    body: 'Checking in regarding LLM margin recovery.'
  });

  console.log('Queue Result 1:', queueResult1);
  assert.strictEqual(queueResult1.eligible, true, 'Clean follow-up should be eligible');
  assert.strictEqual(queueResult1.status, 'CLEARED_FOR_DISPATCH', 'Status must be CLEARED_FOR_DISPATCH');
  console.log('✓ TEST 1 PASSED: Clean initial follow-up queued with CLEARED_FOR_DISPATCH');

  // ---------------------------------------------------------------------------
  // TEST 2: Duplicate suppression on pending task
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 2: Duplicate Task Suppression ---');
  const queueResult2 = queueFollowUpTask({
    leadId: lead1.id,
    email: testEmail1,
    campaignId: 'agency_campaign_b',
    step: 2,
    subject: 'Follow-up step 2 duplicate',
    body: 'Checking in again.'
  });

  console.log('Queue Result 2 (Duplicate Attempt):', queueResult2);
  assert.strictEqual(queueResult2.eligible, false, 'Duplicate follow-up should NOT be eligible');
  assert.strictEqual(queueResult2.status, 'SUPPRESSED_DUPLICATE', 'Status must be SUPPRESSED_DUPLICATE');
  console.log('✓ TEST 2 PASSED: Redundant follow-up suppressed with SUPPRESSED_DUPLICATE');

  // ---------------------------------------------------------------------------
  // TEST 3: 48-Hour Quiet Gap Enforcement (< 48 hours ago)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 3: 48-Hour Quiet Gap Suppression (Contacted 12h ago) ---');
  const testEmail3 = 'alex@test-agency.com';
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  const lead3 = upsertLead({
    id: 'LEAD-TEST-3',
    name: 'Alex Rivera',
    company: 'Rivera Creative',
    email: testEmail3,
    stage: 'contacted',
    lastContactedAt: twelveHoursAgo
  });

  const queueResult3 = queueFollowUpTask({
    leadId: lead3.id,
    email: testEmail3,
    campaignId: 'agency_campaign_a',
    step: 1,
    subject: 'Too early follow-up',
    body: 'Checking in.',
    lastContactedAt: twelveHoursAgo
  });

  console.log('Queue Result 3 (Inside Quiet Gap):', queueResult3);
  assert.strictEqual(queueResult3.eligible, false, 'Inside quiet gap should NOT be eligible');
  assert.strictEqual(queueResult3.status, 'SUPPRESSED_QUIET_GAP', 'Status must be SUPPRESSED_QUIET_GAP');
  assert(queueResult3.details.remainingGapHours > 35, 'Remaining gap hours should be approximately 36 hours');
  console.log(`✓ TEST 3 PASSED: Quiet gap enforced. Remaining gap: ${queueResult3.details.remainingGapHours}h`);

  // ---------------------------------------------------------------------------
  // TEST 4: Quiet Gap Cleared (Contacted 50 hours ago >= 48h)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 4: 48-Hour Quiet Gap Expired (Contacted 50h ago) ---');
  const testEmail4 = 'marcus@test-agency.com';
  const fiftyHoursAgo = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();

  const lead4 = upsertLead({
    id: 'LEAD-TEST-4',
    name: 'Marcus Vance',
    company: 'Vance Design',
    email: testEmail4,
    stage: 'contacted',
    lastContactedAt: fiftyHoursAgo
  });

  const queueResult4 = queueFollowUpTask({
    leadId: lead4.id,
    email: testEmail4,
    campaignId: 'agency_campaign_a',
    step: 1,
    subject: 'Eligible follow-up step 1',
    body: 'Checking in after quiet gap.',
    lastContactedAt: fiftyHoursAgo
  });

  console.log('Queue Result 4 (Outside Quiet Gap):', queueResult4);
  assert.strictEqual(queueResult4.eligible, true, 'Outside quiet gap should be eligible');
  assert.strictEqual(queueResult4.status, 'CLEARED_FOR_DISPATCH', 'Status must be CLEARED_FOR_DISPATCH');
  console.log('✓ TEST 4 PASSED: Follow-up outside 48h window cleared for dispatch');

  // ---------------------------------------------------------------------------
  // TEST 5: One Row per Address Selection (fetchDueFollowUps)
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 5: fetchDueFollowUps One Row Per Address Selection ---');
  const due = fetchDueFollowUps(10);
  const emails = due.map(d => d.email.toLowerCase());
  const uniqueEmails = new Set(emails);
  assert.strictEqual(emails.length, uniqueEmails.size, 'fetchDueFollowUps must return at most one row per unique email');
  console.log(`✓ TEST 5 PASSED: ${due.length} due items returned, all distinct emails`);

  // ---------------------------------------------------------------------------
  // TEST 6: Multi-Campaign Sequence Retirement
  // ---------------------------------------------------------------------------
  console.log('\n--- TEST 6: Multi-Campaign Sequence Retirement ---');
  const testEmail6 = 'eric@test-agency.com';
  upsertLead({
    id: 'LEAD-TEST-6',
    name: 'Eric Siu',
    company: 'Single Grain Test',
    email: testEmail6,
    stage: 'contacted'
  });

  // Insert two pending tasks under different campaigns bypassing single-task queueing to simulate pre-existing race condition
  db.prepare(`
    INSERT INTO pipeline_followups (lead_id, campaign_id, email, step, subject, body, status, due_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
  `).run('LEAD-TEST-6', 'campaign_early', testEmail6, 1, 'Sub 1', 'Body 1');

  db.prepare(`
    INSERT INTO pipeline_followups (lead_id, campaign_id, email, step, subject, body, status, due_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
  `).run('LEAD-TEST-6', 'campaign_late', testEmail6, 2, 'Sub 2', 'Body 2');

  const retireResult = retireDuplicateSequences();
  console.log('Retire Result:', retireResult);
  assert(retireResult.retiredSequences >= 1, 'Should retire at least 1 duplicate campaign sequence');

  const remainingPending = db.prepare(`SELECT campaign_id FROM pipeline_followups WHERE LOWER(email) = ? AND status = 'pending'`).all(testEmail6);
  assert.strictEqual(remainingPending.length, 1, 'Only one campaign should remain pending');
  assert.strictEqual(remainingPending[0].campaign_id, 'campaign_early', 'Earliest campaign must be kept');
  console.log(`✓ TEST 6 PASSED: Duplicate campaign retired, retained: ${remainingPending[0].campaign_id}`);

  console.log('\n======================================================================');
  console.log('           ALL 6 GUARDRAIL TESTS PASSED SUCCESSFULLY!                 ');
  console.log('======================================================================\n');

  // Clean up test rows
  db.exec(`DELETE FROM pipeline_followups WHERE email LIKE '%@test-agency.com';`);
  db.exec(`DELETE FROM pipeline_leads WHERE email LIKE '%@test-agency.com';`);
}

runTests().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
