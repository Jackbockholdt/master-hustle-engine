/**
 * Skill 8: Proof Asset & Pitch Deck Generator
 * Generates custom white-label pitch decks, technical architecture diagrams,
 * financial ROI calculators, and client proof assets.
 */

const { PRICING_PACKAGES } = require('./skill2_proposal_generator');

/**
 * Generates an interactive HTML & Markdown Pitch Deck for client presentations
 */
function generatePitchDeck(params = {}) {
  const agencyName = params.agencyName || params.company || 'Enterprise Agency Partner';
  const burnEst = parseFloat(params.monthlyBurnUSD || 4000);
  const annualBurn = burnEst * 12;
  const annualSavings = Math.round(annualBurn * 0.65);
  const timestamp = new Date().toLocaleDateString();

  const deckMarkdown = `# ⚡ MASTER HUSTLE / ANTI-GRAVITY MARGIN ENGINE
## Transforming Agency AI API Overhead into Pure Profit
**Prepared for:** ${agencyName} | **Date:** ${timestamp}

---

### 1. The Core Problem: LLM Token Burn
* When agencies build multi-agent systems and high-volume client workflows, OpenAI/Anthropic bills skyrocket.
* Standard implementations send unfiltered prompts directly to expensive flagship models ($0.005–$0.015/call).
* For ${agencyName}, an estimated **$${burnEst.toLocaleString()}/month ($${annualBurn.toLocaleString()}/year)** is lost to token overhead.

---

### 2. The Solution: 3-Tier Token Reducer Router
Our proprietary orchestrator acts as a single source of truth across all LLM interactions:

\`\`\`
[ Raw Inbound Lead / Client Request ]
                │
                ▼
┌────────────────────────────────────────────────────────┐
│  Tier 1: Context Bloat Stripper & Fast Qualifier       │
│  Model: Gemini 1.5 Flash (~$0.0001 / lead)             │
│  Result: 87.6% Token Cost Reduction                    │
└───────────────────────┬────────────────────────────────┘
                        │ (If Qualified)
                        ▼
┌────────────────────────────────────────────────────────┐
│  Tier 2: Deep Researcher & Copywriting Engine          │
│  Model: Grok API Path (Prepaid Credits / Fast Copy)    │
│  Result: Highly Personalized Hook & Strategy           │
└───────────────────────┬────────────────────────────────┘
                        │ (Requires Human Approval)
                        ▼
┌────────────────────────────────────────────────────────┐
│  Tier 3: Flagship Enterprise Engine                    │
│  Model: Gemini 1.5 Pro ($0.0035 / unit)                │
│  Security: Gated via HTTP 403 (Zero Automated Leaks)   │
└────────────────────────────────────────────────────────┘
\`\`\`

---

### 3. Financial ROI & Margin Recovery Matrix for ${agencyName}

| Metric | Unoptimized Baseline | With Margin Engine | Total Improvement |
| :--- | :--- | :--- | :--- |
| **Average Cost / Lead** | $0.0050 USD | $0.0001 USD | **50x Cost Reduction** |
| **Monthly Token Burn** | $${burnEst.toLocaleString()} USD | $${Math.round(burnEst * 0.35).toLocaleString()} USD | **+$${Math.round(burnEst * 0.65).toLocaleString()} Profit/mo** |
| **Annualized Recovery** | $${annualBurn.toLocaleString()} USD | $${Math.round(annualBurn * 0.35).toLocaleString()} USD | **+$${annualSavings.toLocaleString()} USD / yr** |
| **Gross Margin Impact** | ~55-65% | **94.2%** | **+29.2% Net Margin** |

---

### 4. Available Licensing Options

1. **Agency Private-Label ($497 setup + $199/mo)**
   * Turnkey deployment of Multi-LLM Failover Router & Safe Outreach Scrubber.
   * Continuous uptime monitoring, automated circuit breaking, and managed cloud maintenance.
2. **Commercial Codebase License ($4,500 one-time)**
   * Full GitHub source code repository (Jackbockholdt/margin-engine-core) transfer.
   * Unlimited agency deployments and perpetual commercial rights with zero recurring fees.
`;

  return {
    success: true,
    agencyName,
    financialModel: {
      estimatedMonthlyBurnUSD: burnEst,
      estimatedMonthlySavingsUSD: Math.round(burnEst * 0.65),
      estimatedAnnualSavingsUSD: annualSavings,
      grossMarginPct: "94.2%"
    },
    pitchDeckMarkdown: deckMarkdown,
    packagesAvailable: PRICING_PACKAGES
  };
}

module.exports = {
  generatePitchDeck
};
