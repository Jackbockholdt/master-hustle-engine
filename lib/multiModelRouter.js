'use strict';

/**
 * lib/multiModelRouter.js
 * Enterprise Multi-Model Real-Cost API Failover Router & Pooling Engine
 * 
 * Provider Failover & Cost-Optimization Chain:
 *   Cheap Tier:
 *     1. Gemini Cheap (gemini-2.5-flash) ->
 *     2. OpenAI Cheap (gpt-4o-mini) ->
 *     3. Anthropic Claude Cheap (claude-3-5-haiku-20241022) ->
 *     4. OpenRouter Cheap (google/gemini-2.0-flash-001)
 *   Escalation / Strong Tier (on failure, empty output, or complex/flagship tasks):
 *     1. Gemini Strong (gemini-2.5-pro) ->
 *     2. OpenAI Strong (gpt-4o) ->
 *     3. Anthropic Claude Strong (claude-3-5-sonnet-20241022) ->
 *     4. OpenRouter Strong (anthropic/claude-3.5-sonnet)
 * 
 * Key Principles:
 *   - Real Cost Routing: send each request to the cheapest model that can handle it
 *   - Escalation on failure or empty output to stronger tier
 *   - Never fake output: returns real error (success: false) when all providers fail
 *   - Real token & cost tracking compared to strong-model baseline (gpt-4o)
 *   - Measured savings in telemetry (zero hardcoded percentages)
 *   - Fail-closed API key verification middleware (ROUTER_API_KEYS)
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const crypto = require('crypto');
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

// ─── Environment Resolution ──────────────────────────────────────────────────
function loadEnv() {
  const envPaths = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env'),
  ];
  if (process.platform === 'win32') {
    envPaths.push('C:/Users/jack/missed-call-agent/.env');
    envPaths.push('C:/Users/jack/Projects/master-hustle-engine/.env');
  }
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
          if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
          }
        }
      } catch (e) {}
    }
  }
}
loadEnv();

// ─── Production Model Identifiers (Cheap + Strong per Provider) ───────────────
function getProviderModels() {
  return {
    tiers: {
      gemini: {
        get cheap() { return process.env.GEMINI_MODEL || process.env.GEMINI_CHEAP_MODEL || 'gemini-3.5-flash-lite'; },
        get strong() { return process.env.GEMINI_FLAGSHIP_MODEL || process.env.GEMINI_STRONG_MODEL || 'gemini-3.8-flash'; }
      },
      openai: {
        get cheap() { return process.env.OPENAI_MINI_MODEL || process.env.OPENAI_CHEAP_MODEL || 'gpt-4o-mini'; },
        get strong() { return process.env.OPENAI_MODEL || process.env.OPENAI_STRONG_MODEL || 'gpt-4o'; }
      },
      claude: {
        get cheap() { return process.env.CLAUDE_HAIKU_MODEL || process.env.CLAUDE_CHEAP_MODEL || 'claude-haiku-4-5-20251001'; },
        get strong() { return process.env.CLAUDE_MODEL || process.env.CLAUDE_STRONG_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'; }
      },
      openrouter: {
        get cheap() { return process.env.OPENROUTER_CHEAP_MODEL || 'google/gemini-3.5-flash-lite'; },
        get strong() { return process.env.OPENROUTER_MODEL || process.env.OPENROUTER_STRONG_MODEL || 'anthropic/claude-sonnet-4.6'; }
      }
    },
    // Top-level aliases for backward compatibility
    get gemini() { return this.tiers.gemini.cheap; },
    get geminiFlagship() { return this.tiers.gemini.strong; },
    get openai() { return this.tiers.openai.strong; },
    get openaiMini() { return this.tiers.openai.cheap; },
    get claude() { return this.tiers.claude.strong; },
    get claudeLatest() { return 'claude-sonnet-4-6'; },
    get claudeHaiku() { return this.tiers.claude.cheap; },
    get openrouter() { return this.tiers.openrouter.strong; }
  };
}

const PROVIDER_MODELS = getProviderModels();

// ─── Model Pricing Table (USD per 1,000,000 tokens) ──────────────────────────
const MODEL_PRICING = {
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'google/gemini-3.5-flash-lite': { input: 0.30, output: 2.50 },
  'anthropic/claude-sonnet-4.6': { input: 3.00, output: 15.00 }
};

// Strong-model baseline for measured savings comparison (default: gpt-4o flagship)
const BASELINE_STRONG_MODEL = process.env.ROUTER_BASELINE_MODEL || 'gpt-4o';
const BASELINE_RATES = MODEL_PRICING[BASELINE_STRONG_MODEL] || { input: 2.50, output: 10.00 };

// ─── Token & Cost Calculations ────────────────────────────────────────────────
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function calculateRequestCost({ model, inputTokens, outputTokens }) {
  const inTok = Number(inputTokens) || 0;
  const outTok = Number(outputTokens) || 0;
  const rates = MODEL_PRICING[model];

  // If model is unknown, do not guess a price - exclude from savings math
  if (!rates) {
    return {
      inputTokens: inTok,
      outputTokens: outTok,
      totalTokens: inTok + outTok,
      actualCostUSD: null,
      baselineCostUSD: null,
      savingsUSD: null,
      savingsPct: null,
      excludedFromSavings: true
    };
  }

  const actualCostUSD = ((inTok * rates.input) + (outTok * rates.output)) / 1000000;
  const baselineCostUSD = ((inTok * BASELINE_RATES.input) + (outTok * BASELINE_RATES.output)) / 1000000;
  const savingsUSD = Math.max(0, baselineCostUSD - actualCostUSD);
  const savingsPct = baselineCostUSD > 0 ? ((baselineCostUSD - actualCostUSD) / baselineCostUSD) * 100 : 0;

  return {
    inputTokens: inTok,
    outputTokens: outTok,
    totalTokens: inTok + outTok,
    actualCostUSD: Number(actualCostUSD.toFixed(7)),
    baselineCostUSD: Number(baselineCostUSD.toFixed(7)),
    savingsUSD: Number(savingsUSD.toFixed(7)),
    savingsPct: Number(savingsPct.toFixed(1)),
    excludedFromSavings: false
  };
}

// ─── In-Memory Real Telemetry ─────────────────────────────────────────────────
const routerTelemetry = {
  totalDispatches: 0,
  successfulDispatches: 0,
  failedDispatches: 0,
  failoverEvents: 0,
  dispatchesByProvider: {
    gemini: 0,
    openai: 0,
    claude: 0,
    openrouter: 0
  },
  dispatchesByTier: {
    cheap: 0,
    strong: 0
  },
  tokens: {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0
  },
  costs: {
    totalActualCostUSD: 0,
    totalBaselineCostUSD: 0,
    totalSavingsUSD: 0,
    measuredSavingsPct: "0.0%"
  },
  lastFailover: null,
  probes: {},
  lastProbedAt: null,
  recentRequests: []
};

function recordTelemetrySuccess({ provider, model, tier, task, inputTokens, outputTokens, latencyMs }) {
  const costData = calculateRequestCost({ model, inputTokens, outputTokens });

  routerTelemetry.totalDispatches++;
  routerTelemetry.successfulDispatches++;
  routerTelemetry.dispatchesByProvider[provider] = (routerTelemetry.dispatchesByProvider[provider] || 0) + 1;
  routerTelemetry.dispatchesByTier[tier] = (routerTelemetry.dispatchesByTier[tier] || 0) + 1;

  routerTelemetry.tokens.totalInputTokens += costData.inputTokens;
  routerTelemetry.tokens.totalOutputTokens += costData.outputTokens;
  routerTelemetry.tokens.totalTokens += costData.totalTokens;

  if (!costData.excludedFromSavings && costData.actualCostUSD !== null) {
    routerTelemetry.costs.totalActualCostUSD += costData.actualCostUSD;
    routerTelemetry.costs.totalBaselineCostUSD += costData.baselineCostUSD;
    routerTelemetry.costs.totalSavingsUSD += costData.savingsUSD;

    if (routerTelemetry.costs.totalBaselineCostUSD > 0) {
      const overallPct = ((routerTelemetry.costs.totalBaselineCostUSD - routerTelemetry.costs.totalActualCostUSD) / routerTelemetry.costs.totalBaselineCostUSD) * 100;
      routerTelemetry.costs.measuredSavingsPct = `${overallPct.toFixed(1)}%`;
    }
  }

  const logItem = {
    timestamp: new Date().toISOString(),
    provider,
    model,
    tier,
    task: task || 'DEFAULT',
    tokens: {
      input: costData.inputTokens,
      output: costData.outputTokens,
      total: costData.totalTokens
    },
    costs: {
      actualCostUSD: costData.actualCostUSD,
      baselineCostUSD: costData.baselineCostUSD,
      savingsUSD: costData.savingsUSD,
      savingsPct: costData.savingsPct
    },
    latencyMs,
    success: true
  };

  routerTelemetry.recentRequests.unshift(logItem);
  if (routerTelemetry.recentRequests.length > 50) {
    routerTelemetry.recentRequests.pop();
  }

  return costData;
}

function recordTelemetryFailure({ task, attempts, latencyMs, error }) {
  routerTelemetry.totalDispatches++;
  routerTelemetry.failedDispatches++;

  const logItem = {
    timestamp: new Date().toISOString(),
    task: task || 'DEFAULT',
    error: error || 'All providers failed',
    attempts,
    latencyMs,
    success: false
  };

  routerTelemetry.recentRequests.unshift(logItem);
  if (routerTelemetry.recentRequests.length > 50) {
    routerTelemetry.recentRequests.pop();
  }
}

// ─── Mock Dispatcher Hook for Testing ─────────────────────────────────────────
let customMockDispatcher = null;
function setMockDispatcher(fn) {
  customMockDispatcher = fn;
}
function resetMockDispatcher() {
  customMockDispatcher = null;
}

// ─── API Pool Parser ──────────────────────────────────────────────────────────
function parseApiPool() {
  const pool = [];
  const seen = new Set();
  const raw = process.env.API_POOL || '';
  
  if (raw) {
    const entries = raw.split(',').map(e => e.trim()).filter(Boolean);
    for (const entry of entries) {
      const idx = entry.indexOf(':');
      if (idx > 0) {
        const provider = entry.slice(0, idx).toLowerCase().trim();
        const apiKey = entry.slice(idx + 1).trim();
        if (!seen.has(provider)) {
          seen.add(provider);
          pool.push({ provider, apiKey });
        }
      }
    }
  }

  // Gemini
  if (!seen.has('gemini') && process.env.GEMINI_API_KEY) {
    seen.add('gemini');
    pool.push({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY });
  }

  // OpenAI
  if (!seen.has('openai') && process.env.OPENAI_API_KEY) {
    seen.add('openai');
    pool.push({ provider: 'openai', apiKey: process.env.OPENAI_API_KEY });
  }

  // Claude / Anthropic
  if (!seen.has('claude') && (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY)) {
    seen.add('claude');
    pool.push({ provider: 'claude', apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY });
  }

  // OpenRouter
  if (!seen.has('openrouter') && process.env.OPENROUTER_API_KEY) {
    seen.add('openrouter');
    pool.push({ provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY });
  }

  return pool;
}

// ─── HTTPS Request Helper with Strict Timeout ─────────────────────────────────
function requestJson(urlStr, options, postData) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const reqOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        family: 4,
        headers: options.headers || {},
        timeout: options.timeout || 12000
      };

      const req = https.request(reqOptions, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ status: res.statusCode, data: parsed, headers: res.headers });
          } catch (e) {
            resolve({ status: res.statusCode, raw: body, headers: res.headers });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('HTTP request timed out');
        err.code = 'ETIMEDOUT';
        err.status = 504;
        reject(err);
      });

      req.on('error', err => reject(err));

      if (postData) {
        req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
      }
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ─── Provider Dispatchers ─────────────────────────────────────────────────────

async function dispatchGemini({ apiKey, model, tier }, prompt, systemPrompt) {
  const selectedModel = model || PROVIDER_MODELS.tiers.gemini[tier || 'cheap'];
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;
  const contents = [];
  if (systemPrompt) {
    contents.push({ role: 'user', parts: [{ text: `SYSTEM INSTRUCTIONS: ${systemPrompt}` }] });
  }
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const res = await requestJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  }, { contents });

  if (res.status !== 200) {
    const err = new Error(res.data?.error?.message || `Gemini error HTTP ${res.status}`);
    err.status = res.status;
    err.provider = 'gemini';
    throw err;
  }

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) {
    const err = new Error('Gemini returned empty output');
    err.status = 204;
    err.provider = 'gemini';
    throw err;
  }

  const inputTokens = res.data?.usageMetadata?.promptTokenCount || estimateTokens(prompt + (systemPrompt || ''));
  const outputTokens = res.data?.usageMetadata?.candidatesTokenCount || estimateTokens(text);

  return {
    text,
    provider: 'gemini',
    model: selectedModel,
    tier: tier || 'cheap',
    inputTokens,
    outputTokens
  };
}

async function dispatchOpenAI({ apiKey, model, tier }, prompt, systemPrompt) {
  const selectedModel = model || PROVIDER_MODELS.tiers.openai[tier || 'cheap'];
  const endpoint = 'https://api.openai.com/v1/chat/completions';
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const res = await requestJson(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 12000
  }, {
    model: selectedModel,
    messages,
    temperature: 0.7
  });

  if (res.status !== 200) {
    const err = new Error(res.data?.error?.message || `OpenAI error HTTP ${res.status}`);
    err.status = res.status;
    err.provider = 'openai';
    throw err;
  }

  const text = res.data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    const err = new Error('OpenAI returned empty output');
    err.status = 204;
    err.provider = 'openai';
    throw err;
  }

  const inputTokens = res.data?.usage?.prompt_tokens || estimateTokens(prompt + (systemPrompt || ''));
  const outputTokens = res.data?.usage?.completion_tokens || estimateTokens(text);

  return {
    text,
    provider: 'openai',
    model: selectedModel,
    tier: tier || 'cheap',
    inputTokens,
    outputTokens
  };
}

async function dispatchClaude({ apiKey, model, tier }, prompt, systemPrompt) {
  const selectedModel = model || PROVIDER_MODELS.tiers.claude[tier || 'cheap'];
  const endpoint = 'https://api.anthropic.com/v1/messages';
  const payload = {
    model: selectedModel,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  };
  if (systemPrompt) payload.system = systemPrompt;

  const res = await requestJson(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    timeout: 12000
  }, payload);

  if (res.status !== 200) {
    const err = new Error(res.data?.error?.message || `Claude error HTTP ${res.status}`);
    err.status = res.status;
    err.provider = 'claude';
    throw err;
  }

  const text = res.data?.content?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) {
    const err = new Error('Claude returned empty output');
    err.status = 204;
    err.provider = 'claude';
    throw err;
  }

  const inputTokens = res.data?.usage?.input_tokens || estimateTokens(prompt + (systemPrompt || ''));
  const outputTokens = res.data?.usage?.output_tokens || estimateTokens(text);

  return {
    text,
    provider: 'claude',
    model: selectedModel,
    tier: tier || 'cheap',
    inputTokens,
    outputTokens
  };
}

async function dispatchOpenRouter({ apiKey, model, tier }, prompt, systemPrompt) {
  const selectedModel = model || PROVIDER_MODELS.tiers.openrouter[tier || 'cheap'];
  const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const res = await requestJson(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://master-hustle-engine.onrender.com',
      'X-Title': 'Master Hustle Engine',
      'Content-Type': 'application/json'
    },
    timeout: 12000
  }, {
    model: selectedModel,
    messages
  });

  if (res.status !== 200) {
    const err = new Error(res.data?.error?.message || `OpenRouter error HTTP ${res.status}`);
    err.status = res.status;
    err.provider = 'openrouter';
    throw err;
  }

  const text = res.data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    const err = new Error('OpenRouter returned empty output');
    err.status = 204;
    err.provider = 'openrouter';
    throw err;
  }

  const inputTokens = res.data?.usage?.prompt_tokens || estimateTokens(prompt + (systemPrompt || ''));
  const outputTokens = res.data?.usage?.completion_tokens || estimateTokens(text);

  return {
    text,
    provider: 'openrouter',
    model: selectedModel,
    tier: tier || 'cheap',
    inputTokens,
    outputTokens
  };
}

// ─── Lightweight Dry Run Connectivity Probe ──────────────────────────────────
async function probeProvider(provider, apiKey, options = {}) {
  const timeoutMs = options.timeoutMs || 4000;
  const startedAt = Date.now();

  if (!apiKey || apiKey.startsWith('mock_')) {
    return {
      provider,
      status: 'NOT_CONFIGURED',
      reachable: false,
      latencyMs: 0,
      details: 'No live API key configured in environment'
    };
  }

  try {
    if (provider === 'openai') {
      const res = await requestJson('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'User-Agent': 'MasterHustleEngine-Probe/1.0'
        },
        timeout: timeoutMs
      });

      const latencyMs = Date.now() - startedAt;

      if (res.status === 200) {
        return { provider: 'openai', status: 'OPENAI_OK', reachable: true, latencyMs };
      }
      if (res.status === 401) {
        return { provider: 'openai', status: 'INVALID_KEY', reachable: false, latencyMs, error: res.data?.error?.message || 'Unauthorized' };
      }
      if (res.status === 429) {
        const msg = String(res.data?.error?.message || '').toLowerCase();
        const code = String(res.data?.error?.code || '').toLowerCase();
        if (code === 'insufficient_quota' || msg.includes('quota') || msg.includes('balance') || msg.includes('billing')) {
          return { provider: 'openai', status: 'ZERO_BALANCE', reachable: true, latencyMs, error: res.data?.error?.message };
        }
        return { provider: 'openai', status: 'OPENAI_RATE_LIMITED', reachable: true, latencyMs };
      }
      return { provider: 'openai', status: `HTTP_${res.status}`, reachable: false, latencyMs, error: res.data?.error?.message };
    }

    if (provider === 'claude' || provider === 'anthropic') {
      const res = await requestJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          'User-Agent': 'MasterHustleEngine-Probe/1.0'
        },
        timeout: timeoutMs
      }, {
        model: PROVIDER_MODELS.tiers.claude.cheap,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }]
      });

      const latencyMs = Date.now() - startedAt;

      if (res.status === 200) {
        return { provider: 'claude', status: 'ANTHROPIC_OK', reachable: true, latencyMs };
      }
      if (res.status === 401) {
        return { provider: 'claude', status: 'INVALID_KEY', reachable: false, latencyMs, error: res.data?.error?.message || 'Unauthorized' };
      }
      const errLower = JSON.stringify(res.data || '').toLowerCase();
      if (res.status === 400 || res.status === 429) {
        if (errLower.includes('credit') || errLower.includes('balance') || errLower.includes('quota')) {
          return { provider: 'claude', status: 'ZERO_BALANCE', reachable: true, latencyMs, error: res.data?.error?.message };
        }
      }
      return { provider: 'claude', status: `HTTP_${res.status}`, reachable: false, latencyMs, error: res.data?.error?.message };
    }

    if (provider === 'gemini') {
      const probeModel = PROVIDER_MODELS.tiers.gemini.cheap;
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${probeModel}?key=${apiKey}`;
      const res = await requestJson(endpoint, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeout: timeoutMs
      });

      const latencyMs = Date.now() - startedAt;

      if (res.status === 200) {
        return { provider: 'gemini', status: 'GEMINI_OK', reachable: true, latencyMs };
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        const msg = JSON.stringify(res.data || '').toLowerCase();
        if (msg.includes('api_key_invalid') || msg.includes('invalid') || msg.includes('unregistered')) {
          return { provider: 'gemini', status: 'INVALID_KEY', reachable: false, latencyMs, error: res.data?.error?.message };
        }
      }
      if (res.status === 429) {
        return { provider: 'gemini', status: 'ZERO_BALANCE', reachable: true, latencyMs, error: 'Quota or rate limit' };
      }
      return { provider: 'gemini', status: `HTTP_${res.status}`, reachable: false, latencyMs };
    }

    if (provider === 'openrouter') {
      const res = await requestJson('https://openrouter.ai/api/v1/auth/key', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'User-Agent': 'MasterHustleEngine-Probe/1.0'
        },
        timeout: timeoutMs
      });
      const latencyMs = Date.now() - startedAt;
      if (res.status === 200) {
        return { provider: 'openrouter', status: 'OPENROUTER_OK', reachable: true, latencyMs };
      }
      if (res.status === 401) {
        return { provider: 'openrouter', status: 'INVALID_KEY', reachable: false, latencyMs, error: res.data?.error?.message || 'Unauthorized' };
      }
      return { provider: 'openrouter', status: `HTTP_${res.status}`, reachable: false, latencyMs, error: res.data?.error?.message };
    }

    return { provider, status: 'UNKNOWN_PROVIDER', reachable: false, latencyMs: 0 };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const isTimeout = err.code === 'ETIMEDOUT';
    return {
      provider,
      status: isTimeout ? 'TIMEOUT' : 'UNREACHABLE',
      reachable: false,
      latencyMs,
      error: err.message
    };
  }
}

async function probeAllProviders() {
  const pool = parseApiPool();
  const poolMap = new Map();
  for (const entry of pool) {
    poolMap.set(entry.provider, entry.apiKey);
  }

  // Ensure standard providers (including openrouter) are evaluated so status and diagnostics exist
  const coreProviders = ['gemini', 'openai', 'claude', 'openrouter'];

  const results = {};

  for (const provider of coreProviders) {
    const key = poolMap.get(provider) || null;
    const probe = await probeProvider(provider, key);
    results[provider] = probe;
    console.log(`[Router Probe] ${provider.toUpperCase()} Status: ${probe.status} (${probe.latencyMs}ms)${probe.reachable ? ' [REACHABLE]' : ''}${probe.error ? ` - ${probe.error}` : ''}`);
  }

  routerTelemetry.probes = results;
  routerTelemetry.lastProbedAt = new Date().toISOString();
  return results;
}

// ─── Real-Cost Multi-Model Failover Router ─────────────────────────────────────
/**
 * Real Cost Routing:
 * 1. Sends request to the cheapest model capable of handling it (cheap tier).
 * 2. If cheap models fail or return empty output, cascades across remaining cheap providers.
 * 3. If all cheap providers fail or return empty output, escalates to strong tier models in cost order.
 * 4. Never fakes output: if all fail, returns success: false with real error status.
 * 5. Logs real token counts and computes measured savings against strong-model baseline (gpt-4o).
 */
async function routeMultiModel({
  prompt,
  systemPrompt,
  preferredProvider,
  tier = 'auto',
  task = 'COPYWRITING',
  mock = false,
  isTest = false,
  skipStats = false
} = {}) {
  const startedAt = Date.now();
  const attempts = [];
  const isMockOrTest = Boolean(mock || isTest || skipStats || task === 'test' || task === 'TEST');

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return {
      success: false,
      error: 'Invalid prompt: prompt must be a non-empty string',
      attempts: [],
      latencyMs: 0
    };
  }

  // Active pool of configured providers
  const pool = parseApiPool();

  // Task / Tier Complexity determination
  const isExplicitStrong = tier === 'strong' ||
    task === 'FLAGSHIP_PRO' ||
    task === 'MANUAL_SALES_COPY' ||
    task === 'COMPLEX_REASONING' ||
    task === 'ENTERPRISE_DEAL';

  function getModelPriceScore(model) {
    const p = MODEL_PRICING[model];
    if (!p) return 999999;
    return (p.input * 3 + p.output) / 4;
  }

  // Build Cost-Ordered Candidate Chain - Cheap tier ordered by real price
  const cheapCandidates = [
    { provider: 'gemini', tier: 'cheap', model: PROVIDER_MODELS.tiers.gemini.cheap },
    { provider: 'openrouter', tier: 'cheap', model: PROVIDER_MODELS.tiers.openrouter.cheap },
    { provider: 'openai', tier: 'cheap', model: PROVIDER_MODELS.tiers.openai.cheap },
    { provider: 'claude', tier: 'cheap', model: PROVIDER_MODELS.tiers.claude.cheap }
  ].sort((a, b) => getModelPriceScore(a.model) - getModelPriceScore(b.model));

  // Strong tier ordered by real price
  const strongCandidates = [
    { provider: 'gemini', tier: 'strong', model: PROVIDER_MODELS.tiers.gemini.strong },
    { provider: 'openai', tier: 'strong', model: PROVIDER_MODELS.tiers.openai.strong },
    { provider: 'claude', tier: 'strong', model: PROVIDER_MODELS.tiers.claude.strong },
    { provider: 'openrouter', tier: 'strong', model: PROVIDER_MODELS.tiers.openrouter.strong }
  ].sort((a, b) => getModelPriceScore(a.model) - getModelPriceScore(b.model));

  function reorderWithPreferred(list, pref) {
    if (!pref) return list;
    const norm = String(pref).toLowerCase().trim();
    return [...list].sort((a, b) => (a.provider === norm ? -1 : b.provider === norm ? 1 : 0));
  }

  // Determine candidate sequence:
  // If explicitly strong, start directly with strong tier.
  // Otherwise, cheap tier candidates first, then escalate to strong tier.
  let executionPlan = [];
  if (isExplicitStrong) {
    executionPlan = reorderWithPreferred(strongCandidates, preferredProvider);
  } else {
    executionPlan = [
      ...reorderWithPreferred(cheapCandidates, preferredProvider),
      ...reorderWithPreferred(strongCandidates, preferredProvider)
    ];
  }

  // Filter candidates to available keys (or allow all if mock dispatcher is configured)
  const keyMap = new Map();
  for (const p of pool) {
    keyMap.set(p.provider, p.apiKey);
  }

  // Handle mock dispatcher or testing simulation
  if (customMockDispatcher || mock) {
    for (let i = 0; i < executionPlan.length; i++) {
      const candidate = executionPlan[i];
      const attemptStart = Date.now();

      try {
        let mockResult = null;
        if (customMockDispatcher) {
          mockResult = await customMockDispatcher({
            provider: candidate.provider,
            tier: candidate.tier,
            model: candidate.model,
            prompt,
            systemPrompt,
            task,
            index: i
          });
        } else {
          // Default built-in test mock simulation
          mockResult = {
            text: `Output from ${candidate.provider} (${candidate.model}) for ${task}`,
            inputTokens: estimateTokens(prompt),
            outputTokens: 25
          };
        }

        // Validate mock result
        if (!mockResult || !mockResult.text || !mockResult.text.trim()) {
          throw new Error(`Empty output from ${candidate.provider} (${candidate.model})`);
        }

        const inputTokens = mockResult.inputTokens || estimateTokens(prompt);
        const outputTokens = mockResult.outputTokens || estimateTokens(mockResult.text);
        const latencyMs = Date.now() - startedAt;

        let costData;
        if (!isMockOrTest) {
          costData = recordTelemetrySuccess({
            provider: candidate.provider,
            model: candidate.model,
            tier: candidate.tier,
            task,
            inputTokens,
            outputTokens,
            latencyMs
          });
        } else {
          // Do NOT record test or mock calls in telemetry stats
          costData = calculateRequestCost({
            model: candidate.model,
            inputTokens,
            outputTokens
          });
        }

        return {
          success: true,
          mode: isMockOrTest ? 'mock_simulation' : 'live_dispatch',
          provider: candidate.provider,
          model: candidate.model,
          tier: candidate.tier,
          task,
          output: mockResult.text,
          tokens: {
            inputTokens: costData.inputTokens,
            outputTokens: costData.outputTokens,
            totalTokens: costData.totalTokens
          },
          cost: {
            actualCostUSD: costData.actualCostUSD,
            baselineCostUSD: costData.baselineCostUSD,
            savingsUSD: costData.savingsUSD,
            savingsPct: costData.savingsPct,
            baselineModel: BASELINE_STRONG_MODEL
          },
          latencyMs: Date.now() - startedAt,
          attempts
        };

      } catch (err) {
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          tier: candidate.tier,
          error: err.message,
          status: err.status || 500,
          durationMs: Date.now() - attemptStart
        });
        routerTelemetry.failoverEvents++;
        routerTelemetry.lastFailover = {
          failedProvider: candidate.provider,
          error: err.message,
          timestamp: new Date().toISOString()
        };
        continue;
      }
    }

    // All mocked candidates failed: Real error, NEVER fake output
    if (!isMockOrTest) {
      recordTelemetryFailure({ task, attempts, latencyMs: Date.now() - startedAt, error: 'All mock providers failed' });
    }
    return {
      success: false,
      error: 'All providers failed or returned empty output',
      task,
      attempts,
      latencyMs: Date.now() - startedAt
    };
  }

  // Live execution against configured pool
  for (let i = 0; i < executionPlan.length; i++) {
    const candidate = executionPlan[i];
    const apiKey = keyMap.get(candidate.provider);

    // Skip unconfigured providers
    if (!apiKey) {
      continue;
    }

    const attemptStart = Date.now();

    try {
      let result = null;
      switch (candidate.provider) {
        case 'gemini':
          result = await dispatchGemini({ apiKey, model: candidate.model, tier: candidate.tier }, prompt, systemPrompt);
          break;
        case 'openai':
          result = await dispatchOpenAI({ apiKey, model: candidate.model, tier: candidate.tier }, prompt, systemPrompt);
          break;
        case 'claude':
        case 'anthropic':
          result = await dispatchClaude({ apiKey, model: candidate.model, tier: candidate.tier }, prompt, systemPrompt);
          break;
        case 'openrouter':
          result = await dispatchOpenRouter({ apiKey, model: candidate.model, tier: candidate.tier }, prompt, systemPrompt);
          break;
        default:
          throw new Error(`Unsupported provider: ${candidate.provider}`);
      }

      // Check for empty output
      if (!result.text || !result.text.trim()) {
        throw new Error(`Empty output received from ${candidate.provider} (${candidate.model})`);
      }

      const latencyMs = Date.now() - startedAt;
      let costData;
      if (!isMockOrTest) {
        costData = recordTelemetrySuccess({
          provider: candidate.provider,
          model: candidate.model,
          tier: candidate.tier,
          task,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs
        });
      } else {
        costData = calculateRequestCost({
          model: candidate.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens
        });
      }

      return {
        success: true,
        mode: 'live_dispatch',
        provider: candidate.provider,
        model: candidate.model,
        tier: candidate.tier,
        task,
        output: result.text,
        tokens: {
          inputTokens: costData.inputTokens,
          outputTokens: costData.outputTokens,
          totalTokens: costData.totalTokens
        },
        cost: {
          actualCostUSD: costData.actualCostUSD,
          baselineCostUSD: costData.baselineCostUSD,
          savingsUSD: costData.savingsUSD,
          savingsPct: costData.savingsPct,
          baselineModel: BASELINE_STRONG_MODEL
        },
        latencyMs,
        attempts
      };

    } catch (err) {
      const status = err.status || (err.code === 'ETIMEDOUT' ? 504 : 500);
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        tier: candidate.tier,
        error: err.message,
        status,
        durationMs: Date.now() - attemptStart
      });

      routerTelemetry.failoverEvents++;
      routerTelemetry.lastFailover = {
        failedProvider: candidate.provider,
        failedModel: candidate.model,
        tier: candidate.tier,
        error: err.message,
        status,
        timestamp: new Date().toISOString()
      };

      console.warn(`[MultiModelRouter] ${candidate.provider} (${candidate.model}, tier=${candidate.tier}) failed: ${err.message}. Cascading to next candidate...`);
      continue;
    }
  }

  // All live providers exhausted: Return real error. NEVER FAKE OUTPUT.
  const finalLatency = Date.now() - startedAt;
  if (!isMockOrTest) {
    recordTelemetryFailure({
      task,
      attempts,
      latencyMs: finalLatency,
      error: attempts.length ? 'All configured providers failed or returned empty output' : 'No live providers configured in environment'
    });
  }

  return {
    success: false,
    error: attempts.length ? 'All configured providers failed or returned empty output' : 'No live providers configured in environment',
    task,
    attempts,
    latencyMs: finalLatency
  };
}

// ─── Health Check & Telemetry Status ──────────────────────────────────────────
function getRouterStatus() {
  const pool = parseApiPool();
  const configured = [...new Set(pool.map(p => p.provider))];
  const probes = routerTelemetry.probes || {};

  const geminiProbe = probes.gemini || {
    reachable: !!process.env.GEMINI_API_KEY,
    status: process.env.GEMINI_API_KEY ? 'GEMINI_OK' : 'NOT_CONFIGURED',
    latencyMs: 0
  };
  const openaiProbe = probes.openai || {
    reachable: false,
    status: process.env.OPENAI_API_KEY ? 'PENDING_PROBE' : 'NOT_CONFIGURED',
    latencyMs: 0
  };
  const claudeProbe = probes.claude || {
    reachable: (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) ? false : false,
    status: (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) ? 'PENDING_PROBE' : 'NOT_CONFIGURED',
    latencyMs: 0
  };
  const openrouterProbe = probes.openrouter || {
    reachable: false,
    status: process.env.OPENROUTER_API_KEY ? 'PENDING_PROBE' : 'NOT_CONFIGURED',
    latencyMs: 0
  };

  const isGeminiReachable = geminiProbe.reachable;
  const isOpenAiReachable = openaiProbe.reachable;
  const isClaudeReachable = claudeProbe.reachable;
  const isOpenRouterReachable = openrouterProbe.reachable;
  const anyReachable = isGeminiReachable || isOpenAiReachable || isClaudeReachable || isOpenRouterReachable;

  const latencies = Object.values(probes).filter(p => p && p.latencyMs > 0).map(p => p.latencyMs);
  const averageLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  // Don't report "healthy" when no providers are configured in the environment
  let overallStatus = 'offline';
  if (configured.length === 0) {
    overallStatus = 'unconfigured';
  } else if (anyReachable) {
    overallStatus = isGeminiReachable ? 'healthy' : 'degraded';
  } else {
    overallStatus = 'degraded';
  }

  // Sanitize public probes: drop provider error text and internal details
  const publicProbes = {
    gemini: {
      provider: 'gemini',
      status: geminiProbe.status,
      reachable: !!geminiProbe.reachable,
      latencyMs: geminiProbe.latencyMs || 0
    },
    openai: {
      provider: 'openai',
      status: openaiProbe.status,
      reachable: !!openaiProbe.reachable,
      latencyMs: openaiProbe.latencyMs || 0
    },
    claude: {
      provider: 'claude',
      status: claudeProbe.status,
      reachable: !!claudeProbe.reachable,
      latencyMs: claudeProbe.latencyMs || 0
    },
    openrouter: {
      provider: 'openrouter',
      status: openrouterProbe.status,
      reachable: !!openrouterProbe.reachable,
      latencyMs: openrouterProbe.latencyMs || 0
    }
  };

  return {
    status: overallStatus,
    primaryProvider: PROVIDER_MODELS.tiers.gemini.cheap,
    secondaryProvider: PROVIDER_MODELS.tiers.openrouter.cheap,
    tertiaryProvider: PROVIDER_MODELS.tiers.openai.cheap,
    configuredProviders: configured,
    activeChain: 'gemini (cheap) -> openrouter (cheap) -> openai (cheap) -> claude (cheap) -> escalation: gemini (strong) -> openai (strong) -> claude (strong) -> openrouter (strong)',
    modelTiers: PROVIDER_MODELS.tiers,
    defaultModels: PROVIDER_MODELS,
    baselineModel: BASELINE_STRONG_MODEL,
    reachability: {
      gemini: isGeminiReachable,
      openai: isOpenAiReachable,
      claude: isClaudeReachable,
      openrouter: isOpenRouterReachable
    },
    probes: publicProbes,
    averageLatencyMs,
    telemetry: {
      totalDispatches: routerTelemetry.totalDispatches,
      successfulDispatches: routerTelemetry.successfulDispatches,
      failedDispatches: routerTelemetry.failedDispatches,
      failoverEvents: routerTelemetry.failoverEvents,
      dispatchesByProvider: routerTelemetry.dispatchesByProvider,
      dispatchesByTier: routerTelemetry.dispatchesByTier,
      tokens: {
        totalInputTokens: routerTelemetry.tokens.totalInputTokens,
        totalOutputTokens: routerTelemetry.tokens.totalOutputTokens,
        totalTokens: routerTelemetry.tokens.totalTokens
      },
      costs: {
        actualCostUSD: Number(routerTelemetry.costs.totalActualCostUSD.toFixed(6)),
        baselineCostUSD: Number(routerTelemetry.costs.totalBaselineCostUSD.toFixed(6)),
        savingsUSD: Number(routerTelemetry.costs.totalSavingsUSD.toFixed(6)),
        measuredSavingsPct: routerTelemetry.costs.measuredSavingsPct
      }
      // Note: recentRequests is intentionally excluded from public status output
    }
  };
}

// ─── Constant-Time Key Comparator ─────────────────────────────────────────────
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Router API Key Verification Middleware ────────────────────────────────────
/**
 * Require valid API key header on router dispatch endpoints (env ROUTER_API_KEYS).
 * Accepts x-api-key, x-router-api-key, or Authorization: Bearer <key>.
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 * Fails closed with 503 if ROUTER_API_KEYS is not configured.
 * Fails with 401 if key is missing or invalid.
 */
function requireRouterApiKey(req, res, next) {
  const routerKeysEnv = process.env.ROUTER_API_KEYS;
  if (!routerKeysEnv || !routerKeysEnv.trim()) {
    return res.status(503).json({
      success: false,
      error: 'ERR_ROUTER_KEYS_UNCONFIGURED',
      message: 'Router dispatch is disabled: ROUTER_API_KEYS is not configured on this server'
    });
  }

  const validKeys = routerKeysEnv.split(',').map(k => k.trim()).filter(Boolean);

  let providedKey = req.headers['x-api-key'] || req.headers['x-router-api-key'];
  if (!providedKey && req.headers['authorization']) {
    const auth = req.headers['authorization'];
    const parts = auth.split(' ');
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
      providedKey = parts[1];
    } else {
      providedKey = auth;
    }
  }

  const isAuthorized = !!providedKey && validKeys.some(validKey => safeCompare(providedKey, validKey));

  if (!isAuthorized) {
    return res.status(401).json({
      success: false,
      error: 'ERR_UNAUTHORIZED',
      message: 'Unauthorized: Missing or invalid router API key in x-api-key or Authorization header'
    });
  }

  if (typeof next === 'function') next();
  return true;
}

module.exports = {
  routeMultiModel,
  getRouterStatus,
  parseApiPool,
  probeProvider,
  probeAllProviders,
  calculateRequestCost,
  requireRouterApiKey,
  setMockDispatcher,
  resetMockDispatcher,
  PROVIDER_MODELS,
  MODEL_PRICING,
  BASELINE_STRONG_MODEL,
  routerTelemetry
};
