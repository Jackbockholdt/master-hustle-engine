const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

function makeRequest(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3005,
      path: path,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', err => reject(err));
    req.end();
  });
}

async function run() {
  console.log('===================================================================');
  console.log('  TESTING /health & /admin/status ROUTES LOCALLY (PORT 3005)');
  console.log('===================================================================');

  let serverProcess = null;
  
  // Check if server is already running on port 3005
  let running = false;
  try {
    const check = await makeRequest('/health');
    if (check.statusCode === 200) running = true;
  } catch (e) {}

  if (!running) {
    console.log('[Setup] Starting server.js on port 3005...');
    serverProcess = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: '3005' },
      stdio: 'pipe'
    });

    // Wait for server to come up
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const check = await makeRequest('/health');
        if (check.statusCode === 200) {
          console.log('[Setup] Server successfully started and responding on port 3005.\n');
          break;
        }
      } catch (e) {}
    }
  } else {
    console.log('[Setup] Server already running on port 3005.\n');
  }

  try {
    // 1. Test /health
    console.log('[Test 1] Testing GET /health (Unauthenticated 200 check)...');
    const healthRes = await makeRequest('/health');
    console.log(`  -> Status Code: ${healthRes.statusCode}`);
    console.log(`  -> Response:`, JSON.stringify(healthRes.data, null, 2));
    if (healthRes.statusCode !== 200 || healthRes.data.status !== 'HEALTHY') {
      throw new Error(`GET /health failed: expected 200 HEALTHY, got ${healthRes.statusCode}`);
    }
    console.log('  ✅ PASS: /health is lightweight and returned 200 OK.\n');

    // 2. Test /admin/status without ADMIN_KEY (Should return 401)
    console.log('[Test 2] Testing GET /admin/status WITHOUT admin key (Expect 401)...');
    const unauthorizedRes = await makeRequest('/admin/status');
    console.log(`  -> Status Code: ${unauthorizedRes.statusCode}`);
    console.log(`  -> Response:`, JSON.stringify(unauthorizedRes.data, null, 2));
    if (unauthorizedRes.statusCode !== 401) {
      throw new Error(`GET /admin/status should have rejected unauthorized request with 401, got ${unauthorizedRes.statusCode}`);
    }
    console.log('  ✅ PASS: /admin/status strictly rejected unauthenticated request with 401 Unauthorized.\n');

    // 3. Test /admin/status with correct ADMIN_KEY (Should return 200 with full telemetry)
    const adminKey = process.env.ADMIN_KEY || 'master-hustle-admin-secret-2026';
    console.log(`[Test 3] Testing GET /admin/status WITH admin key (?key=${adminKey})...`);
    const adminRes = await makeRequest(`/admin/status?key=${adminKey}`);
    console.log(`  -> Status Code: ${adminRes.statusCode}`);
    console.log(`  -> Response:`, JSON.stringify(adminRes.data, null, 2));

    if (adminRes.statusCode !== 200) {
      throw new Error(`GET /admin/status returned status ${adminRes.statusCode}`);
    }

    const { telemetry, outboundQueue, dailySendCounter, failoverRouter } = adminRes.data;

    // Assert telemetry
    if (!telemetry || typeof telemetry.uptimeSeconds !== 'number' || !telemetry.memoryUsageMB) {
      throw new Error('Telemetry payload missing or invalid structure');
    }
    console.log('  ✅ True System Telemetry verified.');

    // Assert outboundQueue
    if (!outboundQueue || typeof outboundQueue.totalQueued !== 'number' || !outboundQueue.stageCounts) {
      throw new Error('Outbound queue status missing or invalid structure');
    }
    console.log('  ✅ Outbound Queue Status verified.');

    // Assert dailySendCounter
    if (!dailySendCounter || typeof dailySendCounter.dailyLimit !== 'number' || typeof dailySendCounter.sentToday !== 'number') {
      throw new Error('Daily send counter missing or invalid structure');
    }
    console.log('  ✅ Daily Send Counter verified.');

    // Assert failoverRouter
    if (!failoverRouter || !failoverRouter.activeChain || failoverRouter.fallbackProviders.includes('grok')) {
      throw new Error('Failover router health missing or still contains grok');
    }
    console.log(`  ✅ Failover Router Health verified (Active chain: ${failoverRouter.activeChain}).`);

    // Assert inboxTriage
    const { inboxTriage } = adminRes.data;
    if (!inboxTriage || !inboxTriage.status || typeof inboxTriage.pendingDraftsCount !== 'number' || !inboxTriage.triagedBreakdown) {
      throw new Error('Inbox triage telemetry missing or invalid structure in /admin/status');
    }
    console.log(`  ✅ Inbound Triage & Circuit Breaker Telemetry verified (Pending drafts: ${inboxTriage.pendingDraftsCount}, Circuit breakers: ${inboxTriage.circuitBreakersTripped}).`);

    console.log('\n===================================================================');
    console.log('  ALL ROUTE AND TELEMETRY TESTS PASSED (HTTP 200 OK)');
    console.log('===================================================================\n');

  } finally {
    if (serverProcess) {
      console.log('[Teardown] Stopping local test server process...');
      serverProcess.kill('SIGTERM');
    }
  }
}

run().catch(err => {
  console.error('❌ Verification Error:', err.message);
  process.exit(1);
});
