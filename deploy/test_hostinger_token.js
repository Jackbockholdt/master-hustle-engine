/**
 * test_hostinger_token.js
 */
const https = require('https');
const fs = require('fs');

const TOKEN = '7iW0CwlQOqDtz5sRPdeCTuw7NzMgJGqXaN5ZmCyF39416933';

function makeRequest(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.hostinger.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ path: urlPath, status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ path: urlPath, status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', err => resolve({ path: urlPath, error: err.message }));
    req.end();
  });
}

async function run() {
  const endpoints = [
    '/v1/vps',
    '/v1/domains',
    '/v1/dns/zones',
    '/v1/hosting/accounts',
    '/v1/webhooks',
    '/v2/vps',
    '/v2/domains'
  ];

  const results = [];
  for (const ep of endpoints) {
    const res = await makeRequest(ep);
    results.push(res);
  }

  fs.writeFileSync('hostinger_api_result.json', JSON.stringify(results, null, 2));
  console.log('Results saved to hostinger_api_result.json');
}

run();
