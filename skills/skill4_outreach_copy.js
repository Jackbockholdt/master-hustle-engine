/**
 * Skill 4: Multi-Agent Copy & Cold Outreach Generator
 * Pitches the Agency AI Infrastructure Layer: Zero-Downtime Failover & Safe Outreach Guardrails
 * 
 * - Offer URL: https://master-hustle-engine.onrender.com/demo
 * - Confirmed Private-Label SKU: https://buy.stripe.com/6oU9AS3WGdTlaWr68D0000G ($497 setup + $199/mo)
 * - Confirmed Codebase SKU: https://buy.stripe.com/bJecN4al44iL5C7bsX0000H ($4,500 one-time buyout)
 */

const { getStripePaymentLink } = require('./skill2_proposal_generator');
const { optimizeTokenRoute } = require('./skill1_token_optimizer');

const LIVE_LANDING_URL = 'https://master-hustle-engine.onrender.com';
const LIVE_DEMO_URL = 'https://master-hustle-engine.onrender.com/demo';
const CONFIRMED_STRIPE_RETAINER = 'https://buy.stripe.com/6oU9AS3WGdTlaWr68D0000G';
const CONFIRMED_STRIPE_BUYOUT = 'https://buy.stripe.com/bJecN4al44iL5C7bsX0000H';

/**
 * Extracts a compelling, personalized hook based on agency niche and use case
 */
function extractOutreachHook(lead = {}) {
  const company = lead.company || 'your agency';
  const industry = lead.industry || 'AI & Digital Services';
  const useCase = lead.llmUseCase || lead.useCase || 'client AI bots & automated pipelines';

  return {
    hook: `Zero-downtime multi-LLM failover (<50ms) and automated queue delivery guardrails for ${company}.`,
    angle: `Protecting client AI bots from upstream outages and keeping sender domains out of spam.`
  };
}

/**
 * Generates full 3-step cold outreach copy sequence
 */
function generateOutreachSequence(params = {}) {
  const lead = params.lead || params;
  const name = lead.name || lead.firstName || 'there';
  const company = lead.company || 'your agency';
  const industry = lead.industry || 'Digital & AI Services';
  const hookData = extractOutreachHook(lead);

  // Route model request through Token Optimizer
  const routeCheck = optimizeTokenRoute({
    taskType: 'OUTREACH_COPY_GENERATION',
    rawPrompt: `Generate agency AI infrastructure copy for ${name} at ${company} in ${industry}`,
    leadCount: 1
  });

  const buyoutLink = CONFIRMED_STRIPE_BUYOUT;
  const retainerLink = CONFIRMED_STRIPE_RETAINER;

  // Step 0: Initial Touch
  const step0 = {
    step: 0,
    type: 'INITIAL_PITCH',
    subject: `uptime insurance for your client AI bots`,
    body: `Hi ${name},

I saw ${company}'s work in ${industry}. Most agencies scaling client AI bots hit two painful failure modes: upstream model outages causing silent bot downtime, and dirty queue data triggering spam blocks on client domains.

We built and open-demonstrated the **Agency AI Infrastructure Layer** (test the interactive failover console and queue scrubber at [${LIVE_DEMO_URL}](${LIVE_DEMO_URL})).

### Core Capabilities:
* **Zero-Downtime Multi-LLM Failover**: If Gemini or OpenAI returns a 503 or 429, requests silently swap to backup providers in under 50ms.
* **10-Point Delivery Guardrail Scrubber**: Automated RFC syntax checks, in-batch deduplication, active DNC suppression, and role/freemail blocking.
* **48-Hour Quiet Window**: Prevents duplicate follow-ups and protects client sender domain reputations.

### Commercial Licensing:
* **Agency Private-Label ($497 setup + $199/mo)**
  Turnkey deployment to your Render/custom domain, white-label dashboard, and 24/7 uptime monitoring.
  👉 [Deploy Agency Private-Label ($497 + $199/mo)](${retainerLink})

* **Commercial Codebase License ($4,500 one-time)**
  Complete source code transfer (GitHub: Jackbockholdt/margin-engine-core), perpetual rights for unlimited client bots, zero monthly royalties.
  👉 [Acquire Commercial License ($4,500)](${buyoutLink})

You can test both the failover circuit and the queue scrubber right now in the live console:
👉 [${LIVE_DEMO_URL}](${LIVE_DEMO_URL})

Open to a brief 5-minute technical review this week?

Best regards,
Jack Buckholdt
Agency AI Infrastructure
${LIVE_DEMO_URL}`
  };

  // Step 1: Technical Follow-Up (+48 Hours)
  const step1 = {
    step: 1,
    type: 'TECHNICAL_BREAKDOWN_48H',
    delayHours: 48,
    subject: `Re: uptime insurance for your client AI bots (<50ms failover)`,
    body: `Hi ${name},

Following up on the agency AI infrastructure for ${company}.

Here is the exact circuit-breaker flow our engine runs:

\`\`\`
[ Client Bot Query ]
        │
        ▼
[ Primary: Gemini 3.6 Flash ] ──(503 / 429 Error)──► [ Hot-Standby: Claude 3.5 / OpenAI ]
        │                                                     │
        ▼                                                     ▼
 (Success ~120ms)                                      (Failover <50ms)
\`\`\`

And before any outbound outreach is dispatched:
* RFC 5322 syntax validation
* Real-time DNC suppression
* 48-hour quiet window enforcement per recipient

Test it live without creating an account: [${LIVE_DEMO_URL}](${LIVE_DEMO_URL})

Would Thursday or Friday work for a quick 10-minute architecture review?

Best,
Jack Buckholdt
Host: ${LIVE_LANDING_URL}`
  };

  // Step 2: Closing & Direct Stripe Link (+72 Hours)
  const step2 = {
    step: 2,
    type: 'WHITE_LABEL_CLOSER_72H',
    delayHours: 72,
    subject: `Final note: failover infrastructure & codebase license for ${company}`,
    body: `Hi ${name},

Closing the loop on the agency AI infrastructure layer.

If ${company} would like to deploy private-label failover for client bots or acquire the codebase:

* **[Agency Private-Label ($497 setup + $199/mo)](${retainerLink})** — Hosted, monitored, and maintained for your agency.
* **[Commercial Codebase License ($4,500 lifetime)](${buyoutLink})** — 100% source code transfer, self-hosting rights, and unlimited client sub-licensing.

Inspect the complete architecture and test the live console at [${LIVE_DEMO_URL}](${LIVE_DEMO_URL}).

Best,
Jack Buckholdt
Agency AI Infrastructure`
  };

  return {
    success: true,
    lead: { name, company, industry, email: lead.email },
    modelTierUsed: routeCheck.selectedModel || 'gemini-3.6-flash',
    hookData,
    sequence: [step0, step1, step2]
  };
}

module.exports = {
  LIVE_LANDING_URL,
  LIVE_DEMO_URL,
  CONFIRMED_STRIPE_RETAINER,
  CONFIRMED_STRIPE_BUYOUT,
  extractOutreachHook,
  generateOutreachSequence
};
