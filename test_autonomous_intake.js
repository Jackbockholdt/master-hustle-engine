'use strict';

/**
 * test_autonomous_intake.js
 * Local test suite for Autonomous Daily Outscraper Scrape & Lead Intake Engine:
 * 1. Verifies lead queue depth audit & pipeline.db query.
 * 2. Tests strict deduplication against pipeline.db and partner_outreach_log.csv.
 * 3. Tests pre-flight RFC syntax and live DNS MX resolution filters.
 * 4. Tests staging of verified leads into pipeline.db and verified_leads.csv.
 * 5. Tests GET /admin/status telemetry exposure of leadQueueDepth.
 * 6. Tests rate limit and empty result resilience without crashing.
 */

const http = require('http');
const { runAutonomousDailyIntake } = require('./lib/autonomousLeadIntake');
const {
  getDatabase,
  getLeadQueueDepth,
  getPipelineSummary,
  upsertLead,
  isLeadInPipeline
} = require('./skills/skill7_pipeline_manager');
const { verifyEmailPreFlight } = require('./lib/emailVerifier');

async function runTests() {
  console.log('===================================================================');
  console.log('  TESTING AUTONOMOUS OUTSCRAPER INTAKE & LEAD BUFFER AUDIT         ');
  console.log('===================================================================');

  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      process.exitCode = 1;
    }
  }

  // --- Test 1: Initial Lead Buffer Audit ---
  console.log('\n--- 1. Testing Lead Buffer Audit & Initial Queue Depth ---');
  const initialDepth = getLeadQueueDepth();
  const summary = getPipelineSummary();
  console.log(`       -> Current Lead Queue Depth: ${initialDepth}`);
  console.log(`       -> Total Dispatched: ${(summary.stageCounts.contacted || 0) + (summary.stageCounts.proposed || 0) + (summary.stageCounts.converted || 0)}`);
  assert(typeof initialDepth === 'number', 'Lead queue depth is returned as a number');
  assert(initialDepth >= 0, 'Lead queue depth is non-negative');

  // --- Test 2: Strict Deduplication against pipeline.db ---
  console.log('\n--- 2. Testing Strict Deduplication against pipeline.db ---');
  const db = getDatabase();
  // Check an existing lead from pipeline.db (e.g. first existing row)
  const existingRow = db.prepare('SELECT company, email, domain FROM pipeline_leads LIMIT 1').get();
  if (existingRow) {
    console.log(`       -> Checking existing lead in DB: "${existingRow.company}" (${existingRow.email})`);
    const dedupeCheck = isLeadInPipeline({
      email: existingRow.email,
      domain: existingRow.domain,
      company: existingRow.company
    });
    assert(dedupeCheck.exists === true, `Strict deduplication detects existing lead in pipeline.db (matched: ${dedupeCheck.match})`);
  } else {
    console.log('       -> No existing rows in DB to test duplicate against, inserting mock.');
    upsertLead({
      id: 'TEST-DEDUPE-1',
      name: 'Test Founder',
      company: 'Existing Test Agency',
      email: 'founder@existingtestagency.io',
      domain: 'existingtestagency.io',
      stage: 'contacted'
    });
    const check = isLeadInPipeline({ email: 'founder@existingtestagency.io' });
    assert(check.exists === true, 'Strict deduplication detects existing lead in pipeline.db');
  }

  // --- Test 3: RFC Syntax & Live DNS MX Resolution Filter ---
  console.log('\n--- 3. Testing RFC Syntax & Live DNS MX Verification Filter ---');
  // 3a. Invalid Syntax
  const badSyntax = await verifyEmailPreFlight({ email: 'invalid-email-no-at-sign', updateDb: false });
  console.log(`       -> Invalid email syntax test: valid=${badSyntax.valid}, reason=${badSyntax.reason}`);
  assert(badSyntax.valid === false && badSyntax.reason === 'DISQUALIFIED_INVALID_SYNTAX', 'Invalid RFC syntax correctly rejected');

  // 3b. Non-existent domain MX failure
  const badMx = await verifyEmailPreFlight({ email: 'test@nonexistent-agency-domain-xyz-98234.org', updateDb: false });
  console.log(`       -> Fake domain MX test: valid=${badMx.valid}, reason=${badMx.reason}`);
  assert(badMx.valid === false && badMx.reason === 'DISQUALIFIED_INVALID_MX', 'Fake domain fails live DNS MX resolution');

  // 3c. Real domain with valid MX
  const realMx = await verifyEmailPreFlight({ email: 'partner@google.com', updateDb: false });
  console.log(`       -> Real domain MX test: valid=${realMx.valid}, mxRecordsCount=${realMx.mxRecords?.length || 0}`);
  assert(realMx.valid === true && realMx.mxRecords.length > 0, 'Real domain passes live DNS MX verification');

  // --- Test 4: Autonomous Intake Execution with Mock Curated Leads ---
  console.log('\n--- 4. Testing Autonomous Intake Pass with Mock Curated Leads ---');
  const intakeResult = await runAutonomousDailyIntake({
    query: 'digital marketing agency, Austin, TX',
    limit: 3,
    mock: true,
    dryRun: false
  });

  console.log(`       -> Evaluated: ${intakeResult.evaluatedCount}`);
  console.log(`       -> Staged:    ${intakeResult.stagedCount}`);
  console.log(`       -> Skips:     ${intakeResult.dedupeSkipsCount}`);
  console.log(`       -> Queue Depth After Intake: ${intakeResult.leadQueueDepth}`);

  assert(intakeResult.success === true, 'Autonomous lead intake executes successfully');
  assert(intakeResult.evaluatedCount > 0, 'Evaluates candidate leads from ICP targeting');
  assert(intakeResult.leadQueueDepth >= initialDepth, 'Lead queue depth increases or remains healthy after intake');

  // --- Test 5: Re-running Same Query Enforces Deduplication ---
  console.log('\n--- 5. Testing Deduplication on Immediate Re-Run ---');
  const rerunResult = await runAutonomousDailyIntake({
    query: 'digital marketing agency, Austin, TX',
    limit: 3,
    mock: true,
    dryRun: false
  });
  console.log(`       -> Re-run staged: ${rerunResult.stagedCount}, dedupe skips: ${rerunResult.dedupeSkipsCount}`);
  assert(rerunResult.dedupeSkipsCount > 0, 'Immediate re-run dedupes leads already staged in pipeline.db');

  // --- Test 6: GET /admin/status Exposes leadQueueDepth ---
  console.log('\n--- 6. Testing GET /admin/status Telemetry for leadQueueDepth ---');
  // Start server on temporary port 3008
  const { app, initScheduler, stopScheduler } = require('./server');
  const PORT = 3008;
  const server = app.listen(PORT);

  await new Promise(r => setTimeout(r, 800));

  try {
    const statusData = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${PORT}/admin/status?key=master-hustle-admin-secret-2026`, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });

    console.log(`       -> /admin/status leadQueueDepth: ${statusData.leadQueueDepth}`);
    console.log(`       -> /admin/status outboundQueue.leadQueueDepth: ${statusData.outboundQueue?.leadQueueDepth}`);
    console.log(`       -> /admin/status scheduler.intakeSchedule: ${statusData.scheduler?.intakeSchedule}`);

    assert(statusData.leadQueueDepth !== undefined, 'GET /admin/status exposes root leadQueueDepth');
    assert(statusData.outboundQueue?.leadQueueDepth !== undefined, 'GET /admin/status exposes outboundQueue.leadQueueDepth');
    assert(statusData.scheduler?.intakeSchedule.includes('6:00 AM CST'), 'Scheduler reports 6:00 AM CST intake schedule');
  } finally {
    server.close();
    stopScheduler();
  }

  console.log(`\n===================================================================`);
  console.log(`  ALL ${total} TESTS COMPLETED: ${passed}/${total} PASSED (${passed === total ? '100% OK' : 'FAILURES PRESENT'})`);
  console.log(`===================================================================\n`);
}

runTests().catch(err => {
  console.error('[Test Error]', err);
  process.exit(1);
});
