'use strict';

/**
 * test_outreach_ingest.js
 * POST /api/ingest/outreach: auth (503 / 401), validation, dedupe on type+email+timestamp,
 * DB location next to ROUTER_USAGE_DB_PATH, and agency report merging with JSONL logs.
 *
 * Local only: spawns this server on localhost with a temp database. Never touches production.
 * Run: node test_outreach_ingest.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-ingest-test-'));
const usageDb = path.join(tmp, 'router_usage.db');
process.env.ROUTER_USAGE_DB_PATH = usageDb;
const ev = require('./lib/outreachEvents');
const report = require('./lib/agencyReport');

const PORT = 3111;
const KEY = 'test-ingest-key';
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
function ok(name) { passed++; console.log(`  ✅ PASS: ${name}`); }

const sample = (over = {}) => ({
  type: 'sent', email: 'Armin@TheLocalSEOs.com', company: "The Local SEO's",
  campaign: 'WHITE_LABEL_SAAS_AUTOMATION', venture_key: 'master-hustle-engine',
  category: 'cold-pitch', timestamp: '2026-10-07T09:59:03-05:00', ...over
});

async function post(body, headers = {}) {
  const res = await fetch(`${BASE}/api/ingest/outreach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function startServer(adminKey) {
  const env = { ...process.env, PORT: String(PORT), ROUTER_USAGE_DB_PATH: usageDb };
  if (adminKey === undefined) delete env.ADMIN_KEY; else env.ADMIN_KEY = adminKey;
  const child = spawn(process.execPath, ['server.js'], { env, stdio: ['ignore', 'ignore', 'ignore'] });
  return child;
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

async function unitTests() {
  console.log('\n-- store (unit) --');
  assert.strictEqual(ev.dbFilePath(), path.join(tmp, 'outreach_events.db'));
  ok('DB file sits next to ROUTER_USAGE_DB_PATH');

  const r1 = ev.insertEvents([sample()]);
  assert.deepStrictEqual([r1.inserted, r1.duplicates, r1.rejected.length], [1, 0, 0]);
  ok('first insert stores the event');

  const r2 = ev.insertEvents([sample()]);
  assert.deepStrictEqual([r2.inserted, r2.duplicates], [0, 1]);
  ok('same type+email+timestamp is skipped as a duplicate');

  const r3 = ev.insertEvents([sample({ timestamp: '2026-10-07T14:59:03Z' })]);
  assert.strictEqual(r3.duplicates, 1, 'same instant in another offset is the same event');
  ok('timestamps are normalized, so the same instant in another offset is a duplicate');

  const r4 = ev.insertEvents([sample({ timestamp: '2026-10-07T10:04:59-05:00', email: 'info@truseosolutions.com' })]);
  assert.strictEqual(r4.inserted, 1);
  ok('different address or time is a new event');

  const bad = ev.insertEvents([
    { ...sample(), type: 'opened' },
    { ...sample(), email: 'not-an-email' },
    { ...sample(), timestamp: 'yesterday' },
    { ...sample(), campaign: '' },
    null
  ]);
  assert.strictEqual(bad.rejected.length, 5);
  assert.strictEqual(bad.inserted, 0);
  ok('invalid events are rejected with reasons and nothing is stored');

  assert.throws(() => ev.insertEvents({ not: 'array' }), /JSON array/);
  assert.throws(() => ev.insertEvents(new Array(ev.MAX_BATCH + 1).fill(sample())), /too large/);
  ok('non-array and oversized bodies throw');

  const all = ev.readEvents();
  assert.strictEqual(all.length, 2);
  ok('readEvents returns the stored events');
  ev.closeDb();
}

async function httpTests() {
  console.log('\n-- route (HTTP, localhost) --');
  // 1) ADMIN_KEY unset -> 503
  let child = startServer(undefined);
  try {
    await waitForHealth();
    const r = await post([sample()], { 'x-admin-key': 'anything' });
    assert.strictEqual(r.status, 503);
    ok('ADMIN_KEY unset: route returns 503');
  } finally { child.kill(); await new Promise((r) => setTimeout(r, 300)); }

  // 2) ADMIN_KEY set
  child = startServer(KEY);
  try {
    await waitForHealth();
    assert.strictEqual((await post([sample()])).status, 401);
    ok('missing x-admin-key: 401');
    assert.strictEqual((await post([sample()], { 'x-admin-key': 'wrong' })).status, 401);
    ok('wrong x-admin-key: 401');
    const r = await post([sample({ timestamp: '2026-10-07T11:00:00-05:00' })], { 'x-admin-key': KEY });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.inserted, 1);
    ok('valid key: 200 and event stored');
    const again = await post([sample({ timestamp: '2026-10-07T11:00:00-05:00' })], { 'x-admin-key': KEY });
    assert.strictEqual(again.body.duplicates, 1);
    ok('re-posting the same event reports a duplicate');
    assert.strictEqual((await post({ not: 'array' }, { 'x-admin-key': KEY })).status, 400);
    ok('non-array body: 400');
  } finally { child.kill(); await new Promise((r) => setTimeout(r, 300)); }
}

function reportTests() {
  console.log('\n-- agency report merge --');
  ev.closeDb();
  // fresh DB for the report test
  fs.rmSync(path.join(tmp, 'outreach_events.db'), { force: true });
  const NOW = Date.UTC(2026, 9, 7, 15, 0, 0);
  const jsonl = path.join(tmp, 'saas_outreach_log.jsonl');
  fs.writeFileSync(jsonl, [
    { campaign: 'WHITE_LABEL_SAAS_AUTOMATION', status: 'SENT', mode: 'LIVE', email: 'armin@thelocalseos.com', timestamp: '2026-10-07T09:59:03-05:00' }
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const triage = path.join(tmp, 'inbound_triage_log.jsonl');
  fs.writeFileSync(triage, '');
  ev.insertEvents([
    sample(),                                                    // duplicate of a JSONL send: must count once
    sample({ email: 'info@truseosolutions.com', timestamp: '2026-10-07T10:04:59-05:00' }), // new send
    { type: 'reply', email: 'owner@agency.com', company: 'Agency', campaign: 'WHITE_LABEL_SAAS_AUTOMATION',
      venture_key: 'WHITE_LABEL_SAAS', category: 'POSITIVE_INTEREST', timestamp: '2026-10-07T12:00:00-05:00' },
    { type: 'bounce', email: 'gone@agency.com', company: 'Gone', campaign: 'WHITE_LABEL_SAAS_AUTOMATION',
      venture_key: null, category: 'bounce', timestamp: '2026-10-07T12:30:00-05:00' }
  ]);
  const cfg = {
    timezone: 'America/Chicago',
    outreachLogs: [jsonl],
    replyLog: triage,
    accounts: [{ id: 'white-label-saas', name: 'WL', campaigns: ['WHITE_LABEL_SAAS_AUTOMATION'], ventures: ['WHITE_LABEL_SAAS'] }]
  };
  const r = report.buildAccountReport(cfg.accounts[0], cfg, report.collectSources(cfg), NOW);
  assert.strictEqual(r.totals.emailsSent, 2, 'JSONL send + one new DB send; duplicate counted once');
  assert.strictEqual(r.totals.replies, 1, 'DB reply counted; bounce is not a reply');
  assert.strictEqual(r.totals.positiveReplies, 1);
  ok('agency report counts DB sends and replies once, merged with JSONL');
  ev.closeDb();
}

function realLogKeyTests() {
  console.log('\n-- agency report merge, real log key names --');
  ev.closeDb();
  fs.rmSync(path.join(tmp, 'outreach_events.db'), { force: true });
  const NOW = Date.UTC(2026, 9, 7, 22, 0, 0);
  // Same shapes as saas_outreach_log.jsonl / shovel_outreach_log.jsonl / inbound_triage_log.jsonl:
  // recipient_email on sends, sender_email on replies, naive Chicago timestamps.
  const jsonl = path.join(tmp, 'saas_outreach_log.jsonl');
  fs.writeFileSync(jsonl, [
    { campaign: 'WHITE_LABEL_SAAS_AUTOMATION', status: 'SENT', mode: 'LIVE', recipient_email: 'armin@thelocalseos.com', timestamp: '2026-10-07T09:59:03.123456' },
    { campaign: 'WHITE_LABEL_SAAS_AUTOMATION', status: 'DRY_RUN_SUCCESS', mode: 'DRY_RUN', recipient_email: 'dry@agency.com', timestamp: '2026-10-07T08:00:00.000000' }
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const triage = path.join(tmp, 'inbound_triage_log.jsonl');
  fs.writeFileSync(triage, JSON.stringify({
    sender_email: 'owner@agency.com', venture_key: 'WHITE_LABEL_SAAS', classification: 'POSITIVE_INTEREST', timestamp: '2026-10-07T12:00:00.000000'
  }) + '\n');
  ev.insertEvents([
    sample({ email: 'Armin@TheLocalSEOs.com', timestamp: '2026-10-07T09:59:05-05:00' }), // same send as the JSONL row: count once
    sample({ email: 'dry@agency.com', timestamp: '2026-10-07T08:00:00-05:00' }),          // only a dry run in JSONL: real send, count it
    { type: 'reply', email: 'owner@agency.com', company: 'Agency', campaign: 'WHITE_LABEL_SAAS_AUTOMATION',
      venture_key: 'WHITE_LABEL_SAAS', category: 'POSITIVE_INTEREST', timestamp: '2026-10-07T12:00:02-05:00' } // same reply: count once
  ]);
  const cfg = {
    timezone: 'America/Chicago',
    outreachLogs: [jsonl],
    replyLog: triage,
    accounts: [{ id: 'white-label-saas', name: 'WL', campaigns: ['WHITE_LABEL_SAAS_AUTOMATION'], ventures: ['WHITE_LABEL_SAAS'] }]
  };
  const r = report.buildAccountReport(cfg.accounts[0], cfg, report.collectSources(cfg), NOW);
  assert.strictEqual(r.totals.emailsSent, 2, 'JSONL send (recipient_email) + DB send whose only JSONL match was a dry run');
  ok('send dedupe matches JSONL recipient_email; a dry run does not hide a real send');
  assert.strictEqual(r.totals.replies, 1, 'JSONL reply (sender_email) and the same DB reply count once');
  assert.strictEqual(r.totals.positiveReplies, 1);
  ok('reply dedupe matches JSONL sender_email');
  ev.closeDb();
}

(async () => {
  try {
    await unitTests();
    reportTests();
    realLogKeyTests();
    await httpTests();
    console.log(`\n${passed} checks passed`);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    ev.closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
