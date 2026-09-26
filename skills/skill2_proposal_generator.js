/**
 * Skill 2: Business Document & Proposal Generator
 * Generates structured B2B proposals, client service agreements, and onboarding scopes with embedded Stripe checkout links.
 */

const fs = require('fs');
const path = require('path');

const PRICING_PACKAGES = {
  retainer: {
    tierId: "retainer",
    title: "Agency Private-Label Setup & Managed Infrastructure",
    dueAtSigningUSD: 696,
    setupFeeUSD: 497,
    monthlyPriceUSD: 199,
    scope: [
      "Turnkey Agency AI Infrastructure deployment on Render Cloud",
      "Zero-Downtime Multi-LLM Failover Router (Sub-50ms circuit breaker)",
      "Automated Safe Outreach Guardrails & Pre-Send Queue Scrubber",
      "5 Included Client Sub-Keys with quota enforcement",
      "Custom agency branding, logo, and white-label portal"
    ],
    stripeLinkEnv: "STRIPE_RETAINER_LINK",
    defaultStripeLink: "https://buy.stripe.com/6oU9AS3WGdTlaWr68D0000G"
  },
  buyout: {
    tierId: "buyout",
    title: "Commercial Codebase & Developer License Buyout",
    oneTimePriceUSD: 4500,
    monthlyPriceUSD: 0,
    scope: [
      "100% Full Source Code Transfer (GitHub Repo: Jackbockholdt/margin-engine-core)",
      "Complete Render backend infrastructure & native SQLite database schemas",
      "Multi-LLM Failover Router & Queue Guardrail Scrubber source code",
      "Perpetual commercial developer license with zero monthly royalties",
      "Complete self-hosting sovereignty and 1-on-1 architecture handoff"
    ],
    stripeLinkEnv: "STRIPE_BUYOUT_LINK",
    defaultStripeLink: "https://buy.stripe.com/bJecN4al44iL5C7bsX0000H"
  }
};

/**
 * Retrieves the appropriate Stripe payment URL dynamically
 */
function getStripePaymentLink(tierId = 'retainer', customLink = null) {
  if (customLink) return customLink;
  if (process.env.STRIPE_PAYMENT_LINK) return process.env.STRIPE_PAYMENT_LINK;

  const pkg = PRICING_PACKAGES[tierId.toLowerCase()] || PRICING_PACKAGES.retainer;
  const envVal = process.env[pkg.stripeLinkEnv];
  return envVal || pkg.defaultStripeLink;
}

/**
 * Generates complete B2B proposal document
 */
function generateProposal(params = {}) {
  const {
    clientName = "Valued Partner",
    companyName = "Enterprise Client",
    tier = "retainer",
    customNotes = "",
    customStripeLink = null
  } = params;

  const selectedTier = String(tier).toLowerCase();
  const pkg = PRICING_PACKAGES[selectedTier] || PRICING_PACKAGES.retainer;
  const checkoutUrl = getStripePaymentLink(selectedTier, customStripeLink);
  const proposalId = `PROP-${Date.now().toString(36).toUpperCase()}`;
  const effectiveDate = new Date().toISOString().split('T')[0];

  const totalDueToday = pkg.oneTimePriceUSD ? pkg.oneTimePriceUSD : (pkg.setupFeeUSD + pkg.monthlyPriceUSD);

  const documentMarkdown = `# ⚡ MASTER HUSTLE ENGINE — B2B CLIENT SERVICE AGREEMENT

**Proposal ID:** ${proposalId}  
**Client:** ${clientName} (${companyName})  
**Effective Date:** ${effectiveDate}  
**Package Selected:** ${pkg.title}  

---

## 1. Executive Scope of Work
The Master Hustle Engine provides an automated, token-optimized infrastructure to automate lead qualification, content syndication, and outreach operations:

${pkg.scope.map(s => `* [x] ${s}`).join('\n')}

${customNotes ? `\n### Special Requirements:\n${customNotes}\n` : ''}

---

## 2. Investment & Commercial Terms
* **Service Plan:** ${pkg.title}
* **Pricing Structure:** ${pkg.oneTimePriceUSD ? `$${pkg.oneTimePriceUSD.toLocaleString()} (One-time Buyout)` : `$${pkg.monthlyPriceUSD}/month (+$${pkg.setupFeeUSD} Initial Setup)`}
* **Total Due to Initiate:** **$${totalDueToday.toLocaleString()} USD**

---

## 3. Stripe Checkout & Instant Onboarding
Click the link below to finalize onboarding via Stripe:

👉 **[Secure Stripe Checkout: Initiate ${pkg.title}](${checkoutUrl})**

*Payment Link URL:* \`${checkoutUrl}\`

---

## 4. Operational Guarantees
* **Fail-Closed Lead Safety**: Automatic suppression against spam traps and invalid DNS MX records.
* **Token Cost Efficiency**: 87.6% reduction enforced via Gemini Flash budget routing.
* **Data Isolation**: Production customer records and test environments remain strictly separated.
`;

  return {
    success: true,
    proposalId,
    clientName,
    companyName,
    tierSelected: pkg.tierId,
    pricing: {
      packageTitle: pkg.title,
      monthlyPriceUSD: pkg.monthlyPriceUSD,
      setupFeeUSD: pkg.setupFeeUSD || 0,
      oneTimePriceUSD: pkg.oneTimePriceUSD || null,
      totalDueTodayUSD: totalDueToday
    },
    stripeCheckout: {
      paymentLink: checkoutUrl,
      isConfigured: !!(process.env[pkg.stripeLinkEnv] || process.env.STRIPE_PAYMENT_LINK || process.env.STRIPE_SECRET_KEY)
    },
    documentMarkdown,
    scopeSummary: pkg.scope
  };
}

module.exports = {
  PRICING_PACKAGES,
  getStripePaymentLink,
  generateProposal
};
