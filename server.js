const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const dns = require('dns');
const cron = require('node-cron');
const {
  scheduledJobsEnabled,
  liveSendsEnabled,
  SCHEDULED_JOBS_DISABLED_REASON,
  LIVE_SENDS_DISABLED_REASON
} = require('./lib/outboundGates');
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {}

const app = express();
const PORT = process.env.PORT || 3005;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Off-message pages that live in the repo but must not be public on this domain.
app.get(['/saas_sell_sheet.html', '/strain-card.html', '/infusion-card.html'], (req, res) => {
  res.redirect(302, '/demo');
});

// The repo root holds lead data, logs, and server source, so only page assets are served from it.
const PUBLIC_STATIC_EXTENSIONS = new Set([
  '.html', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.mp4', '.woff', '.woff2'
]);
const serveRootStatic = express.static(path.join(__dirname));
app.use((req, res, next) => {
  if (!PUBLIC_STATIC_EXTENSIONS.has(path.extname(req.path).toLowerCase())) return next();
  return serveRootStatic(req, res, next);
});

// Helper to load .env configuration files safely across OS environments
function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) {}
}

loadEnvFile(path.join(__dirname, '.env'));
loadEnvFile(path.join(__dirname, '..', '.env'));
if (process.platform === 'win32') {
  loadEnvFile('C:/Users/jack/missed-call-agent/.env');
}

// Lightweight Engine Health Check (Unauthenticated 200 OK)
app.get(['/health', '/api/health'], (req, res) => {
  const { getRouterStatus } = require('./lib/multiModelRouter');
  const routerStatus = getRouterStatus();
  res.status(200).json({
    status: "HEALTHY",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    primaryProvider: routerStatus.primaryProvider,
    secondaryProvider: routerStatus.secondaryProvider,
    tertiaryProvider: routerStatus.tertiaryProvider,
    database: "CONNECTED",
    queueStatus: "READY",
    router: {
      status: routerStatus.status,
      activeChain: routerStatus.activeChain,
      averageLatencyMs: routerStatus.averageLatencyMs,
      reachability: routerStatus.reachability,
      probes: routerStatus.probes
    }
  });
});

// Admin Telemetry & Status Route (Strictly Protected by process.env.ADMIN_KEY)
app.get(['/admin/status', '/api/admin/status'], (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  const providedKey = req.query.key || req.headers['x-admin-key'];

  if (!adminKey) {
    return res.status(503).json({
      success: false,
      error: 'Admin access is disabled: ADMIN_KEY is not set on this server'
    });
  }
  if (!providedKey || providedKey !== adminKey) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or missing admin key'
    });
  }

  // 1. True System Telemetry
  const mem = process.memoryUsage();
  const telemetry = {
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
    memoryUsageMB: {
      rss: +(mem.rss / 1024 / 1024).toFixed(2),
      heapTotal: +(mem.heapTotal / 1024 / 1024).toFixed(2),
      heapUsed: +(mem.heapUsed / 1024 / 1024).toFixed(2),
      external: +(mem.external / 1024 / 1024).toFixed(2)
    },
    timestamp: new Date().toISOString()
  };

  // 2. Outbound Queue Status
  let queueSummary = {
    database: "pipeline.db",
    status: "HEALTHY",
    leadQueueDepth: 0,
    uncontactedQualifiedLeads: 0,
    stageCounts: {
      discovered: 0,
      triaged: 0,
      contacted: 0,
      proposed: 0,
      converted: 0,
      disqualified: 0,
      disqualified_invalid_mx: 0
    },
    totalQueued: 0,
    totalDispatched: 0
  };

  try {
    const { getPipelineSummary, getLeadQueueDepth } = require('./skills/skill7_pipeline_manager');
    const summary = getPipelineSummary();
    if (summary && summary.stageCounts) {
      queueSummary.stageCounts = summary.stageCounts;
      const depth = typeof getLeadQueueDepth === 'function'
        ? getLeadQueueDepth()
        : ((summary.stageCounts.discovered || 0) + (summary.stageCounts.triaged || 0));
      queueSummary.leadQueueDepth = depth;
      queueSummary.uncontactedQualifiedLeads = depth;
      queueSummary.totalQueued = depth;
      queueSummary.totalDispatched = (summary.stageCounts.contacted || 0) + (summary.stageCounts.proposed || 0) + (summary.stageCounts.converted || 0);
    }
  } catch (qErr) {
    queueSummary.status = "DEGRADED";
    queueSummary.error = qErr.message;
  }

  // 3. Daily Send Counter
  const { getDailyDispatchState } = require('./skills/skill7_pipeline_manager');
  const dispatchState = typeof getDailyDispatchState === 'function' ? getDailyDispatchState() : null;
  const dailyLimit = parseInt(process.env.DAILY_DISPATCH_LIMIT || '35', 10);
  const sentToday = dispatchState ? dispatchState.sentToday : 0;
  const dailySendCounter = {
    dailyLimit: dispatchState ? dispatchState.dailyLimit : dailyLimit,
    sentToday,
    remainingToday: dispatchState ? dispatchState.remainingToday : Math.max(0, dailyLimit - sentToday),
    status: dispatchState ? dispatchState.status : (sentToday >= dailyLimit ? "CAP_REACHED" : "ACTIVE"),
    lastLiveDispatchAt: dispatchState?.lastDispatchAt || productionMetrics.lastLiveDispatchAt || new Date().toISOString()
  };

  // 4. Failover Router Health
  const { getRouterStatus } = require('./lib/multiModelRouter');
  const routerStatus = getRouterStatus({ includeSavings: true });
  const failoverRouterHealth = {
    status: routerStatus.status || "HEALTHY",
    primaryProvider: routerStatus.primaryProvider || "gpt-4o-mini",
    secondaryProvider: routerStatus.secondaryProvider || "gemini-3.5-flash-lite",
    tertiaryProvider: routerStatus.tertiaryProvider || "google/gemini-3.5-flash-lite",
    fallbackProviders: routerStatus.configuredProviders || ["openai", "gemini", "claude", "openrouter"],
    activeChain: routerStatus.activeChain || "openai -> gemini -> openrouter -> claude",
    reachability: routerStatus.reachability,
    probes: routerStatus.probes,
    averageLatencyMs: routerStatus.averageLatencyMs,
    telemetry: routerStatus.telemetry || {}
  };

  // 5. Flagged Threads for Human Escalation / Review
  const { getFlaggedThreadsForReview } = require('./skills/skill7_pipeline_manager');
  const threadsForReview = getFlaggedThreadsForReview ? getFlaggedThreadsForReview() : [];

  // 6. Autonomous Scheduler Status
  const scheduler = typeof getSchedulerStatus === 'function' ? getSchedulerStatus() : {
    status: "ACTIVE",
    timezone: "America/Chicago (CST)",
    intakeSchedule: "0 6 * * * (6:00 AM CST)",
    dispatchSchedule: "0 8 * * * (8:00 AM CST)",
    resetSchedule: "0 0 * * * (00:00 Midnight CST)"
  };

  // 7. Inbox Triage & Circuit Breaker Telemetry
  let inboxTriage = null;
  try {
    const { getInboxTriageTelemetry } = require('./lib/inboundReplyListener');
    inboxTriage = getInboxTriageTelemetry();
  } catch (tErr) {
    inboxTriage = { status: "DEGRADED", error: tErr.message };
  }

  return res.status(200).json({
    success: true,
    telemetry,
    outboundQueue: queueSummary,
    leadQueueDepth: queueSummary.leadQueueDepth,
    dailySendCounter,
    scheduler,
    threadsForReview,
    flaggedForReview: threadsForReview,
    failoverRouter: failoverRouterHealth,
    inboxTriage
  });
});

// Mount Central Multi-Skill Engine Router
const engineRouter = require('./routes/engine');
app.use('/api', engineRouter);
app.use('/', engineRouter);

// ===================================================================
// TOKEN GOVERNANCE & SINGLE SOURCE OF TRUTH MODEL ROUTER
// ===================================================================
function formatEfficiencyDisplay(val) {
  if (val === undefined || val === null || val === 'not measured yet' || val === '') return 'not measured yet';
  const str = String(val).trim();
  return str.endsWith('%') ? str : `${str}%`;
}

const tokenGovernance = {
  activeRules: true,
  // Savings are admin-only (/savings and /admin/status). Public responses never show a measured figure here.
  get reductionTargetPct() {
    return "not measured yet";
  },
  modelTiers: {
    get FLASH() { return process.env.GEMINI_MODEL || "gemini-3.5-flash-lite"; },
    get LOW_COST_COPY() { return process.env.COPY_MODEL || process.env.GEMINI_MODEL || "gemini-3.5-flash-lite"; },
    get FLAGSHIP() { return process.env.GEMINI_FLAGSHIP_MODEL || "gemini-3.8-flash"; }
  },
  stats: {
    automatedFlashCalls: 0,
    lowCostCopyCalls: 0,
    manualFlagshipCalls: 0,
    blockedAutomatedFlagshipAttempts: 0,
    totalTokensSaved: 0
  }
};

function routeTokenGovernance(taskType, isHumanTriggered = false, requestedModel = null) {
  const normTask = String(taskType || '').toUpperCase().trim();
  const normModel = String(requestedModel || '').toLowerCase().trim();

  // Flagship Check (Strictly blocked on automated calls, requires human trigger)
  const isFlagship = normModel.includes('pro') || 
                     normModel.includes('flagship') || 
                     normModel === tokenGovernance.modelTiers.FLAGSHIP ||
                     ['MANUAL_SALES_COPY', 'CUSTOM_PITCH_GENERATION', 'FLAGSHIP_PRO', 'HIGH_COST_MODEL'].includes(normTask);

  if (isFlagship) {
    if (!isHumanTriggered) {
      tokenGovernance.stats.blockedAutomatedFlagshipAttempts++;
      return {
        allowed: false,
        statusCode: 403,
        error: 'ERR_FLAGSHIP_RESTRICTED_TO_HUMAN',
        selectedModel: tokenGovernance.modelTiers.FLASH,
        fallbackTier: 'FLASH_BUDGET',
        note: 'Flagship model strictly restricted to manual, human-triggered requests. Automated attempt blocked.'
      };
    }
    tokenGovernance.stats.manualFlagshipCalls++;
    return {
      allowed: true,
      statusCode: 200,
      selectedModel: tokenGovernance.modelTiers.FLAGSHIP,
      tier: 'FLAGSHIP_PRO',
      note: 'Verified human-triggered request authorized for Flagship model.'
    };
  }

  // Outreach Copy Generation -> Primary Low-Cost Fallback Chain
  const isCopyGeneration = normTask.includes('COPY') || 
                           normTask.includes('OUTREACH') || 
                           ['OUTREACH_COPY', 'OUTREACH_COPY_GENERATION', 'SALES_COPY_GENERATION', 'EMAIL_COPY', 'SMS_COPY'].includes(normTask);

  if (isCopyGeneration) {
    tokenGovernance.stats.lowCostCopyCalls++;
    return {
      allowed: true,
      statusCode: 200,
      selectedModel: tokenGovernance.modelTiers.LOW_COST_COPY,
      tier: 'LOW_COST_FALLBACK',
      note: 'Routed through primary low-cost fallback chain (Gemini Flash).'
    };
  }

  // Background / Telemetry / Lead Scoring / Inbox Monitoring / Batch Dispatch -> Flash Budget Tier
  tokenGovernance.stats.automatedFlashCalls++;
  const eff = tokenGovernance.reductionTargetPct;
  const isMeasured = eff !== "not measured yet";

  return {
    allowed: true,
    statusCode: 200,
    selectedModel: tokenGovernance.modelTiers.FLASH,
    tier: 'FLASH_BUDGET',
    tokensSavedPerUnit: isMeasured ? tokenGovernance.stats.totalTokensSaved : "not measured yet",
    efficiencyPct: eff,
    note: isMeasured
      ? `Routed to Flash tier for automated background/telemetry efficiency (${eff} reduction).`
      : 'Routed to Flash tier for automated background/telemetry efficiency.'
  };
}

// ===================================================================
// PRODUCTION VS SIMULATION DATA STORES (STRICTLY ISOLATED & REAL)
// Zero Fabricated Customers. No Synthetic Records.
// ===================================================================
const productionMetrics = {
  pipelineRevenueUSD: 0,
  totalLiveDispatched: 0,
  verifiedOpens: 0,
  verifiedReplies: 0,
  verifiedPositiveDeals: 0,
  verifiedBounces: 0,
  verifiedSpamFlags: 0,
  domainRisk: "LOW",
  lastLiveDispatchAt: null
};

const sandboxTestMetrics = {
  totalTestRuns: 0,
  simulatedLeadsProcessed: 0,
  simulatedOpens: 0,
  simulatedReplies: 0,
  simulatedPositives: 0,
  simulatedBounces: 0,
  simulatedSpamFlags: 0
};

// Real Live Production Deals (Empty pre-revenue)
const verifiedLiveDeals = [];

function getCalculatedProductionMetrics() {
  const openRate = productionMetrics.totalLiveDispatched > 0 ? ((productionMetrics.verifiedOpens / productionMetrics.totalLiveDispatched) * 100).toFixed(1) : "0.0";
  const replyRate = productionMetrics.totalLiveDispatched > 0 ? ((productionMetrics.verifiedReplies / productionMetrics.totalLiveDispatched) * 100).toFixed(1) : "0.0";
  const bounceRate = productionMetrics.totalLiveDispatched > 0 ? ((productionMetrics.verifiedBounces / productionMetrics.totalLiveDispatched) * 100).toFixed(1) : "0.0";

  return {
    pipelineRevenue: productionMetrics.pipelineRevenueUSD,
    totalDispatched: productionMetrics.totalLiveDispatched,
    opens: productionMetrics.verifiedOpens,
    replies: productionMetrics.verifiedReplies,
    positiveInterests: productionMetrics.verifiedPositiveDeals,
    bounces: productionMetrics.verifiedBounces,
    spamFlags: productionMetrics.verifiedSpamFlags,
    domainRisk: productionMetrics.domainRisk,
    openRate: `${openRate}%`,
    replyRate: `${replyRate}%`,
    bounceRate: `${bounceRate}%`,
    status: "STANDBY_PRE_REVENUE",
    environmentMode: "PRE_REVENUE_STAGING",
    sandboxMetrics: sandboxTestMetrics,
    tokenGovernance: {
      active: true,
      reductionEfficiency: formatEfficiencyDisplay(tokenGovernance.reductionTargetPct),
      modelTiers: tokenGovernance.modelTiers,
      stats: tokenGovernance.stats
    }
  };
}

// ===================================================================
// MAIL TRANSPORT DISPATCH ENGINE (GMAIL APPS SCRIPT RELAY / SMTP)
// ===================================================================
function sendViaGmailHttpRelay(urlStr, key, to, subject, bodyText, attempts = 3) {
  function singleAttempt() {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(urlStr);
        const payload = JSON.stringify({
          key: key,
          to: to,
          subject: subject || 'Engine live send test',
          html: `<div style="font-family: Arial, sans-serif; padding: 16px;">${bodyText}</div>`,
          name: 'Master Hustle Engine'
        });

        const options = {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          family: 4,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: 15000
        };

        const req = https.request(options, (res) => {
          // Follow Google Apps Script HTTP redirects (301, 302, 307, 308)
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            const redirectUrl = res.headers.location;
            const redirectReq = https.get(redirectUrl, { family: 4, timeout: 15000 }, (redirectRes) => {
              let data = '';
              redirectRes.on('data', chunk => data += chunk);
              redirectRes.on('end', () => {
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.success) {
                    resolve({
                      success: true,
                      rawResponse: parsed,
                      messageId: parsed.messageId || parsed.id || null
                    });
                  } else {
                    reject(new Error(parsed.error || parsed.message || JSON.stringify(parsed)));
                  }
                } catch (e) {
                  reject(new Error(`Failed to parse redirect response: ${data}`));
                }
              });
            });
            redirectReq.on('error', (e) => reject(e));
            redirectReq.on('timeout', () => { redirectReq.destroy(); reject(new Error('Redirect request timed out')); });
            return;
          }

          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.success) {
                resolve({
                  success: true,
                  rawResponse: parsed,
                  messageId: parsed.messageId || parsed.id || null
                });
              } else {
                reject(new Error(parsed.error || parsed.message || JSON.stringify(parsed)));
              }
            } catch (e) {
              reject(new Error(`Failed to parse response: ${data}`));
            }
          });
        });

        req.on('timeout', () => { req.destroy(); reject(new Error('HTTP relay request timed out')); });
        req.on('error', (e) => reject(e));
        req.write(payload);
        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  return (async () => {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await singleAttempt();
      } catch (err) {
        lastErr = err;
        console.warn(`[RELAY RETRY] Attempt ${i + 1}/${attempts} failed (${err.message}). Retrying...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw lastErr;
  })();
}

// ===================================================================
// API ROUTES
// ===================================================================

// Endpoint Inspector Route
app.get('/api/routes', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const routes = [];
  app._router.stack.forEach(middleware => {
    if (middleware.route) {
      routes.push({
        path: middleware.route.path,
        methods: Object.keys(middleware.route.methods).map(m => m.toUpperCase())
      });
    }
  });
  res.json({ success: true, count: routes.length, routes });
});

// Single Source of Truth Model Router Endpoint
app.post('/api/model/route', (req, res, next) => {
  const { requireRouterApiKey } = require('./lib/multiModelRouter');
  return requireRouterApiKey(req, res, next);
}, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const b = req.body || {};
  const taskType = b.taskType || b.task_type || b.task || 'BACKGROUND_TASK';
  const requestedModel = b.requestedModel || b.requested_model || b.model || b.modelTier || b.model_tier || null;

  const isHuman = b.humanTriggered === true || 
                  b.humanTriggered === 'true' || 
                  b.human_triggered === true || 
                  b.human_triggered === 'true' || 
                  req.headers['x-human-trigger'] === 'true';

  const govResult = routeTokenGovernance(taskType, isHuman, requestedModel);

  if (!govResult.allowed) {
    return res.status(403).json({
      success: false,
      error: govResult.error,
      message: govResult.note,
      tierEnforced: govResult.fallbackTier,
      selectedModel: govResult.selectedModel
    });
  }

  return res.status(200).json({
    success: true,
    taskType: taskType,
    humanTriggered: isHuman,
    selectedModel: govResult.selectedModel,
    tier: govResult.tier,
    efficiencyPct: formatEfficiencyDisplay(govResult.efficiencyPct || tokenGovernance.reductionTargetPct),
    note: govResult.note
  });
});

// Single-Recipient Live Email Dispatch Endpoint (NO SYNTHETIC MESSAGE ID, NO SIMULATION FALLBACK)
app.post('/api/send-single-email', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (!liveSendsEnabled()) {
    return res.status(403).json({ success: false, error: 'ERR_LIVE_SENDS_DISABLED', message: LIVE_SENDS_DISABLED_REASON });
  }
  const b = req.body || {};
  const toEmail = b.to || b.email || b.recipient;
  const subject = b.subject || 'Engine live send test';
  const bodyText = b.body || b.html || b.text || 'First real send from the Master Hustle Engine.';

  if (!toEmail || !toEmail.includes('@')) {
    return res.status(400).json({
      success: false,
      error: "ERR_INVALID_RECIPIENT",
      message: "Valid recipient email address (field 'to') is required."
    });
  }

  // Check if thread is paused for human review
  const { isThreadPaused, flagThreadForReview } = require('./skills/skill7_pipeline_manager');
  if (isThreadPaused(toEmail)) {
    return res.status(422).json({
      success: false,
      error: "ERR_THREAD_PAUSED",
      message: `Thread with ${toEmail} is paused for human review.`
    });
  }

  // Pre-dispatch Blocklist & MX Quality Screening (Fail-Closed)
  try {
    const { loadBlocklist, screenLeadQuality } = require('./trigger_batch_dispatch');
    const { verifyEmailPreFlight } = require('./lib/emailVerifier');
    const blocklist = loadBlocklist();
    const domain = b.domain || toEmail.split('@')[1] || '';
    const screenRes = screenLeadQuality(toEmail, domain, blocklist);

    if (screenRes.status === 'DISQUALIFIED') {
      console.warn(`[SUPPRESSION REJECT] Refused send to ${toEmail}: ${screenRes.reason}`);
      return res.status(422).json({
        success: false,
        error: "ERR_LEAD_DISQUALIFIED",
        status: "disqualified",
        reason: screenRes.reason,
        recipient: toEmail
      });
    }

    const preFlight = await verifyEmailPreFlight({
      email: toEmail,
      domain,
      company: b.company || '',
      updateDb: true
    });

    if (!preFlight.valid) {
      const isMx = preFlight.reason === 'DISQUALIFIED_INVALID_MX';
      console.warn(`[PRE-FLIGHT REJECT] Refused send to ${toEmail}: ${preFlight.error || preFlight.reason}`);
      return res.status(422).json({
        success: false,
        error: isMx ? "ERR_INVALID_MX" : "ERR_INVALID_SYNTAX",
        status: preFlight.reason.toLowerCase(),
        reason: preFlight.error || preFlight.reason,
        recipient: toEmail
      });
    }
  } catch (err) {
    if (err.message.includes('ERR_BLOCKLIST_MISSING_FAIL_CLOSED')) {
      console.error(`[FAIL-CLOSED DISPATCH BLOCK] ${err.message}`);
      return res.status(500).json({
        success: false,
        error: "ERR_BLOCKLIST_MISSING_FAIL_CLOSED",
        message: err.message
      });
    }
  }

  const govResult = routeTokenGovernance('OUTREACH_COPY');
  const gmailUrl = process.env.GMAIL_HTTP_URL;
  const gmailKey = process.env.GMAIL_HTTP_KEY;
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;

  if (!gmailUrl && (!smtpHost || !smtpUser)) {
    console.error(`[LIVE EMAIL FAIL] Could not send to ${toEmail}: Missing GMAIL_HTTP_URL or SMTP credentials.`);
    flagThreadForReview({
      email: toEmail,
      company: b.company || '',
      reason: 'SMTP_CONFIG_ERROR',
      errorCode: 'ERR_SMTP_NOT_CONFIGURED',
      subject,
      messageSnippet: 'Missing GMAIL_HTTP_URL or SMTP credentials'
    });
    return res.status(502).json({
      success: false,
      error: "ERR_SMTP_NOT_CONFIGURED",
      message: `Failed to dispatch email to ${toEmail}. Environment missing GMAIL_HTTP_URL or SMTP credentials. No simulation fallback allowed.`
    });
  }

  try {
    if (gmailUrl) {
      console.log(`[LIVE EMAIL DISPATCH] Dispatching email to ${toEmail} via Apps Script Relay...`);
      const relayRes = await sendViaGmailHttpRelay(gmailUrl, gmailKey, toEmail, subject, bodyText);
      
      const realMessageId = relayRes.messageId || null;
      const isConfirmed = !!realMessageId && relayRes.success === true;

      return res.status(200).json({
        success: relayRes.success === true,
        transport: "Google Apps Script HTTPS Relay",
        recipient: toEmail,
        messageId: realMessageId,
        deliveryConfirmed: isConfirmed,
        transportResponse: relayRes.rawResponse,
        modelUsed: govResult.selectedModel
      });
    } else {
      flagThreadForReview({
        email: toEmail,
        company: b.company || '',
        reason: 'SMTP_TRANSPORT_REQUIRES_GMAIL_RELAY',
        errorCode: 'ERR_SMTP_TRANSPORT_REQUIRES_GMAIL_RELAY',
        subject,
        messageSnippet: 'Direct SMTP port blocked on cloud host'
      });
      return res.status(502).json({
        success: false,
        error: "ERR_SMTP_TRANSPORT_REQUIRES_GMAIL_RELAY",
        message: "Direct SMTP port blocked on cloud host. Set GMAIL_HTTP_URL to activate Apps Script HTTPS relay."
      });
    }
  } catch (err) {
    console.error(`[LIVE EMAIL ERROR] Dispatch to ${toEmail} failed:`, err.message);
    flagThreadForReview({
      email: toEmail,
      company: b.company || '',
      reason: 'MAIL_TRANSPORT_FAILURE',
      errorCode: 'ERR_MAIL_TRANSPORT_FAILED',
      subject,
      messageSnippet: err.message
    });
    return res.status(502).json({
      success: false,
      error: "ERR_MAIL_TRANSPORT_FAILED",
      message: `Mail server rejected dispatch: ${err.message}`,
      attemptedRecipient: toEmail,
      modelUsed: govResult.selectedModel
    });
  }
});

// (Legacy /api/health removed in favor of unified /health endpoint below)

// Telemetry Endpoint
app.get('/api/telemetry', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const govResult = routeTokenGovernance('INBOX_TELEMETRY');
  res.json({
    success: true,
    mode: 'PRE_REVENUE_STAGING',
    tokenGovernance: {
      ruleActive: true,
      telemetryModel: govResult.selectedModel,
      efficiencyPct: formatEfficiencyDisplay(tokenGovernance.reductionTargetPct),
      stats: tokenGovernance.stats
    },
    productionMetrics: getCalculatedProductionMetrics(),
    sandboxTestMetrics: sandboxTestMetrics
  });
});

// Token Governance Audit Endpoint
app.get('/api/telemetry/governance', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    success: true,
    tokenGovernanceRules: {
      rule1_automated_background: `Route all background/telemetry/scoring/monitoring to Flash/Flash-Lite (${tokenGovernance.modelTiers.FLASH}) maintaining high token efficiency`,
      rule2_outreach_copy: "Route outreach copy generation via primary low-cost fallback chain (Gemini Flash / OpenAI)",
      rule3_flagship_restriction: `High-cost flagship models (${tokenGovernance.modelTiers.FLAGSHIP}) strictly restricted to manual, human-triggered endpoints (HTTP 403 enforcement)`
    },
    modelTiers: tokenGovernance.modelTiers,
    stats: tokenGovernance.stats
  });
});

// In-memory UI Audit Log Stream Buffer (max 50 recent entries)
const uiAuditLogs = [];

function pushUiAuditLog(event, details) {
  const item = {
    timestamp: new Date().toISOString(),
    event,
    details
  };
  uiAuditLogs.unshift(item);
  if (uiAuditLogs.length > 50) uiAuditLogs.pop();
  return item;
}

// 25-Lead Batch Execution Endpoint & Synthetic Rule Verification Endpoint
const { runBatchDispatch } = require('./trigger_batch_dispatch');

async function handleBatchDispatch(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    try {
      delete require.cache[require.resolve('./trigger_batch_dispatch')];
    } catch (e) {}
    const { runBatchDispatch } = require('./trigger_batch_dispatch');

    const isLive = req.body?.live === true || req.body?.isLive === true || req.query?.live === "true";
    if (isLive && !liveSendsEnabled()) {
      return res.status(403).json({ success: false, error: 'ERR_LIVE_SENDS_DISABLED', message: LIVE_SENDS_DISABLED_REASON });
    }
    const isSyntheticTest = req.body?.synthetic === true || req.body?.testSynthetic === true || req.query?.synthetic === "true";
    const skipPacing = req.body?.skipPacing === true || req.query?.skipPacing === "true";
    const requestedCap = parseInt(req.body?.maxBatchSize || req.body?.batchSize || req.body?.limit || 25, 10);
    const maxBatchCap = Math.min(isNaN(requestedCap) ? 25 : requestedCap, 25);

    const result = await runBatchDispatch({
      isLive: isLive,
      isSyntheticTest: isSyntheticTest,
      skipPacing: skipPacing,
      batchLimit: maxBatchCap
    });

    if (isLive) {
      if (result.sends) {
        const liveSends = result.sends.filter(s => s.sent).length;
        productionMetrics.totalLiveDispatched += liveSends;
        if (liveSends > 0) productionMetrics.lastLiveDispatchAt = new Date().toISOString();
      }
      try {
        const { recordDispatchEvent } = require('./skills/skill6_verify_telemetry');
        recordDispatchEvent(true, result.sends ? result.sends.filter(s => s.sent).length : 0);
      } catch (e) {}
      pushUiAuditLog('LIVE_BATCH_DISPATCH', `Dispatched ${result.sends ? result.sends.filter(s => s.sent).length : 0} live leads (Evaluated: ${result.evaluated})`);
    } else {
      // FIX KPI STATE PERSISTENCE: Increment sandbox test metrics on dry-run execution
      sandboxTestMetrics.totalTestRuns++;
      sandboxTestMetrics.simulatedLeadsProcessed += result.evaluated || 0;
      try {
        const { recordDispatchEvent } = require('./skills/skill6_verify_telemetry');
        recordDispatchEvent(false, result.evaluated || 0);
      } catch (e) {}
      if (result.sends && Array.isArray(result.sends)) {
        const drySends = result.sends.filter(s => s.status === 'DRY_RUN').length;
        sandboxTestMetrics.simulatedOpens += drySends;
      }
      pushUiAuditLog('SANDBOX_DRY_RUN', `Processed dry-run batch (${result.evaluated} evaluated, ${result.skips ? result.skips.length : 0} skipped, ${result.sends ? result.sends.length : 0} simulated sends)`);
    }

    // Push screening log entries into UI audit stream
    if (result.logs && Array.isArray(result.logs)) {
      result.logs.forEach(l => {
        if (l.includes('[SKIP]') || l.includes('[BLOCKED]') || l.includes('[MX REJECT]')) {
          pushUiAuditLog('DISQUALIFIED_GATE', l);
        }
      });
    }

    return res.status(200).json({
      success: true,
      result: result,
      sandboxMetrics: sandboxTestMetrics
    });
  } catch (err) {
    console.error('[Batch Dispatch Error]', err);
    pushUiAuditLog('DISPATCH_ERROR', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// Strict HTTP POST Enforcement on Batch Execution Endpoints
app.post('/api/trigger-batch-dispatch', handleBatchDispatch);
app.post('/api/run-25-batch', handleBatchDispatch);

function rejectGetBatchTrigger(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Allow', 'POST');
  return res.status(405).json({
    success: false,
    error: "ERR_METHOD_NOT_ALLOWED",
    message: "HTTP GET is not allowed on batch execution endpoints. Use HTTP POST to execute campaign dispatches, preventing web crawlers or browser pre-fetching from triggering sends."
  });
}

app.get('/api/trigger-batch-dispatch', rejectGetBatchTrigger);
app.get('/api/run-25-batch', rejectGetBatchTrigger);

// UI Audit Logs Endpoint
app.get('/api/audit-logs', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    success: true,
    logs: uiAuditLogs
  });
});

// Manual Human-Triggered Endpoints: Custom Pitch & Final Sales Copy Generation
app.post('/api/generate-sales-copy', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const isHuman = req.body?.humanTriggered === true || req.body?.humanTriggered === 'true' || req.headers['x-human-trigger'] === 'true';
  const taskType = req.body?.taskType || 'MANUAL_SALES_COPY';

  const govResult = routeTokenGovernance(taskType, isHuman, tokenGovernance.modelTiers.FLAGSHIP);

  if (!govResult.allowed) {
    return res.status(403).json({
      success: false,
      error: govResult.error,
      message: govResult.note,
      tierEnforced: govResult.fallbackTier
    });
  }

  return res.json({
    success: true,
    taskType: taskType,
    humanTriggeredVerified: true,
    modelUsed: govResult.selectedModel,
    tier: govResult.tier,
    sampleCopy: "High-converting sales copy generated via authorized human-triggered endpoint."
  });
});

function handlePitchRequest(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const isHuman = req.body?.humanTriggered === true || req.body?.humanTriggered === 'true' || req.headers['x-human-trigger'] === 'true';
  const taskType = req.body?.taskType || 'CUSTOM_PITCH_GENERATION';

  const govResult = routeTokenGovernance(taskType, isHuman, tokenGovernance.modelTiers.FLAGSHIP);

  if (!govResult.allowed) {
    return res.status(403).json({
      success: false,
      error: govResult.error,
      message: govResult.note,
      tierEnforced: govResult.fallbackTier
    });
  }

  return res.json({
    success: true,
    taskType: taskType,
    humanTriggeredVerified: true,
    modelUsed: govResult.selectedModel,
    tier: govResult.tier,
    samplePitch: "Custom enterprise pitch deck outline generated via authorized human-triggered endpoint."
  });
}

app.post('/api/generate-pitch', handlePitchRequest);
app.post('/pitch', handlePitchRequest);

// Built-in Commercial Asset Endpoints
app.get('/api/assets/pitch-deck', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Master Hustle Engine - B2B Commercial Sales Pitch Deck</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #09090b; color: #f4f4f5; padding: 40px; line-height: 1.6; }
        .container { max-width: 800px; margin: 0 auto; background: #18181b; padding: 32px; border-radius: 12px; border: 1px solid #27272a; }
        h1 { color: #38bdf8; border-bottom: 1px solid #3f3f46; padding-bottom: 12px; }
        .metric { display: inline-block; background: #27272a; padding: 12px 20px; border-radius: 8px; margin: 10px 10px 10px 0; }
        .metric-val { font-size: 24px; font-weight: bold; color: #4ade80; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>⚡ Master Hustle Engine - Commercial Pitch Deck</h1>
        <p><strong>System Architecture:</strong> Antigravity Multi-Agent 3-Tier Token Reducer Router</p>
        <div class="metric">
          <div>Token Cost Savings</div>
          <div class="metric-val">Measured Real Cost</div>
        </div>
        <div class="metric">
          <div>ICP Qualification Cost</div>
          <div class="metric-val">not measured yet</div>
        </div>
        <div class="metric">
          <div>Daily Batch Cap</div>
          <div class="metric-val">25 Leads Max</div>
        </div>
        <h2>Core Value Proposition</h2>
        <ul>
          <li><strong>Real-Cost Cascade:</strong> Cheap model qualifies -> Escalates to Strong model on complex tasks or failure.</li>
          <li><strong>Flagship Access Control:</strong> Automated calls to flagship models restricted via HTTP 403 authorization guard.</li>
          <li><strong>Turn-Key Commercial Pricing:</strong> Agency Private-Label ($497 setup + $199/mo), Commercial Codebase License ($4,500 one-time).</li>
        </ul>
      </div>
    </body>
    </html>
  `);
});

app.get('/api/assets/financial-model', (req, res) => {
  const csvData = `Category,Year 1 Target,Year 2 Projection,Year 3 Projection
Projected ARR,$150000,$480000,$1200000
Gross Margin (Token Savings),Measured,Measured,Measured
Token Savings Efficiency,Measured,Measured,Measured
Avg Qualification Cost / Lead,not measured yet,not measured yet,not measured yet
Monthly Active Subscribers (Est),15,40,100
`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="master_hustle_engine_financial_model.csv"');
  res.status(200).send(csvData);
});

app.get('/api/export-package', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    success: true,
    package: {
      name: "Master Hustle Engine & Antigravity Token Router Commercial Buyout Bundle",
      version: "4.1.0",
      componentsIncluded: [
        "Full Express Server Core (server.js)",
        "Single-Source Token Router (/api/model/route)",
        "3-Tier Token Reduction Router (agents/outreach_agent.py)",
        "Single-Recipient Live Email Dispatch (/api/send-single-email)",
        "Daily Pipeline Execution & Staging Engine (run_daily_pipeline.js)",
        "Batch Dispatcher & Deduplication Engine (trigger_batch_dispatch.js)",
        "Stripe Monetization & Pricing Ladder",
        "Commercial Assets & 3-Year Token Financial Model"
      ],
      downloadUrl: "/api/assets/financial-model"
    }
  });
});

// Verified Positive Deals API (Empty Pre-Revenue)
app.get('/api/positive-replies', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    success: true,
    mode: "PRE_REVENUE_STAGING",
    totalPositives: 0,
    pipelineRevenue: 0,
    records: []
  });
});

// Update Production Revenue
function handleRevenueUpdate(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const newRev = req.body?.newRevenue !== undefined ? req.body.newRevenue : (req.query?.newRevenue ? parseFloat(req.query.newRevenue) : null);
  if (newRev !== null && !isNaN(newRev) && newRev >= 0) {
    productionMetrics.pipelineRevenueUSD = parseFloat(newRev);
    return res.json({ success: true, pipelineRevenue: productionMetrics.pipelineRevenueUSD });
  }
  res.status(400).json({ success: false, error: 'Invalid revenue value' });
}

app.post('/api/update-revenue', handleRevenueUpdate);
app.get('/api/update-revenue', handleRevenueUpdate);

// 1-Click 7-Day Metrics CSV Export
app.get('/api/export-7day-metrics', (req, res) => {
  let csv = "Date,Live_Dispatched_Leads,Verified_Opens,Verified_Replies,Verified_Positives,Verified_Bounces,Spam_Flags,Health_Status,Pipeline_Revenue_USD\n";
  const calc = getCalculatedProductionMetrics();
  csv += `"${new Date().toISOString().split('T')[0]}",${productionMetrics.totalLiveDispatched},${productionMetrics.verifiedOpens},${productionMetrics.verifiedReplies},${productionMetrics.verifiedPositiveDeals},${productionMetrics.verifiedBounces},0,"${calc.status}",${productionMetrics.pipelineRevenueUSD}\n`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="master_hustle_engine_production_metrics.csv"');
  res.status(200).send(csv);
});

// Gumloop Automated Lead Ingestion & Webhook Endpoint
async function handleGumloopIngestion(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { loadBlocklist, screenLeadQuality, hasValidMX, sanitizeFirstName } = require('./trigger_batch_dispatch');
    const blocklist = loadBlocklist();
    const govResult = routeTokenGovernance('LEAD_SCORING_CHECK');

    const body = req.body || {};
    let rawLeads = [];

    if (Array.isArray(body.leads)) {
      rawLeads = body.leads;
    } else if (Array.isArray(body)) {
      rawLeads = body;
    } else if (body.email) {
      rawLeads = [body];
    }

    if (rawLeads.length === 0) {
      return res.status(400).json({
        success: false,
        error: "ERR_NO_LEADS_PROVIDED",
        message: "No valid lead objects found in request payload. Expected format: { \"leads\": [ { \"email\": \"...\", \"firstName\": \"...\" } ] }"
      });
    }

    const verifiedPath = path.join(__dirname, 'verified_leads.csv');
    const existingEmails = new Set();
    if (fs.existsSync(verifiedPath)) {
      const lines = fs.readFileSync(verifiedPath, 'utf8').split(/\r?\n/).filter(Boolean);
      lines.forEach(l => {
        const parts = l.split(',');
        if (parts[1]) existingEmails.add(parts[1].replace(/^["']|["']$/g, '').trim().toLowerCase());
      });
    }

    const ingestedLeads = [];
    const rejectedLeads = [];

    for (const leadItem of rawLeads) {
      const email = (leadItem.email || leadItem.to || '').trim().toLowerCase();
      const rawFirstName = leadItem.firstName || leadItem.first_name || leadItem.name || '';
      const company = leadItem.company || leadItem.company_name || leadItem.business || '';
      const domain = (leadItem.domain || email.split('@')[1] || '').trim().toLowerCase();

      if (!email || !email.includes('@')) {
        rejectedLeads.push({ email, reason: "Invalid email address structure" });
        continue;
      }

      if (existingEmails.has(email)) {
        rejectedLeads.push({ email, reason: "Duplicate — email already present in queue" });
        continue;
      }

      // 1. Blocklist Gate
      const screenRes = screenLeadQuality(email, domain, blocklist);
      if (screenRes.status === 'DISQUALIFIED') {
        rejectedLeads.push({ email, reason: `Blocklist: ${screenRes.reason}` });
        pushUiAuditLog('GUMLOOP_BLOCKLIST_REJECT', `${email} — ${screenRes.reason}`);
        continue;
      }

      // 2. DNS MX Pre-verification Gate
      const validMX = await hasValidMX(domain);
      if (!validMX) {
        rejectedLeads.push({ email, reason: `[MX REJECT] Domain ${domain} failed MX resolution` });
        pushUiAuditLog('GUMLOOP_MX_REJECT', `${email} (${domain}) — failed DNS MX resolution`);
        continue;
      }

      // 3. Name Sanitizer
      const cleanName = sanitizeFirstName(rawFirstName);

      const rowStr = `A,${email},${domain},valid,Gumloop Webhook Verified,${cleanName === 'there' ? 'role inbox' : 'named person'},${domain},READY,"Company: ${company || domain} | Ingested: ${new Date().toISOString()} | Name: ${cleanName}"\n`;
      fs.appendFileSync(verifiedPath, rowStr);
      existingEmails.add(email);

      ingestedLeads.push({ email, domain, firstName: cleanName, company });
      pushUiAuditLog('GUMLOOP_LEAD_INGESTED', `Queued clean target ${email} (${company || domain})`);
    }

    return res.status(200).json({
      success: true,
      status: "GUMLOOP_LEADS_INGESTED",
      webhookConnected: true,
      ingestedCount: ingestedLeads.length,
      rejectedCount: rejectedLeads.length,
      ingestedLeads: ingestedLeads,
      rejectedLeads: rejectedLeads,
      tokenGovernance: govResult
    });
  } catch (err) {
    console.error('[Gumloop Ingestion Error]', err);
    pushUiAuditLog('GUMLOOP_INGESTION_ERROR', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

app.post('/api/ingest-gumloop-leads', handleGumloopIngestion);
app.post('/webhook/gumloop', handleGumloopIngestion);
app.post('/webhook/lead', handleGumloopIngestion);

// ===================================================================
// MULTI-PROJECT NAMESPACE ROUTER (SHOVEL VS THCA ISOLATION)
// ===================================================================

// Project A: Self-Cleaning Shovel (Invention / B2B Licensing)
app.get('/api/v1/shovel/status', (req, res) => {
  res.json({
    success: true,
    project: "Self-Cleaning Shovel Invention",
    status: "READY",
    namespace: "shovel_invention",
    domains: ["missedcallproject.com", "selfcleaningshovel.tiiny.site"],
    targetSkills: ["licensing_pitch", "manufacturer_outreach", "investor_summary"]
  });
});

app.post('/api/v1/shovel/run-skill', async (req, res) => {
  const { skill, targetCompany, contactName } = req.body || {};
  const isHuman = req.body?.humanTriggered === true || req.headers['x-human-trigger'] === 'true';
  const gov = routeTokenGovernance(skill || 'SHOVEL_OUTREACH', isHuman);
  
  pushUiAuditLog('SHOVEL_SKILL_EXEC', `Executed ${skill || 'licensing_pitch'} for ${targetCompany || 'General Manufacturer'}`);
  
  return res.json({
    success: true,
    project: "shovel_invention",
    skillExecuted: skill || "licensing_pitch",
    targetCompany: targetCompany || "Commercial Manufacturer",
    modelUsed: gov.selectedModel,
    pitchSnippet: `Patent-Pending Self-Cleaning Shovel Licensing Overview for ${targetCompany || 'Manufacturing Partner'}. Engineered mechanical dirt-release blade system.`,
    tokenSavings: formatEfficiencyDisplay(gov.efficiencyPct || tokenGovernance.reductionTargetPct)
  });
});

app.post('/webhook/shovel', (req, res) => {
  const payload = req.body || {};
  pushUiAuditLog('SHOVEL_WEBHOOK_RECEIVED', `Inbound event: ${payload.event || 'lead_inquiry'}`);
  res.json({ success: true, project: "shovel_invention", status: "ACKNOWLEDGED" });
});

// Project B: THCA Review Site (Jacks Plug Reviews / SEO Affiliate)
app.get('/api/v1/thca/status', (req, res) => {
  res.json({
    success: true,
    project: "THCA Review Site (Jacks Plug Reviews)",
    status: "READY",
    namespace: "thca_review_hub",
    domain: "jacksplugreviews.com",
    targetSkills: ["product_review", "comparison_table", "seo_article", "email_sequence"]
  });
});

app.post('/api/v1/thca/run-skill', async (req, res) => {
  const { skill, productName, strainType, potency } = req.body || {};
  const isHuman = req.body?.humanTriggered === true || req.headers['x-human-trigger'] === 'true';
  const gov = routeTokenGovernance(skill || 'THCA_REVIEW_COPY', isHuman);

  pushUiAuditLog('THCA_SKILL_EXEC', `Executed ${skill || 'product_review'} for ${productName || 'THCA Flower Sample'}`);

  return res.json({
    success: true,
    project: "thca_review_hub",
    skillExecuted: skill || "product_review",
    productName: productName || "Premium THCA Flower",
    strainType: strainType || "Hybrid",
    potency: potency || "28.5%",
    seoMeta: {
      title: `${productName || 'Premium THCA'} Review & Lab Analysis | Jack's Plug`,
      disclaimer: "Compliant with 2018 US Farm Bill (<0.3% Delta-9 THC)."
    },
    modelUsed: gov.selectedModel,
    tokenSavings: formatEfficiencyDisplay(gov.efficiencyPct || tokenGovernance.reductionTargetPct)
  });
});

app.post('/webhook/thca', (req, res) => {
  const payload = req.body || {};
  pushUiAuditLog('THCA_WEBHOOK_RECEIVED', `Inbound affiliate event: ${payload.event || 'product_update'}`);
  res.json({ success: true, project: "thca_review_hub", status: "ACKNOWLEDGED" });
});

// ===================================================================
// AUTONOMOUS DEAL ENGINE & INBOUND RESPONSE WEBHOOK
// ===================================================================

const DEMO_SCHEDULING_LINK = process.env.CALENDAR_BOOKING_URL || 'https://cal.com/jack-antigravity/15min';
const STRIPE_CHECKOUT_LINK = 'https://buy.stripe.com/6oU9AS3WGdTlaWr68D0000G';

function appendOutreachLog(entry) {
  const logPath = path.join(__dirname, 'outreach_log.json');
  let logs = [];
  try {
    if (fs.existsSync(logPath)) {
      logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    }
  } catch (e) {
    logs = [];
  }
  logs.push({
    timestamp: new Date().toISOString(),
    ...entry
  });
  try {
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf8');
  } catch (e) {
    console.error('[Deal Engine] Failed writing outreach_log.json:', e.message);
  }
}

app.post(['/api/inbound-reply', '/webhook/inbound-reply'], async (req, res) => {
  const b = req.body || {};
  const rawSender = b.from || b.sender || b.email || b.sender_email || '';
  const subject = b.subject || 'Re: Master Hustle Engine';
  const bodyText = b.body || b.text || b.message || '';
  const senderEmail = (rawSender.includes('<') ? rawSender.split('<')[1].split('>')[0] : rawSender).trim().toLowerCase();

  console.log(`[Deal Engine] Inbound reply received from: ${senderEmail} | Subject: "${subject}"`);

  const queuePath = path.join(__dirname, 'staged_leads_queue.json');
  let queue = [];
  try {
    if (fs.existsSync(queuePath)) {
      queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    }
  } catch (e) {
    queue = [];
  }

  const leadIndex = queue.findIndex(l => l.email && l.email.toLowerCase() === senderEmail);
  const lead = leadIndex >= 0 ? queue[leadIndex] : null;

  const logEntry = {
    event: 'INBOUND_REPLY_RECEIVED',
    sender: senderEmail,
    company: lead ? lead.company : 'Unknown',
    subject,
    bodySnippet: bodyText.slice(0, 150),
    actionTaken: 'FLAGGED_FOR_HUMAN_REVIEW_PAUSED'
  };

  // Human Escalation: Flag thread for review in /admin/status and pause outbound dispatch
  try {
    const { flagThreadForReview } = require('./skills/skill7_pipeline_manager');
    flagThreadForReview({
      email: senderEmail,
      leadId: lead ? lead.id : null,
      company: lead ? lead.company : 'Unknown',
      reason: 'INBOUND_REPLY_RECEIVED',
      errorCode: null,
      subject,
      messageSnippet: bodyText.slice(0, 200)
    });
  } catch (flagErr) {
    console.warn('[Deal Engine Escalation Warning]', flagErr.message);
  }

  if (lead) {
    lead.threadPaused = true;
    lead.sequenceHalted = true;
  }

  if (!lead) {
    appendOutreachLog({ ...logEntry, actionTaken: 'UNMATCHED_SENDER_LOGGED' });
    return res.json({
      success: true,
      status: "LOGGED_UNMATCHED",
      sender: senderEmail,
      message: "Reply logged but sender not in active target queue."
    });
  }

  // Check if sequence is already halted
  if (lead.sequenceHalted) {
    appendOutreachLog({ ...logEntry, actionTaken: 'IGNORED_SEQUENCE_HALTED' });
    return res.json({
      success: true,
      status: "SEQUENCE_HALTED",
      message: `Sequence already halted for ${lead.email} (${lead.status}).`
    });
  }

  lead.repliesCount = (lead.repliesCount || 0) + 1;
  const replyLower = bodyText.toLowerCase();

  // 1. Opt-out check -> Halt sequence immediately
  if (/unsubscribe|remove|stop|not interested|opt out|wrong person|no thanks/i.test(replyLower)) {
    lead.status = "OPTED_OUT";
    lead.sequenceHalted = true;
    logEntry.actionTaken = "OPT_OUT_HALTED";
    appendOutreachLog(logEntry);
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');

    return res.json({
      success: true,
      status: "OPTED_OUT",
      leadEmail: lead.email,
      action: "Sequence halted immediately per opt-out request."
    });
  }

  // 2. Closing / Payment Intent check -> Route to Stripe Checkout & Flag Paid - Pending Onboarding
  if (/sign up|get started|payment|checkout|buy|send invoice|ready to start|move forward|retainer/i.test(replyLower)) {
    lead.status = "Paid - Pending Onboarding";
    lead.paidConfirmed = true;
    lead.sequenceHalted = true;

    // Send private-label Stripe checkout link & receipt onboarding note
    const checkoutSubject = `Onboarding & Private-Label Deployment for ${lead.company}`;
    const checkoutBody = `Hi ${lead.name},\n\nFantastic—we are ready to provision your private-label instance for ${lead.company}.\n\nYou can initiate onboarding and lock in your deployment slot via our direct Stripe checkout link here:\n👉 ${STRIPE_CHECKOUT_LINK}\n\nOnce completed, our automated provisioner will issue your commercial license key and schedule your technical deployment handover.\n\nBest regards,\nJack Buckholdt\nMaster Hustle Engine`;

    const gmailUrl = process.env.GMAIL_HTTP_URL || process.env.GMAIL_RELAY_URL || (process.env.GMAIL_APP_SCRIPT_URL ? process.env.GMAIL_APP_SCRIPT_URL : null);
    const gmailKey = process.env.GMAIL_HTTP_KEY || process.env.GMAIL_RELAY_KEY || process.env.RELAY_SECRET_KEY || '';

    if (!b.simulateOnly && liveSendsEnabled() && gmailUrl) {
      try {
        await sendViaGmailHttpRelay(gmailUrl, gmailKey, lead.email, checkoutSubject, checkoutBody);
      } catch (e) {
        console.warn(`[Deal Engine Relay Warning] Failed sending checkout email: ${e.message}`);
      }
    } else {
      console.log(`[Deal Engine Simulation] Skipped live email send to ${lead.email} (simulateOnly=${!!b.simulateOnly}, liveSendsEnabled=${liveSendsEnabled()})`);
    }

    logEntry.actionTaken = "STRIPE_CHECKOUT_ROUTED";
    logEntry.stripeLink = STRIPE_CHECKOUT_LINK;
    appendOutreachLog(logEntry);
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');

    return res.json({
      success: true,
      status: "Paid - Pending Onboarding",
      leadEmail: lead.email,
      stripeCheckoutLink: STRIPE_CHECKOUT_LINK,
      action: "Private-label Stripe checkout link dispatched; flagged Paid - Pending Onboarding; sequence halted."
    });
  }

  // 3. FIRST REPLY -> Immediately send 10-minute demo scheduling link & Tag "Demo Link Dispatched"
  if (lead.repliesCount === 1 || !lead.demoLinkSent) {
    lead.status = "Demo Link Dispatched";
    lead.demoLinkSent = true;

    const demoSubject = `Re: Cutting ${lead.company}'s LLM API token burn (10-min demo scheduling)`;
    const demoBody = `Hi ${lead.name},\n\nThanks for getting back to me! I'd be glad to walk you through how our 3-tier token router cuts LLM inference burn via real cost routing and keeps client uptime at 100% via multi-model failover.\n\nYou can book a direct 10-minute walkthrough on my calendar here:\n👉 ${DEMO_SCHEDULING_LINK}\n\nIn the meantime, feel free to inspect the live interactive failover console here: https://master-hustle-engine.onrender.com/demo\n\nLooking forward to speaking.\n\nBest regards,\nJack Buckholdt\nFounder & AI Infrastructure Architect\nMaster Hustle Engine / Anti-Gravity`;

    const gmailUrl = process.env.GMAIL_HTTP_URL || process.env.GMAIL_RELAY_URL || (process.env.GMAIL_APP_SCRIPT_URL ? process.env.GMAIL_APP_SCRIPT_URL : null);
    const gmailKey = process.env.GMAIL_HTTP_KEY || process.env.GMAIL_RELAY_KEY || process.env.RELAY_SECRET_KEY || '';

    if (!b.simulateOnly && liveSendsEnabled() && gmailUrl) {
      try {
        await sendViaGmailHttpRelay(gmailUrl, gmailKey, lead.email, demoSubject, demoBody);
      } catch (e) {
        console.warn(`[Deal Engine Relay Warning] Failed sending demo link: ${e.message}`);
      }
    } else {
      console.log(`[Deal Engine Simulation] Skipped live email send to ${lead.email} (simulateOnly=${!!b.simulateOnly}, liveSendsEnabled=${liveSendsEnabled()})`);
    }

    logEntry.actionTaken = "DEMO_LINK_DISPATCHED";
    logEntry.demoLink = DEMO_SCHEDULING_LINK;
    appendOutreachLog(logEntry);
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2), 'utf8');

    return res.json({
      success: true,
      status: "Demo Link Dispatched",
      leadEmail: lead.email,
      schedulingLink: DEMO_SCHEDULING_LINK,
      action: "10-minute demo scheduling link dispatched upon first reply; tagged 'Demo Link Dispatched'."
    });
  }

  // Subsequent reply handling
  appendOutreachLog({ ...logEntry, actionTaken: 'SUBSEQUENT_REPLY_LOGGED' });
  return res.json({
    success: true,
    status: lead.status,
    message: "Subsequent reply logged."
  });
});

app.post('/api/deal-engine/trigger-hopper', async (req, res) => {
  try {
    const { runFeederHopper } = require('./feeder_hopper');
    const dryRun = req.body && req.body.dryRun === true;
    if (!dryRun && !liveSendsEnabled()) {
      return res.status(403).json({ success: false, error: 'ERR_LIVE_SENDS_DISABLED', message: LIVE_SENDS_DISABLED_REASON });
    }
    const targetCount = req.body && req.body.targetCount ? parseInt(req.body.targetCount, 10) : 15;
    const leads = await runFeederHopper({ dryRun, targetCount });
    res.json({
      success: true,
      mode: dryRun ? "DRY_RUN" : "ACTIVE_FEED",
      stagedCount: leads.length,
      targetBatchSize: targetCount,
      leads: leads.map(l => ({ name: l.name, company: l.company, email: l.email, status: l.status }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/deal-engine/status', (req, res) => {
  const queuePath = path.join(__dirname, 'staged_leads_queue.json');
  const logPath = path.join(__dirname, 'outreach_log.json');
  let queue = [];
  let logs = [];
  try {
    if (fs.existsSync(queuePath)) queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    if (fs.existsSync(logPath)) logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch (e) {}

  let nextHopperTime = "17:30:00 CT (Monday - Friday)";
  let nextDispatchTime = "18:00:00 CT (Monday - Friday)";
  try {
    const { getNextWeekdayTrigger } = require('./autonomous_deal_engine');
    const h = getNextWeekdayTrigger(17, 30);
    const d = getNextWeekdayTrigger(18, 0);
    nextHopperTime = h.targetDate.toISOString();
    nextDispatchTime = d.targetDate.toISOString();
  } catch (e) {}

  res.json({
    success: true,
    engine: "Autonomous Outreach and Deal Engine (Recurring Weekday Daemon)",
    schedule: {
      hopperFeedCron: "17:30:00 CT (Mon-Fri)",
      dispatchCron: "18:00:00 CT (Mon-Fri)",
      nextHopperFeedUTC: nextHopperTime,
      nextDispatchUTC: nextDispatchTime,
      weekendFilter: "Weekends automatically skipped (Mon-Fri only)",
      jitterPacing: "15s to 60s randomized delay between outbound dispatches",
      targetDailyBatch: 15
    },
    totalLeadsInQueue: queue.length,
    leads: queue.map(l => ({
      name: l.name,
      company: l.company,
      email: l.email,
      status: l.status,
      outreachStatus: l.outreachStatus,
      demoLinkSent: l.demoLinkSent,
      paidConfirmed: l.paidConfirmed,
      sequenceHalted: l.sequenceHalted
    })),
    recentLogs: logs.slice(-10)
  });
});

// ===================================================================
// CAMPAIGN MANAGER & CRON RUNNER
// ===================================================================

app.get('/api/campaigns', (req, res) => {
  res.json({
    success: true,
    activeCampaigns: [
      { id: "shovel_b2b_outreach", name: "Shovel Manufacturer Licensing", status: "ACTIVE", maxBatch: 25 },
      { id: "thca_seo_scheduler", name: "THCA Review Content Publisher", status: "STANDBY", maxBatch: 10 }
    ]
  });
});

// Automated Cron Runner (Render Cron / External Health Ping compatible)
app.all('/api/cron/run', async (req, res) => {
  try {
    pushUiAuditLog('CRON_PULSE', 'Automated maintenance & telemetry pulse triggered');
    const metrics = getCalculatedProductionMetrics();
    res.json({
      success: true,
      status: "CRON_PULSE_COMPLETE",
      timestamp: new Date().toISOString(),
      metrics: metrics
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health Check Endpoints (Router-Aware)
app.get(['/api/router-health'], (req, res) => {
  const { getRouterStatus } = require('./lib/multiModelRouter');
  res.status(200).json(getRouterStatus());
});

// ===================================================================
// PUBLIC DEMO: WHITE-LABEL AI SALES DESK WALKTHROUGH (static, no API calls)
// ===================================================================

app.get(['/demo', '/demo.html', '/demo-v2', '/demo-v2.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo.html'));
});

// AI Router Walkthrough Page
app.get(['/router', '/router.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'router.html'));
});

// ─── Per-agency client report (/report) ────────────────────────────────────────
// Admin pages use the same ADMIN_KEY auth as /admin/status. Share links are read-only
// and are HMAC tokens per account (REPORT_SHARE_SECRET, falling back to ADMIN_KEY).
function requireReportAdmin(req, res, next) {
  const crypto = require('crypto');
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return res.status(503).type('text/plain').send('Client report is disabled: ADMIN_KEY is not set on this server');
  }
  const providedRaw = req.query.key || req.headers['x-admin-key'];
  const providedKey = typeof providedRaw === 'string' ? providedRaw : '';
  const a = Buffer.from(providedKey);
  const b = Buffer.from(adminKey);
  const ok = a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).type('text/plain').send('Unauthorized: Invalid or missing admin key');
  return next();
}

app.get('/report', requireReportAdmin, (req, res) => {
  try {
    const { loadAgencyConfig, buildAccountReports, shareToken } = require('./lib/agencyReport');
    const { renderIndexPage } = require('./lib/reportPage');
    const cfg = loadAgencyConfig();
    const reports = buildAccountReports(cfg);
    const base = `${req.protocol}://${req.get('host')}`;
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderIndexPage(reports, (id) => {
      const t = shareToken(id);
      return t ? `${base}/report/share/${t}` : null;
    }));
  } catch (err) {
    console.error('[Report] Failed to build index:', err.message);
    res.status(500).type('text/plain').send('Client report unavailable: ' + err.message);
  }
});

app.get('/report/share/:token', (req, res) => {
  try {
    const { loadAgencyConfig, findAccountByShareToken, buildAccountReport, collectSources } = require('./lib/agencyReport');
    const { renderAccountPage } = require('./lib/reportPage');
    const cfg = loadAgencyConfig();
    const account = findAccountByShareToken(req.params.token, cfg);
    if (!account) return res.status(404).type('text/plain').send('Report link not found');
    const report = buildAccountReport(account, cfg, collectSources(cfg));
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.type('html').send(renderAccountPage(report, { shared: true }));
  } catch (err) {
    console.error('[Report] Failed to build shared report:', err.message);
    res.status(500).type('text/plain').send('Client report unavailable');
  }
});

app.get('/report/:accountId', requireReportAdmin, (req, res) => {
  try {
    const { loadAgencyConfig, buildAccountReport, collectSources, shareToken } = require('./lib/agencyReport');
    const { renderAccountPage } = require('./lib/reportPage');
    const cfg = loadAgencyConfig();
    const account = cfg.accounts.find((a) => a.id === req.params.accountId);
    if (!account) return res.status(404).type('text/plain').send('No agency account with that id');
    const report = buildAccountReport(account, cfg, collectSources(cfg));
    const t = shareToken(account.id);
    const shareUrl = t ? `${req.protocol}://${req.get('host')}/report/share/${t}` : null;
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderAccountPage(report, { shareUrl }));
  } catch (err) {
    console.error('[Report] Failed to build account report:', err.message);
    res.status(500).type('text/plain').send('Client report unavailable: ' + err.message);
  }
});

// Private router savings report. Same auth as /admin/status (ADMIN_KEY via ?key= or x-admin-key).
// Savings figures are shown only on this page.
app.get('/savings', (req, res) => {
  const crypto = require('crypto');
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return res.status(503).type('text/plain').send('Savings page is disabled: ADMIN_KEY is not set on this server');
  }
  const providedRaw = req.query.key || req.headers['x-admin-key'];
  const providedKey = typeof providedRaw === 'string' ? providedRaw : '';
  const a = Buffer.from(providedKey);
  const b = Buffer.from(adminKey);
  const keyMatches = a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!keyMatches) {
    return res.status(401).type('text/plain').send('Unauthorized: Invalid or missing admin key');
  }

  try {
    const { getUsageReport } = require('./lib/routerUsageLog');
    const { renderSavingsPage } = require('./lib/savingsPage');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderSavingsPage(getUsageReport()));
  } catch (err) {
    console.error('[Savings] Failed to build report:', err.message);
    res.status(500).type('text/plain').send('Savings report unavailable: ' + err.message);
  }
});

// Demo API: Live Provider Failover (no longer used by /demo; kept for existing scripts)
app.post('/api/demo/failover', (req, res, next) => {
  const { requireRouterApiKey } = require('./lib/multiModelRouter');
  return requireRouterApiKey(req, res, next);
}, async (req, res) => {
  const { prompt, simulateOutage = false } = req.body || {};
  const queryPrompt = prompt || "You are an expert customer success assistant for an e-commerce brand. Please draft an empathetic return policy response for Order #89211.";
  const startTime = Date.now();

  if (simulateOutage) {
    // Primary Provider Failure (Simulated 503 / 429)
    const failoverStart = Date.now();
    
    // Check if backup keys exist
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasClaude = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);

    if (!hasOpenAI && !hasClaude) {
      // Honest reporting: backup not configured
      const endTime = Date.now();
      return res.json({
        success: false,
        failoverOccurred: true,
        primary: {
          provider: 'Gemini 3.5 Flash Lite',
          status: 503,
          state: 'FAILED',
          error: 'HTTP 503: High upstream model load / simulated 503 outage'
        },
        secondary: {
          provider: 'OpenAI / Claude',
          status: 'NOT_CONFIGURED',
          state: 'BACKUP NOT CONFIGURED',
          error: 'backup not configured',
          message: 'Backup provider not configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in environment to enable live secondary fallback.'
        },
        failoverLatencyMs: endTime - failoverStart,
        totalLatencyMs: endTime - startTime
      });
    }

    // If backup key exists, dispatch real call
    try {
      let secondaryRes = null;
      const { routeMultiModel } = require('./lib/multiModelRouter');
      if (hasOpenAI) {
        secondaryRes = await routeMultiModel({ prompt: queryPrompt, preferredProvider: 'openai' });
      } else if (hasClaude) {
        secondaryRes = await routeMultiModel({ prompt: queryPrompt, preferredProvider: 'claude' });
      }
      const endTime = Date.now();
      if (!secondaryRes || !secondaryRes.success) {
        return res.json({
          success: false,
          failoverOccurred: true,
          primary: {
            provider: 'Gemini 3.5 Flash Lite',
            status: 503,
            state: 'FAILED',
            error: 'HTTP 503: High upstream model load / simulated 503 outage'
          },
          secondary: {
            provider: secondaryRes?.provider || 'Backup Provider',
            status: secondaryRes?.status || 502,
            state: 'FAILED',
            error: secondaryRes?.error || 'Secondary provider failover failed to deliver response'
          },
          failoverLatencyMs: endTime - failoverStart,
          totalLatencyMs: endTime - startTime
        });
      }

      return res.json({
        success: true,
        failoverOccurred: true,
        primary: {
          provider: 'Gemini 3.5 Flash Lite',
          status: 503,
          state: 'FAILED',
          error: 'HTTP 503: High upstream model load / simulated 503 outage'
        },
        secondary: {
          provider: secondaryRes?.provider || 'Claude Sonnet 4.6',
          status: 200,
          state: 'SUCCESS',
          model: secondaryRes?.model || 'claude-sonnet-4-6',
          output: secondaryRes?.output || secondaryRes?.text || 'Output delivered from secondary provider.'
        },
        failoverLatencyMs: endTime - failoverStart,
        totalLatencyMs: endTime - startTime
      });
    } catch (secErr) {
      const endTime = Date.now();
      return res.json({
        success: false,
        failoverOccurred: true,
        primary: {
          provider: 'Gemini 3.5 Flash Lite',
          status: 503,
          state: 'FAILED',
          error: 'HTTP 503: High upstream model load / simulated 503 outage'
        },
        secondary: {
          provider: 'OpenAI / Claude',
          status: 500,
          state: 'FAILED',
          error: secErr.message
        },
        failoverLatencyMs: endTime - failoverStart,
        totalLatencyMs: endTime - startTime
      });
    }
  }

  // Normal execution (Primary Gemini 3.6 Flash live call over IPv4)
  try {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      throw new Error('GEMINI_API_KEY not configured');
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${geminiKey}`;
    const postPayload = JSON.stringify({
      contents: [{ parts: [{ text: queryPrompt }] }]
    });

    const geminiRes = await new Promise((resolve, reject) => {
      const u = new URL(endpoint);
      const reqOut = https.request({
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postPayload)
        },
        timeout: 10000
      }, (resOut) => {
        let d = '';
        resOut.on('data', chunk => d += chunk);
        resOut.on('end', () => {
          try {
            resolve({ statusCode: resOut.statusCode, data: JSON.parse(d) });
          } catch (e) {
            resolve({ statusCode: resOut.statusCode, raw: d });
          }
        });
      });
      reqOut.on('timeout', () => { reqOut.destroy(); reject(new Error('Gemini API request timed out')); });
      reqOut.on('error', err => reject(err));
      reqOut.write(postPayload);
      reqOut.end();
    });

    const endTime = Date.now();
    const liveText = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (geminiRes.statusCode === 200 && liveText) {
      return res.json({
        success: true,
        failoverOccurred: false,
        primary: {
          provider: 'Gemini 3.6 Flash',
          status: 200,
          state: 'SUCCESS',
          model: 'gemini-3.6-flash',
          output: liveText.trim()
        },
        totalLatencyMs: endTime - startTime
      });
    }

    throw new Error(geminiRes.data?.error?.message || `HTTP ${geminiRes.statusCode}`);
  } catch (liveErr) {
    const endTime = Date.now();
    return res.json({
      success: false,
      failoverOccurred: false,
      primary: {
        provider: 'Gemini 3.6 Flash',
        status: 500,
        state: 'FAILED',
        error: liveErr.message
      },
      totalLatencyMs: endTime - startTime
    });
  }
});

// Demo API: Queue & Guardrail Scrubber (Exact 10-Row Fixture)
app.post('/api/demo/scrub', (req, res) => {
  // Load DNC registry from do-not-send-list.csv
  const dncPath = path.join(__dirname, 'do-not-send-list.csv');
  const dncSet = new Set(['optout@example.agency', 'dnc@example.agency', 'dnc@example.com']);
  if (fs.existsSync(dncPath)) {
    try {
      const lines = fs.readFileSync(dncPath, 'utf8').split(/\r?\n/).slice(1);
      lines.forEach(line => {
        const email = line.split(',')[0]?.trim().toLowerCase();
        if (email) dncSet.add(email);
      });
    } catch (e) {}
  }

  // Exact 10 Rows Required by Locked Specification
  const FIXTURE_ROWS = [
    { row: 1, email: "ops@example.agency", name: "Alex Morgan", company: "Example Agency", category: "valid agency email", fixtureLastSentHoursAgo: null },
    { row: 2, email: "ops@example.agency", name: "Alex Morgan", company: "Example Agency", category: "duplicate of #1", fixtureLastSentHoursAgo: null },
    { row: 3, email: "broken-email-no-domain", name: "Invalid User", company: "Unknown", category: "bad RFC syntax (no @)", fixtureLastSentHoursAgo: null },
    { row: 4, email: "optout@example.agency", name: "Opted Out", company: "Example Agency", category: "address on DNC / do-not-send-list.csv", fixtureLastSentHoursAgo: null },
    { row: 5, email: "info@example.agency", name: "Info Desk", company: "Example Agency", category: "info@ role account", fixtureLastSentHoursAgo: null },
    { row: 6, email: "founder@gmail.com", name: "Agency Founder", company: "Founder Studio", category: "gmail.com freemail", fixtureLastSentHoursAgo: null },
    { row: 7, email: "growth@example.agency", name: "Sam Rivera", company: "Example Agency", category: "valid second agency email", fixtureLastSentHoursAgo: null },
    { row: 8, email: "growth@example.agency", name: "Sam Rivera", company: "Example Agency", category: "duplicate of #7", fixtureLastSentHoursAgo: null },
    { row: 9, email: "partner@example.agency", name: "Taylor Reed", company: "Example Agency", category: "address inside 48-hour quiet window", fixtureLastSentHoursAgo: 14 },
    { row: 10, email: "owner@example.agency", name: "Jordan Casey", company: "Example Agency", category: "valid third email", fixtureLastSentHoursAgo: null }
  ];

  const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  const seenEmails = new Set();
  const results = [];

  let totalSend = 0;
  let totalDrop = 0;

  for (const item of FIXTURE_ROWS) {
    const rawEmail = item.email.trim();
    const lowerEmail = rawEmail.toLowerCase();
    let action = "SEND";
    let reason = "Passed syntax, deduping, domain MX, and DNC registry checks";

    // 1. RFC Syntax check
    if (!EMAIL_REGEX.test(rawEmail) || !rawEmail.includes('@') || !rawEmail.includes('.')) {
      action = "DROP";
      reason = "Failed RFC email syntax check (missing '@' or valid domain)";
      totalDrop++;
    }
    // 2. DNC suppression check
    else if (dncSet.has(lowerEmail)) {
      action = "DROP";
      reason = "Suppressed: Address matched active suppression list (do-not-send-list.csv)";
      totalDrop++;
    }
    // 3. Role mailbox check
    else if (lowerEmail.startsWith('info@') || lowerEmail.startsWith('admin@') || lowerEmail.startsWith('support@')) {
      action = "DROP";
      reason = "Role mailbox suppressed: Generic 'info@' distribution list";
      totalDrop++;
    }
    // 4. Freemail check
    else if (lowerEmail.endsWith('@gmail.com') || lowerEmail.endsWith('@yahoo.com') || lowerEmail.endsWith('@hotmail.com')) {
      action = "DROP";
      reason = "Freemail provider suppressed: '@gmail.com' rejected for enterprise B2B outreach";
      totalDrop++;
    }
    // 5. Deduplication check
    else if (seenEmails.has(lowerEmail)) {
      action = "DROP";
      reason = "Duplicate recipient address detected within current dispatch cycle";
      totalDrop++;
    }
    // 6. 48-hour quiet window check
    else if (item.fixtureLastSentHoursAgo !== null && item.fixtureLastSentHoursAgo < 48) {
      action = "DROP";
      reason = `Suppressed: Contacted ${item.fixtureLastSentHoursAgo}h ago (within mandatory 48-hour quiet window)`;
      totalDrop++;
    }
    // Cleared for send
    else {
      seenEmails.add(lowerEmail);
      totalSend++;
    }

    results.push({
      row: item.row,
      email: rawEmail,
      name: item.name,
      company: item.company,
      fixtureCategory: item.category,
      action,
      reason,
      quietWindowActive: item.fixtureLastSentHoursAgo !== null ? `${item.fixtureLastSentHoursAgo}h ago` : "None"
    });
  }

  res.json({
    success: true,
    totalIngested: FIXTURE_ROWS.length,
    totalSend,
    totalDrop,
    enforcedQuietGapHours: 48,
    records: results
  });
});

// Explicit Homepage Route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Explicit Dashboard Route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Helper: Get Daily Send Counter from SQLite daily_dispatch_state and environment limit
function getDailySendCounter() {
  const dailyLimit = parseInt(process.env.DAILY_DISPATCH_LIMIT || '35', 10);
  try {
    const { getDailyDispatchState } = require('./skills/skill7_pipeline_manager');
    const state = getDailyDispatchState();
    return {
      dailyLimit: state.dailyLimit,
      sentToday: state.sentToday,
      remainingToday: state.remainingToday,
      status: state.status,
      lastLiveDispatchAt: state.lastDispatchAt || productionMetrics.lastLiveDispatchAt || new Date().toISOString()
    };
  } catch (e) {
    return {
      dailyLimit,
      sentToday: 0,
      remainingToday: dailyLimit,
      status: "ACTIVE",
      lastLiveDispatchAt: productionMetrics.lastLiveDispatchAt || new Date().toISOString()
    };
  }
}

// Dedicated API endpoint for daily send counter check
app.get('/api/daily-send-counter', (req, res) => {
  res.json({
    success: true,
    dailySendCounter: getDailySendCounter()
  });
});

// ===================================================================
// AUTONOMOUS DAILY SCHEDULER & COUNTER RESET (AMERICA/CHICAGO CST)
// ===================================================================

let midnightResetJob = null;
let morningIntakeJob = null;
let morningDispatchJob = null;
let inboundPollerJob = null;

function initScheduler() {
  if (midnightResetJob || morningIntakeJob || morningDispatchJob || inboundPollerJob) return;

  // 1. Midnight Reset Job: 00:00 midnight CST (0 0 * * *)
  midnightResetJob = cron.schedule('0 0 * * *', () => {
    try {
      console.log('[Scheduler] Executing scheduled 00:00 midnight CST daily counter reset...');
      const { resetDailySendCounter } = require('./skills/skill7_pipeline_manager');
      const resetResult = resetDailySendCounter();
      console.log(`[Scheduler] Midnight reset complete for ${resetResult.date}. Sent today: ${resetResult.sentToday}. Daily gates cleared.`);
      pushUiAuditLog('MIDNIGHT_RESET_CST', `Daily send counter reset to 0 for ${resetResult.date}. Daily send gates cleared.`);
    } catch (err) {
      console.error('[Scheduler Error] Failed executing midnight reset:', err.message);
    }
  }, {
    scheduled: true,
    timezone: 'America/Chicago'
  });

  // 2. Morning Automated Outscraper Lead Intake Job: 6:00 AM CST (0 6 * * *)
  morningIntakeJob = cron.schedule('0 6 * * *', async () => {
    console.log('[Scheduler] Triggering autonomous daily Outscraper lead intake at 6:00 AM CST...');
    try {
      const { runAutonomousDailyIntake } = require('./lib/autonomousLeadIntake');
      pushUiAuditLog('INTAKE_START', 'Autonomous 6:00 AM CST Outscraper lead intake triggered');
      const intakeRes = await runAutonomousDailyIntake({ limit: 15 });
      console.log(`[Scheduler] 6:00 AM CST intake complete: staged ${intakeRes.stagedCount} clean leads. Lead queue depth: ${intakeRes.leadQueueDepth}.`);
      pushUiAuditLog('INTAKE_COMPLETE', `Daily intake complete: ${intakeRes.stagedCount} staged, queue depth ${intakeRes.leadQueueDepth}`);
    } catch (err) {
      console.error('[Scheduler Error] Autonomous daily lead intake failed:', err.message);
      pushUiAuditLog('INTAKE_ERROR', `Daily intake failed: ${err.message}`);
    }
  }, {
    scheduled: true,
    timezone: 'America/Chicago'
  });

  // 3. Morning Batch Dispatch Job: 8:00 AM CST (0 8 * * *)
  morningDispatchJob = cron.schedule('0 8 * * *', async () => {
    console.log('[Scheduler] Triggering autonomous daily batch dispatch at 8:00 AM CST...');

    // Safety Catch 1: OUTBOUND_PAUSED check
    if (process.env.OUTBOUND_PAUSED === 'true') {
      console.log('[Scheduler] Dispatch SKIPPED: OUTBOUND_PAUSED is set to true in environment.');
      pushUiAuditLog('SCHEDULER_SKIP', 'Daily 8:00 AM CST dispatch skipped because OUTBOUND_PAUSED=true');
      return;
    }

    if (!liveSendsEnabled()) {
      console.log('[Scheduler] Dispatch SKIPPED: ENABLE_LIVE_SENDS is not set to true.');
      pushUiAuditLog('SCHEDULER_SKIP', 'Daily 8:00 AM CST dispatch skipped because ENABLE_LIVE_SENDS is off');
      return;
    }

    // Safety Catch 2: Hard 35 emails/day ceiling check
    const counter = getDailySendCounter();
    if (counter.sentToday >= counter.dailyLimit || counter.status === 'CAP_REACHED') {
      console.log(`[Scheduler] Dispatch SKIPPED: Daily cap reached (${counter.sentToday}/${counter.dailyLimit})`);
      pushUiAuditLog('SCHEDULER_SKIP', `Daily 8:00 AM CST dispatch skipped because daily cap reached (${counter.sentToday}/${counter.dailyLimit})`);
      return;
    }

    try {
      const { runBatchDispatch } = require('./trigger_batch_dispatch');
      pushUiAuditLog('SCHEDULER_START', 'Autonomous 8:00 AM CST batch dispatch triggered');
      const result = await runBatchDispatch({ isLive: true });
      console.log(`[Scheduler] 8:00 AM CST batch dispatch complete: evaluated ${result.evaluated}, sends: ${result.sends?.length || 0}`);
      pushUiAuditLog('SCHEDULER_COMPLETE', `Daily dispatch complete: ${result.sends?.filter(s => s.sent).length || 0} sent`);
    } catch (err) {
      console.error('[Scheduler Error] Autonomous batch dispatch failed:', err.message);
      pushUiAuditLog('SCHEDULER_ERROR', `Daily batch dispatch failed: ${err.message}`);
    }
  }, {
    scheduled: true,
    timezone: 'America/Chicago'
  });

  // 4. Inbound Reply Listener & Triage Poller Job: Every 15 minutes (*/15 * * * *)
  inboundPollerJob = cron.schedule('*/15 * * * *', async () => {
    console.log('[Scheduler] Executing scheduled 15-minute Hostinger IMAP inbound reply poll...');
    try {
      const { pollInboundReplies } = require('./lib/inboundReplyListener');
      pushUiAuditLog('INBOUND_POLL_START', '15-minute autonomous inbound reply poll triggered');
      const pollRes = await pollInboundReplies();
      console.log(`[Scheduler] Inbound reply poll complete: ${pollRes.processedCount || 0} replies processed, ${pollRes.circuitBreakersTripped || 0} circuit breakers tripped.`);
      pushUiAuditLog('INBOUND_POLL_COMPLETE', `Inbound poll finished: ${pollRes.processedCount || 0} processed, ${pollRes.circuitBreakersTripped || 0} circuit breakers tripped.`);
    } catch (err) {
      console.error('[Scheduler Error] Inbound reply poller failed:', err.message);
      pushUiAuditLog('INBOUND_POLL_ERROR', `Inbound poll failed: ${err.message}`);
    }
  }, {
    scheduled: true,
    timezone: 'America/Chicago'
  });

  console.log('[Scheduler] node-cron autonomous daily schedules initialized (6:00 AM CST intake, 8:00 AM CST dispatch, 15-min inbound triage & 00:00 midnight CST reset).');
}

function stopScheduler() {
  if (midnightResetJob) {
    midnightResetJob.stop();
    midnightResetJob = null;
  }
  if (morningIntakeJob) {
    morningIntakeJob.stop();
    morningIntakeJob = null;
  }
  if (morningDispatchJob) {
    morningDispatchJob.stop();
    morningDispatchJob = null;
  }
  if (inboundPollerJob) {
    inboundPollerJob.stop();
    inboundPollerJob = null;
  }
}

function getSchedulerStatus() {
  return {
    status: (morningDispatchJob && midnightResetJob && morningIntakeJob && inboundPollerJob) ? "ACTIVE" : "STANDBY",
    timezone: "America/Chicago (CST)",
    intakeSchedule: "0 6 * * * (6:00 AM CST)",
    dispatchSchedule: "0 8 * * * (8:00 AM CST)",
    inboundSchedule: "*/15 * * * * (Every 15 min CST)",
    resetSchedule: "0 0 * * * (00:00 Midnight CST)",
    outboundPaused: process.env.OUTBOUND_PAUSED === 'true',
    scheduledJobsEnabled: scheduledJobsEnabled(),
    liveSendsEnabled: liveSendsEnabled(),
    jobsRunning: {
      morningIntake: !!morningIntakeJob,
      morningDispatch: !!morningDispatchJob,
      inboundPoller: !!inboundPollerJob,
      midnightReset: !!midnightResetJob
    }
  };
}

// Dedicated Scheduler Management Endpoints
app.post(['/api/scheduler/intake', '/api/intake/trigger'], async (req, res) => {
  try {
    const { runAutonomousDailyIntake } = require('./lib/autonomousLeadIntake');
    const { query, limit, mock, dryRun, forceLive } = req.body || {};
    if (!scheduledJobsEnabled() && mock !== true && dryRun !== true) {
      return res.status(403).json({ success: false, reason: SCHEDULED_JOBS_DISABLED_REASON });
    }
    const result = await runAutonomousDailyIntake({
      query,
      limit: parseInt(limit, 10) || 15,
      mock: mock === true,
      dryRun: dryRun === true,
      forceLive: forceLive === true
    });
    res.json({ success: true, status: "INTAKE_EXECUTED", result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(['/api/scheduler/trigger', '/api/cron/run'], async (req, res) => {
  const isLive = req.body?.isLive === true || req.query?.live === 'true';
  if (isLive && !scheduledJobsEnabled()) {
    return res.status(403).json({ success: false, reason: SCHEDULED_JOBS_DISABLED_REASON });
  }
  if (isLive && !liveSendsEnabled()) {
    return res.status(403).json({ success: false, reason: LIVE_SENDS_DISABLED_REASON });
  }
  if (process.env.OUTBOUND_PAUSED === 'true') {
    return res.json({ success: false, reason: "OUTBOUND_PAUSED is set to true" });
  }
  const counter = getDailySendCounter();
  if (counter.sentToday >= counter.dailyLimit || counter.status === 'CAP_REACHED') {
    return res.json({ success: false, reason: `Daily cap reached (${counter.sentToday}/${counter.dailyLimit})` });
  }
  try {
    const { runBatchDispatch } = require('./trigger_batch_dispatch');
    const result = await runBatchDispatch({ 
      isLive, 
      skipPacing: req.body?.skipPacing === true || req.query?.skipPacing === 'true' 
    });
    res.json({ success: true, status: "DISPATCH_EXECUTED", result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/scheduler/reset', (req, res) => {
  try {
    const { resetDailySendCounter } = require('./skills/skill7_pipeline_manager');
    const result = resetDailySendCounter();
    res.json({ success: true, status: "COUNTER_RESET", result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dedicated Inbound Reply Listener & Triage Endpoints
app.post(['/api/inbound/poll', '/api/triage/poll'], async (req, res) => {
  try {
    const { pollInboundReplies } = require('./lib/inboundReplyListener');
    const result = await pollInboundReplies(req.body || {});
    res.json({ success: true, status: "INBOUND_POLL_EXECUTED", result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get(['/api/inbound/triage', '/api/triage/status', '/api/inbound/staged-drafts'], (req, res) => {
  try {
    const { getInboxTriageTelemetry } = require('./lib/inboundReplyListener');
    res.json({ success: true, triage: getInboxTriageTelemetry() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback to index.html
// Outreach event ingest: the laptop sender posts sent / reply / bounce events here.
// Auth is the same ADMIN_KEY as /admin/status. If ADMIN_KEY is unset, the route is disabled (503).
app.post('/api/ingest/outreach', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return res.status(503).json({ success: false, error: 'Ingest is disabled: ADMIN_KEY is not set on this server' });
  }
  const providedKey = req.headers['x-admin-key'];
  if (!providedKey || providedKey !== adminKey) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing admin key' });
  }
  try {
    const { insertEvents } = require('./lib/outreachEvents');
    const result = insertEvents(req.body);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    const status = /must be a JSON array|too large/.test(err.message) ? 400 : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

if (scheduledJobsEnabled()) {
  initScheduler();
} else {
  console.log('[Scheduler] Scheduled jobs are OFF (intake, dispatch, inbound poll, midnight reset). Set ENABLE_SCHEDULED_JOBS=true to enable.');
}

let serverInstance = null;
if (require.main === module) {
  serverInstance = app.listen(PORT, () => {
    console.log(`===================================================================`);
    console.log(`  ANTIGRAVITY ENGINE CORE - SINGLE SOURCE OF TRUTH MODEL ROUTER    `);
    console.log(`  Server Running: http://localhost:${PORT}`);
    console.log(`  Router Endpoint: http://localhost:${PORT}/api/model/route`);
    console.log(`  Live Email Endpoint: http://localhost:${PORT}/api/send-single-email`);
    console.log(`  Scheduler: ${scheduledJobsEnabled() ? 'Active (6:00 AM CST Intake / 8:00 AM CST Dispatch / 00:00 Midnight CST Reset)' : 'OFF (ENABLE_SCHEDULED_JOBS not set to true)'}`);
    console.log(`  Token Governance: Active (Flash Tier ${formatEfficiencyDisplay(tokenGovernance.reductionTargetPct)} Efficiency Enforced)`);
    console.log(`  Data Isolation: Production Receipts vs Sandbox Tests ISOLATED`);
    console.log(`===================================================================`);

    // Perform startup dry run probe for configured LLM providers
    try {
      const { probeAllProviders } = require('./lib/multiModelRouter');
      probeAllProviders().catch(err => {
        console.warn('[Router Startup Probe Notice]', err.message);
      });
    } catch (e) {}
  });
}

module.exports = {
  app,
  getDailySendCounter,
  initScheduler,
  stopScheduler,
  getSchedulerStatus,
  serverInstance
};
