/**
 * test-e2e-pipeline.js
 * End-to-End Integration Test for Live Render Outbound Relay Service
 */

'use strict';
const fs = require('fs');
const path = require('path');

// Zero-dependency .env loader
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
} catch (e) {
  console.warn('Could not load .env file:', e.message);
}

const BASE_URL = process.env.RENDER_EXTERNAL_URL || 'https://master-hustle-engine.onrender.com';

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function runIntegrationTest() {
  console.log('======================================================================');
  console.log(' 🔬 MASTER HUSTLE ENGINE — END-TO-END PIPELINE INTEGRATION TEST');
  console.log(` Target Service: ${BASE_URL}`);
  console.log('======================================================================\n');

  // STEP 1: Pre-Ingestion Baseline Snapshot
  console.log('[1/4] Fetching Baseline Telemetry & Status...');
  const baselineStatusRes = await fetchWithRetry(`${BASE_URL}/admin/status`);
  const baselineStatus = await baselineStatusRes.json();
  console.log(` -> Baseline /admin/status (HTTP ${baselineStatusRes.status}):`, JSON.stringify(baselineStatus));

  // STEP 2: Construct Realistic Sample Lead Payload
  const timestamp = new Date().toISOString();
  const sampleLead = {
    first_name: 'Marcus',
    last_name: 'Vance',
    company_name: 'Vance & Sterling Growth Agency',
    contact_email: 'marcus.vance@vancesterlinggrowth.com',
    website: 'https://vancesterlinggrowth.com',
    industry: 'digital marketing agency',
    lead_type: 'B2B Agency Prospect',
    notes: 'Interested in white-label AI infrastructure license for SMB client roster.',
    timestamp: timestamp
  };

  console.log('\n[2/4] Disagreeable / Intake Ingestion: Sending Sample Lead Payload to POST /webhook/lead ...');
  console.log('--- Raw Request Payload ---');
  console.log(JSON.stringify(sampleLead, null, 2));

  const intakeStart = Date.now();
  const intakeRes = await fetchWithRetry(`${BASE_URL}/webhook/lead`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Antigravity-E2E-IntegrationTest/1.0'
    },
    body: JSON.stringify(sampleLead)
  });
  const intakeLatency = Date.now() - intakeStart;
  const intakeBody = await intakeRes.json().catch(() => ({}));

  console.log(`\n--- Raw Response (HTTP ${intakeRes.status} in ${intakeLatency}ms) ---`);
  console.log(JSON.stringify(intakeBody, null, 2));

  // STEP 3: Post-Ingestion Telemetry & Log Inspection
  console.log('\n[3/4] Querying Post-Ingestion Telemetry...');
  await new Promise(r => setTimeout(r, 1000));

  const postStatusRes = await fetchWithRetry(`${BASE_URL}/admin/status`);
  const postStatus = await postStatusRes.json();
  console.log(` -> Post-Ingestion /admin/status (HTTP ${postStatusRes.status}):`, JSON.stringify(postStatus, null, 2));

  // STEP 4: Comprehensive Diagnostic Report
  console.log('\n======================================================================');
  console.log(' 📊 INTEGRATION TEST EXECUTION SUMMARY');
  console.log('======================================================================');

  const is200 = intakeRes.status === 200 || intakeRes.status === 202;
  const isIngested = intakeBody.received === true;
  const isQualified = intakeBody.status === 'SUCCESS';
  const emailDispatched = isQualified && intakeBody.result && intakeBody.result.email_sent === true;
  const pitchesGenerated = isQualified && intakeBody.result && Array.isArray(intakeBody.result.pitches) && intakeBody.result.pitches.length > 0;

  console.log(`HTTP Ingestion Status:     ${intakeRes.status} ${is200 ? '✅' : '❌'}`);
  console.log(`Payload Ingestion:         ${isIngested ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`ICP Lead Qualification:    ${isQualified ? '✅ QUALIFIED' : '⚠️ DISQUALIFIED: ' + (intakeBody.reason || 'N/A')}`);
  console.log(`Prompt Gen / Gemini AI:    ${pitchesGenerated ? '✅ GENERATED (' + intakeBody.result.pitches[0].subject + ')' : 'N/A'}`);
  console.log(`Outbound Relay Dispatch:   ${emailDispatched ? '✅ RELAY TRIGGERED (Google Apps Script)' : (intakeBody.result?.email_error ? '⚠️ Error: ' + intakeBody.result.email_error : 'N/A')}`);
  console.log(`Pipeline Latency:          ${intakeLatency}ms`);
  console.log(`Daily Send Rate Limiter:   ${postStatus.sends ? `${postStatus.sends.today} / ${postStatus.sends.daily_cap}` : 'N/A'}`);
  console.log(`Outbound Pause State:      ${postStatus.outbound?.paused === false ? '✅ Active (OUTBOUND_PAUSED=false)' : '⏸️ Paused'}`);
  console.log('======================================================================\n');
}

runIntegrationTest().catch(err => {
  console.error('❌ Integration Test Fatal Error:', err);
  process.exit(1);
});
