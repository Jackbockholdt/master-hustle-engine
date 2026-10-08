'use strict';

/**
 * test_client_report.js
 * Per-agency client report: attribution, 30-day day buckets, timezone handling,
 * "not tracked yet" semantics, share-link tokens, and page rendering.
 *
 * Run: node test_client_report.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const report = require('./lib/agencyReport');
const { renderAccountPage, renderIndexPage } = require('./lib/reportPage');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-report-test-'));
const NOW = Date.UTC(2026, 9, 7, 15, 0, 0); // Oct 7 2026, 10:00 CDT
const NT = report.NOT_TRACKED;
let passed = 0;
function ok(name) { passed++; console.log(`  ✅ PASS: ${name}`); }

function writeJsonl(name, rows, extraRaw = '') {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n' + extraRaw, 'utf8');
  return p;
}

const outreach = writeJsonl('outreach.jsonl', [
  { campaign: 'WHITE_LABEL_SAAS_AUTOMATION', status: 'SENT', mode: 'LIVE', timestamp: '2026-10-05T09:00:00' },
  { campaign: 'WHITE_LABEL_SAAS_AUTOMATION', status: 'DRY_RUN_SUCCESS', mode: 'DRY_RUN', timestamp: '2026-10-05T09:01:00' },
  { campaign: 'SHOVEL_PATENT_BUYOUT', status: 'SENT', mode: 'LIVE', timestamp: '2026-10-05T09:02:00' },
  { campaign: 'WHITE_LABEL_SAAS_AUTOMATION', status: 'FAILED', mode: 'LIVE', timestamp: '2026-10-05T09:03:00' },
  { campaign: 'WHITE_LABEL_SAAS_AUTOMATION', status: 'SENT', mode: 'LIVE', timestamp: '2026-08-01T10:00:00' },
  { campaign: 'WHITE_LABEL_SAAS_AUTOMATION', status: 'SENT', mode: 'LIVE', timestamp: '2026-10-07T02:30:00Z' }, // Oct 6, 21:30 CDT
  { campaign: 'WHITE_LABEL_SAAS_AUTOMATION', status: 'SUCCESS', mode: 'LIVE', timestamp: '2026-10-07T01:30:00' } // naive = Chicago
], '{not valid json\n');

const replies = writeJsonl('triage.jsonl', [
  { venture_key: 'WHITE_LABEL_SAAS', classification: 'HIGH_INTEREST', timestamp: '2026-10-02T12:00:00' },
  { venture_key: 'WHITE_LABEL_SAAS', classification: 'GENERAL_INQUIRY', timestamp: '2026-10-02T13:00:00' },
  { venture_key: 'SHOVEL_BUYOUT', classification: 'HIGH_INTEREST', timestamp: '2026-10-02T14:00:00' },
  { venture_key: 'WHITE_LABEL_SAAS', classification: 'POSITIVE_INTEREST', timestamp: '2025-01-01T10:00:00' }
]);

function cfgWith(accounts, extra = {}) {
  return { timezone: 'America/Chicago', outreachLogs: [outreach], replyLog: replies, accounts, ...extra };
}
const SAAS = { id: 'white-label-saas', name: 'White-label SaaS', campaigns: ['WHITE_LABEL_SAAS_AUTOMATION'], ventures: ['WHITE_LABEL_SAAS'] };

function run() {
  console.log('\n🧪 Client report tests\n');

  // 1. Config validation
  const badConfig = (accounts) => {
    const p = path.join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify({ accounts }));
    return () => report.loadAgencyConfig(p);
  };
  assert.throws(badConfig([{ id: 'dup-acct', name: 'A' }, { id: 'dup-acct', name: 'B' }]), /duplicate/);
  assert.throws(badConfig([{ id: 'Bad Id!', name: 'A' }]), /lowercase/);
  assert.throws(badConfig([{ id: 'ok-acct', name: '   ' }]), /needs a name/);
  ok('config rejects duplicate ids, bad ids, and missing names');

  // 2. Window and timezone handling
  const keys = report.windowDayKeys(NOW, 'America/Chicago');
  assert.strictEqual(keys.length, 30);
  assert.strictEqual(keys[0], '2026-09-08');
  assert.strictEqual(keys[29], '2026-10-07');
  ok('30-day window ends on today (Chicago) and starts 29 days earlier');

  assert.strictEqual(report.parseLogTimestamp('2026-10-07T01:30:00', 'America/Chicago'), Date.UTC(2026, 9, 7, 6, 30));
  assert.strictEqual(report.parseLogTimestamp('2026-10-07T02:30:00Z', 'America/Chicago'), Date.UTC(2026, 9, 7, 2, 30));
  assert.strictEqual(report.dayKeyOf(Date.UTC(2026, 9, 7, 2, 30), 'America/Chicago'), '2026-10-06');
  assert(Number.isNaN(report.parseLogTimestamp('not a date', 'America/Chicago')));
  ok('naive timestamps are Chicago time; Z timestamps are exact; bad timestamps are rejected');

  // 3. Attribution and counts
  const sources = report.collectSources(cfgWith([SAAS]));
  const r = report.buildAccountReport(SAAS, cfgWith([SAAS]), sources, NOW);
  assert.strictEqual(r.totals.emailsSent, 3, 'LIVE SENT/SUCCESS for this campaign inside the window');
  assert.strictEqual(r.totals.replies, 2, 'replies for this venture inside the window');
  assert.strictEqual(r.totals.positiveReplies, 1, 'HIGH_INTEREST counts as positive; GENERAL_INQUIRY does not');
  ok('emails sent, replies and positive replies attribute to the right account and status');

  const byDate = Object.fromEntries(r.days.map((d) => [d.date, d]));
  assert.strictEqual(byDate['2026-10-05'].emailsSent, 1);
  assert.strictEqual(byDate['2026-10-06'].emailsSent, 1, 'UTC 02:30 on Oct 7 is Oct 6 in Chicago');
  assert.strictEqual(byDate['2026-10-07'].emailsSent, 1, 'naive Oct 7 01:30 is Chicago time');
  assert.strictEqual(byDate['2026-10-02'].replies, 2);
  assert.strictEqual(byDate['2026-10-02'].positiveReplies, 1);
  assert.strictEqual(r.days.reduce((s, d) => s + d.emailsSent, 0), r.totals.emailsSent, 'day buckets sum to total');
  assert.strictEqual(r.days.reduce((s, d) => s + d.replies, 0), r.totals.replies, 'reply buckets sum to total');
  ok('daily buckets match totals and use the Chicago day');

  // 4. Not-tracked versus zero
  assert.strictEqual(r.totals.leadsFound, NT);
  assert.strictEqual(r.totals.meetingsBooked, NT);
  assert.strictEqual(r.days[0].emailsSent, 0, 'tracked metric with no activity shows 0, not "not tracked yet"');
  assert.strictEqual(r.tracked.leadsFound, false);
  ok('leads found and meetings booked always show "not tracked yet"; real zeros stay zero');

  const noCampaign = { id: 'no-campaign', name: 'No campaign', campaigns: [], ventures: ['WHITE_LABEL_SAAS'] };
  const rNc = report.buildAccountReport(noCampaign, cfgWith([noCampaign]), sources, NOW);
  assert.strictEqual(rNc.totals.emailsSent, NT);
  assert.strictEqual(rNc.days[0].emailsSent, null);
  assert.match(rNc.reasons.emailsSent, /No outreach campaign/);
  ok('account with no campaign assigned reports emails sent as "not tracked yet"');

  const missingReply = report.buildAccountReport(SAAS, cfgWith([SAAS], { replyLog: path.join(tmp, 'absent.jsonl') }), report.collectSources(cfgWith([SAAS], { replyLog: path.join(tmp, 'absent.jsonl') })), NOW);
  assert.strictEqual(missingReply.totals.replies, NT);
  assert.strictEqual(missingReply.totals.positiveReplies, NT);
  assert.strictEqual(missingReply.totals.emailsSent, 3, 'other sources still report');
  assert.match(missingReply.reasons.replies, /not found/);
  ok('missing reply log reports replies as "not tracked yet" without hiding other metrics');

  // 5. Share tokens
  const secret = 'test-secret-value';
  const t1 = report.shareToken('white-label-saas', secret);
  assert.strictEqual(t1, report.shareToken('white-label-saas', secret), 'token is deterministic');
  assert.strictEqual(t1.length, 48);
  assert.strictEqual(report.findAccountByShareToken(t1, cfgWith([SAAS]), secret).id, 'white-label-saas');
  assert.strictEqual(report.findAccountByShareToken(t1, cfgWith([SAAS]), 'other-secret'), null, 'rotating the secret revokes links');
  assert.strictEqual(report.findAccountByShareToken(t1.slice(0, -1) + (t1.endsWith('0') ? '1' : '0'), cfgWith([SAAS]), secret), null, 'tampered token rejected');
  assert.strictEqual(report.findAccountByShareToken('../../etc', cfgWith([SAAS]), secret), null, 'malformed token rejected');
  assert.strictEqual(report.shareToken('white-label-saas', ''), null, 'no secret means no share links');
  ok('share tokens verify, revoke on secret rotation, and reject tampering');

  // 6. Page rendering
  const hostile = { ...SAAS, name: '<img src=x onerror=alert(1)>' };
  const rHostile = report.buildAccountReport(hostile, cfgWith([hostile]), sources, NOW);
  const adminHtml = renderAccountPage(rHostile, { shareUrl: 'https://example.test/report/share/abc' });
  assert(!adminHtml.includes('<img src=x'), 'account name must be escaped');
  assert(adminHtml.includes('&lt;img'), 'escaped name present');
  assert(adminHtml.includes('All agency accounts'), 'admin page links back to index');
  assert(adminHtml.includes('https://example.test/report/share/abc'), 'admin page shows the share link');
  const sharedHtml = renderAccountPage(r, { shared: true });
  assert(!sharedHtml.includes('All agency accounts'), 'shared page has no admin navigation');
  assert(!sharedHtml.includes('Shareable read-only link'), 'shared page does not expose share URL controls');
  assert(sharedHtml.includes('noindex') && sharedHtml.includes('<svg'), 'shared page is noindex and includes the chart');
  assert(sharedHtml.includes(NT) && sharedHtml.includes('Leads are not linked'), 'not-tracked cards render with reasons');
  assert(!/saving/i.test(sharedHtml) && !/savings/i.test(adminHtml), 'no router savings text on report pages');
  const ntHtml = renderAccountPage(rNc, { shared: true });
  assert(ntHtml.includes('Emails sent: ' + NT) || ntHtml.includes(NT), 'not-tracked chart shows message instead of empty chart');
  ok('pages escape input, hide admin controls on shared view, and never show savings text');

  const idx = renderIndexPage([], () => null);
  assert(idx.includes('No agency accounts configured'));
  const idx2 = renderIndexPage([r], (id) => `https://example.test/report/share/${report.shareToken(id, secret)}`);
  assert(idx2.includes('/report/white-label-saas') && idx2.includes('/report/share/'));
  ok('index page lists accounts with admin and share links, or an empty-state message');

  // 7. Shipped config loads cleanly
  const shipped = report.loadAgencyConfig(report.DEFAULT_CONFIG_PATH);
  assert(shipped.accounts.length >= 1);
  assert(shipped.accounts.every((a) => a.campaigns.length > 0 && a.ventures.length > 0));
  ok('shipped config/agency_accounts.json is valid');

  console.log(`\n✅ ${passed} client report tests passed\n`);
}

try {
  run();
} catch (err) {
  console.error('\n❌ Client report test failed:', err.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}
