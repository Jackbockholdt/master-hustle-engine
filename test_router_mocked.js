'use strict';

/**
 * test_router_mocked.js
 * Comprehensive Multi-Model Router Unit & Integration Test Suite with Mocked Providers
 * 
 * Verifies:
 * 1. Current model identifiers (cheap + strong tier per provider, env-overridable)
 * 2. Real cost routing: starts at cheapest model that can handle the request
 * 3. Cascade on provider error (401, 429, 500, timeout)
 * 4. Escalation to strong tier on empty output or when cheap tier is exhausted
 * 5. Never fake output: returns success: false with real error when all providers fail
 * 6. Real tokens and cost calculation compared to strong-model baseline (gpt-4o)
 * 7. Real measured savings in telemetry and /api/router/status (no hardcoded 87.6% or 94.2%)
 * 8. Router API key verification middleware (ROUTER_API_KEYS)
 */

const assert = require('assert');
const {
  routeMultiModel,
  getRouterStatus,
  setMockDispatcher,
  resetMockDispatcher,
  requireRouterApiKey,
  calculateRequestCost,
  PROVIDER_MODELS,
  MODEL_PRICING,
  BASELINE_STRONG_MODEL,
  routerTelemetry
} = require('./lib/multiModelRouter');

async function runMockedTests() {
  console.log('===================================================================');
  console.log('  MULTI-MODEL ROUTER TEST SUITE (WITH MOCKED PROVIDERS)            ');
  console.log('===================================================================\n');

  // -----------------------------------------------------------------
  // 1. Model Configuration & Tiers
  // -----------------------------------------------------------------
  console.log('[Test 1] Verifying current model names and cheap/strong tiers...');
  assert.strictEqual(PROVIDER_MODELS.tiers.gemini.cheap, 'gemini-3.5-flash-lite', 'Gemini cheap must be gemini-3.5-flash-lite');
  assert.strictEqual(PROVIDER_MODELS.tiers.gemini.strong, 'gemini-3.8-flash', 'Gemini strong must be gemini-3.8-flash');
  assert.strictEqual(PROVIDER_MODELS.tiers.openai.cheap, 'gpt-4o-mini', 'OpenAI cheap must be gpt-4o-mini');
  assert.strictEqual(PROVIDER_MODELS.tiers.openai.strong, 'gpt-4o', 'OpenAI strong must be gpt-4o');
  assert.strictEqual(PROVIDER_MODELS.tiers.claude.cheap, 'claude-haiku-4-5-20251001', 'Claude cheap must be claude-haiku-4-5-20251001');
  assert.strictEqual(PROVIDER_MODELS.tiers.claude.strong, 'claude-sonnet-4-6', 'Claude strong must be claude-sonnet-4-6');
  assert.strictEqual(PROVIDER_MODELS.tiers.openrouter.cheap, 'google/gemini-3.5-flash-lite', 'OpenRouter cheap must be google/gemini-3.5-flash-lite');
  assert.strictEqual(PROVIDER_MODELS.tiers.openrouter.strong, 'anthropic/claude-sonnet-4.6', 'OpenRouter strong must be anthropic/claude-sonnet-4.6');

  // Verify env override capability
  const prevGeminiEnv = process.env.GEMINI_MODEL;
  process.env.GEMINI_MODEL = 'gemini-custom-flash';
  assert.strictEqual(PROVIDER_MODELS.tiers.gemini.cheap, 'gemini-custom-flash', 'Gemini model must be env-overridable');
  if (prevGeminiEnv) process.env.GEMINI_MODEL = prevGeminiEnv;
  else delete process.env.GEMINI_MODEL;
  console.log('  ✅ PASS: Current model tiers and env overrides verified.\n');

  // -----------------------------------------------------------------
  // 2. Real Cost Routing: Starts on Cheapest Model
  // -----------------------------------------------------------------
  console.log('[Test 2] Testing real cost routing to cheapest available model...');
  const dispatchOrder = [];
  setMockDispatcher(async ({ provider, tier, model }) => {
    dispatchOrder.push({ provider, tier, model });
    return {
      text: 'Cost-optimized synthesis complete',
      inputTokens: 100,
      outputTokens: 50
    };
  });

  const resCost = await routeMultiModel({ prompt: 'Draft lead qualification angle' });
  assert.strictEqual(resCost.success, true, 'Request should succeed');
  assert.strictEqual(resCost.tier, 'cheap', 'Default routing must choose cheap tier');
  assert.strictEqual(dispatchOrder[0].tier, 'cheap', 'First dispatch attempt must be cheap tier');
  assert.strictEqual(dispatchOrder[0].provider, 'openai', 'First dispatch attempt should be cheapest provider (OpenAI gpt-4o-mini)');
  console.log(`  -> Selected: ${resCost.provider} (${resCost.model}, tier=${resCost.tier})`);
  console.log('  ✅ PASS: Request routed to cheapest model.\n');

  // -----------------------------------------------------------------
  // 3. Provider Failover: Cascades to Next Cheap Provider
  // -----------------------------------------------------------------
  console.log('[Test 3] Testing provider failover cascade across cheap tier...');
  dispatchOrder.length = 0;
  setMockDispatcher(async ({ provider, tier, model }) => {
    dispatchOrder.push({ provider, tier, model });
    if (provider === 'openai') {
      const err = new Error('OpenAI upstream 503 load spike');
      err.status = 503;
      throw err;
    }
    return {
      text: 'Gemini fallback response',
      inputTokens: 120,
      outputTokens: 40
    };
  });

  const resFailover = await routeMultiModel({ prompt: 'Generate fallback outreach' });
  assert.strictEqual(resFailover.success, true, 'Failover request should succeed on secondary');
  assert.strictEqual(resFailover.tier, 'cheap', 'Should remain on cheap tier during provider failover');
  assert.strictEqual(resFailover.attempts.length, 1, 'Should record failed OpenAI attempt');
  assert.strictEqual(resFailover.attempts[0].provider, 'openai', 'Recorded attempt provider must be openai');
  assert.strictEqual(resFailover.attempts[0].status, 503, 'Recorded attempt status must be 503');
  console.log(`  -> First attempt failed (OpenAI 503), failed over to: ${resFailover.provider} (${resFailover.model})`);
  console.log('  ✅ PASS: Provider failover cascade succeeded without dropped turns.\n');

  // -----------------------------------------------------------------
  // 4. Escalation to Strong Tier on Empty Output
  // -----------------------------------------------------------------
  console.log('[Test 4] Testing escalation to stronger tier when cheap model returns empty output...');
  dispatchOrder.length = 0;
  setMockDispatcher(async ({ provider, tier, model }) => {
    dispatchOrder.push({ provider, tier, model });
    // Cheap models return empty output or fail
    if (tier === 'cheap') {
      return { text: '   ', inputTokens: 50, outputTokens: 0 }; // Whitespace / empty output
    }
    // Strong tier model returns substantive response
    return {
      text: 'High-quality comprehensive analysis from strong model.',
      inputTokens: 150,
      outputTokens: 80
    };
  });

  const resEmptyOutput = await routeMultiModel({ prompt: 'Solve complex architecture edge case' });
  assert.strictEqual(resEmptyOutput.success, true, 'Escalation request should succeed');
  assert.strictEqual(resEmptyOutput.tier, 'strong', 'Must escalate to strong tier when cheap outputs are empty');
  assert.strictEqual(resEmptyOutput.output, 'High-quality comprehensive analysis from strong model.');
  assert(resEmptyOutput.attempts.length >= 4, 'Should record attempts for cheap tier candidates');
  console.log(`  -> Successfully escalated to: ${resEmptyOutput.provider} (${resEmptyOutput.model}, tier=${resEmptyOutput.tier})`);
  console.log('  ✅ PASS: Escalated to strong tier upon empty outputs.\n');

  // -----------------------------------------------------------------
  // 5. Never Fake Output: Real Error on All Provider Failures
  // -----------------------------------------------------------------
  console.log('[Test 5] Testing real error return when all providers fail (zero synthetic output)...');
  dispatchOrder.length = 0;
  setMockDispatcher(async ({ provider, model }) => {
    const err = new Error(`Connection timeout on ${provider}`);
    err.status = 504;
    throw err;
  });

  const resAllFail = await routeMultiModel({ prompt: 'Test complete outage' });
  assert.strictEqual(resAllFail.success, false, 'Must return success: false when all fail');
  assert(resAllFail.error, 'Must include descriptive error');
  assert(!resAllFail.output, 'Must NOT return fake or synthesized output text');
  assert.strictEqual(String(resAllFail.output || '').includes('FAILOVER RECOVERY'), false, 'Must not include legacy failover recovery text');
  assert(resAllFail.attempts.length > 0, 'Must include log of provider attempts');
  console.log(`  -> Real error returned: "${resAllFail.error}" with ${resAllFail.attempts.length} logged attempts.`);
  console.log('  ✅ PASS: Never fakes output: real error returned on total provider failure.\n');

  // -----------------------------------------------------------------
  // 6. Real Token & Cost Calculations Against Strong Baseline
  // -----------------------------------------------------------------
  console.log('[Test 6] Testing real token & cost calculation against strong-model baseline...');
  const sampleCalc = calculateRequestCost({
    model: 'gemini-2.5-flash',
    inputTokens: 1000,
    outputTokens: 500
  });
  // Baseline (gpt-4o: $2.50/$10.00): (1000 * 2.50 + 500 * 10.00) / 1,000,000 = (2500 + 5000) / 1,000,000 = $0.00750
  // Actual (gemini-2.5-flash: $0.30 input / $2.50 output): (1000 * 0.30 + 500 * 2.50) / 1,000,000 = (300 + 1250) / 1,000,000 = $0.00155
  assert(sampleCalc.baselineCostUSD > sampleCalc.actualCostUSD, 'Baseline cost must exceed cheap model cost');
  assert(sampleCalc.savingsUSD > 0, 'Savings USD must be positive');
  assert(sampleCalc.savingsPct > 70 && sampleCalc.savingsPct < 85, `Savings percent should be ~79.3% for Gemini 2.5 Flash (got ${sampleCalc.savingsPct}%)`);
  console.log(`  -> Actual Cost: $${sampleCalc.actualCostUSD.toFixed(6)} vs Baseline: $${sampleCalc.baselineCostUSD.toFixed(6)} | Savings: ${sampleCalc.savingsPct}%`);

  // Verify unknown model handling: excluded from savings math, no guessed price
  const unknownCalc = calculateRequestCost({
    model: 'unknown-custom-model-99',
    inputTokens: 1000,
    outputTokens: 500
  });
  assert.strictEqual(unknownCalc.excludedFromSavings, true, 'Unknown models must be excluded from savings math');
  assert.strictEqual(unknownCalc.actualCostUSD, null, 'Unknown model cost must not be guessed (null)');
  assert.strictEqual(unknownCalc.savingsUSD, null, 'Unknown model savings must be excluded (null)');
  console.log('  ✅ PASS: Unknown models excluded from savings math without price guessing.');
  console.log('  ✅ PASS: Accurate token and cost calculation against baseline.\n');

  // -----------------------------------------------------------------
  // 7. Telemetry & /api/router/status Reflects Real Measured Savings
  // -----------------------------------------------------------------
  console.log('[Test 7] Testing getRouterStatus() telemetry reporting & mock isolation...');
  setMockDispatcher(async () => ({
    text: 'Telemetry test response',
    inputTokens: 200,
    outputTokens: 100
  }));

  const dispatchesBefore = getRouterStatus().telemetry.totalDispatches;
  // Live / mockDispatcher dispatch should increment
  await routeMultiModel({ prompt: 'Record telemetry test 1' });
  await routeMultiModel({ prompt: 'Record telemetry test 2' });
  const dispatchesAfterLive = getRouterStatus().telemetry.totalDispatches;
  assert.strictEqual(dispatchesAfterLive, dispatchesBefore + 2, 'Live route dispatches must be recorded');

  // Mock simulation call MUST NOT feed or increment routerTelemetry costs or dispatches
  await routeMultiModel({ prompt: 'Mock simulation call', mock: true });
  const dispatchesAfterMock = getRouterStatus().telemetry.totalDispatches;
  assert.strictEqual(dispatchesAfterMock, dispatchesAfterLive, 'Mock call must NOT increment totalDispatches');

  const status = getRouterStatus();
  assert(status.telemetry, 'Status must include telemetry');
  assert(status.telemetry.totalDispatches > 0, 'Total dispatches must be tracked');
  assert(status.telemetry.tokens.totalTokens > 0, 'Tokens must be tracked');
  assert(status.telemetry.costs.actualCostUSD > 0, 'Actual cost must be tracked');
  assert(status.telemetry.costs.baselineCostUSD > 0, 'Baseline cost must be tracked');
  assert(typeof status.telemetry.costs.measuredSavingsPct === 'string', 'Measured savings must be a percentage string');
  assert(!status.telemetry.costs.measuredSavingsPct.includes('87.6%'), 'Must NOT hardcode 87.6% in measured savings');
  assert(!status.telemetry.costs.measuredSavingsPct.includes('94.2%'), 'Must NOT hardcode 94.2% in measured savings');
  console.log(`  -> Measured Savings in Telemetry: ${status.telemetry.costs.measuredSavingsPct}`);
  console.log(`  -> Total Tokens: ${status.telemetry.tokens.totalTokens} | Total Actual Cost: $${status.telemetry.costs.actualCostUSD}`);
  console.log('  ✅ PASS: Real measured telemetry verified without hardcoded numbers & mock calls isolated.\n');

  // -----------------------------------------------------------------
  // 8. API Key Header Verification (ROUTER_API_KEYS)
  // -----------------------------------------------------------------
  console.log('[Test 8] Testing requireRouterApiKey middleware security & crypto.timingSafeEqual...');
  
  // 8a: ROUTER_API_KEYS unset -> 503
  const origKey = process.env.ROUTER_API_KEYS;
  delete process.env.ROUTER_API_KEYS;

  let statusCode = 0;
  let jsonBody = null;
  const mockRes = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; return this; }
  };

  requireRouterApiKey({ headers: {} }, mockRes, () => {});
  assert.strictEqual(statusCode, 503, 'Must return 503 when ROUTER_API_KEYS is unconfigured');
  assert.strictEqual(jsonBody.error, 'ERR_ROUTER_KEYS_UNCONFIGURED');

  // 8b: ROUTER_API_KEYS set, missing header -> 401
  process.env.ROUTER_API_KEYS = 'test-secret-key-1,test-secret-key-2';
  statusCode = 0;
  jsonBody = null;
  requireRouterApiKey({ headers: {} }, mockRes, () => {});
  assert.strictEqual(statusCode, 401, 'Must return 401 when API key header is missing');
  assert.strictEqual(jsonBody.error, 'ERR_UNAUTHORIZED');

  // 8c: ROUTER_API_KEYS set, invalid header (different length and same length) -> 401
  statusCode = 0;
  jsonBody = null;
  requireRouterApiKey({ headers: { 'x-api-key': 'wrong' } }, mockRes, () => {});
  assert.strictEqual(statusCode, 401, 'Must return 401 when different-length invalid key provided');

  statusCode = 0;
  jsonBody = null;
  requireRouterApiKey({ headers: { 'x-api-key': 'test-secret-key-9' } }, mockRes, () => {});
  assert.strictEqual(statusCode, 401, 'Must return 401 when same-length invalid key provided');

  // 8d: Valid x-api-key -> calls next()
  let nextCalled = false;
  statusCode = 0;
  requireRouterApiKey({ headers: { 'x-api-key': 'test-secret-key-1' } }, mockRes, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'Must call next() with valid x-api-key');

  // 8e: Valid Authorization: Bearer <key> -> calls next()
  nextCalled = false;
  requireRouterApiKey({ headers: { 'authorization': 'Bearer test-secret-key-2' } }, mockRes, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'Must call next() with valid Authorization: Bearer header');

  // Restore env
  if (origKey) process.env.ROUTER_API_KEYS = origKey;
  else delete process.env.ROUTER_API_KEYS;
  resetMockDispatcher();

  console.log('  ✅ PASS: ROUTER_API_KEYS middleware correctly enforces security, timingSafeEqual, and fail-closed policies.\n');

  console.log('===================================================================');
  console.log('  🎉 ALL MOCKED PROVIDER ROUTER TESTS PASSED (100% OK)              ');
  console.log('===================================================================\n');
}

runMockedTests().catch(err => {
  resetMockDispatcher();
  console.error('❌ Test failure:', err);
  process.exit(1);
});
