#!/usr/bin/env node
/**
 * Boot-level verification for admin auth, live mailer probe, and send-cap choke.
 * Spawns server.js against a temp sqlite file. Never talks to the live engine.
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 3017;
const KEY = 'verify-admin-key-32bytes-minimum!!';
const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhe-verify-'));
const dbPath = path.join(tmpDir, 'test.sqlite');

function req(pathname, { method = 'GET', headers = {}, body, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* html or empty */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(8000, () => { r.destroy(new Error('timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

function startServer(envExtra = {}) {
  const env = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH: dbPath,
    DATA_DIR: tmpDir,
    OUTBOUND_PAUSED: 'true',
    GEMINI_API_KEY: 'test-gemini',
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    ADMIN_EMAIL: 'ops@example.com',
    GMAIL_HTTP_URL: 'https://example.com/macros/s/fake/exec',
    GMAIL_HTTP_KEY: 'relay-key',
    STATUS_EMAIL_ENABLED: 'false',
    ...envExtra,
  };
  delete env.SMTP_USER;
  delete env.SMTP_PASS;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString(); });
  child.stderr.on('data', (b) => { out += b.toString(); });
  child.log = () => out;
  return child;
}

async function waitUp(child, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`server exited ${child.exitCode}\n${child.log()}`);
    }
    try {
      const r = await req('/version');
      if (r.status === 200) return r;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not come up\n${child.log()}`);
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
  });
}

async function sqliteCount(sql) {
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(dbPath);
  const row = await new Promise((resolve, reject) => {
    db.get(sql, (err, r) => err ? reject(err) : resolve(r));
  });
  await new Promise((resolve) => db.close(() => resolve()));
  return row;
}

(async () => {
  const results = [];
  const pass = (name) => { results.push(`PASS ${name}`); console.log(`PASS ${name}`); };
  const fail = (name, err) => { results.push(`FAIL ${name}: ${err.message}`); console.error(`FAIL ${name}: ${err.stack || err.message}`); };

  // ── 1. Fail-closed: ADMIN_KEY unset → 503 on admin, public still open ──
  let child = startServer({ ADMIN_KEY: '' });
  try {
    await waitUp(child);
    const locked = await req('/admin/status');
    assert.strictEqual(locked.status, 503, `expected 503, got ${locked.status} ${locked.body}`);
    assert.strictEqual(locked.json && locked.json.error, 'admin_locked');
    pass('fail-closed 503 with ADMIN_KEY unset');

    for (const p of ['/', '/version', '/health', '/pitch']) {
      const r = await req(p);
      assert.ok(r.status === 200 || r.status === 503, `${p} should stay public, got ${r.status}`);
      if (p === '/pitch') assert.ok(r.body.includes('<html') || r.body.includes('<!DOCTYPE'), '/pitch should be HTML');
      if (p !== '/pitch') assert.ok(r.status === 200, `${p} expected 200, got ${r.status} ${r.body.slice(0, 200)}`);
    }
    pass('public / /version /health /pitch still open when admin locked');
  } catch (e) { fail('fail-closed suite', e); }
  await stop(child);

  // ── 2. Auth matrix ──
  child = startServer({ ADMIN_KEY: KEY });
  try {
    await waitUp(child);
    const adminPaths = ['/admin/status', '/admin/pitch', '/admin/do-not-contact', '/api/admin/logs'];
    for (const p of adminPaths) {
      const none = await req(p);
      assert.strictEqual(none.status, 401, `${p} none → ${none.status}`);
      const wrong = await req(p, { headers: { 'X-Admin-Key': 'wrong-key-value-not-the-same' } });
      assert.strictEqual(wrong.status, 401, `${p} wrong → ${wrong.status}`);
      const header = await req(p, { headers: { 'X-Admin-Key': KEY } });
      assert.strictEqual(header.status, 200, `${p} header → ${header.status} ${header.body.slice(0, 180)}`);
      const bearer = await req(p, { headers: { Authorization: `Bearer ${KEY}` } });
      assert.strictEqual(bearer.status, 200, `${p} bearer → ${bearer.status}`);
      const query = await req(`${p}${p.includes('?') ? '&' : '?'}key=${encodeURIComponent(KEY)}`);
      assert.strictEqual(query.status, 200, `${p} query → ${query.status}`);
      assert.ok(/no-store/i.test(header.headers['cache-control'] || ''), `${p} missing Cache-Control`);
    }
    pass('auth matrix: none/wrong=401, header/bearer/query=200 on 4 admin endpoints');

    const health = await req('/health?probe=1');
    assert.strictEqual(health.status, 200, `/health ${health.status} ${health.body.slice(0, 200)}`);
    assert.ok(health.json.mailer_live, 'mailer_live missing');
    assert.strictEqual(typeof health.json.mailer_live.can_send, 'boolean');
    assert.ok(health.json.mailer_live.relay, 'relay probe missing');
    pass('live /health includes mailer_live and stays 200');

    // malformed URL (deployment ID, no /exec)
    await stop(child);
    child = startServer({
      ADMIN_KEY: KEY,
      GMAIL_HTTP_URL: 'https://script.google.com/macros/s/AKfycbxDEPLOYMENT_ID',
      GMAIL_HTTP_KEY: 'relay-key',
    });
    await waitUp(child);
    const bad = await req('/health?probe=1');
    const diag = (bad.json.mailer_live.relay && bad.json.mailer_live.relay.diagnosis) || '';
    assert.ok(/\/exec/.test(diag), `expected /exec diagnosis, got: ${diag}`);
    assert.strictEqual(bad.status, 200, 'malformed relay must not flip /health to 503');
    pass('malformed relay URL names the /exec failure mode without flipping status');

    await stop(child);
    child = startServer({
      ADMIN_KEY: KEY,
      GMAIL_HTTP_URL: 'https://127.0.0.1:1/exec',
      GMAIL_HTTP_KEY: 'relay-key',
    });
    await waitUp(child);
    const down = await req('/health?probe=1');
    assert.strictEqual(down.status, 200);
    assert.strictEqual(down.json.mailer_live.can_send, false);
    pass('unreachable relay: can_send false, /health still 200');

    // zero cap: bulk-pitch must not write send_log
    await stop(child);
    child = startServer({
      ADMIN_KEY: KEY,
      DAILY_SEND_CAP: '0',
      OUTBOUND_PAUSED: 'false',
      GMAIL_HTTP_URL: 'https://example.com/exec',
      GMAIL_HTTP_KEY: 'relay-key',
    });
    await waitUp(child);
    const bulk = await req('/admin/bulk-pitch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': KEY },
      body: JSON.stringify({ companies: [{ name: 'Acme Marketing Agency', industry: 'marketing agency', override_email: 'ceo@acmemarketing.test', website: 'https://acmemarketing.test' }] }),
    });
    assert.ok(bulk.status === 200, `bulk-pitch ${bulk.status} ${bulk.body.slice(0, 300)}`);
    const capped = (bulk.json.results || []).every((r) => r.status === 'capped') || bulk.json.summary.capped >= 1;
    assert.ok(capped, `expected capped result, got ${bulk.body.slice(0, 400)}`);
    const row = await sqliteCount('SELECT COUNT(*) AS c FROM send_log');
    assert.strictEqual(row.c, 0, `send_log should be empty under zero cap, got ${row.c}`);
    pass('zero cap: bulk-pitch caps and writes zero send_log rows');
  } catch (e) { fail('auth/probe/cap suite', e); }

  await stop(child);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  const failed = results.filter((r) => r.startsWith('FAIL'));
  console.log('\n' + results.join('\n'));
  if (failed.length) {
    console.error(`\n${failed.length} failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
