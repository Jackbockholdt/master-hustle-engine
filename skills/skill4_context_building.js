'use strict';

/**
 * Skill 4: Context Building Engine
 * Token-Reduction Pruning, Context Assembly & Concise Memory Construction
 * 
 * Capabilities:
 *  - Conversational bloat & pleasantry pruning (recovers 80%+ tokens)
 *  - Structured memory integration (past touches, stage, specific pain points)
 *  - High-density system prompt assembly
 */

const BLOAT_PATTERNS = [
  /I\s+hope\s+this\s+email\s+finds\s+you\s+well[.,!]?/gi,
  /Hope\s+you('re|\s+are)\s+having\s+a\s+(great|wonderful)\s+week[.,!]?/gi,
  /My\s+name\s+is\s+.*?\s+and\s+I\s+am\s+reaching\s+out\s+because/gi,
  /Please\s+let\s+me\s+know\s+if\s+you\s+have\s+any\s+questions[.,!]?/gi,
  /Feel\s+free\s+to\s+reach\s+out\s+anytime[.,!]?/gi,
  /Thanks\s+in\s+advance\s+for\s+your\s+time\s+and\s+consideration[.,!]?/gi
];

function pruneBloat(text) {
  if (typeof text !== 'string') return '';
  let cleaned = text;
  for (const pattern of BLOAT_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Builds compact context for LLM dispatch
 */
function buildContext({ lead = {}, pastTouches = [], objection = null, objective = 'OUTREACH' } = {}) {
  const company = lead.company || 'the agency';
  const name = lead.firstName || lead.fullName || 'there';
  const industry = lead.industry || 'B2B Services';
  const burn = lead.budgetUSD || lead.estimatedMonthlyLLMBurnUSD || 3500;
  const potentialSavings = Math.round(burn * 0.70);

  // Compact Fact Matrix
  const facts = [
    `Target: ${name} (${lead.title || 'Decision Maker'}) @ ${company}`,
    `Vertical: ${industry}`,
    `Est. LLM Burn: $${burn}/mo | Potential Margin Recovery: $${potentialSavings}/mo (70%)`,
    `Core Offer: Master Hustle 9-Skill White-Label Agency Infrastructure`
  ];

  if (objection) {
    facts.push(`Active Objection: "${objection}"`);
  }

  if (pastTouches && pastTouches.length) {
    facts.push(`Touch History: ${pastTouches.slice(-2).map(t => `${t.step}:${t.outcome}`).join(', ')}`);
  }

  const rawContextString = JSON.stringify({ lead, pastTouches, objection, objective });
  const rawTokenEstimate = Math.ceil(rawContextString.length / 4);

  const contextAssembly = facts.join('\n');
  const optimizedTokenEstimate = Math.ceil(contextAssembly.length / 4);
  const reductionPct = Math.round(((rawTokenEstimate - optimizedTokenEstimate) / rawTokenEstimate) * 100);

  return {
    success: true,
    objective,
    contextSummary: contextAssembly,
    tokenMetrics: {
      rawEstimatedTokens: rawTokenEstimate,
      prunedEstimatedTokens: optimizedTokenEstimate,
      reductionPct: `${Math.max(0, reductionPct)}%`
    },
    systemPrompt: `You are the Master Hustle Agency Engine. Write razor-sharp, zero-fluff copy for ${name} at ${company}. Focus exclusively on $${potentialSavings}/mo token margin recovery. Never use pleasantries.`
  };
}

module.exports = {
  buildContext,
  pruneBloat
};
