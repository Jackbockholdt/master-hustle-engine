'use strict';

/**
 * test_audit_capture.js
 * End-to-end and unit test suite for Lead Leak Audit capture:
 * - Email validation (rejects malformed email, accepts valid)
 * - Lead saving into SQLite pipeline.db
 * - Client IP rate limiting (returns 429 after threshold)
 * - Lead notification dispatch to hello@master-hustle-engine.com
 * - Admin route /admin/audit-leads authorization (503 without ADMIN_KEY, 401 on bad key, 200 on valid key)
 * - Public /audit route rendering
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const {
  isValidEmail,
  checkRateLimit,
  resetRateLimit,
  saveAuditLead,
  getAuditLeads,
  getAuditLeadCount,
  sendAuditNotification,
  getDatabase
} = require('./lib/auditLeads');

const TEST_PORT = 3199;
const TEST_ADMIN_KEY = 'test-secret-audit-admin-key-2026';

let passed = 0;
let failed = 0;

function ok(testName) {
  passed++;
  console.log(`  ✓ ${testName}`);
}

function fail(testName, err) {
  failed++;
  console.error(`  ✗ ${testName}:`, err.message || err);
}

function makeRequest({ method = 'GET', path: reqPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (payload && !reqHeaders['Content-Length']) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: reqPath,
      method,
      headers: reqHeaders,
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
          json
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('\n======================================================');
  console.log('   RUNNING LEAD LEAK AUDIT BACKEND TEST SUITE        ');
  console.log('======================================================\n');

  // ─── 1. Unit Tests: Email Validation ─────────────────────────────
  console.log('1. Email Validation Unit Tests');
  try {
    assert.strictEqual(isValidEmail('test@example.com'), true);
    assert.strictEqual(isValidEmail('sarah.jenkins@marketing-agency.co.uk'), true);
    assert.strictEqual(isValidEmail('lead+audit@sub.domain.com'), true);
    assert.strictEqual(isValidEmail('invalid-email'), false);
    assert.strictEqual(isValidEmail('@missingusername.com'), false);
    assert.strictEqual(isValidEmail('missing-domain@'), false);
    assert.strictEqual(isValidEmail('spaces in@email.com'), false);
    assert.strictEqual(isValidEmail(''), false);
    assert.strictEqual(isValidEmail(null), false);
    ok('isValidEmail accurately validates standard & malformed emails');
  } catch (err) {
    fail('isValidEmail', err);
  }

  // ─── 2. Unit Tests: IP Rate Limiting ─────────────────────────────
  console.log('\n2. IP Rate Limiting Unit Tests');
  try {
    resetRateLimit();
    const testIp = '198.51.100.42';
    // 5 allowed requests
    for (let i = 1; i <= 5; i++) {
      const res = checkRateLimit(testIp);
      assert.strictEqual(res.allowed, true, `Attempt ${i} should be allowed`);
    }
    // 6th attempt must be rejected
    const blocked = checkRateLimit(testIp);
    assert.strictEqual(blocked.allowed, false, '6th request must be rate-limited');
    assert.strictEqual(blocked.remaining, 0);
    assert(blocked.resetMs > 0);

    // Another IP should still be allowed
    const diffIp = '198.51.100.43';
    assert.strictEqual(checkRateLimit(diffIp).allowed, true, 'Different IP must not be blocked');
    resetRateLimit();
    ok('checkRateLimit enforces sliding window per IP');
  } catch (err) {
    fail('checkRateLimit', err);
  }

  // ─── 3. Unit Tests: SQLite Storage ───────────────────────────────
  console.log('\n3. SQLite Storage Unit Tests');
  try {
    const testEmail = `lead-${Date.now()}@testagency.com`;
    const lead = saveAuditLead({
      name: 'Benton Eimers',
      email: testEmail,
      business: 'Eimers Digital',
      answers: {
        'Lead Response Speed': 'Instant (< 5 minutes)',
        'Follow-Up Persistence': '3 to 5 step sequence'
      },
      score: 85,
      ip: '203.0.113.10'
    });

    assert(lead.id > 0, 'lead.id must be an incremented integer');
    assert.strictEqual(lead.email, testEmail);
    assert.strictEqual(lead.score, 85);

    // Query back from DB
    const leads = getAuditLeads({ limit: 10 });
    const match = leads.find(l => l.id === lead.id);
    assert(match, 'Saved lead must exist in getAuditLeads()');
    assert.strictEqual(match.name, 'Benton Eimers');
    assert.strictEqual(match.business, 'Eimers Digital');
    assert.strictEqual(match.score, 85);
    assert.strictEqual(match.ip_address, '203.0.113.10');

    const parsedAnswers = JSON.parse(match.answers);
    assert.strictEqual(parsedAnswers['Lead Response Speed'], 'Instant (< 5 minutes)');
    ok('saveAuditLead persists lead attributes into SQLite pipeline.db');
  } catch (err) {
    fail('SQLite storage', err);
  }

  // ─── 4. Unit Tests: Notification Dispatch ────────────────────────
  console.log('\n4. Lead Notification Dispatch');
  try {
    // When GMAIL_HTTP_URL is not set, notification gracefully logs and returns unconfigured without throwing
    const notifRes = await sendAuditNotification({
      name: 'Test Prospect',
      email: 'prospect@example.com',
      business: 'Example Corp',
      score: 70,
      answers: { 'Q1': 'fast' },
      ip_address: '127.0.0.1'
    });

    assert.strictEqual(notifRes.recipient, 'hello@master-hustle-engine.com');
    ok('sendAuditNotification formats email and targets hello@master-hustle-engine.com');
  } catch (err) {
    fail('sendAuditNotification', err);
  }

  // ─── 5. Integration Tests: Server Endpoints ──────────────────────
  console.log('\n5. HTTP Server Integration Tests');

  process.env.PORT = String(TEST_PORT);
  process.env.ADMIN_KEY = TEST_ADMIN_KEY;
  process.env.ENABLE_SCHEDULED_JOBS = 'false';

  const { app } = require('./server');
  const server = http.createServer(app);

  await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));

  try {
    // 5.1 GET /audit serves HTML
    const auditPage = await makeRequest({ path: '/audit' });
    assert.strictEqual(auditPage.statusCode, 200);
    assert(auditPage.data.includes('The Lead Leak Audit'), 'Page should include title');
    assert(auditPage.data.includes('/api/audit-lead'), 'Page should call /api/audit-lead endpoint');
    ok('GET /audit returns 200 OK with Lead Leak Audit HTML');

    // 5.2 POST /api/audit-lead: rejection on invalid email (400)
    resetRateLimit();
    const badEmailRes = await makeRequest({
      method: 'POST',
      path: '/api/audit-lead',
      body: {
        name: 'Bad Email User',
        email: 'not-an-email',
        business: 'Test Co',
        score: 40
      }
    });
    assert.strictEqual(badEmailRes.statusCode, 400);
    assert.strictEqual(badEmailRes.json.success, false);
    assert(badEmailRes.json.error.includes('email'));
    ok('POST /api/audit-lead rejects invalid email with HTTP 400');

    // 5.3 POST /api/audit-lead: success (200)
    const validEmail = `live-test-${Date.now()}@agencygrowth.com`;
    const goodLeadRes = await makeRequest({
      method: 'POST',
      path: '/api/audit-lead',
      headers: { 'X-Forwarded-For': '198.51.100.99' },
      body: {
        name: 'Jordan Miller',
        email: validEmail,
        business: 'Apex Digital Agency',
        score: 65,
        answers: {
          'Lead Response Speed': '15 to 60 minutes',
          'Follow-Up Persistence': '1 or 2 manual follow-ups'
        }
      }
    });
    assert.strictEqual(goodLeadRes.statusCode, 200);
    assert.strictEqual(goodLeadRes.json.success, true);
    assert.strictEqual(goodLeadRes.json.score, 65);
    assert(goodLeadRes.json.id > 0);
    ok('POST /api/audit-lead saves lead to database and returns HTTP 200');

    // 5.4 POST /api/audit-lead: Rate limiting by IP (429)
    const spamIp = '203.0.113.77';
    for (let i = 0; i < 5; i++) {
      const r = await makeRequest({
        method: 'POST',
        path: '/api/audit-lead',
        headers: { 'X-Forwarded-For': spamIp },
        body: { email: `spam-${i}@example.com`, name: `Spammer ${i}`, score: 50 }
      });
      assert.strictEqual(r.statusCode, 200, `Request ${i + 1} should succeed`);
    }
    const rateLimitedRes = await makeRequest({
      method: 'POST',
      path: '/api/audit-lead',
      headers: { 'X-Forwarded-For': spamIp },
      body: { email: 'overflow@example.com', name: 'Overflow', score: 50 }
    });
    assert.strictEqual(rateLimitedRes.statusCode, 429);
    assert.strictEqual(rateLimitedRes.json.success, false);
    assert(rateLimitedRes.json.error.includes('Too many submissions'));
    ok('POST /api/audit-lead enforces IP rate limiting with HTTP 429');

    // 5.5 Admin list without key -> 401
    const unauthAdmin = await makeRequest({
      path: '/admin/audit-leads',
      headers: { 'Accept': 'application/json' }
    });
    assert.strictEqual(unauthAdmin.statusCode, 401);
    ok('GET /admin/audit-leads returns 401 Unauthorized when missing ADMIN_KEY');

    // 5.6 Admin list with wrong key -> 401
    const badKeyAdmin = await makeRequest({
      path: '/admin/audit-leads?key=wrong-key',
      headers: { 'Accept': 'application/json' }
    });
    assert.strictEqual(badKeyAdmin.statusCode, 401);
    ok('GET /admin/audit-leads returns 401 Unauthorized with invalid ADMIN_KEY');

    // 5.7 Admin list with valid key (JSON) -> 200
    const authAdminJson = await makeRequest({
      path: `/admin/audit-leads?key=${TEST_ADMIN_KEY}`,
      headers: { 'Accept': 'application/json' }
    });
    assert.strictEqual(authAdminJson.statusCode, 200);
    assert.strictEqual(authAdminJson.json.success, true);
    assert(Array.isArray(authAdminJson.json.leads));
    assert(authAdminJson.json.total >= 1);
    ok('GET /admin/audit-leads returns 200 JSON with captured leads when authenticated');

    // 5.8 Admin list with valid key (HTML) -> 200
    const authAdminHtml = await makeRequest({
      path: `/admin/audit-leads?key=${TEST_ADMIN_KEY}`,
      headers: { 'Accept': 'text/html' }
    });
    assert.strictEqual(authAdminHtml.statusCode, 200);
    assert(authAdminHtml.data.includes('Lead Leak Audit Captures'));
    assert(authAdminHtml.data.includes(validEmail));
    ok('GET /admin/audit-leads returns 200 HTML table view for admin browser');

  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log('\n======================================================');
  console.log(`  TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
