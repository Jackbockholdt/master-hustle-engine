/**
 * server.js
 * 
 * Unified Backend Engine (Antigravity Autonomous Master Engine)
 * Running on Express, node-cron, and SQLite.
 * 
 * Exposes manual webhook POST endpoints and an automated 8:00 AM daily cron rotation
 * for 9 niches:
 * 1. Vintage Flipper
 * 2. KDP Books
 * 3. Inventor Pitches
 * 4. Voice Prompts
 * 5. Review Replies
 * 6. Local SEO
 * 7. Marketplace Ads
 * 8. Faceless Videos
 * 9. Contract Proposals
 */

require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenAI } = require('@google/genai');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const https = require('https');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl === '/api/stripe-webhook') req.rawBody = buf;
  }
}));

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'transactions.sqlite');

// B2B Sales Engine Config
const B2B_DEPLOYER_NAME  = process.env.INVENTOR_NAME || '';
const B2B_DEPLOYER_EMAIL = process.env.INVENTOR_EMAIL || process.env.ADMIN_EMAIL || '';
const B2B_OFFER_NAME     = process.env.INVENTION_NAME || 'White-Label AI Infrastructure License';
const B2B_OFFER_SUMMARY  = process.env.INVENTION_SUMMARY || '';
const B2B_PROOF_URL      = process.env.PROOF_URL || 'https://missedcallproject.com';
const B2B_DEPLOYMENT_FEE = process.env.DEPLOYMENT_FEE || '1500';
const B2B_PAYMENT_LINK   = process.env.STRIPE_PAYMENT_LINK || '';
const B2B_BATCH_HOURS    = parseInt(process.env.BATCH_INTERVAL_HOURS || '6');
const B2B_BATCH_SIZE     = parseInt(process.env.BATCH_SIZE || '10');
const B2B_INDUSTRIES     = (process.env.TARGET_INDUSTRIES ||
  'digital marketing agency,lead generation agency,marketing agency,seo agency,ppc agency,social media agency,growth agency,advertising agency')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Initialize SQLite database with the logs table
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[SQLite] Connection error:', err.message);
  } else {
    console.log('[SQLite] Connected to transactions database.');
    db.run(`CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_type TEXT,
      asset_generated TEXT,
      status TEXT,
      buyer_email TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS leads_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name  TEXT    NOT NULL,
      contact_email TEXT    NOT NULL,
      website       TEXT,
      industry      TEXT,
      phone         TEXT,
      status        TEXT    NOT NULL DEFAULT 'pending',
      added_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at  DATETIME
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS follow_ups (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id   TEXT    NOT NULL,
      company_name  TEXT    NOT NULL,
      contact_email TEXT    NOT NULL,
      step          INTEGER NOT NULL,
      subject       TEXT    NOT NULL,
      body          TEXT    NOT NULL,
      due_at        TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at       DATETIME
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS audit_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_timestamp TEXT    NOT NULL,
      skill_name          TEXT    NOT NULL,
      lead_id             TEXT,
      input_source        TEXT,
      operational_status  TEXT    NOT NULL,
      key_decisions       TEXT,
      error_message       TEXT,
      duration_ms         INTEGER,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }
});

// Setup Nodemailer SMTP Transporter (fallback only — Render blocks outbound SMTP,
// so GMAIL_HTTP_URL/GMAIL_HTTP_KEY below is the path that actually works there)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Send email via the Gmail HTTPS relay (Apps Script) if configured, else raw SMTP.
// The relay always returns HTTP 200 with {"success": bool, ...} — check the body, not the status.
async function sendEmailViaRelayOrSmtp(to, subject, htmlOrText) {
  const relayUrl = process.env.GMAIL_HTTP_URL;
  if (relayUrl) {
    const res = await fetch(relayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: process.env.GMAIL_HTTP_KEY, to, subject, body: htmlOrText }),
    });
    if (!res.ok) throw new Error(`Gmail relay HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.success) throw new Error(`Gmail relay error: ${data.error || 'unknown'}`);
    return;
  }
  await transporter.sendMail({
    from: `"Antigravity Master Engine" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html: htmlOrText,
  });
}

// Reusable SQLite logging helper
function logTransaction(email, productType, status, assets = '') {
  db.run(
    `INSERT INTO logs (buyer_email, product_type, status, asset_generated) VALUES (?, ?, ?, ?)`,
    [email, productType, status, typeof assets === 'string' ? assets : JSON.stringify(assets)],
    (err) => {
      if (err) console.error('[SQLite] Failed to log transaction:', err.message);
    }
  );
}

// Reusable Helper: Send HTML email via the Gmail relay (or SMTP fallback)
async function sendHtmlEmail(to, subject, htmlContent) {
  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      await sendEmailViaRelayOrSmtp(to, subject, htmlContent);
      console.log(`[Email] Sent successfully to ${to} (Attempt ${attempts})`);
      return true;
    } catch (err) {
      console.warn(`[Email] Attempt ${attempts} failed to send email to ${to}:`, err.message);
      if (attempts === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Reusable Helper: Send Error Alert to Admin with Full Stack Trace
async function sendAdminAlert(context, errorStack) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn('[Alert] No ADMIN_EMAIL defined in environment variables. Alert skipped.');
    return;
  }

  try {
    await sendEmailViaRelayOrSmtp(
      adminEmail,
      `🚨 Antigravity Engine Failure: ${context}`,
      `
        <div style="font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 25px; border: 1px solid #fda4af; background-color: #fff1f2; color: #9f1239; border-radius: 12px; max-width: 700px; margin: 0 auto; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
          <h2 style="margin-top: 0; font-size: 20px; font-weight: 700; color: #e11d48; display: flex; align-items: center; gap: 8px;">🚨 System Processing Failure Alert</h2>
          <p style="font-size: 15px; margin: 10px 0;"><strong>Context:</strong> <span style="color: #4c0519;">${context}</span></p>
          <p style="font-size: 15px; margin: 10px 0;"><strong>Time (Server):</strong> ${new Date().toISOString()}</p>
          <hr style="border: 0; border-top: 1px solid #fecdd3; margin: 20px 0;" />
          <h3 style="margin-top: 0; font-size: 16px; font-weight: 600; color: #be123c;">Full Stack Trace:</h3>
          <pre style="background: #ffe4e6; padding: 15px; border-radius: 8px; font-family: 'Courier New', Courier, monospace; font-size: 13px; white-space: pre-wrap; overflow-x: auto; border: 1px solid #fecdd3; color: #881337; line-height: 1.5;">${errorStack}</pre>
        </div>
      `
    );
    console.log('[Alert] Admin failure email sent successfully.');
  } catch (alertErr) {
    console.error('[Alert] Failed to send admin alert email:', alertErr.message);
  }
}

// Expected Keys in JSON outputs for validation
const EXPECTED_KEYS = {
  'vintage': ['estimated_value_range', 'ebay_optimized_title', 'compelling_listing_description', 'key_keywords_tags'],
  'kdp': ['optimized_title_subtitle', 'category_recommendations', 'amazon_description', 'seven_backend_keywords'],
  'inventor': ['elevator_pitch', 'cold_email_subject', 'cold_email_body', 'licensing_value_proposition'],
  'voice': ['custom_receptionist_prompt', 'first_turn_greeting', 'suggested_voice_profile'],
  'review-reply': ['detected_sentiment', 'custom_reply'],
  'local-seo': ['optimized_about_section', 'top_5_local_keywords', '3_GMB_posts'],
  'marketplace': ['catchy_title', 'high_converting_description', 'FAQ_section'],
  'faceless-video': ['10_video_scripts'],
  'contractor-proposal': ['polished_title', 'executive_summary', 'detailed_bill_of_materials_milestones', 'professional_closing_pitch']
};

// Reusable Helper: Call Gemini API with Retries and JSON parsing validation
async function callGemini(prompt, systemInstruction, nicheKey) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not defined in the environment.');
  }

  const ai = new GoogleGenAI({ apiKey });
  let parsedResponse = null;
  let attempts = 0;
  const maxAttempts = 2; // Strict try + 1 retry
  let lastError = null;

  while (attempts < maxAttempts && !parsedResponse) {
    attempts++;
    try {
      console.log(`[Gemini] Attempting content generation (Try ${attempts}/${maxAttempts})...`);
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
        },
      });

      const textOutput = response.text ? response.text.trim() : '';
      if (!textOutput) throw new Error('Empty response returned from Gemini.');

      const json = JSON.parse(textOutput);
      
      // Validate expected keys
      const requiredKeys = EXPECTED_KEYS[nicheKey];
      if (requiredKeys) {
        const missingKeys = requiredKeys.filter(key => !(key in json));
        if (missingKeys.length > 0) {
          throw new Error(`JSON response is missing required keys: ${missingKeys.join(', ')}`);
        }
      }

      parsedResponse = json;
      console.log(`[Gemini] Successfully generated and validated response.`);
    } catch (err) {
      console.warn(`[Gemini] Attempt ${attempts} failed:`, err.message);
      lastError = err;
      if (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  if (!parsedResponse) {
    throw lastError; // Throw the actual error so caller can report stack trace
  }

  return parsedResponse;
}

// Helper to wrap async routes for global error handling
function wrapAsync(fn) {
  return function (req, res, next) {
    fn(req, res, next).catch(next);
  };
}

// =============================================================================
// NICHES DICTIONARY & ROTATION CONFIG
// =============================================================================
const NICHES_ROTATION = [
  'vintage',
  'kdp',
  'inventor',
  'voice',
  'review-reply',
  'local-seo',
  'marketplace',
  'faceless-video',
  'contractor-proposal'
];

const NICHE_DISPLAY_NAMES = {
  'vintage': 'Vintage Flipper',
  'kdp': 'KDP Books',
  'inventor': 'Inventor Pitches',
  'voice': 'Voice Prompts',
  'review-reply': 'Review Replies',
  'local-seo': 'Local SEO',
  'marketplace': 'Marketplace Ads',
  'faceless-video': 'Faceless Videos',
  'contractor-proposal': 'Contract Proposals'
};

const NICHES_DICTIONARY = {
  vintage: [
    { name: "Vintage Polaroid SX-70 Camera", description: "Original 1970s folding land camera, untested, minor leather wear, includes leather carrying case." },
    { name: "Original 1985 Air Jordan 1 Chicago", description: "Original release size 11, heavy cracking on collar leather, yellowed midsoles, no box." },
    { name: "Vintage Herman Miller Eames Lounge Chair & Ottoman", description: "Rosewood veneer with black leather, cushions have minor creasing, missing one glasper glide on chair." },
    { name: "1970s Pioneer RT-707 Reel-to-Reel Tape Deck", description: "Tested and fully functional, rackmount design, minor faceplate scratches." },
    { name: "Vintage Levi's 501 Single Stitch Selvedge Jeans", description: "Late 1970s Redline selvedge, natural fade, pocket bag stamps visible, size 32x34." }
  ],
  kdp: [
    { title: "ChatGPT Passive Income Machine 2026", genre: "Non-Fiction / Business & Finance", targetAudience: "Side hustlers, digital nomads, and online creators wanting to automate income." },
    { title: "Whispers of the Silicon Valleys", genre: "Fiction / Sci-Fi Cyberpunk Thriller", targetAudience: "Young adult and adult readers who enjoy tech-dystopian espionage novels." },
    { title: "10-Minute Mediterranean Diet Air Fryer Cookbook", genre: "Non-Fiction / Cookbooks", targetAudience: "Busy professionals and families looking for quick, healthy, low-effort recipes." },
    { title: "Stoicism for the Modern Professional", genre: "Non-Fiction / Self-Help & Philosophy", targetAudience: "Corporate workers looking to handle stress, build mental toughness, and focus." },
    { title: "The Shadow Over Ravenwood Manor", genre: "Fiction / Gothic Horror Mystery", targetAudience: "Fans of Victorian-era ghost stories, atmospheric dread, and family curses." }
  ],
  inventor: [
    { title: "Self-Cleaning Spade Shovel", description: "A shovel featuring a mechanical slide barrier that moves down the blade as you tilt to release sticky clay." },
    { title: "Smart Window Screen Dust Filter", description: "A window screen that uses safe static charge to actively repel outdoor pollen, dust, and diesel soot particles." },
    { title: "Solar-Powered Hydroponic Gutter Planter", description: "An automated vertical planter that hangs from roof gutters, using runoff water and a solar pump to grow herbs." },
    { title: "Automatic Cable-Winding Desk Grommet", description: "A desk cable organizer with a spring-tensioned internal spool that retracts cord slack automatically." },
    { title: "Portable Pet Paw Wash Cup", description: "A portable cup with automated rotating soft silicone bristles to clean mud off dog paws after walks." }
  ],
  voice: [
    { businessType: "Emergency 24/7 Plumber", location: "Dallas, TX", mainOffer: "Immediate dispatch for leaks, burst pipes, and drains." },
    { businessType: "Boutique Hair & Nail Salon", location: "Chicago, IL", mainOffer: "Premium cut, color, spa treatments, and walk-in scheduling." },
    { businessType: "Auto Towing & Wrecker Service", location: "Atlanta, GA", mainOffer: "24/7 roadside assistance, accident recovery, flatbed towing." },
    { businessType: "Residential Roofing & Gutter Repair", location: "Nashville, TN", mainOffer: "Free wind/hail storm damage roof inspections and leak repairs." },
    { businessType: "HVAC Furnace & AC Maintenance", location: "Minneapolis, MN", mainOffer: "Same-day emergency heat restoration and seasonal tune-ups." }
  ],
  'review-reply': [
    { text: "Absolutely loved the service! The team arrived on time, fixed my running toilet in under 20 minutes, and cleaned up the bathroom before leaving. A+", reviewer: "Sarah Jenkins", rating: 5 },
    { text: "Terrible experience. They rescheduled twice and when the technician finally arrived, he didn't have the right parts to fix our AC furnace. We were left without heat overnight.", reviewer: "Mark Davis", rating: 1 },
    { text: "Food was decent but the waiter forgot our drink order twice. Overall average experience, might give it another shot if the wait time is shorter.", reviewer: "David L.", rating: 3 },
    { text: "The custom solar patio installation looks stunning! Very professional crews, explained everything carefully, and handled the permits.", reviewer: "Robert G.", rating: 5 },
    { text: "Clean office, friendly front desk, but the billing department made a mistake on my insurance claims. Resolved it but took hours of phone tag.", reviewer: "Amanda K.", rating: 3 }
  ],
  'local-seo': [
    { business_name: "Apex Emergency Plumbing Dallas", city: "Dallas, TX", services: "Burst pipe repairs, drain snaking, water heater installation, leak detection" },
    { business_name: "Glow Hair & Nail Bar Chicago", city: "Chicago, IL", services: "Balayage highlights, precision cuts, shellac manicures, bridal hair styling" },
    { business_name: "Guardian Storm Roofing Nashville", city: "Nashville, TN", services: "Roof replacement, hail damage repairs, seamless gutters, emergency tarping" },
    { business_name: "Polar Bear HVAC Minneapolis", city: "Minneapolis, MN", services: "Furnace tune-ups, AC repairs, heat pump installations, duct cleaning" },
    { business_name: "ProTow Roadside Recovery Atlanta", city: "Atlanta, GA", services: "Flatbed towing, battery jumpstarts, car lockout services, tire changes" }
  ],
  marketplace: [
    { item_name: "Apple iPhone 15 Pro Max 256GB Black Titanium", condition: "Like New (99% battery health, screen protector since day 1)", key_features: "Original box, unused charging cable, unlocked to all carriers" },
    { item_name: "Sony PlayStation 5 Disc Edition Console", condition: "Excellent (fully working, clean vents, adult owned)", key_features: "2 controllers, charging station, includes Spider-Man 2 disc" },
    { item_name: "Patagonia Torrentshell 3L Rain Jacket (Mens L)", condition: "Good (minor dirt marks on collar, DWR coating still sheds water)", key_features: "Classic navy blue color, underarm pit zips, adjustable hood" },
    { item_name: "DeWalt 20V MAX Cordless Drill & Driver Kit", condition: "Very Good (typical tool scuffs, battery holds solid charge)", key_features: "Includes 2 batteries, charger, heavy-duty contractor carrying bag" },
    { item_name: "Apple iPad Air 5th Gen (64GB, Wi-Fi, Space Gray)", condition: "Mint (no scratches or scuffs, rarely left the desk)", key_features: "M1 chip model, includes original packaging and Apple Pencil 2" }
  ],
  'faceless-video': [
    { niche: "Motivational daily grind quotes & wealth discipline mindset" },
    { niche: "Ancient history facts, dark empire conspiracies, and strange discoveries" },
    { niche: "Self-improvement, productivity hacks, and modern stoicism habits" },
    { niche: "Unbelievable space mysteries, black hole facts, and cosmic anomalies" },
    { niche: "Financial literacy, compound interest explainers, and cashflow hacks" }
  ],
  'contractor-proposal': [
    { project_name: "Modern Kitchen Backsplash Installation", scope: "Tile removal of 35 sq ft wall area, install subway glass tiles, grout with waterproof white grout, seal tiles." },
    { project_name: "Wood Deck Re-staining & Sealing", scope: "Power-wash 20x15 ft outdoor pine deck, sand rough board surfaces, apply two coats of semi-transparent premium cedar stain." },
    { project_name: "Smart Thermostat & Ring Doorbell Install", scope: "Mount and wire Google Nest 3rd Gen thermostat, mount Ring Video Doorbell Wired, configure apps, run functional testing." },
    { project_name: "Basement Drywall Repair & Paint Match", scope: "Patch 3 large holes (approx 2x2 ft each) in drywall from water leak, mud, sand, match texture, apply two coats of matching eggshell paint." },
    { project_name: "Seamless Gutter Guard Installation", scope: "Clean out 120 linear feet of residential aluminum gutters, install micro-mesh stainless steel gutter guards to prevent leaf debris clog." }
  ]
};

// Reusable Helper: Wrap email template in premium design HTML
function getPremiumEmailHtml(nicheName, targetInfo, renderedContent) {
  const psLink = process.env.PS_LINK || 'https://jacksplugreviews.com';
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Daily Hustle Report - ${nicheName}</title>
      </head>
      <body style="margin: 0; padding: 0; background-color: #0b0f19; font-family: 'Outfit', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f8fafc;">
        <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 650px; margin: 30px auto; background-color: #111827; border-collapse: collapse; border-radius: 20px; overflow: hidden; border: 1px solid #1f2937; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.3), 0 10px 10px -5px rgba(0,0,0,0.04);">
          <!-- Header Banner -->
          <tr>
            <td style="padding: 40px; background: linear-gradient(135deg, #4f46e5, #06b6d4, #10b981); text-align: center;">
              <h1 style="margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; color: #ffffff; text-shadow: 0 2px 4px rgba(0,0,0,0.15);">🚀 Daily Hustle Report</h1>
              <p style="margin: 8px 0 0; font-size: 14px; font-weight: 500; color: #e0f2fe; text-transform: uppercase; letter-spacing: 1px;">Niche: ${nicheName}</p>
            </td>
          </tr>

          <!-- Target Parameters -->
          <tr>
            <td style="padding: 30px 40px 15px 40px;">
              <div style="background-color: rgba(31, 41, 55, 0.5); border: 1px solid #374151; padding: 20px; border-radius: 12px; border-left: 4px solid #10b981;">
                <h4 style="margin: 0 0 8px 0; font-size: 12px; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px;">🎯 Today's Target Payload</h4>
                <div style="font-size: 14px; line-height: 1.6; color: #e5e7eb;">
                  ${Object.entries(targetInfo).map(([key, val]) => `<strong>${key.replace('_', ' ').toUpperCase()}:</strong> ${val}`).join('<br>')}
                </div>
              </div>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 15px 40px 40px 40px;">
              <div style="font-size: 16px; line-height: 1.7; color: #d1d5db;">
                ${renderedContent}
              </div>

              <!-- CTA / PS Link -->
              <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top: 40px; border-top: 1px solid #1f2937; padding-top: 30px;">
                <tr>
                  <td align="center">
                    <p style="margin: 0 0 15px 0; font-size: 14px; color: #9ca3af;">Want to view live insights or adjust automation?</p>
                    <a href="${psLink}" target="_blank" style="display: inline-block; padding: 12px 28px; background: linear-gradient(135deg, #10b981, #059669); color: #ffffff; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 10px; box-shadow: 0 4px 6px -1px rgba(16, 185, 129, 0.25);">Visit Control Dashboard</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #0d121f; padding: 25px 40px; text-align: center; border-top: 1px solid #1f2937;">
              <p style="margin: 0; font-size: 12px; color: #6b7280; line-height: 1.5;">
                Antigravity Autonomous Master Engine · Built by Jack<br>
                This report is generated dynamically by Gemini 2.5 API on a 24h cron cycle.
              </p>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

// Helper to convert JSON results to beautiful HTML blocks
function renderJsonToHtml(data) {
  let html = '';
  for (const [key, val] of Object.entries(data)) {
    const title = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    if (Array.isArray(val)) {
      html += `<h3 style="color: #6366f1; margin: 25px 0 10px 0; font-size: 18px; font-weight: 600;">📋 ${title}</h3>`;
      html += `<ul style="margin: 0 0 20px 0; padding-left: 20px; color: #e5e7eb; font-size: 15px;">`;
      val.forEach(item => {
        if (typeof item === 'object') {
          html += `<li style="margin-bottom: 12px;">`;
          Object.entries(item).forEach(([k, v]) => {
            html += `<strong>${k.replace('_', ' ').toUpperCase()}:</strong> ${v}<br>`;
          });
          html += `</li>`;
        } else {
          html += `<li style="margin-bottom: 8px;">${item}</li>`;
        }
      });
      html += `</ul>`;
    } else if (typeof val === 'object' && val !== null) {
      html += `<h3 style="color: #6366f1; margin: 25px 0 10px 0; font-size: 18px; font-weight: 600;">🛠️ ${title}</h3>`;
      html += `<div style="background-color: #1f2937; padding: 15px; border-radius: 8px; font-size: 14px; color: #e5e7eb;">`;
      Object.entries(val).forEach(([k, v]) => {
        html += `<strong>${k.replace('_', ' ').toUpperCase()}:</strong> ${v}<br>`;
      });
      html += `</div>`;
    } else {
      html += `<h3 style="color: #6366f1; margin: 25px 0 10px 0; font-size: 18px; font-weight: 600;">💎 ${title}</h3>`;
      html += `<div style="background-color: #1f2937; padding: 15px; border-radius: 8px; font-size: 15px; line-height: 1.6; color: #e5e7eb; white-space: pre-wrap;">${val}</div>`;
    }
  }
  return html;
}

// =============================================================================
// BACKUP MANUAL ENDPOINTS (All 9 Niches)
// =============================================================================

// 1. Vintage Flipper (/api/vintage)
app.post('/api/vintage', wrapAsync(async (req, res) => {
  const { item_name, description, buyer_email } = req.body;
  if (!item_name || !buyer_email) {
    return res.status(400).json({ success: false, error: 'Missing item_name or buyer_email.' });
  }

  const systemInstruction = `
    Act as an expert vintage appraisal and marketplace listing copywriter.
    Return a JSON object with:
    1. "estimated_value_range": string, realistic vintage pricing.
    2. "ebay_optimized_title": string, keyword-rich title.
    3. "compelling_listing_description": string, detailed listing details.
    4. "key_keywords_tags": array of 5 tags.
  `;
  const prompt = `Item Name: ${item_name}\nDescription/Condition: ${description || 'unknown'}`;
  const data = await callGemini(prompt, systemInstruction, 'vintage');
  
  const renderedContent = renderJsonToHtml(data);
  const emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['vintage'], { item_name, description }, renderedContent);

  await sendHtmlEmail(buyer_email, `Daily Hustle Report - Vintage Flipper`, emailHtml);
  logTransaction(buyer_email, 'vintage', 'success', data);
  res.json({ success: true, data });
}));

// 2. KDP Optimizer (/api/kdp)
app.post('/api/kdp', wrapAsync(async (req, res) => {
  const { title, genre, targetAudience, buyer_email } = req.body;
  if (!title || !buyer_email) {
    return res.status(400).json({ success: false, error: 'Missing title or buyer_email.' });
  }

  const systemInstruction = `
    Act as a professional self-publishing KDP book launch strategist.
    Return a JSON object with:
    1. "optimized_title_subtitle": string.
    2. "category_recommendations": array of 3 categories.
    3. "amazon_description": string (SEO-rich HTML style).
    4. "seven_backend_keywords": array of 7 keywords.
  `;
  const prompt = `Book Title: ${title}\nGenre: ${genre || 'General'}\nTarget Audience: ${targetAudience || 'Any'}`;
  const data = await callGemini(prompt, systemInstruction, 'kdp');

  const renderedContent = renderJsonToHtml(data);
  const emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['kdp'], { title, genre, targetAudience }, renderedContent);

  await sendHtmlEmail(buyer_email, `Daily Hustle Report - KDP Books`, emailHtml);
  logTransaction(buyer_email, 'kdp', 'success', data);
  res.json({ success: true, data });
}));

// 3. Inventor Pitch (/api/inventor)
app.post('/api/inventor', wrapAsync(async (req, res) => {
  const { title, description, buyer_email } = req.body;
  if (!title || !buyer_email) {
    return res.status(400).json({ success: false, error: 'Missing title or buyer_email.' });
  }

  const systemInstruction = `
    Act as a high-converting technology scout and cold outreach copywriter.
    Return a JSON object with:
    1. "elevator_pitch": string.
    2. "cold_email_subject": string.
    3. "cold_email_body": string.
    4. "licensing_value_proposition": string.
  `;
  const prompt = `Invention: ${title}\nDescription: ${description || ''}`;
  const data = await callGemini(prompt, systemInstruction, 'inventor');

  const renderedContent = renderJsonToHtml(data);
  const emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['inventor'], { title, description }, renderedContent);

  await sendHtmlEmail(buyer_email, `Daily Hustle Report - Inventor Pitches`, emailHtml);
  logTransaction(buyer_email, 'inventor', 'success', data);
  res.json({ success: true, data });
}));

// 4. Voice Agent Prompt (/api/voice)
app.post('/api/voice', wrapAsync(async (req, res) => {
  const { businessType, location, mainOffer, buyer_email } = req.body;
  if (!businessType || !buyer_email) {
    return res.status(400).json({ success: false, error: 'Missing businessType or buyer_email.' });
  }

  const systemInstruction = `
    Act as a Vapi voice receptionist dialog engineer.
    Return a JSON object with:
    1. "custom_receptionist_prompt": string (800+ words detailed agent system instruction).
    2. "first_turn_greeting": string.
    3. "suggested_voice_profile": string.
  `;
  const prompt = `Business Type: ${businessType}\nLocation: ${location || 'Any'}\nOffer: ${mainOffer || 'Call dispatching'}`;
  const data = await callGemini(prompt, systemInstruction, 'voice');

  const renderedContent = renderJsonToHtml(data);
  const emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['voice'], { businessType, location, mainOffer }, renderedContent);

  await sendHtmlEmail(buyer_email, `Daily Hustle Report - Voice Prompts`, emailHtml);
  logTransaction(buyer_email, 'voice', 'success', data);
  res.json({ success: true, data });
}));

// 5. Google Review Reply (/api/review-reply)
app.post('/api/review-reply', wrapAsync(async (req, res) => {
  const { review_text, tone, buyer_email } = req.body;
  if (!review_text || !buyer_email) {
    return res.status(400).json({ success: false, error: 'Missing review_text or buyer_email.' });
  }

  const systemInstruction = `
    Act as an expert customer review responder.
    Return a JSON object with:
    1. "detected_sentiment": string (positive/negative/neutral).
    2. "custom_reply": string (polite, under 80 words response).
  `;
  const prompt = `Review Content: "${review_text}"\nTone requested: ${tone || 'professional'}`;
  const data = await callGemini(prompt, systemInstruction, 'review-reply');

  const renderedContent = renderJsonToHtml(data);
  const emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['review-reply'], { review_text, tone }, renderedContent);

  await sendHtmlEmail(buyer_email, `Daily Hustle Report - Review Replies`, emailHtml);
  logTransaction(buyer_email, 'review-reply', 'success', data);
  res.json({ success: true, data });
}));

// 6. GMB Local SEO (/api/local-seo)
app.post('/api/local-seo', wrapAsync(async (req, res) => {
  const { business_name, city, services, buyer_email } = req.body;
  if (!business_name || !city || !services || !buyer_email) {
    return res.status(400).json({ success: false, error: 'Missing required parameters.' });
  }

  const systemInstruction = `
    Act as a local SEO expert.
    Return a JSON object with:
    1. "optimized_about_section": string (max 750 chars).
    2. "top_5_local_keywords": array of 5 strings.
    3. "3_GMB_posts": array of 3 optimized GMB posts.
  `;
  const prompt = `Business: ${business_name}\nCity: ${city}\nServices: ${Array.isArray(services) ? services.join(', ') : services}`;
  const data = await callGemini(prompt, systemInstruction, 'local-seo');

  const renderedContent = renderJsonToHtml(data);
  const emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['local-seo'], { business_name, city, services }, renderedContent);

  await sendHtmlEmail(buyer_email, `Daily Hustle Report - Local SEO`, emailHtml);
  logTransaction(buyer_email, 'local-seo', 'success', data);
  res.json({ success: true, data });
}));

// 7. Marketplace Ad Writer (/api/marketplace)
app.post('/api/marketplace', wrapAsync(async (req, res) => {
  const { item_name, condition, key_features, buyer_email } = req.body;
  if (!item_name || !buyer_email) {
    return res.status(400).json({ success: false, error: 'Missing required parameters.' });
  }

  const systemInstruction = `
    Act as a classifieds copywriter.
    Return a JSON object with:
    1. "catchy_title": string.
    2. "high_converting_description": string.
    3. "FAQ_section": array of objects with "question" and "answer".
  `;
  const prompt = `Item: ${item_name}\nCondition: ${condition || ''}\nFeatures: ${key_features || ''}`;
  const data = await callGemini(prompt, systemInstruction, 'marketplace');

  const renderedContent = renderJsonToHtml(data);
  const emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['marketplace'], { item_name, condition, key_features }, renderedContent);

  await sendHtmlEmail(buyer_email, `Daily Hustle Report - Marketplace Ads`, emailHtml);
  logTransaction(buyer_email, 'marketplace', 'success', data);
  res.json({ success: true, data });
}));

// 8. Faceless Video Scripts (/api/faceless-video)
app.post('/api/faceless-video', wrapAsync(async (req, res) => {
  const { niche, buyer_email } = req.body;
  if (!niche || !buyer_email) {
    return res.status(400).json({ success: false, error: 'Missing niche or buyer_email.' });
  }

  const systemInstruction = `
    Act as a short-form content strategist.
    Return a JSON object with a "10_video_scripts" array. Each script must have:
    - "hook": string.
    - "visual_instructions": string.
    - "spoken_script": string.
    - "caption_with_hashtags": string.
  `;
  const prompt = `Niche: ${niche}`;
  const data = await callGemini(prompt, systemInstruction, 'faceless-video');

  const renderedContent = renderJsonToHtml(data);
  const emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['faceless-video'], { niche }, renderedContent);

  await sendHtmlEmail(buyer_email, `Daily Hustle Report - Faceless Videos`, emailHtml);
  logTransaction(buyer_email, 'faceless-video', 'success', data);
  res.json({ success: true, data });
}));

// 9. Contractor Proposal Polish (/api/contractor-proposal)
app.post('/api/contractor-proposal', wrapAsync(async (req, res) => {
  const { project_name, scope, buyer_email } = req.body;
  if (!project_name || !buyer_email) {
    return res.status(400).json({ success: false, error: 'Missing project_name or buyer_email.' });
  }

  const systemInstruction = `
    Act as an elite construction and field services project estimator.
    Return a JSON object with:
    1. "polished_title": string.
    2. "executive_summary": string.
    3. "detailed_bill_of_materials_milestones": array of strings.
    4. "professional_closing_pitch": string.
  `;
  const prompt = `Project Name: ${project_name}\nScope of Work: ${scope || ''}`;
  const data = await callGemini(prompt, systemInstruction, 'contractor-proposal');

  const renderedContent = renderJsonToHtml(data);
  const emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['contractor-proposal'], { project_name, scope }, renderedContent);

  await sendHtmlEmail(buyer_email, `Daily Hustle Report - Contract Proposals`, emailHtml);
  logTransaction(buyer_email, 'contractor-proposal', 'success', data);
  res.json({ success: true, data });
}));


// =============================================================================
// AUTOMATED CRON CLOCK CYCLE (Daily 8:00 AM)
// =============================================================================
async function triggerDailyNicheHustle() {
  console.log('[Cron Engine] Initiating Daily Niche Hustle Generation Cycle...');
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error('No ADMIN_EMAIL defined in environment variables. Daily cycle aborted.');
  }

  // Promise-wrapped db.get to find the last successful product_type
  const getLatestLog = () => {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT product_type FROM logs WHERE status = 'success' ORDER BY timestamp DESC LIMIT 1`,
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? row.product_type : null);
        }
      );
    });
  };

  const yesterdayNiche = await getLatestLog();
  let currentIndex = 0;

  if (yesterdayNiche) {
    const lastIdx = NICHES_ROTATION.indexOf(yesterdayNiche);
    if (lastIdx !== -1) {
      currentIndex = (lastIdx + 1) % NICHES_ROTATION.length;
    }
  }

  const activeNiche = NICHES_ROTATION[currentIndex];
  console.log(`[Cron Engine] Selected Niche for Today: ${activeNiche} (Yesterday was: ${yesterdayNiche || 'none'})`);

  const dictionaryList = NICHES_DICTIONARY[activeNiche];
  const randomTarget = dictionaryList[Math.floor(Math.random() * dictionaryList.length)];
  console.log(`[Cron Engine] Selected Target Example: ${JSON.stringify(randomTarget)}`);

  let systemInstruction = '';
  let prompt = '';
  const nicheDisplayName = NICHE_DISPLAY_NAMES[activeNiche];

  switch (activeNiche) {
    case 'vintage':
      systemInstruction = `Act as an expert vintage appraisal and marketplace listing copywriter. Return a JSON object with: "estimated_value_range": string, "ebay_optimized_title": string, "compelling_listing_description": string, "key_keywords_tags": array of 5 strings.`;
      prompt = `Appraise and draft copy for: ${randomTarget.name}\nDescription: ${randomTarget.description}`;
      break;
    case 'kdp':
      systemInstruction = `Act as a professional self-publishing KDP book launch strategist. Return a JSON object with: "optimized_title_subtitle": string, "category_recommendations": array of 3 strings, "amazon_description": string, "seven_backend_keywords": array of 7 strings.`;
      prompt = `Plan book launch for: ${randomTarget.title}\nGenre: ${randomTarget.genre}\nTarget Audience: ${randomTarget.targetAudience}`;
      break;
    case 'inventor':
      systemInstruction = `Act as a high-converting technology scout and cold outreach copywriter. Return a JSON object with: "elevator_pitch": string, "cold_email_subject": string, "cold_email_body": string, "licensing_value_proposition": string.`;
      prompt = `Create pitch kit for: ${randomTarget.title}\nDescription: ${randomTarget.description}`;
      break;
    case 'voice':
      systemInstruction = `Act as a Vapi voice receptionist dialog engineer. Return a JSON object with: "custom_receptionist_prompt": string (800+ words detailed agent system instruction), "first_turn_greeting": string, "suggested_voice_profile": string.`;
      prompt = `Draft receptionist prompt for: ${randomTarget.businessType} in ${randomTarget.location}\nOffer: ${randomTarget.mainOffer}`;
      break;
    case 'review-reply':
      systemInstruction = `Act as an expert customer review responder. Return a JSON object with: "detected_sentiment": string, "custom_reply": string.`;
      prompt = `Draft response to review: "${randomTarget.text}" by reviewer ${randomTarget.reviewer}`;
      break;
    case 'local-seo':
      systemInstruction = `Act as a local SEO expert. Return a JSON object with: "optimized_about_section": string (max 750 chars), "top_5_local_keywords": array of 5 strings, "3_GMB_posts": array of 3 strings.`;
      prompt = `Optimize business profile: ${randomTarget.business_name} in ${randomTarget.city}\nServices: ${randomTarget.services}`;
      break;
    case 'marketplace':
      systemInstruction = `Act as a classifieds copywriter. Return a JSON object with: "catchy_title": string, "high_converting_description": string, "FAQ_section": array of objects with "question" and "answer".`;
      prompt = `Draft listing for: ${randomTarget.item_name}\nCondition: ${randomTarget.condition}\nFeatures: ${randomTarget.key_features}`;
      break;
    case 'faceless-video':
      systemInstruction = `Act as a short-form content strategist. Return a JSON object with a "10_video_scripts" array containing hooks, visual_instructions, spoken_script, and caption_with_hashtags.`;
      prompt = `Draft 10 viral video scripts for the niche: ${randomTarget.niche}`;
      break;
    case 'contractor-proposal':
      systemInstruction = `Act as an elite construction and field services project estimator. Return a JSON object with: "polished_title": string, "executive_summary": string, "detailed_bill_of_materials_milestones": array of strings, "professional_closing_pitch": string.`;
      prompt = `Refine proposal for: ${randomTarget.project_name}\nScope: ${randomTarget.scope}`;
      break;
  }

  try {
    const data = await callGemini(prompt, systemInstruction, activeNiche);
    const renderedContent = renderJsonToHtml(data);
    const emailHtml = getPremiumEmailHtml(nicheDisplayName, randomTarget, renderedContent);

    await sendHtmlEmail(adminEmail, `Daily Hustle Report - ${nicheDisplayName}`, emailHtml);
    logTransaction(adminEmail, activeNiche, 'success', data);
    console.log(`[Cron Engine] Daily hustle report dispatched to ${adminEmail} for niche ${activeNiche}.`);
  } catch (cronErr) {
    logTransaction(adminEmail, activeNiche, 'failure', cronErr.message);
    throw cronErr; // rethrow to be caught by triggerDailyNicheHustleSafe
  }
}

// Safe cron executor that reports stack trace to admin on any failure
async function triggerDailyNicheHustleSafe() {
  try {
    await triggerDailyNicheHustle();
  } catch (err) {
    console.error('[Cron Engine Error] Failed execution:', err);
    await sendAdminAlert('Daily Niche Hustle Cron Job', err.stack || err.message);
  }
}

// Arm 8:00 AM Cron Clock
cron.schedule('0 8 * * *', triggerDailyNicheHustleSafe);
console.log('[Cron Engine] 8:00 AM Daily Niche Hustle Cron Armed.');

// Extra route to manually trigger the daily hustle loop for verification
app.post('/api/admin/trigger-daily', wrapAsync(async (req, res) => {
  await triggerDailyNicheHustle();
  res.json({ success: true, message: 'Daily Niche Hustle triggered manually.' });
}));

// Admin Route: View Logs
app.get('/api/admin/logs', (req, res) => {
  db.all('SELECT * FROM logs ORDER BY timestamp DESC', (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.status(200).json({ logs: rows });
  });
});

// =============================================================================
// STRIPE WEBHOOK — Purchase → Run Skill → Email Buyer
// =============================================================================

async function processNicheForBuyer(niche, fields, buyerEmail) {
  let systemInstruction, prompt, data, renderedContent, emailHtml;

  switch (niche) {
    case 'vintage': {
      const item_name = fields.itemname || '';
      const description = fields.itemdescription || '';
      systemInstruction = `Act as an expert vintage appraisal and marketplace listing copywriter. Return a JSON object with: 1. "estimated_value_range": string, realistic vintage pricing. 2. "ebay_optimized_title": string, keyword-rich title. 3. "compelling_listing_description": string, detailed listing copy. 4. "key_keywords_tags": array of 5 strings.`;
      prompt = `Item Name: ${item_name}\nDescription/Condition: ${description}`;
      data = await callGemini(prompt, systemInstruction, 'vintage');
      renderedContent = renderJsonToHtml(data);
      emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['vintage'], { item_name, description }, renderedContent);
      await sendHtmlEmail(buyerEmail, 'Your Vintage Flipper AI Report — Antigravity Engine', emailHtml);
      logTransaction(buyerEmail, 'vintage', 'success', data);
      break;
    }
    case 'kdp': {
      const title = fields.booktitle || '';
      const genre = fields.genre || '';
      const targetAudience = fields.targetaudience || '';
      systemInstruction = `Act as a professional self-publishing KDP book launch strategist. Return a JSON object with: 1. "optimized_title_subtitle": string. 2. "category_recommendations": array of 3 strings. 3. "amazon_description": string (SEO-rich HTML style). 4. "seven_backend_keywords": array of 7 strings.`;
      prompt = `Book Title: ${title}\nGenre: ${genre}\nTarget Audience: ${targetAudience}`;
      data = await callGemini(prompt, systemInstruction, 'kdp');
      renderedContent = renderJsonToHtml(data);
      emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['kdp'], { title, genre, targetAudience }, renderedContent);
      await sendHtmlEmail(buyerEmail, 'Your KDP Book Launch Kit — Antigravity Engine', emailHtml);
      logTransaction(buyerEmail, 'kdp', 'success', data);
      break;
    }
    case 'inventor': {
      const title = fields.inventionname || '';
      const description = fields.inventiondesc || '';
      systemInstruction = `Act as a high-converting technology scout and cold outreach copywriter. Return a JSON object with: 1. "elevator_pitch": string. 2. "cold_email_subject": string. 3. "cold_email_body": string. 4. "licensing_value_proposition": string.`;
      prompt = `Invention: ${title}\nDescription: ${description}`;
      data = await callGemini(prompt, systemInstruction, 'inventor');
      renderedContent = renderJsonToHtml(data);
      emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['inventor'], { title, description }, renderedContent);
      await sendHtmlEmail(buyerEmail, 'Your Inventor Pitch Kit — Antigravity Engine', emailHtml);
      logTransaction(buyerEmail, 'inventor', 'success', data);
      break;
    }
    case 'voice': {
      const businessType = fields.businesstype || '';
      const location = fields.location || '';
      const mainOffer = fields.mainoffer || '';
      systemInstruction = `Act as a Vapi voice receptionist dialog engineer. Return a JSON object with: 1. "custom_receptionist_prompt": string (800+ words detailed agent system instruction). 2. "first_turn_greeting": string. 3. "suggested_voice_profile": string.`;
      prompt = `Business Type: ${businessType}\nLocation: ${location}\nOffer: ${mainOffer}`;
      data = await callGemini(prompt, systemInstruction, 'voice');
      renderedContent = renderJsonToHtml(data);
      emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['voice'], { businessType, location, mainOffer }, renderedContent);
      await sendHtmlEmail(buyerEmail, 'Your AI Voice Receptionist Prompt — Antigravity Engine', emailHtml);
      logTransaction(buyerEmail, 'voice', 'success', data);
      break;
    }
    case 'review-reply': {
      const review_text = fields.reviewtext || '';
      const tone = fields.tone || 'professional';
      systemInstruction = `Act as an expert customer review responder. Return a JSON object with: 1. "detected_sentiment": string (positive/negative/neutral). 2. "custom_reply": string (polite, under 80 words).`;
      prompt = `Review Content: "${review_text}"\nTone requested: ${tone}`;
      data = await callGemini(prompt, systemInstruction, 'review-reply');
      renderedContent = renderJsonToHtml(data);
      emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['review-reply'], { review_text, tone }, renderedContent);
      await sendHtmlEmail(buyerEmail, 'Your Google Review Reply — Antigravity Engine', emailHtml);
      logTransaction(buyerEmail, 'review-reply', 'success', data);
      break;
    }
    case 'local-seo': {
      const business_name = fields.businessname || '';
      const city = fields.city || '';
      const services = fields.services || '';
      systemInstruction = `Act as a local SEO expert. Return a JSON object with: 1. "optimized_about_section": string (max 750 chars). 2. "top_5_local_keywords": array of 5 strings. 3. "3_GMB_posts": array of 3 optimized GMB posts.`;
      prompt = `Business: ${business_name}\nCity: ${city}\nServices: ${services}`;
      data = await callGemini(prompt, systemInstruction, 'local-seo');
      renderedContent = renderJsonToHtml(data);
      emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['local-seo'], { business_name, city, services }, renderedContent);
      await sendHtmlEmail(buyerEmail, 'Your Local SEO Profile Kit — Antigravity Engine', emailHtml);
      logTransaction(buyerEmail, 'local-seo', 'success', data);
      break;
    }
    case 'marketplace': {
      const item_name = fields.itemname || '';
      const condition = fields.condition || '';
      const key_features = fields.keyfeatures || '';
      systemInstruction = `Act as a classifieds copywriter. Return a JSON object with: 1. "catchy_title": string. 2. "high_converting_description": string. 3. "FAQ_section": array of objects with "question" and "answer".`;
      prompt = `Item: ${item_name}\nCondition: ${condition}\nFeatures: ${key_features}`;
      data = await callGemini(prompt, systemInstruction, 'marketplace');
      renderedContent = renderJsonToHtml(data);
      emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['marketplace'], { item_name, condition, key_features }, renderedContent);
      await sendHtmlEmail(buyerEmail, 'Your Marketplace Ad Copy — Antigravity Engine', emailHtml);
      logTransaction(buyerEmail, 'marketplace', 'success', data);
      break;
    }
    case 'faceless-video': {
      const niche = fields.contentniche || '';
      systemInstruction = `Act as a short-form content strategist. Return a JSON object with a "10_video_scripts" array. Each script must have: "hook": string, "visual_instructions": string, "spoken_script": string, "caption_with_hashtags": string.`;
      prompt = `Niche: ${niche}`;
      data = await callGemini(prompt, systemInstruction, 'faceless-video');
      renderedContent = renderJsonToHtml(data);
      emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['faceless-video'], { niche }, renderedContent);
      await sendHtmlEmail(buyerEmail, 'Your 10 Video Scripts — Antigravity Engine', emailHtml);
      logTransaction(buyerEmail, 'faceless-video', 'success', data);
      break;
    }
    case 'contractor-proposal': {
      const project_name = fields.projectname || '';
      const scope = fields.scopeofwork || '';
      systemInstruction = `Act as an elite construction and field services project estimator. Return a JSON object with: 1. "polished_title": string. 2. "executive_summary": string. 3. "detailed_bill_of_materials_milestones": array of strings. 4. "professional_closing_pitch": string.`;
      prompt = `Project Name: ${project_name}\nScope of Work: ${scope}`;
      data = await callGemini(prompt, systemInstruction, 'contractor-proposal');
      renderedContent = renderJsonToHtml(data);
      emailHtml = getPremiumEmailHtml(NICHE_DISPLAY_NAMES['contractor-proposal'], { project_name, scope }, renderedContent);
      await sendHtmlEmail(buyerEmail, 'Your Contractor Proposal — Antigravity Engine', emailHtml);
      logTransaction(buyerEmail, 'contractor-proposal', 'success', data);
      break;
    }
    default:
      throw new Error(`Unknown niche: ${niche}`);
  }
}

app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const buyerEmail = session.customer_details?.email;
    const niche = session.metadata?.niche;

    const fields = {};
    if (Array.isArray(session.custom_fields)) {
      session.custom_fields.forEach(f => {
        fields[f.key] = f.text?.value || '';
      });
    }

    console.log(`[Stripe Webhook] Purchase complete — niche: ${niche}, buyer: ${buyerEmail}`);

    if (!niche || !buyerEmail) {
      console.error('[Stripe Webhook] Missing niche or buyer email in session:', session.id);
      return res.json({ received: true });
    }

    processNicheForBuyer(niche, fields, buyerEmail).catch(async (err) => {
      console.error('[Stripe Webhook] Processing error:', err);
      await sendAdminAlert(`Stripe purchase processing failed — niche: ${niche}, buyer: ${buyerEmail}`, err.stack || err.message);
    });
  }

  res.json({ received: true });
});

// =============================================================================
// B2B SALES ENGINE — OpenPhone SMS, Lead Queue, Invention Outreach
// =============================================================================

// Low-level HTTPS POST helper (no extra dependencies)
function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Send SMS via OpenPhone API
async function sendSms(to, body) {
  const apiKey = process.env.OPENPHONE_API_KEY;
  const from = process.env.OPENPHONE_FROM_NUMBER;
  if (!apiKey) {
    console.warn('[SMS] OPENPHONE_API_KEY not configured — skipping SMS to', to);
    return;
  }
  const res = await httpsPost(
    'https://api.openphone.com/v1/messages',
    { content: body, from, to: [to] },
    { Authorization: apiKey }
  );
  if (![200, 201, 202].includes(res.status)) {
    throw new Error(`OpenPhone ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

// Send plain-text pitch email to a B2B lead via SMTP
async function sendPitchEmail(toEmail, subject, body) {
  await transporter.sendMail({
    from: `"${B2B_DEPLOYER_NAME || 'Antigravity Engine'}" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject,
    text: body,
  });
  console.log(`[Pitch Email] Sent → ${toEmail} | ${subject}`);
}

// Promise wrappers around SQLite callbacks
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function dbGetOne(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

// Lead queue DB helpers
async function queueLeads(leads) {
  let inserted = 0;
  for (const lead of leads) {
    const email = (lead.contact_email || '').trim().toLowerCase();
    if (!email) continue;
    const exists = await dbGetOne('SELECT 1 FROM leads_queue WHERE contact_email = ?', [email]);
    if (exists) continue;
    await dbRun(
      'INSERT INTO leads_queue (company_name, contact_email, website, industry, phone) VALUES (?, ?, ?, ?, ?)',
      [lead.company_name || '', email, lead.website || '', lead.industry || '', lead.phone || '']
    );
    inserted++;
  }
  return inserted;
}

async function fetchPendingLeads(limit) {
  return dbAll(
    "SELECT id, company_name, contact_email, website, industry, phone FROM leads_queue WHERE status = 'pending' ORDER BY id ASC LIMIT ?",
    [limit || B2B_BATCH_SIZE]
  );
}

async function markLead(id, status) {
  await dbRun('UPDATE leads_queue SET status=?, processed_at=CURRENT_TIMESTAMP WHERE id=?', [status, id]);
}

async function queueStats() {
  const rows = await dbAll('SELECT status, COUNT(*) as count FROM leads_queue GROUP BY status');
  const stats = { pending: 0, sent: 0, disqualified: 0, failed: 0 };
  for (const row of rows) stats[row.status] = (row.count || 0);
  return stats;
}

async function queueFollowUp(campaignId, companyName, contactEmail, step, subject, body, dueAt) {
  await dbRun(
    'INSERT INTO follow_ups (campaign_id, company_name, contact_email, step, subject, body, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [campaignId, companyName, contactEmail, step, subject, body, dueAt.toISOString()]
  );
}

async function fetchDueFollowUps(limit) {
  const now = new Date().toISOString();
  return dbAll(
    "SELECT id, campaign_id, company_name, contact_email, step, subject, body FROM follow_ups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?",
    [now, limit || 25]
  );
}

async function markFollowUp(id, status) {
  await dbRun('UPDATE follow_ups SET status=?, sent_at=CURRENT_TIMESTAMP WHERE id=?', [status, id]);
}

async function followUpStats() {
  const rows = await dbAll('SELECT status, COUNT(*) as count FROM follow_ups GROUP BY status');
  const stats = { pending: 0, sent: 0, failed: 0 };
  for (const row of rows) stats[row.status] = (row.count || 0);
  return stats;
}

// Normalize US phone number to E.164 (+1XXXXXXXXXX)
function toE164(phone) {
  if (!phone) return phone;
  if (phone.startsWith('+') && /^\+\d{11,}$/.test(phone)) return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return phone;
}

// Filter leads by target industry list
function qualifyLead(companyName, industry) {
  if (!industry) return { qualified: true, reason: 'industry not provided — passing through' };
  const ind = industry.trim().toLowerCase();
  for (const q of B2B_INDUSTRIES) {
    if (q.includes(ind) || ind.includes(q)) return { qualified: true, reason: `matched: ${q}` };
  }
  return { qualified: false, reason: `industry '${industry}' not in qualified list` };
}

// Generate AI cold pitch email copy for one company
async function generatePitchCopy(company, deployerName, deployerEmail, proofUrl, fee, offerName, offerSummary) {
  const ctaLinks = `proof link: ${proofUrl}${B2B_PAYMENT_LINK ? ' and payment/booking link: ' + B2B_PAYMENT_LINK : ''} and contact email ${deployerEmail}`;
  const systemInstruction = (
    'You are an elite B2B sales copywriter. Write a cold outreach email selling a white-label AI infrastructure license to a marketing/lead-gen agency owner who will resell it to their own local business clients. ' +
    'Return JSON only: {"subject":"string max 60 chars","body":"string max 220 words"}. ' +
    'Rules: 1. The body MUST name the target company. 2. Frame this as a REVENUE LINE for their agency, not a tech purchase. ' +
    '3. Lead with the math: resell to 3-5 clients at $500-$1,000/month each covers the license; everything after is pure margin. ' +
    '4. Present the offer as a complete 9-skill AI infrastructure backend (call catching, voice agent, lead sorting, web pages, email handling) they can resell tonight — no dev team, no build time. ' +
    '5. Include exactly 3 value bullets: (a) the resell math/break-even, (b) zero dev/maintenance burden, (c) sticky recurring revenue. ' +
    `6. End CTA: request a 15-min screen-share demo. Close with ${ctaLinks}. ` +
    '7. No buzzwords, no hype. Direct, peer-to-peer, confident tone.'
  );
  const prompt = `Deployer: ${deployerName}. Offer: ${offerName}. Summary: ${offerSummary}. Monthly fee: $${fee}. Target company: ${company}.`;
  const pitch = await callGemini(prompt, systemInstruction, 'pitch-email');
  if (!(pitch.body || '').toLowerCase().includes(company.toLowerCase())) {
    pitch.body = `I'm reaching out to ${company} specifically because ${pitch.body}`;
  }
  pitch.body = (pitch.body || '').replace('{{DEPLOYER_EMAIL}}', deployerEmail);
  return pitch;
}

// Generate Day 5 (step 2) or Day 10 (step 3) follow-up copy
async function generateFollowupCopy(step, company, deployerName, deployerEmail, proofUrl, fee, offerName, offerSummary) {
  const angles = {
    2: 'Social proof follow-up. Share a believable, concrete example of another agency reselling this to local business clients and hitting break-even fast. Slightly stronger CTA than first touch.',
    3: 'Final follow-up. Give them permission to walk away, note this is the last email, and add light urgency about being first in their market. Offer to stop future emails on reply.',
  };
  const ctaLinks = `proof link: ${proofUrl}${B2B_PAYMENT_LINK ? ' and payment/booking link: ' + B2B_PAYMENT_LINK : ''} and contact email ${deployerEmail}`;
  const systemInstruction = (
    `You are an elite B2B sales copywriter writing follow-up email #${step} in a 3-email cold outreach sequence — the prospect has not replied yet. ` +
    'Return JSON only: {"subject":"string max 60 chars","body":"string max 180 words"}. ' +
    `${angles[step]} ` +
    'The body MUST name the target company. Frame the offer as a white-label AI infrastructure license the agency resells to its own local business clients as a new revenue line. ' +
    `Close with ${ctaLinks}. No buzzwords, no hype. Direct, peer-to-peer tone.`
  );
  const prompt = `Deployer: ${deployerName}. Offer: ${offerName}. Summary: ${offerSummary}. Monthly fee: $${fee}. Target company: ${company}.`;
  const result = await callGemini(prompt, systemInstruction, 'followup-email');
  return { subject: result.subject, body: result.body };
}

// Run full invention outreach: AI pitch → email lead → queue Day-5 and Day-10 follow-ups
async function runInventionOutreach(payload) {
  const offerName     = payload.invention_name    || B2B_OFFER_NAME;
  let   offerSummary  = payload.invention_summary || B2B_OFFER_SUMMARY;
  const deployerName  = payload.inventor_name     || B2B_DEPLOYER_NAME;
  const deployerEmail = payload.inventor_email    || B2B_DEPLOYER_EMAIL;
  const targetCos     = (payload.target_companies || []).slice(0, 5);
  const campaignId    = payload.campaign_id       || 'unknown';
  const proofUrl      = payload.proof_url         || B2B_PROOF_URL;
  const fee           = payload.deployment_fee    || B2B_DEPLOYMENT_FEE;
  const contactEmail  = payload.contact_email     || '';

  if ((offerSummary || '').split(' ').length < 10) {
    offerSummary = (
      `${offerName} is a complete, production-ready 9-skill AI infrastructure backend (call catching, voice agent, ` +
      `web page creation, lead sorting, email handling, and more) that agencies white-label under their own brand and ` +
      `resell to local business clients. Agencies license it for a flat $${fee}/month and resell access to 3-5 clients ` +
      `at $500-$1,000/month each — break-even from month one, pure margin after. No dev team, no build time, no maintenance. Proof: ${proofUrl}`
    );
  }

  const companies = targetCos.length > 0 ? targetCos : ['a leading agency in this space'];
  const pitches = [];
  for (const company of companies) {
    const pitch = await generatePitchCopy(company, deployerName, deployerEmail, proofUrl, fee, offerName, offerSummary);
    pitch.company = company;
    pitches.push(pitch);
  }

  let emailSent = false;
  let emailError = '';
  if (contactEmail && pitches.length > 0) {
    try {
      await sendPitchEmail(contactEmail, pitches[0].subject, pitches[0].body);
      emailSent = true;
      const company = pitches[0].company;
      const now = new Date();
      for (const [step, days] of [[2, 5], [3, 10]]) {
        const { subject, body } = await generateFollowupCopy(step, company, deployerName, deployerEmail, proofUrl, fee, offerName, offerSummary);
        const dueAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
        await queueFollowUp(campaignId, company, contactEmail, step, subject, body, dueAt);
      }
      console.log(`[Invention Outreach] Pitch sent + follow-ups queued for ${contactEmail}`);
    } catch (err) {
      emailError = err.message;
      console.error('[Invention Outreach] Pitch email failed for', contactEmail, ':', err.message);
      await sendAdminAlert(`Pitch email FAILED — ${contactEmail}`, err.stack || err.message);
    }
  }

  return { campaign_id: campaignId, offer_name: offerName, deployer_name: deployerName, pitches, email_sent: emailSent, email_error: emailError };
}

// Run call catcher: classify missed call intent → send SMS text-back via OpenPhone
async function runCallCatcher(payload) {
  const rawPhone     = payload.caller_phone || payload.customer_phone || '';
  const callerPhone  = toE164(rawPhone);
  const transcript   = payload.voicemail_transcript || '';
  const businessName = payload.business_name || 'the team';

  if (!callerPhone || !callerPhone.startsWith('+')) {
    throw new Error(`ERR_PAYLOAD_INVALID: could not normalize '${rawPhone}' to E.164`);
  }

  let urgency = 'UNKNOWN';
  let primaryNeed = 'General Inquiry';
  try {
    const systemInstruction = 'Analyze the voicemail transcript and return JSON only: {"urgency":"HIGH|MEDIUM|LOW","primary_need":"string max 15 words","confidence":0.0}';
    const parsed = await callGemini(transcript || 'No voicemail left.', systemInstruction, 'call-classify');
    if (parseFloat(parsed.confidence || 0) >= 0.65) {
      urgency     = parsed.urgency      || 'UNKNOWN';
      primaryNeed = parsed.primary_need || 'General Inquiry';
    }
  } catch (err) {
    console.warn('[Call Catcher] LLM classification failed — using defaults:', err.message);
  }

  const smsBody = urgency === 'HIGH'
    ? `Hi! You called ${businessName}. We know this is urgent — someone calls you back within 15 min. Reply now if needed.`
    : `Hi! You called ${businessName}. We missed you but we're on it. We'll be in touch shortly — reply here if you need us now.`;

  await sendSms(callerPhone, smsBody.slice(0, 320));
  return { lead_id: callerPhone, urgency, primary_need: primaryNeed, sms_sent: true };
}

// Pull pending leads from SQLite and run invention outreach on each
async function processLeadQueue(batchSize) {
  const leads = await fetchPendingLeads(batchSize || B2B_BATCH_SIZE);
  if (!leads.length) {
    console.log('[Lead Queue] No pending leads.');
    return { processed: 0, sent: 0, disqualified: 0, failed: 0 };
  }
  let sent = 0, disq = 0, failed = 0;
  for (const lead of leads) {
    const { id, company_name, contact_email, industry } = lead;
    try {
      const { qualified, reason } = qualifyLead(company_name, industry || '');
      if (!qualified) {
        await markLead(id, 'disqualified');
        disq++;
        console.log(`[Lead Queue] Disqualified ${company_name}: ${reason}`);
        continue;
      }
      await runInventionOutreach({ ...lead, target_companies: [company_name], contact_email });
      await markLead(id, 'sent');
      sent++;
    } catch (err) {
      console.error(`[Lead Queue] Failed for ${contact_email}:`, err.message);
      await markLead(id, 'failed');
      failed++;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`[Lead Queue] Batch done — sent=${sent} disq=${disq} failed=${failed}`);
  return { processed: leads.length, sent, disqualified: disq, failed };
}

// =============================================================================
// B2B ENDPOINTS
// =============================================================================

// OpenPhone webhook — missed call → instant SMS text-back
app.post('/webhook/openphone', wrapAsync(async (req, res) => {
  const { type: eventType, data } = req.body;
  const obj = (data && data.object) ? data.object : (data || {});
  console.log(`[OpenPhone] event=${eventType}`);
  if (!['call.completed', 'call.missed', 'call.ringing'].includes(eventType)) {
    return res.json({ received: true, action: 'ignored', event: eventType });
  }
  const callerPhone = obj.from || obj.caller || '';
  const callStatus  = obj.status || '';
  const transcript  = (obj.transcription && typeof obj.transcription === 'object') ? (obj.transcription.text || '') : '';
  if (!['missed', 'no-answer', 'canceled', ''].includes(callStatus) && eventType !== 'call.missed') {
    return res.json({ received: true, action: 'ignored', reason: `call status '${callStatus}' not a missed call` });
  }
  if (!callerPhone) {
    return res.json({ received: true, action: 'skipped', reason: 'no caller_phone in payload' });
  }
  const result = await runCallCatcher({
    caller_phone: callerPhone,
    voicemail_transcript: transcript,
    business_name: B2B_DEPLOYER_NAME || 'the team',
  });
  res.json({ received: true, status: 'SUCCESS', result });
}));

// Direct lead intake — qualify and pitch immediately
app.post('/webhook/lead', wrapAsync(async (req, res) => {
  const body = req.body;
  if (!body.contact_email && body.email) body.contact_email = body.email;
  const missing = ['company_name', 'contact_email', 'website'].filter(f => !body[f]);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  const { qualified, reason } = qualifyLead(body.company_name, body.industry || '');
  if (!qualified) return res.json({ received: true, status: 'DISQUALIFIED', reason });
  const campaignId = body.campaign_id || `lead-${body.company_name.toLowerCase().replace(/\s+/g, '-')}`;
  const result = await runInventionOutreach({
    target_companies: [body.company_name],
    contact_email: body.contact_email,
    website: body.website,
    proof_url: B2B_PROOF_URL,
    deployment_fee: B2B_DEPLOYMENT_FEE,
    campaign_id: campaignId,
  });
  res.json({ received: true, status: 'SUCCESS', result });
}));

// Bulk import leads into the queue
app.post('/admin/leads', wrapAsync(async (req, res) => {
  const body = req.body;
  const leads = Array.isArray(body) ? body : (body.leads || []);
  if (!leads.length) return res.status(400).json({ error: 'Send a JSON array of leads or {"leads": [...]}' });
  const inserted = await queueLeads(leads);
  const stats = await queueStats();
  res.json({ imported: inserted, skipped: leads.length - inserted, queue: stats });
}));

// Immediately process the next batch of pending leads
app.post('/admin/run-now', wrapAsync(async (req, res) => {
  const size = parseInt((req.body && req.body.batch_size) || B2B_BATCH_SIZE);
  const result = await processLeadQueue(size);
  result.queue = await queueStats();
  res.json(result);
}));

// Lead queue + follow-up status dashboard
app.get('/admin/status', wrapAsync(async (req, res) => {
  const [queue, follow_ups] = await Promise.all([queueStats(), followUpStats()]);
  res.json({ queue, follow_ups, config: { batch_size: B2B_BATCH_SIZE, interval_hours: B2B_BATCH_HOURS } });
}));

// Global Express Error Handler Middleware to email stack trace on endpoint failure
app.use(async (err, req, res, next) => {
  console.error('[Global Error Handler] Caught exception:', err);
  const buyer_email = req.body ? req.body.buyer_email : null;
  const product_type = req.path.replace('/api/', '');

  logTransaction(buyer_email || 'unknown', product_type, 'failure', err.message);

  await sendAdminAlert(`Webhook endpoint failure on ${req.method} ${req.path}`, err.stack || err.message);

  if (!res.headersSent) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Background: process lead queue every BATCH_INTERVAL_HOURS hours
setInterval(async () => {
  console.log('[Lead Scheduler] Firing lead batch run');
  try {
    await processLeadQueue();
  } catch (err) {
    console.error('[Lead Scheduler] Error:', err.message);
    await sendAdminAlert('Lead Queue Batch Run Failed', err.stack || err.message);
  }
}, B2B_BATCH_HOURS * 60 * 60 * 1000);
console.log(`[Lead Scheduler] Armed — runs every ${B2B_BATCH_HOURS}h`);

// Background: send due follow-ups every hour
setInterval(async () => {
  try {
    const due = await fetchDueFollowUps();
    for (const fu of due) {
      try {
        await sendPitchEmail(fu.contact_email, fu.subject, fu.body);
        await markFollowUp(fu.id, 'sent');
        console.log(`[Follow-up Scheduler] Sent step ${fu.step} → ${fu.contact_email}`);
      } catch (err) {
        await markFollowUp(fu.id, 'failed');
        console.error(`[Follow-up Scheduler] Failed → ${fu.contact_email}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error('[Follow-up Scheduler] Error:', err.message);
  }
}, 60 * 60 * 1000);
console.log('[Follow-up Scheduler] Armed — checks every 1h');

// Start Server
app.listen(PORT, () => {
  console.log(`[Server] Antigravity Master Engine running on port ${PORT}`);
});
