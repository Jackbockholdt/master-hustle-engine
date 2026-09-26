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

async function main() {
  const ts = new Date().toISOString().split('T')[1];
  console.log(`[${ts}] Checking https://master-hustle-engine.onrender.com/ ...`);
  
  try {
    const root = await get('https://master-hustle-engine.onrender.com/');
    const isHtml = root.body.includes('<!DOCTYPE html>');
    const has4000 = root.body.includes('4,000') || root.body.includes('4000');
    const has1500 = root.body.includes('1,500') || root.body.includes('1500');
    const has25k = root.body.includes('25,000') || root.body.includes('25000');
    const has497 = root.body.includes('497');
    const has199 = root.body.includes('199');
    const has4500 = root.body.includes('4,500') || root.body.includes('4500');
    const hasDemo = root.body.includes('/demo');

    console.log(`  Root: Status ${root.status}, isHtml: ${isHtml}`);
    console.log(`  Old Pricing: 4000=${has4000}, 1500=${has1500}, 25000=${has25k}`);
    console.log(`  New Pricing: 497=${has497}, 199=${has199}, 4500=${has4500}`);
    console.log(`  Demo Link: ${hasDemo}`);

    if (isHtml) {
      const title = root.body.match(/<title>([\s\S]*?)<\/title>/)?.[1];
      console.log(`  Title: ${title}`);
    }

    const demo = await get('https://master-hustle-engine.onrender.com/demo');
    const isDemoV2 = demo.body.includes('Failover Console') || demo.body.includes('simulateOutage') || demo.body.includes('Queue & Guardrail Scrubber');
    console.log(`  Demo: Status ${demo.status}, Length: ${demo.body.length}, isNewDemo: ${isDemoV2}`);
    const demoTitle = demo.body.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    console.log(`  Demo Title: ${demoTitle}`);

    return {
      rootReady: isHtml && !has4000 && has497 && has4500 && hasDemo,
      demoReady: isDemoV2
    };
  } catch (err) {
    console.error('Fetch error:', err.message);
    return { rootReady: false, demoReady: false };
  }
}

main();
