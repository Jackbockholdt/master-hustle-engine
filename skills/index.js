'use strict';

/**
 * skills/index.js
 * Central Export Gateway for the 9-Skill Master Hustle Engine Enterprise Architecture
 */

// Enterprise 9-Skill Architecture
const { gatekeepRequest, screenThreats, sanitizeObject } = require('./skill1_gatekeeping');
const { extractEntities, normalizeDomain, normalizePhone } = require('./skill2_entity_extraction');
const { scoreLead } = require('./skill3_lead_qualification');
const { buildContext, pruneBloat } = require('./skill4_context_building');
const { generateCopywriting } = require('./skill5_copywriting');
const { handleObjection, classifyObjection } = require('./skill6_objection_handling');
const { generateBookingLink, dispatchWebhook, prepareMeetingDispatch } = require('./skill7_scheduling_dispatch');
const { validateSchema, validateAgainstSchema, SCHEMAS } = require('./skill8_schema_validation');
const { triggerEscalation, getActiveIncidents, SEVERITY_LEVELS } = require('./skill9_escalation');

// Multi-Model Failover Router
const { routeMultiModel, getRouterStatus } = require('../lib/multiModelRouter');

// Legacy / Operational Margin Skills (Backward Compatibility)
const { optimizeTokenRoute, tokenStats } = require('./skill1_token_optimizer');
const { generateProposal, PRICING_PACKAGES } = require('./skill2_proposal_generator');
const { triageLead, verifyMxRecord } = require('./skill3_lead_triage');
const { generateOutreachSequence, extractOutreachHook } = require('./skill4_outreach_copy');
const { scrapeAndEnrichLead, estimateAgencyLLMBurn } = require('./skill5_scrape_enrich');
const { compileTelemetryReport, verifyDomainMX, recordDispatchEvent } = require('./skill6_verify_telemetry');
const { getPipelineSummary, upsertLead, transitionStage, seedInitialPipeline } = require('./skill7_pipeline_manager');
const { generatePitchDeck } = require('./skill8_asset_generator');
const { provisionLicense, generateLicenseKey } = require('./skill9_license_provisioner');

module.exports = {
  // Enterprise 9 Skills
  skill1: { gatekeepRequest, screenThreats, sanitizeObject },
  skill2: { extractEntities, normalizeDomain, normalizePhone },
  skill3: { scoreLead },
  skill4: { buildContext, pruneBloat },
  skill5: { generateCopywriting },
  skill6: { handleObjection, classifyObjection },
  skill7: { generateBookingLink, dispatchWebhook, prepareMeetingDispatch },
  skill8: { validateSchema, validateAgainstSchema, SCHEMAS },
  skill9: { triggerEscalation, getActiveIncidents, SEVERITY_LEVELS },

  // Router
  multiModelRouter: { routeMultiModel, getRouterStatus },

  // Direct Functions
  gatekeepRequest,
  extractEntities,
  scoreLead,
  buildContext,
  generateCopywriting,
  handleObjection,
  generateBookingLink,
  dispatchWebhook,
  prepareMeetingDispatch,
  validateSchema,
  triggerEscalation,
  routeMultiModel,

  // Legacy Compatible Exports
  optimizeTokenRoute,
  tokenStats,
  generateProposal,
  PRICING_PACKAGES,
  triageLead,
  verifyMxRecord,
  generateOutreachSequence,
  extractOutreachHook,
  scrapeAndEnrichLead,
  estimateAgencyLLMBurn,
  compileTelemetryReport,
  verifyDomainMX,
  recordDispatchEvent,
  getPipelineSummary,
  upsertLead,
  transitionStage,
  seedInitialPipeline,
  generatePitchDeck,
  provisionLicense,
  generateLicenseKey
};
