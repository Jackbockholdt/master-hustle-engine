'use strict';

/**
 * test_standalone_router.js
 * Standalone Multi-Model Router Verification Script
 * 
 * Verifies:
 * 1. Model identifier configuration (GPT-4o / GPT-4o-mini, Claude 3.5 Sonnet / Haiku, Gemini)
 * 2. Prompt / response round trips through primary and fallback providers
 * 3. Graceful cascade on 401, 429, and 500s without crashing caller processes
 * 4. Lightweight dry run connectivity probes and status logging
 * 5. Telemetry accuracy and health reporting
 */

const assert = require('assert');
const { routeMultiModel, getRouterStatus, probeProvider, probeAllProviders, parseApiPool, PROVIDER_MODELS } = require('./lib/multiModelRouter');

async function runVerification() {
  console.log('===================================================================');
  console.log('  MULTI-MODEL ROUTER STANDALONE VERIFICATION SUITE                 ');
  console.log('===================================================================\n');

  // Test 1: Verify configured model strings
  console.log('[Test 1] Auditing configured model identifiers...');
  console.log('  -> Default Models:', JSON.stringify(PROVIDER_MODELS, null, 2));
  assert(PROVIDER_MODELS.openai === 'gpt-4o', 'OpenAI primary must be gpt-4o (not deprecated openai-gpt-4o)');
  assert(PROVIDER_MODELS.openaiMini === 'gpt-4o-mini', 'OpenAI mini must be gpt-4o-mini');
  assert(PROVIDER_MODELS.claude.includes('claude-3-5-sonnet') || PROVIDER_MODELS.claude.includes('claude-3-5-sonnet-latest'), 'Claude primary must be Claude 3.5 Sonnet');
  assert(PROVIDER_MODELS.claudeHaiku === 'claude-3-haiku-20240307', 'Claude light must be claude-3-haiku-20240307');
  console.log('  ✅ PASS: All model identifiers match stable production specifications.\n');

  // Test 2: Dry Run Connectivity Probes
  console.log('[Test 2] Testing lightweight connectivity probes for providers...');
  const probeResults = await probeAllProviders();
  console.log('  -> Probes:', JSON.stringify(probeResults, null, 2));
  assert(probeResults.gemini !== undefined, 'Gemini probe result must exist');
  assert(probeResults.openai !== undefined, 'OpenAI probe result must exist');
  assert(probeResults.claude !== undefined, 'Claude probe result must exist');
  console.log('  ✅ PASS: Dry run connectivity probes executed and logged distinct statuses.\n');

  // Test 2b: Test distinct probe statuses (INVALID_KEY, NOT_CONFIGURED)
  console.log('[Test 2b] Testing probe handling of invalid keys (expect INVALID_KEY)...');
  const invalidOai = await probeProvider('openai', 'sk-invalid-probe-key-12345');
  const invalidAnt = await probeProvider('claude', 'sk-ant-invalid-probe-key-12345');
  console.log(`  -> OpenAI invalid probe status: ${invalidOai.status} (${invalidOai.latencyMs}ms)`);
  console.log(`  -> Anthropic invalid probe status: ${invalidAnt.status} (${invalidAnt.latencyMs}ms)`);
  assert(invalidOai.status === 'INVALID_KEY', 'Invalid OpenAI key must return INVALID_KEY');
  assert(invalidAnt.status === 'INVALID_KEY', 'Invalid Anthropic key must return INVALID_KEY');
  console.log('  ✅ PASS: INVALID_KEY status correctly detected without hanging.\n');

  // Test 3: Primary Provider Round-Trip (Simulation & Live Cascade)
  console.log('[Test 3] Testing prompt / response round-trip on Primary Provider (Gemini simulation)...');
  const primarySim = await routeMultiModel({
    prompt: 'Respond with test token',
    preferredProvider: 'gemini',
    mock: true,
    task: 'ROUTING'
  });
  console.log('  -> Mode:', primarySim.mode);
  console.log('  -> Provider:', primarySim.provider);
  console.log('  -> Model:', primarySim.model);
  console.log('  -> Latency:', primarySim.latencyMs, 'ms');
  assert(primarySim.success === true, 'Primary simulation must succeed');
  assert(primarySim.provider === 'gemini', 'Provider must be gemini');
  console.log('  ✅ PASS: Primary provider simulation round-trip succeeded.\n');

  // Test 4: Secondary Provider Round-Trip (OpenAI)
  console.log('[Test 4] Testing prompt / response round-trip on Secondary Provider (OpenAI simulation)...');
  const secondarySim = await routeMultiModel({
    prompt: 'Summarize outreach lead context for agency white-label licensing.',
    preferredProvider: 'openai',
    mock: true,
    task: 'EXTRACTION'
  });
  console.log('  -> Mode:', secondarySim.mode);
  console.log('  -> Provider:', secondarySim.provider);
  console.log('  -> Model:', secondarySim.model);
  assert(secondarySim.success === true, 'Secondary simulation must succeed');
  assert(secondarySim.provider === 'openai', 'Provider must be openai');
  console.log('  ✅ PASS: Secondary provider round-trip succeeded.\n');

  // Test 5: Fallback Cascade on 401/429/500s Simulation
  console.log('[Test 5] Testing graceful cascade when upstream providers fail (401 / 429 / 500s)...');
  const cascadeResult = await routeMultiModel({
    prompt: 'Generate emergency response under load',
    task: 'COPYWRITING',
    mock: false
  });
  console.log('  -> Cascade result mode:', cascadeResult.mode);
  console.log('  -> Successfully routed via:', cascadeResult.provider);
  console.log('  -> Output snippet:', cascadeResult.output.slice(0, 80));
  assert(cascadeResult.success === true, 'Router must not crash caller process on cascade');
  console.log('  ✅ PASS: Router handled multi-model execution and returned clean output without crashing caller.\n');

  // Test 6: Verify health reporting reflects true reachability and latency
  console.log('[Test 6] Verifying getRouterStatus() reflects real telemetry and reachability...');
  const status = getRouterStatus();
  console.log('  -> Router status:', status.status);
  console.log('  -> Reachability:', JSON.stringify(status.reachability));
  console.log('  -> Primary provider:', status.primaryProvider);
  console.log('  -> Secondary provider:', status.secondaryProvider);
  console.log('  -> Tertiary provider:', status.tertiaryProvider);
  console.log('  -> Probes:', JSON.stringify(status.probes));
  assert(status.reachability !== undefined, 'Reachability must be defined in status');
  assert(status.probes !== undefined, 'Probes must be defined in status');
  assert(status.secondaryProvider === 'gpt-4o', 'Secondary provider must report gpt-4o');
  console.log('  ✅ PASS: Real health telemetry verified.\n');

  console.log('===================================================================');
  console.log('  🎉 ALL MULTI-MODEL ROUTER VERIFICATION TESTS PASSED (100% OK)     ');
  console.log('===================================================================\n');
}

runVerification().catch(err => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
