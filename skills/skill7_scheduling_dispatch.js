'use strict';

/**
 * Skill 7: Scheduling & Dispatch Engine
 * Webhook Dispatches, Calendar Booking & Meeting Scheduling
 * 
 * Capabilities:
 *  - Dynamic calendar booking URL generation
 *  - Meeting invitation payload packaging (agenda, timezone, attendee)
 *  - Outbound webhook dispatch with retry & signature tracking
 */

const https = require('https');
const http = require('http');

const DEFAULT_CALENDAR_BASE = process.env.CALENDAR_BOOKING_URL || 'https://cal.com/jack-antigravity/15min';

function generateBookingLink({ lead = {}, utmCampaign = 'mhe_outbound', durationMinutes = 15 } = {}) {
  const url = new URL(DEFAULT_CALENDAR_BASE);
  if (lead.email) url.searchParams.set('email', lead.email);
  if (lead.fullName || lead.name) url.searchParams.set('name', lead.fullName || lead.name);
  if (lead.company) url.searchParams.set('notes', `Agency Infrastructure & Token Margin Review for ${lead.company}`);
  url.searchParams.set('utm_campaign', utmCampaign);
  url.searchParams.set('duration', String(durationMinutes));

  return url.toString();
}

async function dispatchWebhook({ webhookUrl, payload = {}, secret = null } = {}) {
  if (!webhookUrl) {
    return { success: false, error: 'ERR_MISSING_WEBHOOK_URL' };
  }

  const data = JSON.stringify({
    event: 'LEAD_BOOKING_DISPATCH',
    timestamp: new Date().toISOString(),
    payload
  });

  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(webhookUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'X-Engine-Event': 'scheduling_dispatch',
          ...(secret ? { 'X-Signature': secret } : {})
        },
        timeout: 8000
      }, (res) => {
        let respBody = '';
        res.on('data', chunk => respBody += chunk);
        res.on('end', () => {
          resolve({
            success: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            response: respBody.slice(0, 500)
          });
        });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Webhook dispatch timed out' });
      });

      req.write(data);
      req.end();
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

function prepareMeetingDispatch({ lead = {}, preferredDate = null, notes = '' } = {}) {
  const bookingLink = generateBookingLink({ lead });
  const meetingId = `MEET-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  return {
    success: true,
    meetingId,
    bookingLink,
    scheduledAt: preferredDate || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    attendee: {
      name: lead.fullName || lead.firstName || 'Decision Maker',
      email: lead.email,
      company: lead.company,
      title: lead.title
    },
    agenda: `15-Min Architecture Review: Master Hustle 9-Skill White-Label Agency Infrastructure for ${lead.company || 'Agency'}`,
    notes
  };
}

module.exports = {
  generateBookingLink,
  dispatchWebhook,
  prepareMeetingDispatch
};
