const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    }).on('error', reject);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(d) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: d });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function check() {
  const ts = new Date().toISOString().split('T')[1].slice(0, 8);
  try {
    const root = await get('https://master-hustle-engine.onrender.com/');
    const isHtml = root.body.includes('<!DOCTYPE html>');
    const has4000 = root.body.includes('4,000') || root.body.includes('4000');
    const has1500 = root.body.includes('1,500') || root.body.includes('1500');
    const has25k = root.body.includes('25,000') || root.body.includes('25000');
    const has2500 = root.body.includes('2,500') || root.body.includes('2500');
    const has497 = root.body.includes('497');
    const has199 = root.body.includes('199');
    const has4500 = root.body.includes('4,500') || root.body.includes('4500');
    const hasDemo = root.body.includes('/demo');

    const demo = await get('https://master-hustle-engine.onrender.com/demo');
    const isDemoV2 = demo.body.includes('Failover Console') || demo.body.includes('simulateOutage') || demo.body.includes('Queue & Guardrail Scrubber');

    console.log(`[${ts}] rootStatus=${root.status} isHtml=${isHtml} has4000=${has4000} has1500=${has1500} has2500=${has2500} has25k=${has25k} has497=${has497} has199=${has199} has4500=${has4500} hasDemo=${hasDemo} isDemoV2=${isDemoV2}`);

    if (isHtml && !has4000 && !has1500 && !has2500 && !has25k && has497 && has199 && has4500 && hasDemo && isDemoV2) {
      console.log('\n======================================================');
      console.log('  LIVE RENDER DEPLOYMENT CONFIRMED AND VERIFIED!');
      console.log('======================================================\n');

      // Test live failover endpoint
      console.log('Testing live failover endpoint...');
      const failoverRes = await postJson('https://master-hustle-engine.onrender.com/api/demo/failover', {
        prompt: 'Order #89211 return request empathy response',
        simulateOutage: true
      });
      console.log('Live Failover Result:', JSON.stringify(failoverRes, null, 2));

      // Test live queue scrubber
      console.log('Testing live queue scrubber endpoint...');
      const scrubRes = await postJson('https://master-hustle-engine.onrender.com/api/demo/scrub', {});
      console.log('Live Scrub Result:', JSON.stringify(scrubRes, null, 2));

      return true;
    }
  } catch (e) {
    console.log(`[${ts}] Error checking: ${e.message}`);
  }
  return false;
}

async function watch() {
  console.log('Watching https://master-hustle-engine.onrender.com until new deployment is live...');
  for (let i = 0; i < 30; i++) {
    const done = await check();
    if (done) process.exit(0);
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log('Watcher finished 30 cycles.');
  process.exit(1);
}

watch();
