/**
 * trigger_gumloop_ingestion.js
 * Programmatic Utility & CLI Script for testing Gumloop Webhook Ingestion
 */

const http = require('http');

const samplePayload = {
  leads: [
    {
      email: "contact@targetdomain.com",
      firstName: "John",
      company: "Target Company LLC",
      phone: "555-123-4567"
    }
  ]
};

function sendGumloopPayload(payload = samplePayload, port = 3005) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const options = {
      hostname: 'localhost',
      port: port,
      path: '/api/ingest-gumloop-leads',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

if (require.main === module) {
  console.log('📡 Sending test payload to /api/ingest-gumloop-leads...');
  sendGumloopPayload()
    .then(res => {
      console.log(`HTTP ${res.statusCode}:`, JSON.stringify(res.data || res.raw, null, 2));
    })
    .catch(err => {
      console.error('❌ Request error:', err.message);
    });
}

module.exports = { sendGumloopPayload };
