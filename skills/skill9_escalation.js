'use strict';

/**
 * Skill 9: Escalation Engine
 * Automated Human Alert Triggers, High-Value Deal Routing & Critical Failure Traps
 * 
 * Escalation Triggers:
 *  - VIP_DEAL_DETECTED: High-value lead ($5,000+/mo burn or Buyout tier interest)
 *  - MULTI_MODEL_EXHAUSTION: All LLM providers in pool failed
 *  - SECURITY_THREAT_BLOCK: SQLi or jailbreak attempt blocked at gatekeeper
 *  - CONSECUTIVE_DISPATCH_FAILURE: Unrecoverable delivery errors
 */

const incidentLog = [];

const SEVERITY_LEVELS = {
  P1_CRITICAL: 'P1_CRITICAL', // Immediate ops attention (all models down, security exploit)
  P2_HIGH: 'P2_HIGH',         // High priority (VIP enterprise deal, large buyout interest)
  P3_WARNING: 'P3_WARNING'    // Deliverability anomaly or recoverable rate limit
};

function triggerEscalation({ triggerType = 'VIP_DEAL_DETECTED', details = {}, lead = null, severity = null } = {}) {
  let resolvedSeverity = severity;
  let actionRequired = '';

  switch (triggerType) {
    case 'VIP_DEAL_DETECTED':
      resolvedSeverity = resolvedSeverity || SEVERITY_LEVELS.P2_HIGH;
      actionRequired = 'Direct human founder/executive outreach. Prepare customized architecture pitch.';
      break;

    case 'MULTI_MODEL_EXHAUSTION':
      resolvedSeverity = resolvedSeverity || SEVERITY_LEVELS.P1_CRITICAL;
      actionRequired = 'Inspect API_POOL tokens, verify billing on Gemini/Claude/Grok/OpenRouter.';
      break;

    case 'SECURITY_THREAT_BLOCK':
      resolvedSeverity = resolvedSeverity || SEVERITY_LEVELS.P1_CRITICAL;
      actionRequired = 'Audit origin IP/token, check blocklist, verify zero data leakage.';
      break;

    case 'DELIVERY_FAILURE_SPIKE':
      resolvedSeverity = resolvedSeverity || SEVERITY_LEVELS.P3_WARNING;
      actionRequired = 'Verify sending domain DNS records, MX health, and Gmail Apps Script relay quota.';
      break;

    default:
      resolvedSeverity = resolvedSeverity || SEVERITY_LEVELS.P3_WARNING;
      actionRequired = 'Log and review during regular daily telemetry audit.';
  }

  const incidentId = `INC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  const incident = {
    incidentId,
    timestamp: new Date().toISOString(),
    triggerType,
    severity: resolvedSeverity,
    lead: lead ? { company: lead.company, email: lead.email, score: lead.qualificationScore } : null,
    details,
    actionRequired,
    status: 'ACTIVE_ESCALATION'
  };

  incidentLog.unshift(incident);
  if (incidentLog.length > 100) incidentLog.pop(); // Cap history

  console.warn(`[Escalation Trap] ${resolvedSeverity} Triggered: ${triggerType} -> ${actionRequired}`);

  return {
    success: true,
    incidentId,
    escalated: true,
    severity: resolvedSeverity,
    triggerType,
    actionRequired,
    incident
  };
}

function getActiveIncidents() {
  return {
    totalIncidents: incidentLog.length,
    incidents: incidentLog
  };
}

module.exports = {
  triggerEscalation,
  getActiveIncidents,
  SEVERITY_LEVELS
};
