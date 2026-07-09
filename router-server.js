'use strict';

/**
 * AI Failover Router — Standalone Service
 * Sold as its own product, deployed on its own Render service.
 * Exposes the 3-Tier Intelligent Router (Gemini → OpenAI → Anthropic)
 * behind a simple authenticated HTTP API.
 *
 * Start command: node router-server.js
 * Required env vars:
 *   ROUTER_API_KEY — shared secret; callers must send it as x-api-key
 *   API_POOL       — "gemini:KEY1,openai:KEY2,anthropic:KEY3"
 * Optional (for the built-in comms tools):
 *   GMAIL_HTTP_URL, GMAIL_HTTP_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 */

const express = require('express');
const { routePrompt, send_email, send_sms } = require('./agent.skills/intelligent-router');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 10000;

function requireApiKey(req, res, next) {
  const key = process.env.ROUTER_API_KEY;
  if (!key || req.headers['x-api-key'] !== key) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'ai-failover-router' });
});

// Main endpoint: send a prompt, get a completion — provider failover handled automatically
app.post('/route', requireApiKey, async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Missing "prompt" in request body' });
  try {
    const text = await routePrompt(prompt);
    res.json({ text });
  } catch (err) {
    console.error('[Router Service] route failed:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/send-email', requireApiKey, async (req, res) => {
  const { to, subject, body } = req.body || {};
  if (!to || !subject || !body) return res.status(400).json({ error: 'Requires "to", "subject", "body"' });
  try {
    res.json(await send_email(to, subject, body));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/send-sms', requireApiKey, async (req, res) => {
  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: 'Requires "to", "message"' });
  try {
    res.json(await send_sms(to, message));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Router Service] AI Failover Router listening on port ${PORT}`);
});
