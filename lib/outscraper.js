'use strict';
/**
 * lib/outscraper.js
 *
 * Minimal Outscraper REST client — zero dependencies (Node 18+ global fetch).
 * Replaces the Gumloop pipeline as the engine's lead source. Jack already has
 * an Outscraper account; the API key is the only credential.
 *
 * Endpoints used (verified against the official outscraper Python SDK v6):
 *   POST /google-maps-search   — places for a query, with optional enrichments
 *   GET  /email-validator      — deliverability check for a list of addresses
 *   GET  /requests/{id}        — poll an async request until status != Pending
 *
 * Auth header: X-API-KEY. Base URL falls back from .com to .cloud, as the SDK does.
 */

const API_URLS = ['https://api.app.outscraper.com', 'https://api.app.outscraper.cloud'];

class OutscraperError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'OutscraperError';
    this.status = status;
    this.body = body;
  }
}

function asList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

class OutscraperClient {
  /**
   * @param {string} apiKey
   * @param {object} [opts]
   * @param {number} [opts.pollIntervalMs=5000]  how often to poll an async request
   * @param {number} [opts.maxWaitMs=600000]     give up polling after this long (10 min)
   * @param {number} [opts.timeoutMs=60000]      per-HTTP-call timeout
   */
  constructor(apiKey, opts = {}) {
    if (!apiKey) throw new OutscraperError('OUTSCRAPER_API_KEY is required');
    this.apiKey = apiKey;
    this.pollIntervalMs = opts.pollIntervalMs || 5000;
    this.maxWaitMs = opts.maxWaitMs || 10 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs || 60 * 1000;
    this.fetch = opts.fetch || globalThis.fetch;
    this.log = opts.log || (() => {});
  }

  async _request(method, path, { params, json } = {}) {
    let lastErr;
    for (const base of API_URLS) {
      const url = new URL(base + path);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (v == null || v === '') continue;
          for (const item of asList(v)) url.searchParams.append(k, String(item));
        }
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const resp = await this.fetch(url, {
          method,
          headers: {
            'X-API-KEY': this.apiKey,
            'client': 'master-hustle-engine',
            ...(json ? { 'Content-Type': 'application/json' } : {}),
          },
          body: json ? JSON.stringify(json) : undefined,
          signal: ctrl.signal,
        });
        const text = await resp.text();
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
        if (resp.status === 401 || resp.status === 403) {
          throw new OutscraperError(`Outscraper rejected the API key (${resp.status})`, resp.status, body);
        }
        if (resp.status === 402) {
          throw new OutscraperError('Outscraper account has no credit / payment required (402)', 402, body);
        }
        if (resp.status < 200 || resp.status >= 300) {
          throw new OutscraperError(`Outscraper ${method} ${path} → HTTP ${resp.status}`, resp.status, body);
        }
        if (body && body.error) {
          throw new OutscraperError(`Outscraper error: ${body.errorMessage || body.error}`, resp.status, body);
        }
        return body;
      } catch (err) {
        // Only network-level failures fall through to the .cloud mirror.
        if (err instanceof OutscraperError) throw err;
        lastErr = err;
        this.log(`[Outscraper] ${base} unreachable (${err.name}: ${err.message}) — trying next host`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new OutscraperError(`Outscraper unreachable on all hosts: ${lastErr && lastErr.message}`);
  }

  /** Poll /requests/{id} until the task leaves 'Pending'. Returns the archive record. */
  async waitForRequest(requestId) {
    const started = Date.now();
    while (Date.now() - started < this.maxWaitMs) {
      await new Promise(r => setTimeout(r, this.pollIntervalMs));
      let rec;
      try {
        rec = await this._request('GET', `/requests/${encodeURIComponent(requestId)}`);
      } catch (err) {
        if (err.status && err.status >= 500) { this.log(`[Outscraper] poll ${requestId}: ${err.message}`); continue; }
        throw err;
      }
      if (rec && rec.status && rec.status !== 'Pending') return rec;
    }
    throw new OutscraperError(`Outscraper request ${requestId} still pending after ${Math.round(this.maxWaitMs / 1000)}s`);
  }

  /** Unwrap either a sync result ({data:[...]}) or an async handle ({id, status:'Pending'}). */
  async _resolve(body) {
    if (body && body.id && (body.status === 'Pending' || body.data === undefined)) {
      this.log(`[Outscraper] async request ${body.id} — polling`);
      const rec = await this.waitForRequest(body.id);
      if (rec.status && /error|fail/i.test(rec.status)) {
        throw new OutscraperError(`Outscraper request ${body.id} finished with status ${rec.status}`, 0, rec);
      }
      return rec.data || [];
    }
    return (body && body.data) || [];
  }

  /**
   * Google Maps search. Returns an array (one entry per query) of arrays of places.
   * @param {string|string[]} query   e.g. "digital marketing agency, Austin, TX"
   * @param {object} [o]
   * @param {number}   [o.limit=20]        places per query (Outscraper param organizationsPerQueryLimit)
   * @param {number}   [o.skip=0]          pagination offset, multiple of 20
   * @param {string}   [o.language='en']
   * @param {string}   [o.region='US']
   * @param {string[]} [o.enrichment]      e.g. ['domains_service'] to pull emails/socials for each site
   * @param {boolean}  [o.dropDuplicates=true]
   */
  async googleMapsSearch(query, o = {}) {
    const queries = asList(query);
    if (!queries.length) return [];
    const payload = {
      query: queries,
      language: o.language || 'en',
      region: o.region || 'US',
      organizationsPerQueryLimit: o.limit || 20,
      skipPlaces: o.skip || 0,
      dropDuplicates: o.dropDuplicates !== false,
      // Mirror the SDK: more than 10 queries (or >50) must go async.
      async: !!o.async || (queries.length > 10 && (o.limit || 20) > 1) || queries.length > 50,
      enrichment: asList(o.enrichment),
      fields: o.fields || '',
      ui: false,
      webhook: '',
    };
    const body = await this._request('POST', '/google-maps-search', { json: payload });
    const data = await this._resolve(body);
    // With dropDuplicates the API returns one flat array; otherwise one array per query.
    // Normalise to a flat list of places either way.
    const flat = [];
    for (const item of data) {
      if (Array.isArray(item)) flat.push(...item);
      else if (item && typeof item === 'object') flat.push(item);
    }
    return flat;
  }

  /**
   * Deliverability check. Returns [{ query: email, status: 'RECEIVING'|'INVALID'|..., ... }]
   * @param {string[]} emails
   */
  async validateEmails(emails) {
    const list = asList(emails).map(e => String(e).trim().toLowerCase()).filter(Boolean);
    if (!list.length) return [];
    const body = await this._request('GET', '/email-validator', {
      params: { query: list, async: list.length > 1 },
    });
    return this._resolve(body);
  }
}

module.exports = { OutscraperClient, OutscraperError };
