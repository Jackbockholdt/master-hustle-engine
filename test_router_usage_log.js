'use strict';

/**
 * test_router_usage_log.js
 * Verifies router usage logging: cost math, baseline choice, Chicago day windows,
 * per-task breakdown, failed-request logging through routeMultiModel, savings page
 * rendering, and that routing still returns the same result shape.
 *
 * Run: node test_router_usage_log.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated database and no provider keys, so no network calls are made.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-usage-test-'));
process.env.ROUTER_USAGE_DB_PATH = path.join(tmpDir, 'router_usage.db');
for (const k of ['API_POOL', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'OPENROUTER_API_KEY']) {
  delete process.env[k];
}

const usage = require('./lib/routerUsageLog');
const { routeMultiModel, PROVIDER_MODELS } = require('./lib/multiModelRouter');
const { renderSavingsPage } = require('./lib/savingsPage');

const DAY = 24 * 60 * 60 * 1000;
let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✅ PASS: ${name}`);
}
function close(actual, expected, msg) {
  assert(Math.abs(actual - expected) < 1e-9, `${msg}: expected ${expected}, got ${actual}`);
}

async function run() {
  console.log('\n🧪 Router usage logging tests\n');

  // 1. Pricing config is valid and baseline is the most expensive default strong-tier model
  const cfg = usage.loadPricingConfig();
  assert.strictEqual(cfg.timezone, 'America/Chicago');
  ok('pricing config loads and validates');

  const score = (r) => (r.input * 3 + r.output) / 4;
  const defaultStrong = [
    PROVIDER_MODELS.tiers.gemini.strong,
    PROVIDER_MODELS.tiers.openai.strong,
    PROVIDER_MODELS.tiers.claude.strong,
    PROVIDER_MODELS.tiers.openrouter.strong
  ];
  const priced = defaultStrong.filter((m) => cfg.models[m]);
  const mostExpensive = priced.reduce((a, b) => (score(cfg.models[a]) >= score(cfg.models[b]) ? a : b));
  assert.strictEqual(cfg.baselineModel, mostExpensive, `baseline should be most expensive default strong model (${mostExpensive})`);
  ok(`baseline is the most expensive default strong-tier model (${cfg.baselineModel})`);

  // 2. Cost math: actual vs baseline vs savings
  const t0 = Date.UTC(2026, 9, 7, 15, 0, 0); // Oct 7 2026 15:00 UTC
  usage.recordUsage({ task: 'COPYWRITING', provider: 'claude', model: 'claude-haiku-4-5-20251001', tier: 'cheap', status: 'success', inputTokens: 1000, outputTokens: 500 }, t0);
  // actual = (1000*1 + 500*5)/1e6 = 0.0035 ; baseline = (1000*3 + 500*15)/1e6 = 0.0105 ; saved = 0.007
  const r1 = usage.getUsageReport(t0);
  close(r1.windows.today.actualCostUSD, 0.0035, 'actual cost');
  close(r1.windows.today.baselineCostUSD, 0.0105, 'baseline cost');
  close(r1.windows.today.savingsUSD, 0.007, 'savings');
  close(r1.windows.today.savingsPct, 66.7, 'savings percent');
  ok('cost math: actual, baseline, savings and percent match hand calculation');

  // 3. Unknown model: no price guessed, excluded from dollar totals, still counted as a request
  usage.recordUsage({ task: 'TEST_UNPRICED', provider: 'mystery', model: 'not-a-real-model', tier: 'cheap', status: 'success', inputTokens: 100, outputTokens: 100 }, t0);
  const r2 = usage.getUsageReport(t0);
  assert.strictEqual(r2.windows.today.unpricedRequests, 1, 'unpriced count');
  close(r2.windows.today.actualCostUSD, 0.0035, 'unpriced row excluded from actual');
  close(r2.windows.today.baselineCostUSD, 0.0105, 'baseline excludes unpriced row');
  ok('unknown model is excluded from dollar savings without guessing a price');

  // 4. Failed request: zero tokens, zero cost, counted as failed
  usage.recordUsage({ task: 'COPYWRITING', provider: null, model: null, tier: null, status: 'failed', inputTokens: 0, outputTokens: 0 }, t0);
  const r3 = usage.getUsageReport(t0);
  assert.strictEqual(r3.windows.today.failedRequests, 1, 'failed count');
  ok('failed request is logged with zero cost');

  // 5. Chicago calendar day and trailing windows
  const now = Date.UTC(2026, 9, 7, 3, 0, 0); // Oct 6 2026 22:00 CDT
  const chicagoMidnight = Date.UTC(2026, 9, 6, 5, 0, 0); // Oct 6 00:00 CDT
  assert.strictEqual(usage.startOfZonedDay(now, 'America/Chicago'), chicagoMidnight, 'Chicago midnight');
  ok('"today" starts at Chicago midnight (DST-aware)');

  const dbNow = now;
  usage.recordUsage({ task: 'WINDOW_TODAY', provider: 'gemini', model: 'gemini-3.5-flash-lite', tier: 'cheap', status: 'success', inputTokens: 1000000, outputTokens: 0 }, chicagoMidnight + 30 * 60 * 1000);
  usage.recordUsage({ task: 'WINDOW_YESTERDAY', provider: 'gemini', model: 'gemini-3.5-flash-lite', tier: 'cheap', status: 'success', inputTokens: 1000000, outputTokens: 0 }, chicagoMidnight - 60 * 60 * 1000);
  usage.recordUsage({ task: 'WINDOW_8D', provider: 'gemini', model: 'gemini-3.5-flash-lite', tier: 'cheap', status: 'success', inputTokens: 1000000, outputTokens: 0 }, dbNow - 8 * DAY);
  usage.recordUsage({ task: 'WINDOW_31D', provider: 'gemini', model: 'gemini-3.5-flash-lite', tier: 'cheap', status: 'success', inputTokens: 1000000, outputTokens: 0 }, dbNow - 31 * DAY);

  const rep = usage.getUsageReport(dbNow);
  const taskNames = rep.byTask.map((t) => t.task);
  assert(taskNames.includes('WINDOW_TODAY'), 'today row present');
  assert(!taskNames.includes('WINDOW_YESTERDAY') || rep.byTask.find((t) => t.task === 'WINDOW_YESTERDAY').windows.today === undefined, 'yesterday not in today');
  assert.strictEqual(rep.byTask.find((t) => t.task === 'WINDOW_TODAY').windows.today.requests, 1);
  assert.strictEqual(rep.byTask.find((t) => t.task === 'WINDOW_YESTERDAY').windows.days7.requests, 1);
  assert.strictEqual(rep.byTask.find((t) => t.task === 'WINDOW_8D').windows.days7, undefined, '8-day-old row not in 7d');
  assert.strictEqual(rep.byTask.find((t) => t.task === 'WINDOW_8D').windows.days30.requests, 1);
  assert.strictEqual(rep.byTask.find((t) => t.task === 'WINDOW_31D'), undefined, '31-day-old row not in 30d');
  ok('today / 7-day / 30-day windows include and exclude the right rows');

  // 6. Breakdown totals reconcile with window totals (30-day window)
  const sumTasksSaved = rep.byTask.reduce((s, t) => s + (t.windows.days30?.savingsUSD || 0), 0);
  close(Number(sumTasksSaved.toFixed(6)), rep.windows.days30.savingsUSD, 'per-task savings sum to 30-day total');
  ok('per-task breakdown reconciles with the 30-day total');

  // 7. Routing through routeMultiModel with no providers configured: returns the same failure shape and logs one failed row
  const before = usage.getUsageReport().windows.today.requests;
  const result = await routeMultiModel({ prompt: 'usage logging smoke test', task: 'USAGE_TEST_NO_PROVIDERS' });
  assert.strictEqual(result.success, false, 'no providers should fail closed');
  assert(typeof result.error === 'string' && result.error.length > 0, 'error message present');
  const after = usage.getUsageReport().windows.today.requests;
  assert.strictEqual(after, before + 1, 'exactly one row logged for the routed request');
  ok('routeMultiModel still fails closed and logs exactly one row for the request');

  // 8. Mock/test calls are not logged
  const beforeMock = usage.getUsageReport().windows.today.requests;
  await routeMultiModel({ prompt: 'mock call', task: 'test', isTest: true });
  assert.strictEqual(usage.getUsageReport().windows.today.requests, beforeMock, 'test calls are not logged');
  ok('test calls are not logged');

  // 9. Savings page renders and escapes task names
  usage.recordUsage({ task: '<script>alert(1)</script>', provider: 'gemini', model: 'gemini-3.5-flash-lite', tier: 'cheap', status: 'success', inputTokens: 10, outputTokens: 10 }, dbNow);
  const html = renderSavingsPage(usage.getUsageReport(dbNow));
  assert(html.includes('Router savings'), 'page title');
  assert(!html.includes('<script>alert(1)</script>'), 'task name must be escaped');
  assert(html.includes('&lt;script&gt;'), 'escaped task name present');
  ok('savings page renders with escaped task names');

  console.log(`\n✅ ${passed} router usage tests passed\n`);
}

run()
  .catch((err) => {
    console.error('\n❌ Router usage test failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  });
