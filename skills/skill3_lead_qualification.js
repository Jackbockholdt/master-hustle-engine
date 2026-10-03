'use strict';

/**
 * Skill 3: Lead Qualification Engine
 * Scoring Matrix, ICP Validation & Tier Routing
 * 
 * Matrix Breakdown (Max 100 pts):
 *  - Domain Quality (Corporate vs Freemail / Missing): 20 pts
 *  - Company Identity & Web Presence: 20 pts
 *  - Decision Maker Authority (C-Level, Founder, VP): 20 pts
 *  - Target ICP Industry Fit: 20 pts (High-Value AI & Automation agencies get +20 pts)
 *  - Financial Capacity / LLM Burn Threshold: 20 pts
 * 
 * Target High-Intent Buyer Categories:
 *  - AI automation agency
 *  - GoHighLevel agency
 *  - Marketing automation consultant
 *  - B2B growth agency
 *  - Workflow automation agency
 * 
 * Tier Classification:
 *  - TIER_1_VIP: Score >= 80 (Eligible for Buyout & Direct Flagship Copy)
 *  - TIER_2_STANDARD: Score 50 - 79 (Automated Sequence Dispatch)
 *  - TIER_3_NURTURE: Score 30 - 49 (Low-cost Newsletter / Educational Content)
 *  - DISQUALIFIED: Score < 30 (Fails minimum ICP criteria)
 */

const HIGH_INTENT_CATEGORIES = [
  'ai automation agency',
  'ai automation',
  'gohighlevel agency',
  'gohighlevel',
  'ghl agency',
  'marketing automation consultant',
  'marketing automation',
  'b2b growth agency',
  'b2b growth',
  'workflow automation agency',
  'workflow automation',
  'automation agency'
];

const TARGET_INDUSTRIES = [
  ...HIGH_INTENT_CATEGORIES,
  'digital marketing',
  'marketing agency',
  'seo agency',
  'ppc agency',
  'social media',
  'advertising',
  'growth agency',
  'web development',
  'ui/ux',
  'creative studio',
  'software',
  'saas'
];

const DECISION_MAKER_TITLES = [
  'ceo', 'founder', 'co-founder', 'owner', 'president', 'cto', 'cmo',
  'vp', 'vice president', 'director', 'principal', 'head of', 'partner'
];

function scoreLead(lead = {}) {
  let score = 0;
  const breakdown = {};

  // 1. Domain & Email Authenticity (20 pts)
  const isCorporate = lead.isCorporateEmail !== false && lead.domain && !['gmail.com', 'yahoo.com', 'hotmail.com'].includes(lead.domain);
  if (isCorporate) {
    score += 20;
    breakdown.domainQuality = { points: 20, reason: 'Valid corporate domain' };
  } else {
    breakdown.domainQuality = { points: 0, reason: 'Freemail or missing corporate domain' };
  }

  // 2. Company Identity (20 pts)
  if (lead.company && lead.company.length >= 2) {
    score += 20;
    breakdown.companyIdentity = { points: 20, reason: `Identified company: ${lead.company}` };
  } else {
    breakdown.companyIdentity = { points: 0, reason: 'Missing company name' };
  }

  // 3. Decision Maker Authority (20 pts)
  const title = String(lead.title || '').toLowerCase();
  const isDecisionMaker = DECISION_MAKER_TITLES.some(dm => title.includes(dm));
  if (isDecisionMaker) {
    score += 20;
    breakdown.authority = { points: 20, reason: `High-value title: ${lead.title}` };
  } else if (title) {
    score += 10;
    breakdown.authority = { points: 10, reason: `General staff title: ${lead.title}` };
  } else {
    breakdown.authority = { points: 0, reason: 'Unknown decision-maker title' };
  }

  // 4. Industry Fit (20 pts) - Prioritizes High-Intent AI/Automation Categories
  const industry = String(lead.industry || lead.category || '').toLowerCase();
  const isHighIntent = HIGH_INTENT_CATEGORIES.some(cat => industry.includes(cat));
  const isTargetIndustry = TARGET_INDUSTRIES.some(ind => industry.includes(ind));

  if (isHighIntent) {
    score += 20;
    breakdown.industryFit = { points: 20, reason: `High-Intent Target Category: ${lead.industry || 'AI/Workflow Automation'}` };
  } else if (isTargetIndustry) {
    score += 15;
    breakdown.industryFit = { points: 15, reason: `Target agency vertical: ${lead.industry}` };
  } else {
    score += 5;
    breakdown.industryFit = { points: 5, reason: `Adjacent vertical: ${lead.industry || 'General'}` };
  }

  // 5. Financial Capacity / Burn Threshold (20 pts)
  const burn = lead.budgetUSD || lead.estimatedMonthlyLLMBurnUSD || 0;
  if (burn >= 3000) {
    score += 20;
    breakdown.financialCapacity = { points: 20, reason: `High LLM Burn: $${burn}/mo` };
  } else if (burn >= 1000) {
    score += 10;
    breakdown.financialCapacity = { points: 10, reason: `Moderate LLM Burn: $${burn}/mo` };
  } else {
    score += 5;
    breakdown.financialCapacity = { points: 5, reason: 'Estimated default agency tier' };
  }

  // Tier Assignment
  let tier = 'DISQUALIFIED';
  let routingRecommendation = 'Drop lead or add to blocklist';
  if (score >= 80) {
    tier = 'TIER_1_VIP';
    routingRecommendation = 'Route to High-Touch Flagship Proposal & Immediate Outbound';
  } else if (score >= 50) {
    tier = 'TIER_2_STANDARD';
    routingRecommendation = 'Route to Automated 3-Step Outbound Outreach Sequence';
  } else if (score >= 30) {
    tier = 'TIER_3_NURTURE';
    routingRecommendation = 'Route to Educational Newsletter & Retainer Nurture';
  }

  return {
    qualified: score >= 50,
    score,
    tier,
    isHighIntentBuyer: isHighIntent,
    routingRecommendation,
    breakdown,
    evaluatedAt: new Date().toISOString()
  };
}

module.exports = {
  scoreLead,
  HIGH_INTENT_CATEGORIES,
  TARGET_INDUSTRIES,
  DECISION_MAKER_TITLES
};
