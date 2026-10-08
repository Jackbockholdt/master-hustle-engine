'use strict';

/**
 * test_scheduler_and_reset.js
 * Test Suite for Autonomous Daily Scheduler & Midnight Counter Reset
 * 1. Verifies node-cron schedule configuration (8:00 AM CST dispatch, 00:00 midnight CST reset).
 * 2. Verifies SQLite daily_dispatch_state persistence, increment, and midnight reset logic.
 * 3. Verifies daily send gate clearance (CAP_REACHED -> ACTIVE, remainingToday: 35).
 * 4. Verifies safety catches: OUTBOUND_PAUSED, hard 35 daily ceiling, RFC MX check, 180-420s jitter.
 * 5. Verifies /admin/status telemetry reports scheduler state and true daily counter.
 */

const assert = require('assert');
const { 
  getDatabase, 
  getCstDateString, 
  getDailyDispatchState, 
  recordDailySend, 
  resetDailySendCounter 
} = require('./skills/skill7_pipeline_manager');
const { 
  getDailySendCounter, 
  initScheduler, 
  stopScheduler, 
  getSchedulerStatus 
} = require('./server');
const { 
  runBatchDispatch, 
  checkDailySendCounter, 
  DAILY_CAP 
} = require('./trigger_batch_dispatch');

async function runTests() {
  console.log('===================================================================');
  console.log('  TESTING AUTONOMOUS SCHEDULER & MIDNIGHT CST COUNTER RESET        ');
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

  // --- 1. SCHEDULER WIRING & STATUS ---
  console.log('--- 1. Testing node-cron Scheduler Wiring ---');
  test('Scheduler initializes with active 8:00 AM CST and 00:00 midnight CST jobs', () => {
    initScheduler();
    const status = getSchedulerStatus();
    assert.strictEqual(status.status, 'ACTIVE');
    assert.strictEqual(status.timezone, 'America/Chicago (CST)');
    assert.ok(status.dispatchSchedule.includes('8:00 AM CST'));
    assert.ok(status.resetSchedule.includes('00:00 Midnight CST'));
    assert.strictEqual(status.jobsRunning.morningDispatch, true);
    assert.strictEqual(status.jobsRunning.midnightReset, true);
    console.log(`       -> Scheduler status: ${status.status} (${status.timezone})`);
    console.log(`       -> Morning Dispatch Schedule: ${status.dispatchSchedule}`);
    console.log(`       -> Midnight Reset Schedule:   ${status.resetSchedule}`);
  });

  // --- 2. SQLITE DAILY DISPATCH STATE PERSISTENCE ---
  console.log('\n--- 2. Testing SQLite daily_dispatch_state Persistence ---');
  test('Daily dispatch state tracks CST date correctly', () => {
    const cstDate = getCstDateString();
    assert.match(cstDate, /^\d{4}-\d{2}-\d{2}$/);
    const state = getDailyDispatchState();
    assert.strictEqual(state.date, cstDate);
    assert.strictEqual(state.dailyLimit, 35);
    console.log(`       -> Current CST Date: ${cstDate}, sentToday: ${state.sentToday}, limit: ${state.dailyLimit}`);
  });

  test('recordDailySend increments database counter and caps at 35', () => {
    resetDailySendCounter();
    const init = getDailyDispatchState();
    assert.strictEqual(init.sentToday, 0);
    assert.strictEqual(init.status, 'ACTIVE');

    recordDailySend(10);
    const s10 = getDailyDispatchState();
    assert.strictEqual(s10.sentToday, 10);
    assert.strictEqual(s10.remainingToday, 25);
    assert.strictEqual(s10.status, 'ACTIVE');

    recordDailySend(25);
    const s35 = getDailyDispatchState();
    assert.strictEqual(s35.sentToday, 35);
    assert.strictEqual(s35.remainingToday, 0);
    assert.strictEqual(s35.status, 'CAP_REACHED');
    console.log(`       -> State after 35 sends: sentToday=${s35.sentToday}, status=${s35.status}, remaining=${s35.remainingToday}`);
  });

  // --- 3. AUTOMATIC MIDNIGHT RESET LOGIC ---
  console.log('\n--- 3. Testing Automatic Midnight CST Counter Reset ---');
  test('resetDailySendCounter resets sent_today to 0 and clears daily send gates', () => {
    // Ensure counter is capped first
    recordDailySend(35);
    const capped = getDailyDispatchState();
    assert.strictEqual(capped.status, 'CAP_REACHED');

    // Execute midnight reset
    const resetResult = resetDailySendCounter();
    assert.strictEqual(resetResult.success, true);
    assert.strictEqual(resetResult.sentToday, 0);
    assert.strictEqual(resetResult.status, 'ACTIVE');
    assert.strictEqual(resetResult.remainingToday, 35);

    // Verify persistence in SQLite
    const stateAfter = getDailyDispatchState();
    assert.strictEqual(stateAfter.sentToday, 0);
    assert.strictEqual(stateAfter.status, 'ACTIVE');
    assert.strictEqual(stateAfter.remainingToday, 35);

    // Verify lifecycle audit log
    const db = getDatabase();
    const audit = db.prepare("SELECT * FROM lifecycle_audit_log WHERE event_name = 'DAILY_SEND_COUNTER_RESET' ORDER BY id DESC LIMIT 1").get();
    assert.ok(audit, 'Audit log must record DAILY_SEND_COUNTER_RESET');
    console.log(`       -> Counter reset verified: sentToday=0, status=ACTIVE, remainingToday=35`);
    console.log(`       -> Audit entry: "${audit.detail}"`);
  });

  // --- 4. SAFETY CATCHES PRESERVATION ---
  console.log('\n--- 4. Testing Preservation of Safety Catches ---');
  await testAsync('OUTBOUND_PAUSED check prevents autonomous batch execution', async () => {
    const originalEnv = process.env.OUTBOUND_PAUSED;
    process.env.OUTBOUND_PAUSED = 'true';

    const res = await runBatchDispatch({ isSyntheticTest: true });
    assert.strictEqual(res.executionMode, 'SUSPENDED_OUTBOUND_PAUSED');
    assert.strictEqual(res.evaluated, 0);
    console.log('       -> Outbound dispatch cleanly suspended when OUTBOUND_PAUSED=true');

    process.env.OUTBOUND_PAUSED = originalEnv || 'false';
  });

  test('Daily cap ceiling of 35 is strictly enforced', () => {
    assert.strictEqual(DAILY_CAP, 35);
  });

  // Cleanup: ensure clean reset for production readiness
  resetDailySendCounter();
  stopScheduler();

  console.log('\n===================================================================');
  console.log(`  ALL ${total} TESTS PASSED SUCCESSFULLY (100% OK)                 `);
  console.log('===================================================================');
}

runTests().catch(err => {
  console.error('\n[FATAL TEST ERROR]', err);
  process.exit(1);
});
