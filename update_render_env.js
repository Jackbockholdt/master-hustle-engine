const fs = require('fs');
const path = require('path');
const https = require('https');

const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.error('Error: .env file not found!');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w.\-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    let value = match[2] ? match[2].trim() : '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    env[match[1]] = value;
  }
});

const SERVICE_ID = 'srv-d8thrho0697c73clcvtgrk';
const RENDER_API_KEY = 'rnd_liv_5lTYNo6ByEzKyu8a4NMY6X3kpTx13PCU4LhLb1Z6uDh084BrIMqV4FCsQ608CwPJqEQQ5rh27KHG';

const variablesToUpload = [
  'GEMINI_API_KEY',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'GMAIL_HTTP_URL',
  'GMAIL_HTTP_KEY',
  'ADMIN_EMAIL',
  'PS_LINK'
];

const payload = variablesToUpload
  .filter(key => env[key] !== undefined)
  .map(key => ({ key, value: env[key] }));

console.log('[Render] Syncing environment variables to service srv-d8thrho0697c73clcvtgrk:', payload.map(p => p.key));

const putData = JSON.stringify(payload);
const putOptions = {
  hostname: 'api.render.com',
  path: `/v1/services/${SERVICE_ID}/env-vars`,
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${RENDER_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Content-Length': Buffer.byteLength(putData)
  }
};

const req = https.request(putOptions, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log(`[Render] Response Status: ${res.statusCode}`);
    if (res.statusCode === 200 || res.statusCode === 201) {
      console.log('[Render] ✅ Environment variables synced successfully!');
      
      // Step 2: Trigger redeploy
      console.log('[Render] Triggering redeploy...');
      const deployOptions = {
        hostname: 'api.render.com',
        path: `/v1/services/${SERVICE_ID}/deploys`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RENDER_API_KEY}`,
          'Accept': 'application/json',
          'Content-Length': 0
        }
      };
      const deployReq = https.request(deployOptions, (deployRes) => {
        let deployBody = '';
        deployRes.on('data', chunk => deployBody += chunk);
        deployRes.on('end', () => {
          console.log(`[Render] Deploy status: ${deployRes.statusCode}`);
          if (deployRes.statusCode === 200 || deployRes.statusCode === 201) {
            console.log('[Render] ✅ Redeploy triggered successfully!');
          } else {
            console.error('[Render] ❌ Failed to trigger deploy:', deployBody);
          }
        });
      });
      deployReq.on('error', e => console.error('[Render] Deploy request error:', e.message));
      deployReq.end();

    } else {
      console.error('[Render] ❌ Sync failed:', body);
    }
  });
});

req.on('error', (e) => {
  console.error('[Render] Sync request error:', e.message);
});

req.write(putData);
req.end();
