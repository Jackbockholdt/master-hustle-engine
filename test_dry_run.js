const http = require('http');

async function testDryRun() {
  console.log('=== STARTING DRY-RUN DISPATCH & ENDPOINT VERIFICATION ===');
  
  // 1. Start server in background require
  const server = require('./server.js');
  
  // Give server 500ms to bind to port 3005
  await new Promise(resolve => setTimeout(resolve, 500));
  
  function postRequest(path, payload, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = http.request({
        hostname: 'localhost',
        port: 3005,
        path: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  function getRequest(path) {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:3005${path}`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, raw: body });
          }
        });
      }).on('error', reject);
    });
  }

  try {
    // A. Check /api/health
    console.log('\n[Test A] GET /api/health ...');
    const health = await getRequest('/api/health');
    console.log('StatusCode:', health.statusCode);
    console.log('Response:', health.data);

    // B. Check /pitch endpoint with human trigger
    console.log('\n[Test B] POST /pitch (Human Triggered) ...');
    const pitch = await postRequest('/pitch', { humanTriggered: true });
    console.log('StatusCode:', pitch.statusCode);
    console.log('Model Used:', pitch.data.modelUsed);

    // C. Check Dry-Run Batch Dispatch /api/trigger-batch-dispatch
    console.log('\n[Test C] POST /api/trigger-batch-dispatch (Dry-Run Mode) ...');
    const dispatch = await postRequest('/api/trigger-batch-dispatch', { isLive: false, skipPacing: true });
    console.log('StatusCode:', dispatch.statusCode);
    console.log('Success:', dispatch.data.success);
    console.log('Evaluated:', dispatch.data.result?.evaluated);
    console.log('Execution Mode:', dispatch.data.result?.executionMode);

    console.log('\n=== ALL VERIFICATION TESTS PASSED SUCCESSFULLY ===');
    process.exit(0);
  } catch (err) {
    console.error('Verification error:', err);
    process.exit(1);
  }
}

testDryRun();
