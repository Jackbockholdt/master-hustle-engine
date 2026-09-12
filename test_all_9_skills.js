/**
 * test_all_9_skills.js
 * Comprehensive Verification & Integration Test Suite for the 9-Skill Margin Engine
 */

const express = require('express');
const http = require('http');
const engineRouter = require('./routes/engine');

const app = express();
app.use(express.json());
app.use('/api', engineRouter);

let server = null;
const TEST_PORT = 3006;

function requestEngine(action, payload = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const postBody = JSON.stringify({ action, ...payload });
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postBody),
      ...headers
    };

    const req = http.request({
      hostname: 'localhost',
      port: TEST_PORT,
      path: '/api/engine',
      method: 'POST',
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', err => reject(err));
    req.write(postBody);
    req.end();
  });
}

async function runAllTests() {
  console.log("===================================================================");
  console.log("  9-SKILL MARGIN ENGINE: COMPREHENSIVE INTEGRATION TEST SUITE      ");
  console.log("===================================================================\n");

  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, () => {
      console.log(`[Test Server] Listening on http://localhost:${TEST_PORT}/api/engine\n`);
      resolve();
    });
  });

  const results = [];

  function record(skillNum, name, passed, details = '') {
    results.push({ skillNum, name, passed, details });
    console.log(`[Skill ${skillNum}: ${name}] -> ${passed ? '✅ PASS' : '❌ FAIL'} ${details}`);
  }

  try {
    // 1. Skill 1: Token Burn & Margin Optimizer
    const res1 = await requestEngine('optimize_tokens', {
      taskType: 'BACKGROUND_TELEMETRY',
      rawPrompt: 'Please kindly summarize this data for me as an AI',
      leadCount: 5
    });
    const pass1 = res1.status === 200 && res1.data.selectedModel === 'gemini-1.5-flash' && res1.data.tier === 'FLASH_BUDGET';
    record(1, 'Token Burn & Margin Optimizer', pass1, `Model: ${res1.data.selectedModel}, Saved: ${res1.data.tokensSavedEstimate} tokens`);

    // Flagship Pro Gating Check on Skill 1
    const res1ProBlocked = await requestEngine('optimize_tokens', {
      taskType: 'MANUAL_SALES_COPY',
      requestedModel: 'gemini-1.5-pro',
      humanTriggered: false
    });
    const pass1Blocked = res1ProBlocked.status === 403 && res1ProBlocked.data.error === 'ERR_FLAGSHIP_RESTRICTED_TO_HUMAN';
    console.log(`  └─ Flagship Pro Gating Check (Automated Block HTTP 403): ${pass1Blocked ? '✅ PASS' : '❌ FAIL'}`);

    const res1ProAllowed = await requestEngine('optimize_tokens', {
      taskType: 'MANUAL_SALES_COPY',
      requestedModel: 'gemini-1.5-pro',
      humanTriggered: true
    });
    const pass1Allowed = res1ProAllowed.status === 200 && res1ProAllowed.data.tier === 'FLAGSHIP_PRO';
    console.log(`  └─ Flagship Pro Gating Check (Human Trigger Allowed HTTP 200): ${pass1Allowed ? '✅ PASS' : '❌ FAIL'}`);

    // 2. Skill 2: Business Document & Proposal Generator
    const res2 = await requestEngine('generate_proposal', {
      clientName: 'Brynn',
      companyName: 'Hook Agency',
      tier: 'buyout'
    });
    const pass2 = res2.status === 200 && res2.data.proposalId && res2.data.pricing.oneTimePriceUSD === 25000;
    record(2, 'Document & Proposal Generator', pass2, `Proposal ID: ${res2.data.proposalId}, SOW Amount: $${res2.data.pricing.oneTimePriceUSD}`);

    // 3. Skill 3: Lead Triage & Safety Gate
    const res3 = await requestEngine('triage_lead', {
      name: 'Alex',
      email: 'alex@ux4sight.com',
      company: 'UX 4Sight',
      domain: 'ux4sight.com',
      employees: 30,
      revenue: 2000000,
      intent: 'HIGH'
    });
    const pass3 = res3.status === 200 && res3.data.status === 'QUALIFIED' && res3.data.score >= 70;
    record(3, 'Lead Triage & Safety Gate', pass3, `Status: ${res3.data.status}, Score: ${res3.data.score}/100`);

    // 4. Skill 4: Multi-Agent Cold Outreach Copy
    const res4 = await requestEngine('generate_outreach', {
      lead: {
        name: 'Sarah',
        company: 'Lemon Seed Marketing',
        industry: 'Creative Marketing',
        llmUseCase: 'Client proposal generation & content calendars',
        estimatedMonthlyLLMBurnUSD: 2900
      }
    });
    const pass4 = res4.status === 200 && res4.data.sequence.length === 3 && res4.data.modelTierUsed === 'grok-beta';
    record(4, 'Multi-Agent Cold Outreach Copy', pass4, `3-Step Sequence generated via ${res4.data.modelTierUsed}`);

    // 5. Skill 5: Lead Scraper & Enrichment Engine
    const res5 = await requestEngine('scrape_enrich', {
      company: 'Media Saga Social SEO',
      domain: 'mediasagasocialseo.com',
      employees: 25,
      industry: 'AI Social & Search'
    });
    const pass5 = res5.status === 200 && res5.data.lead.llmBurnAnalysis.estimatedMonthlyLLMBurnUSD > 0;
    record(5, 'Scraper & Metadata Enrichment', pass5, `Est. Monthly Burn: $${res5.data.lead.llmBurnAnalysis.estimatedMonthlyLLMBurnUSD}/mo`);

    // 6. Skill 6: DNS/MX Deliverability & Telemetry
    const res6 = await requestEngine('verify_telemetry', {});
    const pass6 = res6.status === 200 && res6.data.tokenGovernance.telemetryModel === 'gemini-1.5-flash';
    record(6, 'DNS/MX Deliverability & Telemetry', pass6, `Telemetry compiled with ${res6.data.tokenGovernance.reductionTargetPct} savings target`);

    // 7. Skill 7: Pipeline State & SQLite Lifecycle Tracker
    const testLeadId = `TEST-LEAD-${Date.now().toString(36).toUpperCase()}`;
    await requestEngine('manage_pipeline', {
      subAction: 'upsert',
      lead: {
        id: testLeadId,
        name: 'Austin',
        company: 'Marketing Activations Group',
        email: 'awallace@marketingactivationsgroup.com',
        stage: 'discovered',
        dealValueUSD: 25000
      }
    });
    const res7Transition = await requestEngine('manage_pipeline', {
      leadId: testLeadId,
      stage: 'proposed',
      detail: 'Sent Proposal and Stripe Checkout link'
    });
    const pass7 = res7Transition.status === 200 && res7Transition.data.currentStage === 'proposed';
    record(7, 'Pipeline State & SQLite Lifecycle Tracker', pass7, `Lead ${testLeadId} transitioned to 'proposed' in SQLite`);

    // 8. Skill 8: Proof Asset & Pitch Deck Generator
    const res8 = await requestEngine('generate_assets', {
      agencyName: 'Ad Creations',
      monthlyBurnUSD: 4500
    });
    const pass8 = res8.status === 200 && res8.data.financialModel.estimatedAnnualSavingsUSD > 0;
    record(8, 'Proof Asset & Pitch Deck Generator', pass8, `Annual Savings Model: $${res8.data.financialModel.estimatedAnnualSavingsUSD.toLocaleString()} USD`);

    // 9. Skill 9: Stripe Checkout & License Provisioning Fulfillment
    const res9 = await requestEngine('provision_license', {
      company: 'Hook Agency',
      tier: 'buyout',
      leadId: testLeadId,
      simulatePayment: true
    });
    const pass9 = res9.status === 200 && res9.data.certificate.licenseKey && res9.data.certificate.paymentStatus === 'PAID_ACTIVE';
    record(9, 'Stripe Checkout & License Provisioning', pass9, `Issued License Key: ${res9.data.certificate.licenseKey}`);

    // Fail-Closed Validation Check
    const resFailClosed = await requestEngine('non_existent_skill_action', {});
    const passFailClosed = resFailClosed.status === 400 && resFailClosed.data.error === 'ERR_UNKNOWN_ACTION';
    console.log(`\n[Fail-Closed Safety Gate] -> ${passFailClosed ? '✅ PASS' : '❌ FAIL'} (Returns HTTP 400 ERR_UNKNOWN_ACTION)`);

    console.log("\n===================================================================");
    console.log("                  FINAL 9-SKILL TEST RESULTS                       ");
    console.log("===================================================================");
    const allPassed = results.every(r => r.passed) && pass1Blocked && pass1Allowed && passFailClosed;
    results.forEach(r => {
      console.log(` Skill ${r.skillNum} [${r.name}]: ${r.passed ? '✅ PASSED' : '❌ FAILED'}`);
    });
    console.log(`\n Overall Test Result: ${allPassed ? '🎉 ALL 9 SKILLS + GOVERNANCE PASSING' : '⚠️ SOME TESTS FAILED'}`);
    console.log("===================================================================\n");

    if (!allPassed) {
      process.exit(1);
    }
  } catch (err) {
    console.error('[Test Suite Error]', err);
    process.exit(1);
  } finally {
    if (server) server.close();
  }
}

runAllTests();
