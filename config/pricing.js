/**
 * config/pricing.js
 *
 * THE single pricing authority for this repo. There is exactly ONE offer:
 *
 *   $4,000 due at signing ($2,500 setup + first month) then $1,500/month.
 *
 * The $25,000 codebase buyout is retained as a PRICE ANCHOR ONLY. It may appear
 * in human-facing sales copy (landing pages, one-pagers) to frame the license as
 * the cheaper path. It must NEVER be quoted as a purchasable option in an API
 * response or in automated outbound email — see `quotableOffer()` below, which is
 * what those code paths are required to use.
 *
 * Numbers live in config/pricing.json so orchestrator.py reads the same source.
 * Do not hardcode a dollar figure anywhere else; import from here instead.
 */

const raw = require('./pricing.json');

const money = (n) => `$${n.toLocaleString('en-US')}`;

const PRICING = {
  offerName: raw.offerName,
  currency: raw.currency,

  // Raw numbers — use these for arithmetic and for Stripe amount comparisons.
  setupFee: raw.setupFee,
  firstMonth: raw.firstMonth,
  dueAtSigning: raw.dueAtSigning,
  monthly: raw.monthly,
  buyout: raw.buyout,

  // Pre-formatted display strings — use these in copy so every surface renders
  // the price identically.
  display: {
    setupFee: money(raw.setupFee),
    dueAtSigning: money(raw.dueAtSigning),
    monthly: `${money(raw.monthly)}/mo`,
    monthlyLong: `${money(raw.monthly)}/month`,
    buyout: money(raw.buyout),
    // The canonical one-line quote. If you need to state the price, state this.
    headline: `${money(raw.dueAtSigning)} to start (${money(raw.setupFee)} setup + first month), then ${money(raw.monthly)}/month`,
    short: `${money(raw.dueAtSigning)} to start, then ${money(raw.monthly)}/mo`,
  },
};

/**
 * The ONLY offer that may be quoted in an endpoint response or an automated
 * outbound email. Deliberately omits the buyout — anchor pricing is a
 * conversation a human has, not a number a cron job emails out.
 */
function quotableOffer() {
  return {
    name: PRICING.offerName,
    due_at_signing: PRICING.dueAtSigning,
    setup_fee: PRICING.setupFee,
    first_month: PRICING.firstMonth,
    monthly: PRICING.monthly,
    currency: PRICING.currency,
    headline: PRICING.display.headline,
  };
}

/**
 * Sales-copy view. Includes the buyout because human-facing pages are allowed to
 * anchor against it. `buyout_is_anchor_only` is carried through so any consumer
 * can tell the difference between "a price you can buy" and "a price you compare to".
 */
function salesCopyOffer() {
  return {
    ...quotableOffer(),
    buyout: PRICING.buyout,
    buyout_is_anchor_only: raw.buyoutIsAnchorOnly,
  };
}

module.exports = { PRICING, quotableOffer, salesCopyOffer };
