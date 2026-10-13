'use strict';

/**
 * lib/routerUsageLog.js
 *
 * Usage logging for the multi-model router. Records one row per request the
 * router handles into a local SQLite file, priced from config/router_pricing.json.
 *
 * This module is observational only. It never decides routing, and every
 * failure inside it is caught and logged so it cannot break a dispatch.
 *
 * Storage: data/router_usage.db by default. Override with ROUTER_USAGE_DB_PATH
 * (on Render, point this at a persistent disk or the file is lost on deploy).
 */

const fs = require('fs');
const path = require('path');

const PRICING_PATH = path.join(__dirname, '..', 'config', 'router_pricing.json');
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'router_usage.db');
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Pricing config (re-read automatically when the file's mtime changes) ─────
let pricingCache = { mtimeMs: null, config: null };

function validatePricing(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('pricing config is not an object');
  if (typeof raw.baselineModel !== 'string' || !raw.baselineModel) {
    throw new Error('pricing config is missing baselineModel');
  }
  if (!raw.models || typeof raw.models !== 'object') throw new Error('pricing config is missing models');
  for (const [name, rates] of Object.entries(raw.models)) {
    if (!rates || !Number.isFinite(rates.input) || !Number.isFinite(rates.output) || rates.input < 0 || rates.output < 0) {
      throw new Error(`invalid rates for model "${name}" (need non-negative input and output numbers)`);
    }
  }
  const baseline = raw.models[raw.baselineModel];
  if (!baseline) throw new Error(`baselineModel "${raw.baselineModel}" has no entry in models`);
  return {
    currency: raw.currency || 'USD',
    timezone: raw.timezone || 'America/Chicago',
    baselineModel: raw.baselineModel,
    baselineRates: baseline,
    models: raw.models
  };
}

function loadPricingConfig() {
  const { mtimeMs } = fs.statSync(PRICING_PATH);
  if (pricingCache.config && pricingCache.mtimeMs === mtimeMs) return pricingCache.config;
  const raw = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
  const config = validatePricing(raw);
  pricingCache = { mtimeMs, config };
  return config;
}

// ─── Timezone helpers (calendar "today" in the configured zone) ───────────────
function zonedWallClockAsUtc(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(ms))) p[type] = value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

function zoneOffsetMs(ms, timeZone) {
  return zonedWallClockAsUtc(ms, timeZone) - Math.floor(ms / 1000) * 1000;
}

function startOfZonedDay(ms, timeZone) {
  const wall = new Date(zonedWallClockAsUtc(ms, timeZone));
  const midnightWallAsUtc = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  // Re-check the offset at the candidate instant so DST transitions resolve correctly.
  const guess = midnightWallAsUtc - zoneOffsetMs(ms, timeZone);
  return midnightWallAsUtc - zoneOffsetMs(guess, timeZone);
}

// ─── SQLite handle ────────────────────────────────────────────────────────────
let db = null;
let dbInitFailed = false;

function getDb() {
  if (db) return db;
  if (dbInitFailed) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = process.env.ROUTER_USAGE_DB_PATH || DEFAULT_DB_PATH;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS router_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        ts_iso TEXT NOT NULL,
        task_type TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        tier TEXT,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        price_known INTEGER NOT NULL DEFAULT 1,
        actual_cost_usd REAL,
        baseline_model TEXT NOT NULL,
        baseline_cost_usd REAL NOT NULL DEFAULT 0,
        savings_usd REAL
      );
      CREATE INDEX IF NOT EXISTS idx_router_usage_ts ON router_usage (ts_ms);
    `);
    return db;
  } catch (err) {
    dbInitFailed = true;
    console.warn(`[RouterUsageLog] Disabled: could not open usage database (${err.message}). Routing is unaffected.`);
    return null;
  }
}

// ─── Recording ────────────────────────────────────────────────────────────────
/**
 * Record one router request. Returns true if a row was written.
 * entry: { task, provider, model, tier, status: 'success'|'failed', inputTokens, outputTokens }
 */
function recordUsage(entry, now = Date.now()) {
  const handle = getDb();
  if (!handle) return false;

  const cfg = loadPricingConfig();
  const inTok = Math.max(0, Math.round(Number(entry.inputTokens) || 0));
  const outTok = Math.max(0, Math.round(Number(entry.outputTokens) || 0));
  const status = entry.status === 'failed' ? 'failed' : 'success';

  // Actual cost: needs a price for the model that served it. Zero-token rows cost nothing.
  const rates = entry.model ? cfg.models[entry.model] : null;
  let actualCost = null;
  if (inTok + outTok === 0) actualCost = 0;
  else if (rates) actualCost = (inTok * rates.input + outTok * rates.output) / 1e6;

  // Baseline: what the same tokens would cost on the configured baseline model.
  const baselineCost = (inTok * cfg.baselineRates.input + outTok * cfg.baselineRates.output) / 1e6;
  const savings = actualCost === null ? null : baselineCost - actualCost;

  handle.prepare(`
    INSERT INTO router_usage (
      ts_ms, ts_iso, task_type, provider, model, tier, status,
      input_tokens, output_tokens, price_known,
      actual_cost_usd, baseline_model, baseline_cost_usd, savings_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now,
    new Date(now).toISOString(),
    String(entry.task || 'DEFAULT'),
    entry.provider || null,
    entry.model || null,
    entry.tier || null,
    status,
    inTok,
    outTok,
    actualCost === null ? 0 : 1,
    actualCost,
    cfg.baselineModel,
    baselineCost,
    savings
  );
  return true;
}

// ─── Reporting ────────────────────────────────────────────────────────────────
function windowBounds(now, timeZone) {
  return {
    today: startOfZonedDay(now, timeZone),
    days7: now - 7 * DAY_MS,
    days30: now - 30 * DAY_MS
  };
}

function summarizeRow(row) {
  const baselineForPriced = Number(row.baseline_priced || 0);
  const actual = Number(row.actual || 0);
  const saved = Number(row.saved || 0);
  return {
    requests: Number(row.requests || 0),
    successfulRequests: Number(row.successful || 0),
    failedRequests: Number(row.failed || 0),
    unpricedRequests: Number(row.unpriced || 0),
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    actualCostUSD: round(actual, 6),
    baselineCostUSD: round(baselineForPriced, 6),
    savingsUSD: round(saved, 6),
    savingsPct: baselineForPriced > 0 ? round((saved / baselineForPriced) * 100, 1) : null
  };
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round((Number(n) || 0) * f) / f;
}

const TOTALS_SQL = `
  SELECT
    COUNT(*) AS requests,
    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN price_known = 0 THEN 1 ELSE 0 END) AS unpriced,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(actual_cost_usd) AS actual,
    SUM(CASE WHEN actual_cost_usd IS NOT NULL THEN baseline_cost_usd ELSE 0 END) AS baseline_priced,
    SUM(savings_usd) AS saved
  FROM router_usage
  WHERE ts_ms >= ?
`;

const BY_TASK_SQL = `
  SELECT
    task_type,
    COUNT(*) AS requests,
    SUM(actual_cost_usd) AS actual,
    SUM(CASE WHEN actual_cost_usd IS NOT NULL THEN baseline_cost_usd ELSE 0 END) AS baseline_priced,
    SUM(savings_usd) AS saved
  FROM router_usage
  WHERE ts_ms >= ?
  GROUP BY task_type
`;

/**
 * Totals for today (since local midnight in the configured zone), trailing 7 days and trailing 30 days,
 * plus a per-task-type breakdown for each window.
 */
function getUsageReport(now = Date.now()) {
  const handle = getDb();
  const cfg = loadPricingConfig();
  const bounds = windowBounds(now, cfg.timezone);
  const windowKeys = ['today', 'days7', 'days30'];

  const empty = {
    generatedAt: new Date(now).toISOString(),
    timezone: cfg.timezone,
    currency: cfg.currency,
    baselineModel: cfg.baselineModel,
    windows: {},
    byTask: [],
    enabled: Boolean(handle)
  };
  if (!handle) {
    for (const k of windowKeys) empty.windows[k] = summarizeRow({});
    return empty;
  }

  const windows = {};
  const taskMap = new Map();
  for (const key of windowKeys) {
    windows[key] = summarizeRow(handle.prepare(TOTALS_SQL).get(bounds[key]) || {});
    for (const row of handle.prepare(BY_TASK_SQL).all(bounds[key])) {
      if (!taskMap.has(row.task_type)) taskMap.set(row.task_type, { task: row.task_type, windows: {} });
      taskMap.get(row.task_type).windows[key] = summarizeRow({
        requests: row.requests,
        actual: row.actual,
        baseline_priced: row.baseline_priced,
        saved: row.saved
      });
    }
  }

  const byTask = [...taskMap.values()].sort((a, b) =>
    (b.windows.days30?.baselineCostUSD || 0) - (a.windows.days30?.baselineCostUSD || 0)
  );

  return { ...empty, windows, byTask };
}

module.exports = {
  recordUsage,
  getUsageReport,
  loadPricingConfig,
  startOfZonedDay,
  PRICING_PATH,
  DEFAULT_DB_PATH
};
