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
    const rootShowsPrices = /\$\s?\d/.test(root.body);
    const rootHasSalesDesk = root.body.includes('AI sales desk');
    const rootHasContact = root.body.includes('hello@master-hustle-engine.com') && !root.body.includes('@gmail.com');
    const hasDemo = root.body.includes('/demo');

    console.log(`  Root: Status ${root.status}, isHtml: ${isHtml}`);
    console.log(`  Sales desk copy: ${rootHasSalesDesk}, public prices: ${rootShowsPrices}, hello@ contact: ${rootHasContact}`);
    console.log(`  Demo Link: ${hasDemo}`);

    if (isHtml) {
      const title = root.body.match(/<title>([\s\S]*?)<\/title>/)?.[1];
      console.log(`  Title: ${title}`);
    }

    const demo = await get('https://master-hustle-engine.onrender.com/demo');
    const isSalesDeskDemo = demo.body.includes('data-demo="sales-desk"');
    const demoShowsPrices = /\$\s?\d/.test(demo.body);
    console.log(`  Demo: Status ${demo.status}, Length: ${demo.body.length}, isSalesDeskDemo: ${isSalesDeskDemo}, public prices: ${demoShowsPrices}`);
    const demoTitle = demo.body.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    console.log(`  Demo Title: ${demoTitle}`);

    return {
      rootReady: isHtml && rootHasSalesDesk && !rootShowsPrices && rootHasContact && hasDemo,
      demoReady: isSalesDeskDemo && !demoShowsPrices
    };
  } catch (err) {
    console.error('Fetch error:', err.message);
    return { rootReady: false, demoReady: false };
  }
}

main();
