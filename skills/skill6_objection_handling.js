'use strict';

/**
 * Skill 6: Objection Handling Engine
 * Classification & Rebuttal Playbook Engine
 * 
 * Classifies objections:
 *  - PRICE_BUDGET
 *  - TIMING
 *  - IN_HOUSE_BUILD
 *  - COMPETITOR_EXISTING
 *  - AUTHORITY_DELEGATION
 */

const { routeMultiModel } = require('../lib/multiModelRouter');

const REBUTTAL_PLAYBOOKS = {
  PRICE_BUDGET: {
    coreAngle: 'Self-funding margin recovery',
    talkingPoint: 'The system does not cost money; it recovers 50-70% of current runaway token burn. If your monthly LLM spend is $3k, the $1.5k retainer pays for itself in 30 days.',
    sampleReply: 'Understood on budget. The reason shops license the 9-skill engine is that it actually pays for itself on day 1 by slashing 87% of background token waste. If we do not recover more than the retainer in month one, you pay nothing.'
  },
  TIMING: {
    coreAngle: 'Zero-friction drop-in gateway',
    talkingPoint: 'Implementation takes under 45 minutes via proxy middleware. No engineering sprints or roadmap delays.',
    sampleReply: 'Totally get it — timing is everything. Just so you know, implementation is a 45-minute drop-in proxy (zero rewrite of your existing agent code). Would a quick 5-minute Loom video make sense so you have it on file for next quarter?'
  },
  IN_HOUSE_BUILD: {
    coreAngle: 'Buy vs. build economics',
    talkingPoint: 'Building custom multi-model failover, token governance, and SQLite state tracking takes 160+ dev hours ($20k+ internal salary burn).',
    sampleReply: 'Your team can certainly build this — but at 160 engineering hours, that is $20,000+ in diverted dev focus. We hand you the fully tested production codebase today for a fraction of that.'
  },
  COMPETITOR_EXISTING: {
    coreAngle: 'Multi-model failover insurance',
    talkingPoint: 'Single-vendor setups leave agencies vulnerable to 429 outages and token price hikes. Our router sits on top and auto-fails over.',
    sampleReply: 'Great to hear you have an existing setup. We do not replace your stack; we sit directly in front of it as an intelligent failover router that guarantees 100% uptime across Gemini, Claude, and Grok.'
  },
  AUTHORITY_DELEGATION: {
    coreAngle: 'Executive alignment package',
    talkingPoint: 'Provide concise 1-page executive summary for the right stakeholder.',
    sampleReply: 'Thanks for pointing me in the right direction. Could you connect me with whoever oversees your AI infra and engineering margins so I can share the 1-page architectural breakdown?'
  }
};

function classifyObjection(text = '') {
  const lower = String(text).toLowerCase();

  if (/price|cost|expensive|budget|afford|money|cents|dollars/i.test(lower)) {
    return 'PRICE_BUDGET';
  }
  if (/busy|later|next quarter|not now|bad time|q3|q4|next month|in the middle of/i.test(lower)) {
    return 'TIMING';
  }
  if (/in-house|build our own|internal team|our devs|in house|we do this ourselves/i.test(lower)) {
    return 'IN_HOUSE_BUILD';
  }
  if (/already use|competitor|openai|chatgpt|claude|copilot|another vendor|already have/i.test(lower)) {
    return 'COMPETITOR_EXISTING';
  }
  if (/not the right person|talk to|refer you|reach out to|cfo|cto|ceo|manager/i.test(lower)) {
    return 'AUTHORITY_DELEGATION';
  }

  return 'PRICE_BUDGET'; // Default high-probability objection
}

async function handleObjection({ objectionText = '', lead = {}, mock = false } = {}) {
  const category = classifyObjection(objectionText);
  const playbook = REBUTTAL_PLAYBOOKS[category];

  const prompt = `
A prospect (${lead.fullName || 'Lead'} at ${lead.company || 'their agency'}) raised this objection:
"${objectionText}"

Category identified: ${category}
Core Angle to emphasize: ${playbook.coreAngle}
Key Talking Point: ${playbook.talkingPoint}

Write a professional, persuasive 2-sentence email reply overcoming this friction.
`.trim();

  const dispatch = await routeMultiModel({
    prompt,
    systemPrompt: 'You are an executive dealmaker handling client objections with calm confidence and concrete financial math.',
    task: 'OBJECTION_REBUTTAL',
    mock
  });

  return {
    success: true,
    objectionText,
    category,
    playbook,
    recommendedRebuttal: playbook.sampleReply,
    aiGeneratedRebuttal: dispatch.output,
    providerUsed: dispatch.provider
  };
}

module.exports = {
  handleObjection,
  classifyObjection,
  REBUTTAL_PLAYBOOKS
};
