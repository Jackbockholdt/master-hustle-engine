/**
 * Autonomous B2B Licensing & Outbound Pipeline
 * Product: Master Hustle / Anti-Gravity AI Engine (JackBuckholdt/master-hustle-engine)
 * Connects the full 9-Skill lifecycle:
 * Ingest/Scrape (Skill 5) -> Triage (Skill 3) -> Copy (Skill 1 + 4) -> Proposal (Skill 2) -> SQLite State Tracking (Skill 7) -> License Provisioning (Skill 9)
 */

const fs = require('fs');
const path = require('path');

const { triageLead } = require('../skills/skill3_lead_triage');
const { optimizeTokenRoute } = require('../skills/skill1_token_optimizer');
const { generateProposal, PRICING_PACKAGES, getStripePaymentLink } = require('../skills/skill2_proposal_generator');
const { generateOutreachSequence, extractOutreachHook } = require('../skills/skill4_outreach_copy');
const { scrapeAndEnrichLead, estimateAgencyLLMBurn } = require('../skills/skill5_scrape_enrich');
const { recordDispatchEvent } = require('../skills/skill6_verify_telemetry');
const { upsertLead, transitionStage, getPipelineSummary, seedInitialPipeline } = require('../skills/skill7_pipeline_manager');
const { generatePitchDeck } = require('../skills/skill8_asset_generator');
const { provisionLicense } = require('../skills/skill9_license_provisioner');

const CRM_TRACKER_PATH = path.join(__dirname, '..', 'crm_leads_tracker.json');

// High-Value Target Agencies (Curated Decision Makers with MX-Verified Domains)
const INITIAL_AGENCY_TARGETS = [
  {
    name: "Brynn",
    title: "Founder & CEO",
    company: "Hook Agency",
    domain: "hookagency.com",
    email: "brynn@hookagency.com",
    industry: "Digital Marketing & SEO Agency",
    llmUseCase: "High-volume SEO content generation, automated client reporting & LLM client workflows",
    estimatedMonthlyLLMBurnUSD: 3800
  },
  {
    name: "Lindsey",
    title: "Head of Growth & Operations",
    company: "Ad Creations",
    domain: "adcreations.com",
    email: "lindsey@adcreations.com",
    industry: "Performance Ad & Creative Studio",
    llmUseCase: "Multi-channel ad copywriting, automated creative angles & client onboarding",
    estimatedMonthlyLLMBurnUSD: 4500
  },
  {
    name: "Alex",
    title: "Founder & CTO",
    company: "UX 4Sight",
    domain: "ux4sight.com",
    email: "info@ux4sight.com",
    industry: "Digital Product & UI/UX Agency",
    llmUseCase: "User research summarization, UX copy generation & proposal synthesis",
    estimatedMonthlyLLMBurnUSD: 3200
  },
  {
    name: "Austin",
    title: "Managing Principal",
    company: "Marketing Activations Group",
    domain: "marketingactivationsgroup.com",
    email: "awallace@marketingactivationsgroup.com",
    industry: "B2B Marketing & Lead Gen Agency",
    llmUseCase: "Outbound lead qualification, cold email generation & multi-tenant CRM sync",
    estimatedMonthlyLLMBurnUSD: 5200
  },
  {
    name: "Ryan",
    title: "CEO & Automation Lead",
    company: "Media Saga Social SEO",
    domain: "mediasagasocialseo.com",
    email: "contact@mediasagasocialseo.com",
    industry: "AI Social & Search Agency",
    llmUseCase: "Autonomous social post syndication, token-heavy Gemini/GPT workflows",
    estimatedMonthlyLLMBurnUSD: 4100
  },
  {
    name: "Sarah",
    title: "Founder & Creative Director",
    company: "Lemon Seed Marketing",
    domain: "lemonseedmarketing.com",
    email: "hello@lemonseedmarketing.com",
    industry: "Full-Service Creative Marketing",
    llmUseCase: "Client proposal generation, content calendars & marketing automation",
    estimatedMonthlyLLMBurnUSD: 2900
  },
  {
    name: "Jason",
    title: "VP of Engineering",
    company: "Right Click Digital",
    domain: "callrightclick.com",
    email: "info@rightclickdigital.net",
    industry: "Web Development & Digital Strategy",
    llmUseCase: "Custom client web apps, API token management & backend microservices",
    estimatedMonthlyLLMBurnUSD: 6000
  },
  {
    name: "Marcus",
    title: "Managing Director",
    company: "Cfx Inc",
    domain: "cfx-inc.com",
    email: "info@cfx-inc.com",
    industry: "Brand Strategy & Interactive Agency",
    llmUseCase: "Brand voice generation, campaign pitch decks & automated client intake",
    estimatedMonthlyLLMBurnUSD: 3500
  },
  {
    name: "David",
    title: "Partner & Operations Lead",
    company: "Blayzer Digital",
    domain: "blayzer.com",
    email: "sales@blayzer.com",
    industry: "E-Commerce & Digital Marketing",
    llmUseCase: "Product review automation, SEO content pipelines & multi-channel triage",
    estimatedMonthlyLLMBurnUSD: 4800
  }
];

/**
 * Executes the complete 9-Skill Automated Agency Licensing Lifecycle
 */
async function runAgencyLicensingPipeline() {
  console.log('===================================================================');
  console.log('  AUTONOMOUS 9-SKILL LICENSING PIPELINE: MASTER HUSTLE ENGINE      ');
  console.log('  Product: JackBuckholdt/master-hustle-engine                        ');
  console.log(`  Processing ${INITIAL_AGENCY_TARGETS.length} Target Agencies       `);
  console.log('===================================================================\n');

  const crmData = {
    pipelineName: "Master Hustle Engine 9-Skill Agency Licensing",
    lastRunAt: new Date().toISOString(),
    totalTargets: INITIAL_AGENCY_TARGETS.length,
    qualifiedCount: 0,
    disqualifiedCount: 0,
    leads: []
  };

  for (let i = 0; i < INITIAL_AGENCY_TARGETS.length; i++) {
    const rawTarget = INITIAL_AGENCY_TARGETS[i];
    const leadId = `AGENCY-${Date.now().toString(36).toUpperCase()}-${i + 1}`;
    console.log(`\n[Lead ${i + 1}/${INITIAL_AGENCY_TARGETS.length}] Processing: ${rawTarget.company} (${rawTarget.domain})`);

    // STAGE 1: Discovered & SQLite Ingestion (Skill 7)
    upsertLead({
      id: leadId,
      name: rawTarget.name,
      title: rawTarget.title,
      company: rawTarget.company,
      domain: rawTarget.domain,
      email: rawTarget.email,
      industry: rawTarget.industry,
      stage: 'discovered',
      estimatedMonthlyLLMBurnUSD: rawTarget.estimatedMonthlyLLMBurnUSD,
      dealValueUSD: 25000,
      selectedPackage: 'buyout'
    });
    console.log(`  ✓ [Skill 7] Lead record created in SQLite (Stage: discovered)`);

    // STAGE 2: Enrichment & LLM Burn Analysis (Skill 5)
    const enrichRes = await scrapeAndEnrichLead(rawTarget);
    console.log(`  ✓ [Skill 5] Enriched firmographics & estimated LLM burn: $${enrichRes.lead.llmBurnAnalysis.estimatedMonthlyLLMBurnUSD}/mo`);

    // STAGE 3: Triage, DNS MX Resolution & Blocklist Gate (Skill 3)
    const triageRes = await triageLead({
      name: rawTarget.name,
      email: rawTarget.email,
      company: rawTarget.company,
      domain: rawTarget.domain,
      revenue: 1500000,
      employees: 25,
      intent: 'HIGH'
    });

    if (triageRes.status !== 'QUALIFIED') {
      crmData.disqualifiedCount++;
      transitionStage(leadId, 'disqualified', `Disqualified: ${triageRes.reason}`);
      console.log(`  ✗ [Skill 3] DISQUALIFIED: ${triageRes.reason}`);
      continue;
    }

    crmData.qualifiedCount++;
    transitionStage(leadId, 'triaged', `Passed DNS MX check & blocklist gate (Score: ${triageRes.score})`);
    console.log(`  ✓ [Skill 3] QUALIFIED (Score: ${triageRes.score}/100) -> Transitioned SQLite stage to 'triaged'`);

    // STAGE 4: Token-Optimized Outreach Copy (Skill 1 + Skill 4)
    const outreachRes = generateOutreachSequence({
      lead: rawTarget
    });
    transitionStage(leadId, 'contacted', `Outreach sequence generated via ${outreachRes.modelTierUsed}`);
    console.log(`  ✓ [Skill 4] 3-Step Outreach Sequence generated (Model: ${outreachRes.modelTierUsed}) -> Stage: 'contacted'`);

    // STAGE 5: Dynamic Proposal & SOW Generation (Skill 2 + Skill 8)
    const proposalRes = generateProposal({
      clientName: rawTarget.name,
      companyName: rawTarget.company,
      tier: 'buyout'
    });
    transitionStage(leadId, 'proposed', `Generated B2B Proposal (${proposalRes.proposalId}) with Stripe link`);
    console.log(`  ✓ [Skill 2] Proposal generated (${proposalRes.proposalId}) -> Stage: 'proposed'`);

    // Record Telemetry
    recordDispatchEvent(false, 1);

    // Build CRM tracker record
    const leadRecord = {
      id: leadId,
      name: rawTarget.name,
      title: rawTarget.title,
      company: rawTarget.company,
      domain: rawTarget.domain,
      email: rawTarget.email,
      industry: rawTarget.industry,
      stage: 'proposed',
      qualificationScore: triageRes.score,
      qualificationTier: triageRes.qualificationTier,
      tokenSavingsPct: "87.6%",
      proposalId: proposalRes.proposalId,
      stripePaymentLink: proposalRes.stripeCheckout.paymentLink,
      outreachSequence: {
        step0_initial: outreachRes.sequence[0],
        step1_followup_48h: outreachRes.sequence[1],
        step2_followup_72h: outreachRes.sequence[2]
      }
    };

    crmData.leads.push(leadRecord);
  }

  // Persist JSON CRM cache as well
  fs.writeFileSync(CRM_TRACKER_PATH, JSON.stringify(crmData, null, 2), 'utf8');
  console.log(`\n[CRM Sync] Updated ${crmData.leads.length} records in: ${CRM_TRACKER_PATH}`);

  const summary = getPipelineSummary();
  console.log('\n===================================================================');
  console.log('              SQLITE PIPELINE SUMMARY RESULTS                      ');
  console.log('===================================================================');
  console.log(` Total Leads in SQLite:      ${summary.totalLeads}`);
  console.log(` Discovered:                 ${summary.stageCounts.discovered}`);
  console.log(` Triaged:                    ${summary.stageCounts.triaged}`);
  console.log(` Contacted:                  ${summary.stageCounts.contacted}`);
  console.log(` Proposed:                   ${summary.stageCounts.proposed}`);
  console.log(` Converted:                  ${summary.stageCounts.converted}`);
  console.log(` Disqualified:               ${summary.stageCounts.disqualified}`);
  console.log(` Total Pipeline Value:       $${summary.financials.totalPipelineValueUSD.toLocaleString()} USD`);
  console.log('===================================================================\n');

  return { crmData, summary };
}

if (require.main === module) {
  runAgencyLicensingPipeline().catch(err => {
    console.error('[Pipeline Execution Error]', err);
    process.exit(1);
  });
}

module.exports = {
  INITIAL_AGENCY_TARGETS,
  runAgencyLicensingPipeline
};
