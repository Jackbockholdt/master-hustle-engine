const https = require('https');

const TOKEN = '7iW0CwlQOqDtz5sRPdeCTuw7NzMgJGqXaN5ZmCyF39416933';

function req(path) {
  return new Promise((resolve) => {
    const r = https.request({
      hostname: 'developers.hostinger.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[${path}] HTTP ${res.statusCode}: ${data.substring(0, 200)}`);
        resolve();
      });
    });
    r.on('error', err => resolve());
    r.end();
  });
}

async function test() {
  await req('/api/dns/v1/zones');
  await req('/api/dns/v1/records');
  await req('/api/billing/v1/services');
  await req('/api/websites/v1/websites');
  await req('/api/mail/v1/mailboxes');
  await req('/api/vps/v1/virtual-machines');
}

test();
