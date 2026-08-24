/**
 * Master Hustle Engine - Two-Track Batch Dispatch Runner
 * Target: https://master-hustle-engine.onrender.com/webhook/lead
 */

const TARGET_URL = process.env.TARGET_URL || 'https://master-hustle-engine.onrender.com/webhook/lead';
const THROTTLE_MS = 3500; // 3.5s delay between requests to avoid rate limits

const PROSPECTS = [
  // --- TRACK 1: AGENCY WHITE-LABEL ($4,000 START / $1,500/MO) ---
  {
    first_name: "Tyler",
    last_name: "Reed",
    company_name: "Summit Digital Growth",
    contact_email: "tyler.reed@summitdigitalgrowth.com",
    website: "https://summitdigitalgrowth.com",
    industry: "digital marketing agency",
    lead_type: "Agency White-Label",
    notes: "18 SMB clients; focuses on local contractor and dental SEO.",
    track: "white-label"
  },
  {
    first_name: "Sarah",
    last_name: "Jenkins",
    company_name: "Apex Scale Marketing",
    contact_email: "sarah.j@apexscalemarketing.com",
    website: "https://apexscalemarketing.com",
    industry: "lead generation agency",
    lead_type: "Agency White-Label",
    notes: "Looking for automated call-catching and SMS lead routing for local clients.",
    track: "white-label"
  },
  {
    first_name: "David",
    last_name: "Kowalski",
    company_name: "Metro Local SEO",
    contact_email: "david@metrolocalseo.io",
    website: "https://metrolocalseo.io",
    industry: "seo agency",
    lead_type: "Agency White-Label",
    notes: "Manages 25+ GMB accounts; needs automated review replies & localized content.",
    track: "white-label"
  },
  {
    first_name: "Elena",
    last_name: "Rostova",
    company_name: "Vortex Ad Media",
    contact_email: "elena.r@vortexadmedia.com",
    website: "https://vortexadmedia.com",
    industry: "ppc agency",
    lead_type: "Agency White-Label",
    notes: "High ad spend clients asking for 24/7 AI call capture receptionist.",
    track: "white-label"
  },
  {
    first_name: "Marcus",
    last_name: "Thorne",
    company_name: "Blueprint Creative & Growth",
    contact_email: "marcus@blueprintcreativegrowth.com",
    website: "https://blueprintcreativegrowth.com",
    industry: "growth agency",
    lead_type: "Agency White-Label",
    notes: "Offers full-funnel digital delivery; wants sticky monthly software margin.",
    track: "white-label"
  },

  // --- TRACK 2: CODEBASE & IP BUYOUT ($25,000 OUTRIGHT) ---
  {
    first_name: "Alex",
    last_name: "Chen",
    company_name: "Novastack Software Labs",
    contact_email: "alex.chen@novastacklabs.io",
    website: "https://novastacklabs.io",
    industry: "digital marketing agency",
    lead_type: "Codebase Buyout",
    notes: "Boutique Node.js dev shop building bespoke AI wrappers for enterprise clients.",
    track: "codebase-buyout"
  },
  {
    first_name: "Liam",
    last_name: "O'Connor",
    company_name: "Vector Capital Micro SaaS",
    contact_email: "liam@vectorcapholdings.com",
    website: "https://vectorcapholdings.com",
    industry: "growth agency",
    lead_type: "Codebase Buyout",
    notes: "Acquires micro-SaaS and AI middleware codebases for portfolio rollout.",
    track: "codebase-buyout"
  },
  {
    first_name: "Brandon",
    last_name: "Hayes",
    company_name: "CloudForge Solutions",
    contact_email: "brandon.hayes@cloudforgesolutions.dev",
    website: "https://cloudforgesolutions.dev",
    industry: "lead generation agency",
    lead_type: "Codebase Buyout",
    notes: "Technical consultancy looking to integrate multi-model failover routers into internal products.",
    track: "codebase-buyout"
  },
  {
    first_name: "Julian",
    last_name: "Mercer",
    company_name: "Foundry Tech Ventures",
    contact_email: "julian.m@foundryventures.tech",
    website: "https://foundryventures.tech",
    industry: "advertising agency",
    lead_type: "Codebase Buyout",
    notes: "Software accelerator evaluating 9-skill automation backends for turnkey distribution.",
    track: "codebase-buyout"
  },
  {
    first_name: "Priya",
    last_name: "Patel",
    company_name: "Synthetix AI Studio",
    contact_email: "priya@synthetixaistudio.com",
    website: "https://synthetixaistudio.com",
    industry: "marketing agency",
    lead_type: "Codebase Buyout",
    notes: "Specializes in voice and workflow orchestration; looking for complete source code ownership.",
    track: "codebase-buyout"
  }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendLead(prospect, index, total) {
  const timestamp = new Date().toISOString();
  const payload = { ...prospect, timestamp };

  console.log(`\n============================================================`);
  console.log(`[${index + 1}/${total}] Dispatching: ${prospect.company_name} (${prospect.lead_type})`);
  console.log(`Target Email: ${prospect.contact_email}`);
  console.log(`============================================================`);

  const startTime = Date.now();

  try {
    const response = await fetch(TARGET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MasterEngine-BatchTwoTrack/1.0'
      },
      body: JSON.stringify(payload)
    });

    const elapsed = Date.now() - startTime;
    const data = await response.json();

    console.log(`HTTP Status: ${response.status} (${elapsed}ms)`);
    console.log(`Status:      ${data.status || (data.received ? 'RECEIVED' : 'UNKNOWN')}`);

    if (data.result) {
      console.log(`Campaign ID: ${data.result.campaign_id || 'N/A'}`);
      console.log(`Email Sent:  ${data.result.email_sent ? '✅ YES' : '❌ NO'}`);
      if (data.result.email_error) {
        console.log(`Email Error: ⚠️ ${data.result.email_error}`);
      }
      if (data.result.pitches && data.result.pitches.length > 0) {
        console.log(`Subject:     "${data.result.pitches[0].subject}"`);
      }
    } else {
      console.log(`Response:`, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error(`❌ Dispatch Failed:`, err.message);
  }
}

async function run() {
  console.log(`🚀 Starting Two-Track Batch Dispatch (${PROSPECTS.length} total leads)`);
  console.log(`Endpoint: ${TARGET_URL}`);
  console.log(`Throttle: ${THROTTLE_MS}ms\n`);

  for (let i = 0; i < PROSPECTS.length; i++) {
    await sendLead(PROSPECTS[i], i, PROSPECTS.length);
    if (i < PROSPECTS.length - 1) {
      console.log(`⏳ Waiting ${THROTTLE_MS / 1000}s before next dispatch...`);
      await sleep(THROTTLE_MS);
    }
  }

  console.log(`\n🎉 Batch Dispatch Completed.`);
}

run();
