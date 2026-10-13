'use strict';

/**
 * test_failover_real.js
 * Verification of Multi-Provider AI Failover with Cheap-First Ordering.
 * 
 * Verifies:
 * 1. Cheap-First Chain Ordering:
 *    Gemini Flash-Lite -> OpenRouter -> GPT-4o-mini -> Claude Haiku
 * 2. Real Request on Primary Provider (Gemini Flash-Lite):
 *    Executes live request, records measured tokens and real costs, logs provider.
 * 3. Forced Failure on Primary (503 / 429 / Timeout):
 *    Forces failure on Gemini primary, proves automatic cascade and successful
 *    completion through the backup provider, logging which provider served each request.
 * 4. Dry run connectivity probe audit for all configured providers.
 */

const assert = require('assert');
const {
  routeMultiModel,
  getRouterStatus,
  setMockDispatcher,
  resetMockDispatcher,
  probeProvider,
  PROVIDER_MODELS,
  routerTelemetry
} = require('./lib/multiModelRouter');

async function runFailoverVerification() {
  console.log('===================================================================');
  console.log('  REAL AI FAILOVER ENGINE VERIFICATION                             ');
  console.log('===================================================================\n');

  // -----------------------------------------------------------------
  // Part 1: Verify Configured Active Chain & Cheap-First Ordering
  // -----------------------------------------------------------------
  console.log('[Part 1] Auditing Router Active Chain & Cheap-First Hierarchy...');
  const status = getRouterStatus();
  console.log('  -> Active Chain:', status.activeChain);
  console.log('  -> Primary Provider:', status.primaryProvider);
  console.log('  -> Secondary Provider:', status.secondaryProvider);
  console.log('  -> Tertiary Provider:', status.tertiaryProvider);
  console.log('  -> Configured Providers in pool:', JSON.stringify(status.configuredProviders));

  assert.strictEqual(status.primaryProvider, 'gemini-3.5-flash-lite', 'Primary provider must be gemini-3.5-flash-lite');
  assert.strictEqual(status.secondaryProvider, 'google/gemini-3.5-flash-lite', 'Secondary provider must be OpenRouter cheap model');
  assert.strictEqual(status.tertiaryProvider, 'gpt-4o-mini', 'Tertiary provider must be OpenAI gpt-4o-mini');
  assert(status.activeChain.startsWith('gemini (cheap) -> openrouter (cheap) -> openai (cheap) -> claude (cheap)'),
    'Active chain must start with Gemini -> OpenRouter -> OpenAI -> Claude');
  console.log('  ✅ PASS: Cheap-first hierarchy strictly verified.\n');

  // -----------------------------------------------------------------
  // Part 2: Live Request on Primary Provider (Gemini Flash-Lite)
  // -----------------------------------------------------------------
  console.log('[Part 2] Executing live prompt through Primary Provider (Gemini Flash-Lite)...');
  const livePrimary = await routeMultiModel({
    prompt: 'Reply with the single word VERIFIED.',
    task: 'ROUTING',
    mock: false
  });

  console.log('  -> Success:', livePrimary.success);
  console.log('  -> Provider that served request:', livePrimary.provider);
  console.log('  -> Model:', livePrimary.model);
  console.log('  -> Output snippet:', livePrimary.output.trim());
  console.log('  -> Latency:', livePrimary.latencyMs, 'ms');
  console.log('  -> Measured Tokens:', JSON.stringify(livePrimary.tokens));
  console.log('  -> Measured Cost USD:', livePrimary.cost?.actualCostUSD !== undefined ? `$${livePrimary.cost.actualCostUSD}` : 'N/A');

  assert.strictEqual(livePrimary.success, true, 'Live primary dispatch must succeed');
  assert.strictEqual(livePrimary.provider, 'gemini', 'Primary request must be served by gemini');
  assert(['gemini-3.5-flash-lite', 'gemini-3.8-flash'].includes(livePrimary.model), 'Model must be a valid Gemini model');
  assert(livePrimary.output.includes('VERIFIED'), 'Output should contain response from Gemini');
  console.log('  ✅ PASS: Live primary dispatch completed successfully.\n');

  // -----------------------------------------------------------------
  // Part 3: Force Failure on Primary (503 Service Unavailable)
  // Prove Automatic Failover & Request Completion via Backup Provider
  // -----------------------------------------------------------------
  console.log('[Part 3] Forcing 503 outage on primary (Gemini) to verify automatic failover...');
  const recordedDispatches = [];

  setMockDispatcher(async ({ provider, tier, model, prompt, task }) => {
    recordedDispatches.push({ provider, tier, model });
    if (provider === 'gemini') {
      const err = new Error('Google Cloud 503 Service Unavailable: upstream overloaded');
      err.status = 503;
      throw err;
    }
    // Backup provider processes the request
    return {
      text: `[${provider.toUpperCase()} BACKUP RESPONSE] Successfully fulfilled prompt after primary outage. Query: "${prompt.slice(0, 30)}..."`,
      inputTokens: 140,
      outputTokens: 45
    };
  });

  const failoverResult = await routeMultiModel({
    prompt: 'Emergency dispatch: generate white-label sales desk pitch',
    task: 'COPYWRITING',
    mock: true
  });

  resetMockDispatcher();

  console.log('  -> Failover Success:', failoverResult.success);
  console.log('  -> Provider that served request:', failoverResult.provider);
  console.log('  -> Model that served request:', failoverResult.model);
  console.log('  -> Output snippet:', failoverResult.output.slice(0, 80));
  console.log('  -> Total Latency:', failoverResult.latencyMs, 'ms');
  console.log('  -> Recorded Attempts:', JSON.stringify(failoverResult.attempts));

  assert.strictEqual(failoverResult.success, true, 'Failover request must succeed through backup');
  assert.strictEqual(failoverResult.attempts.length, 1, 'Must have recorded 1 failed primary attempt');
  assert.strictEqual(failoverResult.attempts[0].provider, 'gemini', 'First failed attempt must be gemini');
  assert.strictEqual(failoverResult.attempts[0].status, 503, 'Failed attempt status must be 503');
  assert.strictEqual(failoverResult.provider, 'openrouter', 'Backup provider must be openrouter (2nd in cheap chain)');
  console.log('  ✅ PASS: Primary failure forced (503); request completed through backup (openrouter).\n');

  // -----------------------------------------------------------------
  // Part 4: Force Timeout / 429 on Primary & OpenRouter to test chain depth
  // -----------------------------------------------------------------
  console.log('[Part 4] Forcing cascade across multiple providers (Gemini 429 + OpenRouter Timeout -> OpenAI)...');
  setMockDispatcher(async ({ provider, tier, model, prompt }) => {
    if (provider === 'gemini') {
      const err = new Error('Gemini 429 RESOURCE_EXHAUSTED: rate limit exceeded');
      err.status = 429;
      throw err;
    }
    if (provider === 'openrouter') {
      const err = new Error('OpenRouter 504 Gateway Timeout');
      err.status = 504;
      throw err;
    }
    return {
      text: `[${provider.toUpperCase()} RESPONSE] Tertiary fallback successful.`,
      inputTokens: 110,
      outputTokens: 35
    };
  });

  const multiFailover = await routeMultiModel({
    prompt: 'Multi-hop failover verification',
    task: 'ROUTING',
    mock: true
  });

  resetMockDispatcher();

  console.log('  -> Multi-hop Success:', multiFailover.success);
  console.log('  -> Provider that served request:', multiFailover.provider);
  console.log('  -> Model that served request:', multiFailover.model);
  console.log('  -> Attempts sequence:', multiFailover.attempts.map(a => `${a.provider}:${a.status}`).join(' -> '));

  assert.strictEqual(multiFailover.success, true);
  assert.strictEqual(multiFailover.provider, 'openai', 'Tertiary provider must be openai (gpt-4o-mini)');
  assert.strictEqual(multiFailover.attempts.length, 2, 'Should record 2 failed attempts before succeeding');
  assert.strictEqual(multiFailover.attempts[0].provider, 'gemini');
  assert.strictEqual(multiFailover.attempts[0].status, 429);
  assert.strictEqual(multiFailover.attempts[1].provider, 'openrouter');
  assert.strictEqual(multiFailover.attempts[1].status, 504);
  console.log('  ✅ PASS: Multi-hop cascade (Gemini 429 -> OpenRouter 504 -> OpenAI 200 OK) verified.\n');

  // -----------------------------------------------------------------
  // Part 5: Audit Live Probe Status of Current Environment
  // -----------------------------------------------------------------
  console.log('[Part 5] Auditing live environment key reachability probes...');
  const geminiProbe = await probeProvider('gemini', process.env.GEMINI_API_KEY);
  const openrouterProbe = await probeProvider('openrouter', process.env.OPENROUTER_API_KEY);

  console.log(`  -> Gemini Probe: Status=${geminiProbe.status}, Reachable=${geminiProbe.reachable}, Latency=${geminiProbe.latencyMs}ms`);
  console.log(`  -> OpenRouter Probe: Status=${openrouterProbe.status}, Reachable=${openrouterProbe.reachable}, Latency=${openrouterProbe.latencyMs}ms${openrouterProbe.error ? ` (${openrouterProbe.error})` : ''}`);

  console.log('\n===================================================================');
  console.log('  🎉 ALL REAL AI FAILOVER VERIFICATIONS PASSED (100% OK)            ');
  console.log('===================================================================\n');
}

runFailoverVerification().catch(err => {
  console.error('❌ Failover verification failed:', err);
  process.exit(1);
});
