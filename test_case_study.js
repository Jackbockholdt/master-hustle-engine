/**
 * test_case_study.js
 * Verification test for the /case-study page route and content requirements.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

console.log('Testing /case-study page template requirements...');

// 1. Verify file exists
const caseStudyPath = path.join(__dirname, 'public', 'case-study.html');
assert(fs.existsSync(caseStudyPath), 'public/case-study.html must exist');
const html = fs.readFileSync(caseStudyPath, 'utf8');

// 2. Client Identity (Talha / Alpheynia web studio)
assert(/Alpheynia/i.test(html), 'Case study must mention Alpheynia');
assert(/Talha/i.test(html), 'Case study must mention Talha');
assert(/web (design|development|studio)/i.test(html), 'Case study must mention web studio specialization');

// 3. What we did (50 plumbers and gyms in Austin and Oklahoma, free homepage mockup offer)
assert(/50/i.test(html), 'Case study must mention 50 businesses');
assert(/plumber/i.test(html), 'Case study must mention plumbers');
assert(/gym/i.test(html), 'Case study must mention gyms');
assert(/Austin/i.test(html), 'Case study must mention Austin');
assert(/Oklahoma/i.test(html), 'Case study must mention Oklahoma');
assert(/homepage mockup/i.test(html), 'Case study must mention the free homepage mockup offer');

// 4. Metric values from talha-report.html (26 sent, 0 replies, calls booked left blank)
assert(/metric-emails-sent[\s\S]*?>26</.test(html), 'Emails sent must be 26 as reported in talha-report.html');
assert(/metric-replies[\s\S]*?>0</.test(html), 'Replies received must be 0 as reported in talha-report.html');
assert(/metric-calls-booked[\s\S]*?>&nbsp;</.test(html), 'Calls booked must be left blank because it is not in talha-report.html');

// 5. Zero made-up numbers or savings claims
assert(!/saved\s+\$/i.test(html), 'Must not include savings claims');
assert(!/\b(\d+)%\s+savings\b/i.test(html), 'Must not include percentage savings claims');
assert(!/estimated\s+savings/i.test(html), 'Must not include estimated savings');

// 6. Link to /demo
assert(/href=["']\/demo["']/i.test(html), 'Case study must link to /demo');

// 7. No em-dashes or en-dashes
assert(!html.includes('\u2014'), 'Must not contain em-dash (\\u2014)');
assert(!html.includes('\u2013'), 'Must not contain en-dash (\\u2013)');
assert(!html.includes('&mdash;'), 'Must not contain &mdash;');
assert(!html.includes('&ndash;'), 'Must not contain &ndash;');

// 8. Verify server route definition in server.js
const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
assert(serverSrc.includes("['/case-study', '/case-study.html']"), 'server.js must register /case-study route');
assert(serverSrc.includes("'case-study.html'"), 'server.js must serve case-study.html');

// 9. Live HTTP route integration test
const { app } = require('./server');
const TEST_PORT = 3192;

const server = http.createServer(app);

function makeRequest(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${TEST_PORT}${urlPath}`, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
    }).on('error', reject);
  });
}

server.listen(TEST_PORT, async () => {
  try {
    // Test /case-study
    const res1 = await makeRequest('/case-study');
    assert.strictEqual(res1.status, 200, 'GET /case-study must return 200 OK');
    assert(res1.data.includes('Alpheynia'), 'GET /case-study response must contain Alpheynia');
    assert(res1.data.includes('/demo'), 'GET /case-study response must link to /demo');

    // Test /case-study.html
    const res2 = await makeRequest('/case-study.html');
    assert.strictEqual(res2.status, 200, 'GET /case-study.html must return 200 OK');
    assert(res2.data.includes('Talha Kamdar'), 'GET /case-study.html response must contain Talha Kamdar');

    console.log('HTTP integration tests passed: /case-study and /case-study.html both serve 200 OK');
    console.log('ALL /case-study REQUIREMENTS VERIFIED SUCCESSFULLY!');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('Test failure:', err);
    server.close();
    process.exit(1);
  }
});
