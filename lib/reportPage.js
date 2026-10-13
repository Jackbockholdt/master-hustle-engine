'use strict';

/**
 * lib/reportPage.js
 * Server-rendered HTML for the per-agency client report. Inputs come from
 * lib/agencyReport.js. Every value is escaped. Savings figures are never rendered here.
 */

const { NOT_TRACKED } = require('./agencyReport');

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNum(v) {
  return typeof v === 'number' ? v.toLocaleString('en-US') : esc(v);
}

const CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0b0d10; color: #e6e8eb; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1.05rem; margin: 28px 0 10px; color: #cfd3d8; }
  a { color: #7ab8ff; }
  .sub { color: #8a919c; font-size: 0.9rem; margin-bottom: 8px; }
  .muted { color: #8a919c; }
  .banner { background: #14202e; border: 1px solid #1f3550; border-radius: 8px; padding: 10px 12px; font-size: 0.88rem; margin: 12px 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .card { background: #12151a; border: 1px solid #1f242c; border-radius: 10px; padding: 14px; }
  .card .label { color: #8a919c; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
  .card .value { font-size: 1.6rem; font-weight: 600; margin-top: 6px; }
  .card .value.nt { font-size: 1rem; color: #8a919c; font-weight: 500; margin-top: 10px; }
  .card .why { color: #6b727c; font-size: 0.78rem; margin-top: 6px; }
  .chart { background: #12151a; border: 1px solid #1f242c; border-radius: 10px; padding: 12px; }
  .chart svg { width: 100%; height: auto; display: block; }
  .legend { font-size: 0.8rem; color: #8a919c; margin-bottom: 6px; }
  .legend span { display: inline-block; margin-right: 14px; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  .nt-box { color: #8a919c; padding: 28px 12px; text-align: center; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #1f242c; text-align: left; }
  th { color: #8a919c; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; }
  td.n { text-align: right; }
  .list { list-style: none; padding: 0; margin: 0; }
  .list li { background: #12151a; border: 1px solid #1f242c; border-radius: 10px; padding: 14px; margin-bottom: 10px; }
  .url { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.8rem; word-break: break-all; color: #cfd3d8; }
`;

function page(title, body, { shared = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(title)}</title>
  <style>${CSS}</style>
</head>
<body>
  <main>
    ${shared ? '' : '<div class="sub"><a href="/report">All agency accounts</a></div>'}
    ${body}
  </main>
</body>
</html>`;
}

const CARD_ORDER = [
  ['leadsFound', 'Leads found'],
  ['emailsSent', 'Emails sent'],
  ['replies', 'Replies'],
  ['positiveReplies', 'Positive replies'],
  ['meetingsBooked', 'Meetings booked']
];

function renderCards(report) {
  return CARD_ORDER.map(([key, label]) => {
    const v = report.totals[key];
    const isNt = v === NOT_TRACKED;
    return `
      <div class="card">
        <div class="label">${esc(label)}</div>
        ${isNt
          ? `<div class="value nt">${esc(NOT_TRACKED)}</div><div class="why">${esc(report.reasons[key] || '')}</div>`
          : `<div class="value">${fmtNum(v)}</div>`}
      </div>`;
  }).join('');
}

// Simple grouped bar chart as inline SVG. series: [{label, color, values}] with values possibly null.
function barChart(days, series, emptyMessage) {
  const tracked = series.filter((s) => Array.isArray(s.values));
  if (tracked.length === 0) {
    return `<div class="chart"><div class="nt-box">${esc(emptyMessage)}</div></div>`;
  }
  const W = 600, H = 200, PAD_L = 28, PAD_B = 22, PAD_T = 10;
  const plotW = W - PAD_L - 6, plotH = H - PAD_T - PAD_B;
  const max = Math.max(1, ...tracked.flatMap((s) => s.values.map((v) => v || 0)));
  const slot = plotW / days.length;
  const barW = Math.max(1, (slot * 0.8) / tracked.length);
  let bars = '';
  days.forEach((d, i) => {
    tracked.forEach((s, si) => {
      const v = s.values[i] || 0;
      const h = (v / max) * plotH;
      const x = PAD_L + i * slot + slot * 0.1 + si * barW;
      const y = PAD_T + plotH - h;
      bars += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="${s.color}"><title>${esc(d.date)} · ${esc(s.label)}: ${v}</title></rect>`;
    });
  });
  const gridLines = [0, 0.5, 1].map((f) => {
    const y = PAD_T + plotH - f * plotH;
    return `<line x1="${PAD_L}" x2="${W - 6}" y1="${y.toFixed(2)}" y2="${y.toFixed(2)}" stroke="#1f242c"/><text x="${PAD_L - 6}" y="${(y + 4).toFixed(2)}" fill="#6b727c" font-size="10" text-anchor="end">${Math.round(f * max)}</text>`;
  }).join('');
  const first = days[0].date.slice(5), last = days[days.length - 1].date.slice(5);
  const labels = `<text x="${PAD_L}" y="${H - 6}" fill="#6b727c" font-size="10">${esc(first)}</text><text x="${W - 6}" y="${H - 6}" fill="#6b727c" font-size="10" text-anchor="end">${esc(last)}</text>`;
  const legend = tracked.map((s) => `<span><i class="swatch" style="background:${s.color}"></i>${esc(s.label)}</span>`).join('');
  return `<div class="chart"><div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily counts for the last 30 days">${gridLines}${bars}${labels}</svg></div>`;
}

function renderAccountBody(report, { shareUrl = null, shared = false } = {}) {
  const w = report.window;
  const banner = shared
    ? `<div class="banner">Read-only report for <strong>${esc(report.account.name)}</strong>. Last 30 days, ${esc(w.from)} to ${esc(w.to)} (${esc(report.timezone)}).</div>`
    : `<div class="banner">Shareable read-only link: <span class="url">${esc(shareUrl || 'Set REPORT_SHARE_SECRET or ADMIN_KEY to enable share links')}</span></div>`;
  const emailChart = barChart(report.days, [
    { label: 'Emails sent', color: '#5aa9ff', values: report.days.map((d) => d.emailsSent) }
  ], 'Emails sent: ' + NOT_TRACKED);
  const replyChart = barChart(report.days, [
    { label: 'Replies', color: '#9aa4b2', values: report.days.map((d) => d.replies) },
    { label: 'Positive replies', color: '#6fd28a', values: report.days.map((d) => d.positiveReplies) }
  ], 'Replies: ' + NOT_TRACKED);
  return `
    <h1>${esc(report.account.name)}</h1>
    <div class="sub">Client report · last 30 days (${esc(w.from)} to ${esc(w.to)}) · ${esc(report.timezone)}</div>
    ${banner}
    <h2>Totals</h2>
    <div class="cards">${renderCards(report)}</div>
    <h2>Emails sent per day</h2>
    ${emailChart}
    <h2>Replies per day</h2>
    ${replyChart}
    <p class="muted" style="font-size:0.8rem;margin-top:18px">Generated ${esc(report.generatedAt)}. Counts come from the app's outreach and reply logs. Dry runs and failed sends are excluded.</p>`;
}

function renderAccountPage(report, opts = {}) {
  const body = renderAccountBody(report, opts);
  return page(`${report.account.name} · Client report`, body, { shared: !!opts.shared });
}

function renderIndexPage(reports, shareUrlFor) {
  if (reports.length === 0) {
    return page('Agency client reports', `
      <h1>Agency client reports</h1>
      <div class="sub">No agency accounts configured.</div>
      <div class="banner">Add accounts to <code>config/agency_accounts.json</code> and restart the server.</div>`);
  }
  const items = reports.map((r) => {
    const url = shareUrlFor(r.account.id);
    return `
      <li>
        <div><strong>${esc(r.account.name)}</strong> <span class="muted">· ${esc(r.account.id)}</span></div>
        <div class="sub"><a href="/report/${esc(r.account.id)}">Open report</a></div>
        <div class="sub">Share link: <span class="url">${esc(url || 'disabled (no secret configured)')}</span></div>
      </li>`;
  }).join('');
  return page('Agency client reports', `
    <h1>Agency client reports</h1>
    <div class="sub">Last 30 days per agency account.</div>
    <ul class="list">${items}</ul>`);
}

module.exports = { renderAccountPage, renderIndexPage, esc };
