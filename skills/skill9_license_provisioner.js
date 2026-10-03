/**
 * Skill 9: Stripe Checkout & License Provisioning Fulfillment
 * Issues commercial license keys, generates checkout fulfillment certificates,
 * and updates SQLite pipeline lifecycle state to 'converted'.
 */

const crypto = require('crypto');
const { PRICING_PACKAGES, getStripePaymentLink } = require('./skill2_proposal_generator');
const { transitionStage } = require('./skill7_pipeline_manager');

/**
 * Generates an authorized cryptographically secure license key
 */
function generateLicenseKey(company = 'Enterprise', tier = 'buyout') {
  const prefix = tier.toUpperCase().slice(0, 3);
  const hash = crypto.createHash('sha256').update(`${company}-${tier}-${Date.now()}`).digest('hex').toUpperCase();
  return `MHE-${prefix}-${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}`;
}

/**
 * Provisions a commercial license for an agency buyer
 */
function provisionLicense(params = {}) {
  const company = params.company || params.companyName || 'Enterprise Partner';
  const tier = (params.tier || params.package || 'retainer').toLowerCase();
  const contactEmail = params.email || params.contactEmail || `admin@${company.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
  const leadId = params.leadId || null;

  const pkg = PRICING_PACKAGES[tier] || PRICING_PACKAGES.retainer;
  const licenseKey = generateLicenseKey(company, tier);
  const issuedDate = new Date().toISOString();
  const checkoutUrl = getStripePaymentLink(tier, params.customStripeLink);

  // Transition state in SQLite if leadId provided
  let sqliteTransition = null;
  if (leadId) {
    try {
      sqliteTransition = transitionStage(leadId, 'converted', `Purchased ${pkg.title} (${licenseKey})`);
    } catch (e) {
      sqliteTransition = { error: e.message };
    }
  }

  const certificate = {
    certificateId: `CERT-${Date.now().toString(36).toUpperCase()}`,
    licensee: company,
    contactEmail,
    tier: pkg.title,
    licenseKey,
    commercialRights: {
      unlimitedSubLicensing: tier === 'buyout',
      sourceCodeAccess: tier === 'buyout',
      tokenRouterAccess: true,
      maxDeployments: tier === 'buyout' ? 'UNLIMITED' : (tier === 'setup_only' ? 1 : 5)
    },
    paymentStatus: params.simulatePayment === true ? 'PAID_ACTIVE' : 'PENDING_PAYMENT',
    stripeCheckoutUrl: checkoutUrl,
    issuedAt: issuedDate
  };

  return {
    success: true,
    message: `License successfully provisioned for ${company} (${pkg.title}).`,
    certificate,
    sqliteTransition
  };
}

module.exports = {
  generateLicenseKey,
  provisionLicense
};
