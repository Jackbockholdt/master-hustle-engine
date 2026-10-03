/**
 * test_token_governance.js
 * Automated Verification Suite for Token Governance & Metric Isolation
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

let spawnedServer = null;
const TEST_ROUTER_KEY = process.env.ROUTER_API_KEYS || 'test-router-key';
process.env.ROUTER_API_KEYS = TEST_ROUTER_KEY;

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': TEST_ROUTER_KEY,
      ...headers
    };
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const testPort = parseInt(process.env.TEST_PORT || process.env.PORT || 3005, 10);
    const req = http.request({
      hostname: '127.0.0.1',
      port: testPort,
      path: path,
      method: method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw: data, parseError: e.message });
        }
      });
    });

    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureServerRunning() {
  try {
    const test = await makeRequest('GET', '/api/health');
    if (test.statusCode === 200) return;
  } catch (e) {}

  const targetPort = process.env.PORT || '3005';
  console.log(`[Test Setup] Starting local server on port ${targetPort}...`);
  process.env.PORT = targetPort;
  
  // Start server as child process
  spawnedServer = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: targetPort, ROUTER_API_KEYS: TEST_ROUTER_KEY },
    stdio: 'ignore'
  });

  // Poll until ready
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await makeRequest('GET', '/api/health');
      if (res.statusCode === 200) {
        console.log('[Test Setup] Server ready on port 3005.\n');
        return;
      }
    } catch (e) {}
  }
}

async function runVerificationSuite() {
  await ensureServerRunning();

  console.log("===================================================================");
  console.log("  TOKEN GOVERNANCE & METRIC ISOLATION VERIFICATION SUITE");
  console.log("===================================================================");

  const checklist = {
    rule1_flash_background_telemetry: false,
    rule2_low_cost_outreach_copy: false,
    rule3_flagship_blocked_automated: false,
    rule3_flagship_authorized_human: false,
    rule4_sandbox_isolation_verified: false
  };

  const expectedFlash = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const expectedFlagship = process.env.GEMINI_FLAGSHIP_MODEL || 'gemini-2.5-pro';

  // Test 0: Single Source of Truth Router Endpoint (/api/model/route)
  console.log("\n[Test 0] Testing /api/model/route Single Source of Truth...");
  const routeFlashRes = await makeRequest('POST', '/api/model/route', { taskType: 'BACKGROUND_TASK' });
  if (routeFlashRes.statusCode === 200 && (routeFlashRes.data.selectedModel === expectedFlash || routeFlashRes.data.tier === 'FLASH_BUDGET')) {
    console.log(`  ✅ PASS: /api/model/route correctly assigned Flash tier (${routeFlashRes.data.selectedModel}) for automated background task.`);
  }

  const routeCopyRes = await makeRequest('POST', '/api/model/route', { taskType: 'OUTREACH_COPY_GENERATION' });
  if (routeCopyRes.statusCode === 200 && (routeCopyRes.data.selectedModel === expectedFlash || routeCopyRes.data.tier === 'LOW_COST_FALLBACK')) {
    console.log("  ✅ PASS: /api/model/route correctly assigned Low-Cost Fallback path for copy generation.");
    checklist.rule2_low_cost_outreach_copy = true;
  }

  const routeFlagshipBlocked = await makeRequest('POST', '/api/model/route', {
    taskType: 'BACKGROUND_TASK',
    requestedModel: expectedFlagship,
    humanTriggered: false
  });
  if (routeFlagshipBlocked.statusCode === 403 && routeFlagshipBlocked.data.error === 'ERR_FLAGSHIP_RESTRICTED_TO_HUMAN') {
    console.log("  ✅ PASS: /api/model/route correctly blocked automated flagship attempt with HTTP 403.");
  }

  // Test 1: Telemetry & Background Routing to Flash Tier
  console.log("\n[Test 1] Testing /api/telemetry background governance...");
  const telRes = await makeRequest('GET', '/api/telemetry');
  if (telRes.statusCode === 200 && (telRes.data.tokenGovernance?.telemetryModel === expectedFlash || telRes.data.tokenGovernance?.telemetryModel?.includes('flash'))) {
    console.log(`  ✅ PASS: Telemetry routed through ${telRes.data.tokenGovernance.telemetryModel} (${telRes.data.tokenGovernance.efficiencyPct} efficiency).`);
    checklist.rule1_flash_background_telemetry = true;
  } else {
    console.log("  ❌ FAIL: Telemetry routing unexpected:", telRes.data);
  }

  // Test 2: Webhook Lead Scoring Routing to Flash Tier
  console.log("\n[Test 2] Testing /webhook/lead automated lead scoring...");
  const leadRes = await makeRequest('POST', '/webhook/lead', {
    company: "Test Verification Co",
    email: "verify@testco.com"
  });
  if (leadRes.statusCode === 200 && (leadRes.data.tokenGovernance?.selectedModel === expectedFlash || leadRes.data.tokenGovernance?.selectedModel?.includes('flash'))) {
    console.log("  ✅ PASS: Lead scoring check routed through Flash Budget Tier.");
  } else {
    console.log("  ❌ FAIL: Lead webhook routing unexpected:", leadRes.data);
  }

  // Test 3: Flagship Endpoint Blocked on Automated Request (HTTP 403)
  console.log("\n[Test 3] Testing /api/generate-sales-copy WITHOUT humanTriggered flag...");
  const blockRes = await makeRequest('POST', '/api/generate-sales-copy', {
    humanTriggered: false,
    requestedModel: expectedFlagship,
    taskType: "MANUAL_SALES_COPY"
  });
  if (blockRes.statusCode === 403 && blockRes.data.error === 'ERR_FLAGSHIP_RESTRICTED_TO_HUMAN') {
    console.log("  ✅ PASS: Blocked automated request to Flagship Pro model with HTTP 403 Forbidden.");
    checklist.rule3_flagship_blocked_automated = true;
  } else {
    console.log("  ❌ FAIL: Automated flagship call was not blocked:", blockRes);
  }

  // Test 4: Flagship Endpoint Allowed on Verified Human Trigger
  console.log("\n[Test 4] Testing /api/generate-sales-copy WITH humanTriggered=true...");
  const allowRes = await makeRequest('POST', '/api/generate-sales-copy', {
    humanTriggered: true,
    requestedModel: expectedFlagship,
    taskType: "MANUAL_SALES_COPY"
  });
  if (allowRes.statusCode === 200 && allowRes.data.success === true && (allowRes.data.humanAuthorized === true || allowRes.data.humanTriggeredVerified === true)) {
    console.log(`  ✅ PASS: Authorized human-triggered request executed on ${allowRes.data.modelUsed}.`);
    checklist.rule3_flagship_authorized_human = true;
  } else {
    console.log("  ❌ FAIL: Human-triggered flagship call failed:", allowRes);
  }

  // Test 5: Metric Store Isolation (Sandbox vs Production)
  console.log("\n[Test 5] Auditing strict data isolation (Production Receipts vs Sandbox Tests)...");
  const metricsRes = await makeRequest('GET', '/api/telemetry');
  const prod = metricsRes.data.productionMetrics;
  const sandbox = metricsRes.data.sandboxTestMetrics;

  console.log("  -> Production Revenue:", prod?.pipelineRevenue);
  console.log("  -> Production Verified Opens:", prod?.opens);
  console.log("  -> Production Status:", prod?.status);
  console.log("  -> Sandbox Total Runs:", sandbox?.totalTestRuns);

  if (prod?.pipelineRevenue === 0 && prod?.opens === 0 && prod?.status === "STANDBY_PRE_REVENUE") {
    console.log("  ✅ PASS: Production store is 100% clean, verified, and uncorrupted by synthetic test data.");
    checklist.rule4_sandbox_isolation_verified = true;
  } else {
    console.log("  ❌ FAIL: Production metrics contain fabricated or simulated values!");
  }

  // Final Audit Summary
  console.log("\n===================================================================");
  console.log("  AUDIT SUMMARY");
  console.log("===================================================================");
  console.log("  Rule 1 (Flash Background Telemetry):", checklist.rule1_flash_background_telemetry ? "PASSED" : "FAILED");
  console.log("  Rule 2 (Low-Cost Outreach Copy):   ", checklist.rule2_low_cost_outreach_copy ? "PASSED" : "FAILED");
  console.log("  Rule 3 (Flagship Blocked Auto):     ", checklist.rule3_flagship_blocked_automated ? "PASSED" : "FAILED");
  console.log("  Rule 3b (Flagship Allowed Human):   ", checklist.rule3_flagship_authorized_human ? "PASSED" : "FAILED");
  console.log("  Rule 4 (Data Isolation Clean):      ", checklist.rule4_sandbox_isolation_verified ? "PASSED" : "FAILED");
  console.log("===================================================================\n");

  if (spawnedServer) {
    spawnedServer.kill();
  }

  const allPassed = Object.values(checklist).every(v => v === true);
  if (!allPassed) {
    console.error("❌ Verification failed: Not all governance rules passed.");
    process.exit(1);
  }

  console.log("🎉 ALL TOKEN GOVERNANCE RULES VERIFIED SUCCESSFULLY.");
}

runVerificationSuite().catch(err => {
  if (spawnedServer) spawnedServer.kill();
  console.error("❌ Unhandled verification error:", err);
  process.exit(1);
});
