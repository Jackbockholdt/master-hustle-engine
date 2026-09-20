'use strict';

/**
 * Skill 5: Copywriting & Output Generation Engine
 * Multi-Model Dispatch for High-Converting Cold Email & Pitch Copy
 * 
 * Configured around the White-Label Agency Licensing Offer:
 *  - $4,000 to start ($2,500 setup plus first month)
 *  - $1,500/month thereafter
 * 
 * Core Technical Differentiators:
 *  1. Multi-LLM Zero-Downtime Failover (<50ms circuit swap)
 *  2. 10-layer queue scrubber with RFC syntax check & DNC suppression
 *  3. Deployable under their agency brand with white-label dashboard
 * 
 * Dispatches through lib/multiModelRouter:
 *   Gemini -> Claude -> Grok -> OpenRouter
 */

const { routeMultiModel } = require('../lib/multiModelRouter');
const { PRICING } = require('../config/pricing');

async function generateCopywriting({
  lead = {},
  context = {},
  channel = 'EMAIL',
  preferredProvider,
  mock = false
} = {}) {
  const company = lead.company || 'your agency';
  const name = lead.firstName || lead.fullName || 'there';
  const industry = lead.industry || 'AI automation & digital services';
  const burn = lead.budgetUSD || lead.estimatedMonthlyLLMBurnUSD || 3500;

  const prompt = `
Generate a high-converting ${channel} outreach pitch for ${name} at ${company} (${industry}).
The Offer:
- License the Agency AI Infrastructure for ${PRICING.display.headline}.
- Do not quote a codebase-buyout price or include a Stripe checkout link in cold outreach.
- Key Differentiators:
  1. Zero-downtime multi-LLM failover router (<50ms circuit swap on 503/429).
  2. 10-point delivery guardrail queue scrubber (RFC syntax, DNC suppression, role/freemail filtering).
  3. Deployable 100% white-label under their agency brand for client bots.

Tone: Senior technical architect to agency owner. Concise, zero fluff.
`.trim();

  const systemPrompt = context.systemPrompt || 'You are an enterprise B2B software architect pitching agency infrastructure to founders.';

  // Dispatch via Multi-Model Router
  const dispatchResult = await routeMultiModel({
    prompt,
    systemPrompt,
    preferredProvider,
    task: 'COPYWRITING_OUTREACH',
    mock
  });

  // Pre-configured structured 3-touch sequence reflecting the White-Label Offer
  const sequence = {
    step1_teaser: {
      subject: `${company}: multi-LLM failover router + outbound guardrails`,
      body: `Hey ${name}, saw ${company}'s work in ${industry}. Most agencies scaling client AI bots hit a wall with upstream provider downtime and dirty queue data burning domain reputation.\n\nWe packaged a production-tested infrastructure layer with sub-50ms failover across Gemini, Claude, and OpenAI plus a 10-point queue scrubber that protects client domains.\n\nAvailable as a ${PRICING.display.headline} private-label license. Open to a 5-minute technical overview?`
    },
    step2_breakdown: {
      subject: `Re: ${company} — zero downtime failover (<50ms swap)`,
      body: `Hey ${name}, following up on the agency AI infrastructure. The core resilience our partners care about:\n\n1. Zero-downtime failover: if Gemini or OpenAI hits an upstream 503 or 429, requests silently swap to backup providers in under 50ms.\n2. Automated delivery guardrails: RFC syntax checks, DNC suppression, and a mandatory 48-hour quiet window to protect sending reputations.\n\nTested console available at /demo. Worth a brief walkthrough this week?`
    },
    step3_breakup: {
      subject: `Final note: white-label AI infrastructure for ${company}`,
      body: `${name}, closing out my notes for ${company}. If adding a white-label AI infrastructure line is not on your roadmap this quarter, completely understand.\n\nIf it becomes relevant, I can walk you through the live failover and outbound guardrail console.`
    }
  };

  return {
    success: true,
    channel,
    offer: {
      buyoutUSD: 25000,
      setupUSD: 4000,
      monthlyRetainerUSD: 1500,
      differentiators: [
        '9 pre-built operational modules (gatekeeping, entity extraction, validation, failover)',
        'Multi-model failover pooling (Gemini -> Claude -> Grok -> OpenRouter)',
        '100% white-label deployment under agency brand to resell to clients'
      ]
    },
    modelUsed: dispatchResult.model,
    providerUsed: dispatchResult.provider,
    generatedCopy: dispatchResult.output,
    sequence,
    telemetry: {
      latencyMs: dispatchResult.latencyMs,
      mode: dispatchResult.mode
    }
  };
}

module.exports = {
  generateCopywriting
};
