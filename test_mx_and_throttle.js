'use strict';

/**
 * test_mx_and_throttle.js
 * Comprehensive Local Test Suite:
 * 1. Pre-Send DNS/MX Verification (1 Valid Domain vs 1 Fake Domain)
 * 2. RFC Syntax Validation & Dropping
 * 3. pipeline.db DISQUALIFIED_INVALID_MX Persistence & Audit Log
 * 4. Autonomous Dispatch Scheduler: 35/day Cap & 180-420s Randomized Stagger
 * 5. Human Escalation: Thread Pausing & /admin/status Flagging
 */

const assert = require('assert');
const { validateEmailSyntax, resolveMxRecords, verifyEmailPreFlight } = require('./lib/emailVerifier');
const { 
  getDatabase, 
  getPipelineSummary, 
  markLeadDisqualifiedMx, 
  flagThreadForReview, 
  getFlaggedThreadsForReview, 
  isThreadPaused, 
  unpauseThread 
} = require('./skills/skill7_pipeline_manager');
const { 
  getRandomStaggerMs, 
  checkDailySendCounter, 
  DAILY_CAP, 
  runBatchDispatch 
} = require('./trigger_batch_dispatch');

async function runTests() {
  console.log('===================================================================');
  console.log('  TESTING NATIVE MX VERIFICATION & 35/DAY RANDOMIZED THROTTLE     ');
  console.log('===================================================================\n');

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name}: ${err.message}`);
      throw err;
    }
  }

  async function testAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name}: ${err.message}`);
      throw err;
    }
  }

  // --- PART 1: RFC SYNTAX VALIDATION ---
  console.log('--- 1. Testing RFC Syntax Validation ---');
  test('Valid email syntax passes RFC check', () => {
    const res = validateEmailSyntax('alex.miller@growthagency.com');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.normalizedEmail, 'alex.miller@growthagency.com');
  });

  test('Missing @ symbol is rejected', () => {
    const res = validateEmailSyntax('alexmillergrowthagency.com');
    assert.strictEqual(res.valid, false);
    assert.match(res.error, /exactly one @/i);
  });

  test('Multiple @ symbols are rejected', () => {
    const res = validateEmailSyntax('alex@@growthagency.com');
    assert.strictEqual(res.valid, false);
  });

  test('Illegal characters and empty strings are rejected', () => {
    assert.strictEqual(validateEmailSyntax('').valid, false);
    assert.strictEqual(validateEmailSyntax('bad user@domain.com').valid, false);
    assert.strictEqual(validateEmailSyntax('bad<user>@domain.com').valid, false);
  });

  // --- PART 2: NATIVE DNS/MX VERIFICATION (1 VALID DOMAIN + 1 FAKE DOMAIN) ---
  console.log('\n--- 2. Testing Native DNS/MX Verification ---');
  await testAsync('Valid domain (google.com) resolves active MX records via Node dns.promises.resolveMx', async () => {
    const res = await resolveMxRecords('google.com');
    assert.strictEqual(res.hasMx, true);
    assert.ok(Array.isArray(res.records));
    assert.ok(res.records.length > 0);
    assert.ok(res.records[0].exchange, 'MX record must contain exchange host');
    console.log(`       -> Resolved ${res.records.length} MX record(s) for google.com: ${res.records[0].exchange} (priority: ${res.records[0].priority})`);
  });

  await testAsync('Fake/non-existent domain (fakedomainxyznotreal999.com) fails MX resolution', async () => {
    const res = await resolveMxRecords('fakedomainxyznotreal999.com');
    assert.strictEqual(res.hasMx, false);
    assert.strictEqual(res.records.length, 0);
    console.log(`       -> Fake domain correctly rejected with reason: ${res.reason}`);
  });

  // --- PART 3: PRE-SEND PRE-FLIGHT & pipeline.db DISQUALIFIED_INVALID_MX ---
  console.log('\n--- 3. Testing Pre-Flight & SQLite pipeline.db Tagging ---');
  await testAsync('Pre-flight passes for valid email with active MX', async () => {
    const res = await verifyEmailPreFlight({ email: 'contact@google.com', updateDb: false });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.reason, 'PASSED_MX_AND_SYNTAX');
    assert.ok(res.mxRecords.length > 0);
  });

  await testAsync('Pre-flight marks fake domain lead as DISQUALIFIED_INVALID_MX in pipeline.db', async () => {
    const testEmail = `lead_test_${Date.now()}@fakedomainxyznotreal999.com`;
    const res = await verifyEmailPreFlight({ 
      email: testEmail, 
      company: 'Fake Corp',
      updateDb: true 
    });

    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.reason, 'DISQUALIFIED_INVALID_MX');
    assert.strictEqual(res.mxRecords.length, 0);

    // Verify record in SQLite pipeline.db
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM pipeline_leads WHERE email = ?').get(testEmail);
    assert.ok(row, 'Disqualified lead must exist in pipeline_leads');
    assert.strictEqual(row.stage, 'disqualified_invalid_mx');
    assert.strictEqual(row.qualification_tier, 'DISQUALIFIED_INVALID_MX');

    // Verify lifecycle audit log entry
    const audit = db.prepare('SELECT * FROM lifecycle_audit_log WHERE lead_id = ?').get(row.id);
    assert.ok(audit, 'Audit log entry must exist for MX failure');
    assert.strictEqual(audit.to_stage, 'disqualified_invalid_mx');
    assert.strictEqual(audit.event_name, 'PRE_SEND_MX_DISQUALIFIED');

    console.log(`       -> Lead successfully marked DISQUALIFIED_INVALID_MX in pipeline.db (ID: ${row.id})`);

    // Clean up test rows
    db.prepare('DELETE FROM lifecycle_audit_log WHERE lead_id = ?').run(row.id);
    db.prepare('DELETE FROM pipeline_leads WHERE id = ?').run(row.id);
  });

  // --- PART 4: AUTONOMOUS DISPATCH SCHEDULER & 35/DAY THROTTLE ---
  console.log('\n--- 4. Testing Autonomous Dispatch Scheduler & 35/Day Cap ---');
  test('Strict daily cap is configured to 35', () => {
    assert.strictEqual(DAILY_CAP, 35);
  });

  test('Randomized stagger falls strictly within 180 to 420 seconds (180,000ms - 420,000ms)', () => {
    for (let i = 0; i < 50; i++) {
      const ms = getRandomStaggerMs(180, 420);
      assert.ok(ms >= 180000, `Stagger ${ms}ms must be >= 180,000ms`);
      assert.ok(ms <= 420000, `Stagger ${ms}ms must be <= 420,000ms`);
    }
    const sampleMs = getRandomStaggerMs(180, 420);
    console.log(`       -> Verified 50 randomized samples; sample delay: ${(sampleMs / 1000).toFixed(1)}s (${(sampleMs / 60000).toFixed(2)} mins)`);
  });

  await testAsync('dailySendCounter cleanly reflects cap status when dispatched >= 35', async () => {
    const counter = await checkDailySendCounter();
    assert.strictEqual(counter.dailyLimit, 35);
    assert.ok(typeof counter.sentToday === 'number');
    assert.ok(['ACTIVE', 'CAP_REACHED'].includes(counter.status));
    console.log(`       -> dailySendCounter: sentToday=${counter.sentToday}, limit=${counter.dailyLimit}, remaining=${counter.remainingToday}, status=${counter.status}`);
  });

  // --- PART 5: HUMAN ESCALATION & THREAD PAUSING ---
  console.log('\n--- 5. Testing Human Escalation & /admin/status Flagging ---');
  test('flagThreadForReview records review thread and pauses dispatch', () => {
    const testThreadEmail = `reply_lead_${Date.now()}@agencygrowth.org`;
    const flagRes = flagThreadForReview({
      email: testThreadEmail,
      company: 'Growth Agency Inc',
      reason: 'INBOUND_REPLY_RECEIVED',
      subject: 'Re: White-label AI inquiry',
      messageSnippet: 'Hey Jack, tell me more about your margin structure.'
    });

    assert.strictEqual(flagRes.success, true);
    assert.strictEqual(flagRes.status, 'PAUSED_NEEDS_REVIEW');
    assert.strictEqual(isThreadPaused(testThreadEmail), true);

    const flaggedList = getFlaggedThreadsForReview();
    const found = flaggedList.find(t => t.email === testThreadEmail);
    assert.ok(found, 'Flagged thread must appear in getFlaggedThreadsForReview()');
    assert.strictEqual(found.reason, 'INBOUND_REPLY_RECEIVED');
    assert.strictEqual(found.status, 'PAUSED_NEEDS_REVIEW');

    console.log(`       -> Thread ${testThreadEmail} flagged and paused. Reported in review queue.`);

    // Unpause / clean up
    unpauseThread(testThreadEmail, 'RESOLVED_TEST');
    assert.strictEqual(isThreadPaused(testThreadEmail), false);
  });

  test('Non-bad-address SMTP error flags thread for review', () => {
    const errorEmail = `smtp_err_${Date.now()}@legitdomain.com`;
    const flagRes = flagThreadForReview({
      email: errorEmail,
      company: 'Legit Domain Corp',
      reason: 'OUTBOUND_SEND_FAILURE',
      errorCode: 'ERR_MAIL_TRANSPORT_FAILED',
      subject: 'Outreach to Legit Domain Corp',
      messageSnippet: 'Mail server connection timed out after 20s'
    });

    assert.strictEqual(flagRes.success, true);
    assert.strictEqual(isThreadPaused(errorEmail), true);

    const flaggedList = getFlaggedThreadsForReview();
    const found = flaggedList.find(t => t.email === errorEmail);
    assert.ok(found);
    assert.strictEqual(found.error_code, 'ERR_MAIL_TRANSPORT_FAILED');

    console.log(`       -> Non-address transport error correctly paused thread ${errorEmail}`);

    unpauseThread(errorEmail, 'RESOLVED_TEST');
  });

  console.log('\n===================================================================');
  console.log(`  ALL ${total} TESTS PASSED SUCCESSFULLY (100% OK)                 `);
  console.log('===================================================================');
}

runTests().catch(err => {
  console.error('\n[FATAL TEST ERROR]', err);
  process.exit(1);
});
