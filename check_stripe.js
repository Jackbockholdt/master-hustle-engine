const https = require('https');

function check(url) {
  return new Promise((resolve) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Find base64 init string or json
        const b64 = data.match(/atob\(decodeURIComponent\("([^"]+)"\)\)/);
        if (b64) {
          try {
            const decoded = Buffer.from(decodeURIComponent(b64[1]), 'base64').toString('utf8');
            console.log(`=== ${url} DECODED ===`);
            console.log(decoded.substring(0, 1000));
          } catch (e) {
            console.log(`Error decoding for ${url}:`, e.message);
          }
        } else {
          console.log(`No base64 payload found for ${url}`);
        }
        resolve();
      });
    });
  });
}

async function run() {
  await check('https://buy.stripe.com/6oU9AS3WGdTlaWr68D0000G');
  await check('https://buy.stripe.com/bJecN4al44iL5C7bsX0000H');
}

run();
