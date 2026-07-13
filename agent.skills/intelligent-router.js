'use strict';

/**
 * 3-Tier Intelligent Router
 * Tries each provider in API_POOL in order.
 * On 429 rate limit, logs the failure and falls back to the next provider.
 * Communication is restricted to send_email and send_sms — no outbound calls.
 */

const { GoogleGenAI } = require('@google/genai');

// Parse API_POOL from env: "gemini:KEY1,gemini:KEY2,openai:KEY3"
// Format per entry: "provider:apikey"
function parseApiPool() {
  const raw = process.env.API_POOL || '';
  if (!raw) return [];
  return raw.split(',').map(entry => {
    const [provider, ...rest] = entry.trim().split(':');
    return { provider: provider.trim(), apiKey: rest.join(':').trim() };
  });
}

// ─── Allowed communication tools ─────────────────────────────────────────────

async function send_email(to, subject, body) {
  const relayUrl = process.env.GMAIL_HTTP_URL;
  if (!relayUrl) throw new Error('GMAIL_HTTP_URL not set');
  const resp = await fetch(relayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject, body, key: process.env.GMAIL_HTTP_KEY }),
  });
  if (!resp.ok) throw new Error(`Email relay failed: ${resp.status}`);
  return { sent: true, to, subject };
}

async function send_sms(to, message) {
  // Twilio SMS — requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM in env
  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM;
  if (!sid || !token || !from) throw new Error('Twilio env vars not set (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)');
  const body = new URLSearchParams({ To: to, From: from, Body: message });
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!resp.ok) throw new Error(`SMS failed: ${resp.status}`);
  return { sent: true, to };
}

// Blocked — no outbound calls allowed
function make_phone_call() {
  throw new Error('[Router] Outbound phone calls are disabled. Use send_email or send_sms.');
}

// ─── Provider call wrapper ────────────────────────────────────────────────────

async function callProvider({ provider, apiKey }, prompt) {
  if (provider === 'gemini') {
    const ai = new GoogleGenAI({ apiKey });
    // Default to the flash-lite tier: the router only runs after the primary
    // flash model already failed, and retrying the same congested model is useless.
    const result = await ai.models.generateContent({
      model: process.env.GEMINI_ROUTER_MODEL || 'gemini-flash-lite-latest',
      contents: prompt,
    });
    return result.text;
  }

  if (provider === 'openai') {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const e = new Error(err.error?.message || `OpenAI error ${resp.status}`);
      e.status = resp.status;
      throw e;
    }
    const data = await resp.json();
    return data.choices[0].message.content;
  }

  if (provider === 'anthropic') {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const e = new Error(err.error?.message || `Anthropic error ${resp.status}`);
      e.status = resp.status;
      throw e;
    }
    const data = await resp.json();
    return data.content[0].text;
  }

  throw new Error(`Unknown provider: ${provider}`);
}

// ─── Main router ──────────────────────────────────────────────────────────────

async function routePrompt(prompt) {
  const pool = parseApiPool();

  if (!pool.length) {
    // Fallback: use GEMINI_API_KEY directly
    pool.push({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY });
  }

  let lastError;
  for (const entry of pool) {
    try {
      console.log(`[Router] Trying provider: ${entry.provider}`);
      const result = await callProvider(entry, prompt);
      console.log(`[Router] Success with provider: ${entry.provider}`);
      return result;
    } catch (err) {
      const isTransient = err.status === 429 || err.status === 503 ||
        /rate.?limit|quota|too many|high demand|unavailable/i.test(err.message);
      if (isTransient) {
        console.warn(`[Router] Transient error on ${entry.provider} — trying next provider`);
        lastError = err;
        continue;
      }
      throw err; // Non-transient errors bubble up immediately
    }
  }

  throw lastError || new Error('[Router] All providers in API_POOL exhausted');
}

module.exports = {
  routePrompt,
  send_email,
  send_sms,
  make_phone_call, // exported but throws — enforces the restriction
};
