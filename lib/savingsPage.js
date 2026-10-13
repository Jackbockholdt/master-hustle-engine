'use strict';

/**
 * lib/savingsPage.js
 * Server-rendered HTML for the private /savings page. Input is the report from
 * lib/routerUsageLog.js getUsageReport(). All values are escaped.
 */

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function usd(n) {
  if (n === null || n === undefined) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function pct(n) {
  return n === null || n === undefined ? '—' : `${n.toFixed(1)}%`;
}

const WINDOW_LABELS = [
  ['today', 'Today'],
  ['days7', 'Last 7 days'],
  ['days30', 'Last 30 days']
];

function renderSummaryRows(report) {
  return WINDOW_LABELS.map(([key, label]) => {
    const w = report.windows[key];
    return `
        <tr>
          <th scope="row">${esc(label)}</th>
          <td>${esc(w.requests.toLocaleString('en-US'))}</td>
          <td>${esc(usd(w.actualCostUSD))}</td>
          <td>${esc(usd(w.baselineCostUSD))}</td>
          <td class="${w.savingsUSD < 0 ? 'neg' : 'pos'}">${esc(usd(w.savingsUSD))}</td>
          <td>${esc(pct(w.savingsPct))}</td>
        </tr>`;
  }).join('');
}

function renderTaskRows(report) {
  if (!report.byTask.length) {
    return `<tr><td colspan="7" class="muted">No requests logged yet.</td></tr>`;
  }
  return report.byTask.map((t) => {
    const cells = WINDOW_LABELS.map(([key]) => {
      const w = t.windows[key];
      if (!w) return '<td>—</td><td>—</td>';
      return `<td>${esc(usd(w.savingsUSD))}</td><td>${esc(pct(w.savingsPct))}</td>`;
    }).join('');
    const reqs30 = t.windows.days30 ? t.windows.days30.requests : 0;
    return `
        <tr>
          <th scope="row">${esc(t.task)}<div class="muted small">${esc(reqs30.toLocaleString('en-US'))} requests (30d)</div></th>
          ${cells}
        </tr>`;
  }).join('');
}

function renderSavingsPage(report) {
  const generated = new Date(report.generatedAt).toLocaleString('en-US', { timeZone: report.timezone, dateStyle: 'medium', timeStyle: 'short' });
  const unpriced = report.windows.days30.unpricedRequests || 0;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Router Savings</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0b0d10; color: #e6e8eb; }
    main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
    h1 { font-size: 1.5rem; margin: 0 0 4px; }
    h2 { font-size: 1.05rem; margin: 28px 0 10px; color: #cfd3d8; }
    .sub { color: #8a919c; font-size: 0.9rem; margin-bottom: 8px; }
    .muted { color: #8a919c; }
    .small { font-size: 0.8rem; font-weight: normal; }
    .table-wrap { overflow-x: auto; border: 1px solid #1f242c; border-radius: 10px; background: #12151a; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; min-width: 560px; }
    th, td { padding: 10px 12px; text-align: right; border-bottom: 1px solid #1f242c; white-space: nowrap; }
    th[scope="row"] { text-align: left; font-weight: 600; }
    thead th { color: #8a919c; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.03em; }
    tr:last-child th, tr:last-child td { border-bottom: none; }
    .neg { color: #ff7b72; }
    .pos { color: #6fd28a; }
    .note { font-size: 0.82rem; color: #8a919c; margin-top: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Router savings</h1>
    <div class="sub">Baseline model: <strong>${esc(report.baselineModel)}</strong> · Day boundary: ${esc(report.timezone)} · Generated ${esc(generated)}</div>

    <h2>Totals</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col" style="text-align:left">Window</th>
            <th scope="col">Requests</th>
            <th scope="col">Actual cost</th>
            <th scope="col">Baseline cost</th>
            <th scope="col">Saved</th>
            <th scope="col">% saved</th>
          </tr>
        </thead>
        <tbody>${renderSummaryRows(report)}
        </tbody>
      </table>
    </div>

    <h2>By task type</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col" style="text-align:left" rowspan="2">Task type</th>
            <th scope="col" colspan="2">Today</th>
            <th scope="col" colspan="2">Last 7 days</th>
            <th scope="col" colspan="2">Last 30 days</th>
          </tr>
          <tr>
            <th scope="col">Saved</th><th scope="col">% saved</th>
            <th scope="col">Saved</th><th scope="col">% saved</th>
            <th scope="col">Saved</th><th scope="col">% saved</th>
          </tr>
        </thead>
        <tbody>${renderTaskRows(report)}
        </tbody>
      </table>
    </div>

    <p class="note">
      Actual cost uses the provider token counts and the price table in config/router_pricing.json.
      Baseline cost is the same tokens priced on the baseline model. Saved = baseline minus actual, so it is negative when a request cost more than the baseline.
      Failed requests carry no tokens and add nothing. Mock and test calls are not logged.${unpriced ? ` ${esc(unpriced)} logged request(s) used a model with no price in the table and are excluded from dollar totals.` : ''}
    </p>
  </main>
</body>
</html>`;
}

module.exports = { renderSavingsPage, usd, pct, esc };
