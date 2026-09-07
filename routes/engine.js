/**
 * Master Hustle Engine - Central 9-Skill Router
 * Enterprise Multi-Agent Operations & Token Governance Architecture
 * 
 * 9 Enterprise Functional Skills:
 *  1. gatekeeping         -> skills/skill1_gatekeeping.js (Rate-limiting, sanitization, threat screening)
 *  2. entity_extraction   -> skills/skill2_entity_extraction.js (Data normalization & payload parsing)
 *  3. lead_qualification  -> skills/skill3_lead_qualification.js (Scoring matrix & tier routing)
 *  4. context_building    -> skills/skill4_context_building.js (Token-reduction pruning & memory assembly)
 *  5. copywriting         -> skills/skill5_copywriting.js (Multi-model copy dispatch)
 *  6. objection_handling  -> skills/skill6_objection_handling.js (Rebuttal logic & classification)
 *  7. scheduling          -> skills/skill7_scheduling_dispatch.js (Webhook triggers & calendar booking)
 *  8. schema_validation   -> skills/skill8_schema_validation.js (Strict JSON schema enforcement)
 *  9. escalation          -> skills/skill9_escalation.js (Automated human alert triggers & failure traps)
 * 
 * Multi-Model Failover Router:
 *  - lib/multiModelRouter.js (Gemini -> Claude -> Grok -> OpenRouter)
 * 
 * Backward Compatible Actions:
 *  - optimize_tokens, generate_proposal, triage_lead, generate_outreach, scrape_enrich,
 *    verify_telemetry, manage_pipeline, generate_assets, provision_license
 */

const express = require('express');
const router = express.Router();

// 1. Enterprise 9 Skills
const { gatekeepRequest, screenThreats, sanitizeObject } = require('../skills/skill1_gatekeeping');
const { extractEntities, normalizeDomain, normalizePhone } = require('../skills/skill2_entity_extraction');
const { scoreLead } = require('../skills/skill3_lead_qualification');
const { buildContext, pruneBloat } = require('../skills/skill4_context_building');
const { generateCopywriting } = require('../skills/skill5_copywriting');
const { handleObjection, classifyObjection } = require('../skills/skill6_objection_handling');
const { generateBookingLink, dispatchWebhook, prepareMeetingDispatch } = require('../skills/skill7_scheduling_dispatch');
const { validateSchema, validateAgainstSchema, SCHEMAS } = require('../skills/skill8_schema_validation');
const { triggerEscalation, getActiveIncidents, SEVERITY_LEVELS } = require('../skills/skill9_escalation');

// Multi-Model Failover Router
const { routeMultiModel, getRouterStatus } = require('../lib/multiModelRouter');

// Outscraper Agency Intake Engine
const { runIntakeScrape, targetingConfig } = require('../lib/outscraperIntake');

// 3. Legacy / Operational Skills (Preserved for 100% Backward Compatibility)
const { optimizeTokenRoute, tokenStats } = require('../skills/skill1_token_optimizer');
const { generateProposal, PRICING_PACKAGES } = require('../skills/skill2_proposal_generator');
const { triageLead, verifyMxRecord } = require('../skills/skill3_lead_triage');
const { generateOutreachSequence, extractOutreachHook } = require('../skills/skill4_outreach_copy');
const { scrapeAndEnrichLead, estimateAgencyLLMBurn } = require('../skills/skill5_scrape_enrich');
const { compileTelemetryReport, verifyDomainMX, recordDispatchEvent } = require('../skills/skill6_verify_telemetry');
const { getPipelineSummary, upsertLead, transitionStage, seedInitialPipeline } = require('../skills/skill7_pipeline_manager');
const { generatePitchDeck } = require('../skills/skill8_asset_generator');
const { provisionLicense, generateLicenseKey } = require('../skills/skill9_license_provisioner');

// Enterprise Catalog
const ENTERPRISE_SKILL_CATALOG = [
  { skillNumber: 1, id: "gatekeeping", name: "Gatekeeping (Rate-limiting, sanitization, threat screening)", file: "skills/skill1_gatekeeping.js" },
  { skillNumber: 2, id: "entity_extraction", name: "Entity Extraction (Data normalization and payload parsing)", file: "skills/skill2_entity_extraction.js" },
  { skillNumber: 3, id: "lead_qualification", name: "Lead Qualification (Scoring matrix and tier routing)", file: "skills/skill3_lead_qualification.js" },
  { skillNumber: 4, id: "context_building", name: "Context Building (Token-reduction pruning and memory assembly)", file: "skills/skill4_context_building.js" },
  { skillNumber: 5, id: "copywriting", name: "Copywriting / Output Generation (Model dispatch)", file: "skills/skill5_copywriting.js" },
  { skillNumber: 6, id: "objection_handling", name: "Objection Handling (Rebuttal logic)", file: "skills/skill6_objection_handling.js" },
  { skillNumber: 7, id: "scheduling", name: "Scheduling & Dispatch (Webhook triggers and calendar booking)", file: "skills/skill7_scheduling_dispatch.js" },
  { skillNumber: 8, id: "schema_validation", name: "Schema Validation (Strict JSON schema enforcement)", file: "skills/skill8_schema_validation.js" },
  { skillNumber: 9, id: "escalation", name: "Escalation (Automated human alert triggers and critical failure traps)", file: "skills/skill9_escalation.js" }
];

// Combined Action List for Discovery
const ALL_ACTION_IDS = [
  'gatekeeping', 'entity_extraction', 'lead_qualification', 'context_building',
  'copywriting', 'objection_handling', 'scheduling', 'schema_validation', 'escalation',
  'optimize_tokens', 'generate_proposal', 'triage_lead', 'generate_outreach',
  'scrape_enrich', 'verify_telemetry', 'manage_pipeline', 'generate_assets', 'provision_license'
];

// ===================================================================
// 1. UNIFIED DISPATCHER: POST /api/engine
// ===================================================================
router.post('/engine', async (req, res) => {
  const body = req.body || {};
  const action = String(body.action || body.skill || body.taskType || '').toLowerCase().trim();
  const payload = body.payload || body;
  const isHuman = body.humanTriggered === true || req.headers['x-human-trigger'] === 'true';

  try {
    switch (action) {
      // -------------------------------------------------------------
      // ENTERPRISE SKILL 1: Gatekeeping
      // -------------------------------------------------------------
      case 'gatekeeping':
      case 'gatekeep':
      case 'threat_screen': {
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
        const result = gatekeepRequest({
          identifier: payload.identifier || clientIp,
          payload: payload.data || payload
        });
        return res.status(result.statusCode).json(result);
      }

      // -------------------------------------------------------------
      // ENTERPRISE SKILL 2: Entity Extraction
      // -------------------------------------------------------------
      case 'entity_extraction':
      case 'extract_entities':
      case 'parse_lead': {
        const result = extractEntities(payload);
        return res.status(200).json(result);
      }

      // -------------------------------------------------------------
      // ENTERPRISE SKILL 3: Lead Qualification
      // -------------------------------------------------------------
      case 'lead_qualification':
      case 'qualify_lead':
      case 'score_lead': {
        const result = scoreLead(payload);
        return res.status(result.qualified ? 200 : 422).json(result);
      }

      // -------------------------------------------------------------
      // ENTERPRISE SKILL 4: Context Building
      // -------------------------------------------------------------
      case 'context_building':
      case 'build_context':
      case 'prune_context': {
        const result = buildContext(payload);
        return res.status(200).json(result);
      }

      // -------------------------------------------------------------
      // ENTERPRISE SKILL 5: Copywriting / Output Generation
      // -------------------------------------------------------------
      case 'copywriting':
      case 'generate_copy':
      case 'outreach_copy': {
        const result = await generateCopywriting(payload);
        return res.status(200).json(result);
      }

      // -------------------------------------------------------------
      // ENTERPRISE SKILL 6: Objection Handling
      // -------------------------------------------------------------
      case 'objection_handling':
      case 'handle_objection':
      case 'rebuttal': {
        const result = await handleObjection(payload);
        return res.status(200).json(result);
      }

      // -------------------------------------------------------------
      // ENTERPRISE SKILL 7: Scheduling & Dispatch
      // -------------------------------------------------------------
      case 'scheduling':
      case 'schedule_dispatch':
      case 'book_meeting': {
        if (payload.subAction === 'webhook' || payload.webhookUrl) {
          const whResult = await dispatchWebhook(payload);
          return res.status(whResult.success ? 200 : 502).json(whResult);
        }
        const meeting = prepareMeetingDispatch(payload);
        return res.status(200).json(meeting);
      }

      // -------------------------------------------------------------
      // ENTERPRISE SKILL 8: Schema Validation
      // -------------------------------------------------------------
      case 'schema_validation':
      case 'validate_schema':
      case 'validate_payload': {
        const schemaName = payload.schema || payload.schemaName || 'LEAD_INBOUND';
        const result = validateSchema(schemaName, payload.data || payload);
        return res.status(result.valid ? 200 : 400).json(result);
      }

      // -------------------------------------------------------------
      // ENTERPRISE SKILL 9: Escalation
      // -------------------------------------------------------------
      case 'escalation':
      case 'escalate':
      case 'trigger_alert': {
        const result = triggerEscalation(payload);
        return res.status(200).json(result);
      }

      // -------------------------------------------------------------
      // MULTI-MODEL ROUTER DISPATCH
      // -------------------------------------------------------------
      case 'route_model':
      case 'multi_model_dispatch':
      case 'ai_dispatch': {
        const result = await routeMultiModel(payload);
        return res.status(200).json(result);
      }

      // -------------------------------------------------------------
      // LEGACY COMPATIBILITY: Skill 1 (Token Optimizer)
      // -------------------------------------------------------------
      case 'optimize_tokens':
      case 'token_optimizer':
      case 'token-optimizer':
      case 'model_router': {
        const result = optimizeTokenRoute({
          taskType: payload.taskType || payload.task,
          rawPrompt: payload.prompt || payload.rawPrompt,
          requestedModel: payload.model || payload.requestedModel,
          humanTriggered: isHuman,
          leadCount: payload.leadCount || 1
        });
        return res.status(result.statusCode || 200).json(result);
      }

      // -------------------------------------------------------------
      // LEGACY COMPATIBILITY: Skill 2 (Proposal Generator)
      // -------------------------------------------------------------
      case 'generate_proposal':
      case 'proposal_generator':
      case 'proposal-generator':
      case 'create_proposal': {
        const result = generateProposal({
          clientName: payload.clientName || payload.name,
          companyName: payload.companyName || payload.company,
          tier: payload.tier || payload.package,
          customNotes: payload.customNotes,
          customStripeLink: payload.customStripeLink
        });
        return res.status(200).json(result);
      }

      // -------------------------------------------------------------
      // LEGACY COMPATIBILITY: Skill 3 (Lead Triage)
      // -------------------------------------------------------------
      case 'triage_lead':
      case 'lead_triage':
      case 'lead-triage': {
        const result = await triageLead(payload);
        return res.status(result.status === 'QUALIFIED' ? 200 : 422).json(result);
      }

      // -------------------------------------------------------------
      // LEGACY COMPATIBILITY: Skill 4 (Outreach Copy)
      // -------------------------------------------------------------
      case 'generate_outreach':
      case 'cold_copy':
      case 'create_outreach': {
        const result = generateOutreachSequence({
          lead: payload.lead || payload,
          customStripeBuyout: payload.customStripeBuyout,
          customStripeRetainer: payload.customStripeRetainer,
          customStripeSetup: payload.customStripeSetup
        });
        return res.status(200).json(result);
      }

      // -------------------------------------------------------------
      // LEGACY COMPATIBILITY: Skill 5 (Scrape & Enrich)
      // -------------------------------------------------------------
      case 'scrape_enrich':
      case 'enrich_lead':
      case 'scrape_agencies': {
        const result = await scrapeAndEnrichLead(payload);
        return res.status(200).json(result);
      }

      // -------------------------------------------------------------
      // LEGACY COMPATIBILITY: Skill 6 (Telemetry)
      // -------------------------------------------------------------
      case 'verify_telemetry':
      case 'compile_telemetry':
      case 'check_health': {
        if (payload.domain) {
          const mxCheck = await verifyDomainMX(payload.domain);
          return res.status(200).json(mxCheck);
        }
        const telemetry = compileTelemetryReport();
        return res.status(200).json(telemetry);
      }

      // -------------------------------------------------------------
      // LEGACY COMPATIBILITY: Skill 7 (Pipeline Manager)
      // -------------------------------------------------------------
      case 'manage_pipeline':
      case 'pipeline_manager':
      case 'update_stage':
      case 'get_pipeline': {
        if (payload.subAction === 'transition' || payload.stage) {
          const transition = transitionStage(payload.leadId, payload.stage, payload.detail);
          return res.status(200).json(transition);
        }
        if (payload.subAction === 'upsert' || payload.lead) {
          const upserted = upsertLead(payload.lead || payload);
          return res.status(200).json({ success: true, lead: upserted });
        }
        const summary = getPipelineSummary();
        return res.status(200).json(summary);
      }

      // -------------------------------------------------------------
      // LEGACY COMPATIBILITY: Skill 8 (Asset Generator)
      // -------------------------------------------------------------
      case 'generate_assets':
      case 'pitch_deck':
      case 'create_deck': {
        const deck = generatePitchDeck({
          agencyName: payload.agencyName || payload.company,
          monthlyBurnUSD: payload.monthlyBurnUSD || payload.burn
        });
        return res.status(200).json(deck);
      }

      // -------------------------------------------------------------
      // LEGACY COMPATIBILITY: Skill 9 (License Provisioner)
      // -------------------------------------------------------------
      case 'provision_license':
      case 'issue_license':
      case 'create_license': {
        const license = provisionLicense({
          company: payload.company || payload.companyName,
          tier: payload.tier || payload.package,
          email: payload.email,
          leadId: payload.leadId,
          simulatePayment: payload.simulatePayment,
          customStripeLink: payload.customStripeLink
        });
        return res.status(200).json(license);
      }

      // Fail-closed Unknown Action
      default:
        return res.status(400).json({
          success: false,
          error: "ERR_UNKNOWN_ACTION",
          message: `Unknown action '${action}'. Please specify one of the 9 operational skills.`,
          availableActions: ALL_ACTION_IDS
        });
    }
  } catch (err) {
    console.error('[Engine Router Error]', err);
    return res.status(500).json({
      success: false,
      error: "ERR_INTERNAL_EXECUTION_FAILURE",
      message: err.message
    });
  }
});

// ===================================================================
// 2. END-TO-END PIPELINE ORCHESTRATION: POST /api/pipeline/process
// ===================================================================
router.post('/pipeline/process', async (req, res) => {
  const rawInput = req.body || {};
  const pipelineLog = [];

  try {
    // Step 1: Gatekeeping
    const gate = gatekeepRequest({ payload: rawInput });
    pipelineLog.push({ step: 'Skill 1 [Gatekeeping]', passed: gate.passed });
    if (!gate.passed) {
      return res.status(gate.statusCode).json({ success: false, step: 'gatekeeping', error: gate.error, message: gate.message });
    }

    // Step 2: Entity Extraction
    const extraction = extractEntities(gate.sanitizedPayload);
    pipelineLog.push({ step: 'Skill 2 [Entity Extraction]', passed: extraction.success, entities: extraction.entities });

    // Step 3: Schema Validation
    const validation = validateSchema('LEAD_INBOUND', extraction.entities);
    pipelineLog.push({ step: 'Skill 3 [Schema Validation]', valid: validation.valid, errorCount: validation.errorCount });
    if (!validation.valid) {
      return res.status(400).json({ success: false, step: 'schema_validation', errors: validation.errors });
    }

    // Step 4: Lead Qualification
    const qualification = scoreLead(extraction.entities);
    pipelineLog.push({ step: 'Skill 4 [Lead Qualification]', score: qualification.score, tier: qualification.tier });

    // Step 5: Context Building
    const context = buildContext({ lead: extraction.entities, objective: 'OUTREACH' });
    pipelineLog.push({ step: 'Skill 5 [Context Building]', reductionPct: context.tokenMetrics.reductionPct });

    // Step 6: Copywriting Generation
    const copy = await generateCopywriting({
      lead: extraction.entities,
      context,
      mock: true
    });
    pipelineLog.push({ step: 'Skill 6 [Copywriting]', provider: copy.providerUsed, model: copy.modelUsed });

    // Step 7: Objection Handling Preview
    const objectionSample = await handleObjection({
      objectionText: 'Too expensive right now',
      lead: extraction.entities,
      mock: true
    });
    pipelineLog.push({ step: 'Skill 7 [Objection Handling]', category: objectionSample.category });

    // Step 8: Scheduling & Dispatch
    const meeting = prepareMeetingDispatch({ lead: extraction.entities });
    pipelineLog.push({ step: 'Skill 8 [Scheduling & Dispatch]', meetingId: meeting.meetingId });

    // Step 9: Escalation Check
    let escalation = null;
    if (qualification.tier === 'TIER_1_VIP') {
      escalation = triggerEscalation({
        triggerType: 'VIP_DEAL_DETECTED',
        lead: extraction.entities,
        details: { score: qualification.score, budget: extraction.entities.budgetUSD }
      });
      pipelineLog.push({ step: 'Skill 9 [Escalation]', incidentId: escalation.incidentId, severity: escalation.severity });
    }

    return res.status(200).json({
      success: true,
      pipelineStatus: 'COMPLETED_CLEAN',
      lead: extraction.entities,
      qualification,
      contextMetrics: context.tokenMetrics,
      copySample: copy.sequence.step1_teaser,
      meetingDispatch: meeting,
      escalationTriggered: !!escalation,
      pipelineLog
    });

  } catch (err) {
    console.error('[Pipeline Execution Failure]', err);
    return res.status(500).json({ success: false, error: err.message, log: pipelineLog });
  }
});

// ===================================================================
// 3. MULTI-MODEL ROUTER ENDPOINTS
// ===================================================================
router.post('/router/dispatch', async (req, res) => {
  try {
    const result = await routeMultiModel(req.body);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, error: err.message, attempts: err.attempts });
  }
});

router.get('/router/status', (req, res) => {
  res.json(getRouterStatus());
});

// ===================================================================
// 4. DEDICATED REST ENDPOINTS FOR ALL 9 ENTERPRISE SKILLS
// ===================================================================

// Skill 1: Gatekeeping
router.post('/skills/gatekeeping', (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const result = gatekeepRequest({ identifier: req.body?.identifier || clientIp, payload: req.body?.data || req.body });
  return res.status(result.statusCode).json(result);
});

// Skill 2: Entity Extraction
router.post('/skills/entity-extraction', (req, res) => {
  const result = extractEntities(req.body);
  return res.status(200).json(result);
});

// Skill 3: Lead Qualification
router.post('/skills/lead-qualification', (req, res) => {
  const result = scoreLead(req.body);
  return res.status(result.qualified ? 200 : 422).json(result);
});

// Skill 4: Context Building
router.post('/skills/context-building', (req, res) => {
  const result = buildContext(req.body);
  return res.status(200).json(result);
});

// Skill 5: Copywriting
router.post('/skills/copywriting', async (req, res) => {
  const result = await generateCopywriting(req.body);
  return res.status(200).json(result);
});

// Skill 6: Objection Handling
router.post('/skills/objection-handling', async (req, res) => {
  const result = await handleObjection(req.body);
  return res.status(200).json(result);
});

// Skill 7: Scheduling
router.post('/skills/scheduling', async (req, res) => {
  if (req.body?.subAction === 'webhook' || req.body?.webhookUrl) {
    const whResult = await dispatchWebhook(req.body);
    return res.status(whResult.success ? 200 : 502).json(whResult);
  }
  const result = prepareMeetingDispatch(req.body);
  return res.status(200).json(result);
});

// Skill 8: Schema Validation
router.post('/skills/schema-validation', (req, res) => {
  const schemaName = req.body?.schema || req.body?.schemaName || 'LEAD_INBOUND';
  const result = validateSchema(schemaName, req.body?.data || req.body);
  return res.status(result.valid ? 200 : 400).json(result);
});

// Skill 9: Escalation
router.post('/skills/escalation', (req, res) => {
  const result = triggerEscalation(req.body);
  return res.status(200).json(result);
});

// ===================================================================
// 5. OUTSCRAPER INTAKE & TARGETING ENDPOINTS
// ===================================================================
router.get('/intake/targeting', (req, res) => {
  res.json({
    success: true,
    targeting: targetingConfig
  });
});

router.post('/intake/scrape-agencies', async (req, res) => {
  try {
    const { query, limit, dryRun, mock } = req.body || {};
    const result = await runIntakeScrape({
      query: query || 'AI automation agency, Austin, TX',
      limit: parseInt(limit, 10) || 5,
      dryRun: dryRun === true,
      mock: mock === true
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[Intake Scrape Route Error]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ===================================================================
// 6. ENGINE HEALTH & CATALOG DISCOVERY
// ===================================================================
router.get('/engine/skills', (req, res) => {
  res.json({
    success: true,
    totalEnterpriseSkills: ENTERPRISE_SKILL_CATALOG.length,
    enterpriseSkills: ENTERPRISE_SKILL_CATALOG,
    routerFailoverPool: getRouterStatus()
  });
});

router.get(['/engine/health', '/health'], (req, res) => {
  const routerStatus = getRouterStatus();
  const primaryProvider = routerStatus.primaryProvider || 'gemini';
  const secondaryProvider = routerStatus.secondaryProvider || (process.env.OPENAI_API_KEY ? 'openai' : (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY ? 'claude' : 'not_configured'));

  let databaseStatus = 'CONNECTED';
  try {
    const fs = require('fs');
    const path = require('path');
    const localDb = path.join(__dirname, '..', 'outreach_queue.db');
    const parentDb = path.join(__dirname, '..', '..', 'outreach_queue.db');
    if (!fs.existsSync(localDb) && !fs.existsSync(parentDb)) {
      databaseStatus = 'ONLINE';
    }
  } catch (e) {
    databaseStatus = 'ONLINE';
  }

  res.status(200).json({
    status: "HEALTHY",
    primaryProvider,
    secondaryProvider,
    uptime: Math.round(process.uptime()),
    databaseStatus
  });
});

module.exports = router;
