const https = require('https');

const TOKEN = '7iW0CwlQOqDtz5sRPdeCTuw7NzMgJGqXaN5ZmCyF39416933';

function req(hostname, path) {
  return new Promise((resolve) => {
    const r = https.request({
      hostname: hostname,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[${hostname}${path}] HTTP ${res.statusCode}`);
        if (data.length < 500) console.log(data);
        else console.log(data.substring(0, 300) + '...');
        resolve();
      });
    });
    r.on('error', err => {
      console.log(`[${hostname}${path}] ERR: ${err.message}`);
      resolve();
    });
    r.end();
  });
}

async function test() {
  await req('developers.hostinger.com', '/api/hosting/v1/accounts');
  await req('developers.hostinger.com', '/api/vps/v1/virtual-machines');
  await req('developers.hostinger.com', '/api/domains/v1/domains');
}

test();
