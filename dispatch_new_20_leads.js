/**
 * dispatch_new_20_leads.js
 * Automated Outreach Dispatch for the 20 Newly Qualified Agency Leads in pipeline.db
 */

const tls = require('tls');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const { generateOutreachSequence } = require('./skills/skill4_outreach_copy');
const { transitionStage } = require('./skills/skill7_pipeline_manager');

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = 465;

if (!SMTP_USER || !SMTP_PASS) {
  throw new Error('Missing SMTP_USER/SMTP_PASS');
}

const STRIPE_BUYOUT = "YOUR_25000_STRIPE_LINK_HERE";
const STRIPE_RETAINER = "YOUR_2500_STRIPE_LINK_HERE";
const STRIPE_SETUP = "YOUR_997_STRIPE_LINK_HERE";

const db = new DatabaseSync(path.join(__dirname, 'pipeline.db'));

function sendEmailSmtp(toEmail, subject, bodyHtml) {
  return new Promise((resolve) => {
    const socket = tls.connect(SMTP_PORT, SMTP_HOST, { rejectUnauthorized: false }, () => {});
    socket.setEncoding('utf8');

    let step = 0;
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ success: false, error: 'SMTP Timeout' });
    }, 15000);

    socket.on('data', data => {
      if (data.startsWith('220') && step === 0) {
        step = 1;
        socket.write('EHLO localhost\r\n');
      } else if (step === 1 && data.includes('250')) {
        step = 2;
        socket.write('AUTH LOGIN\r\n');
      } else if (step === 2 && data.startsWith('334')) {
        step = 3;
        socket.write(Buffer.from(SMTP_USER).toString('base64') + '\r\n');
      } else if (step === 3 && data.startsWith('334')) {
        step = 4;
        socket.write(Buffer.from(SMTP_PASS).toString('base64') + '\r\n');
      } else if (step === 4 && data.startsWith('235')) {
        step = 5;
        socket.write(`MAIL FROM:<${SMTP_USER}>\r\n`);
      } else if (step === 5 && data.startsWith('250')) {
        step = 6;
        socket.write(`RCPT TO:<${toEmail}>\r\n`);
      } else if (step === 6 && data.startsWith('250')) {
        step = 7;
        socket.write('DATA\r\n');
      } else if (step === 7 && data.startsWith('354')) {
        step = 8;
        const msg = [
          `From: "Jack Bockholdt - Master Hustle Engine" <${SMTP_USER}>`,
          `To: <${toEmail}>`,
          `Reply-To: ${SMTP_USER}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/html; charset=utf-8',
          '',
          `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px;">`,
          bodyHtml.replace(/\n/g, '<br>'),
          `</div>`,
          '.'
        ].join('\r\n');
        socket.write(msg + '\r\n');
      } else if (step === 8 && data.startsWith('250')) {
        clearTimeout(timeout);
        socket.write('QUIT\r\n');
        socket.end();
        resolve({ success: true, response: data.trim() });
      } else if (data.startsWith('5') || data.startsWith('4')) {
        clearTimeout(timeout);
        socket.destroy();
        resolve({ success: false, error: data.trim() });
      }
    });

    socket.on('error', err => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    });
  });
}

async function dispatch20Leads() {
  console.log(`===================================================================`);
  console.log(`  DISPATCHING OUTREACH TO 20 NEWLY QUALIFIED AGENCY FOUNDERS      `);
  console.log(`===================================================================`);
  console.log(`Sender Account : ${SMTP_USER}`);
  console.log(`Stripe Buyout  : ${STRIPE_BUYOUT}`);
  console.log(`Stripe Retainer: ${STRIPE_RETAINER}`);
  console.log(`Stripe Setup   : ${STRIPE_SETUP}`);
  console.log(`===================================================================\n`);

  // Fetch the 20 newly discovered leads
  const newLeads = db.prepare(`
    SELECT id, name, title, company, domain, email, industry, stage, qualification_score, estimated_burn 
    FROM pipeline_leads 
    WHERE id LIKE 'LEAD-DISC-%'
    ORDER BY id ASC
  `).all();

  console.log(`Found ${newLeads.length} newly discovered leads in pipeline.db to dispatch.\n`);

  const results = [];

  for (let i = 0; i < newLeads.length; i++) {
    const lead = newLeads[i];
    const burn = lead.estimated_burn || 4000;

    // Generate sequence with updated direct Stripe links
    const outreach = generateOutreachSequence({
      lead: {
        name: lead.name,
        company: lead.company,
        industry: lead.industry,
        email: lead.email,
        monthlyBurn: burn
      },
      customStripeBuyout: STRIPE_BUYOUT,
      customStripeRetainer: STRIPE_RETAINER,
      customStripeSetup: STRIPE_SETUP
    });

    const step0 = outreach.sequence[0];
    console.log(`[${i + 1}/${newLeads.length}] Dispatching Step 0 to ${lead.name} (${lead.company} <${lead.email}>)...`);
    console.log(`     Subject: "${step0.subject}"`);

    const sendRes = await sendEmailSmtp(lead.email, step0.subject, step0.body);

    if (sendRes.success) {
      console.log(`     ✅ Sent via SMTP (Status: 250 OK)`);
      try {
        transitionStage(lead.id, 'contacted', `Step 0 Outreach Dispatched with Direct Stripe Links: "${step0.subject}"`);
      } catch (e) {}

      results.push({
        id: lead.id,
        name: lead.name,
        title: lead.title,
        company: lead.company,
        email: lead.email,
        burn: `$${burn.toLocaleString()}/mo`,
        savingsEst: `$${Math.round(burn * 0.65).toLocaleString()}/mo`,
        subject: step0.subject,
        status: 'DELIVERED (250 OK)',
        stage: 'contacted'
      });
    } else {
      console.log(`     ⚠️ Delivery Note: ${sendRes.error}`);
      results.push({
        id: lead.id,
        name: lead.name,
        title: lead.title,
        company: lead.company,
        email: lead.email,
        burn: `$${burn.toLocaleString()}/mo`,
        savingsEst: `$${Math.round(burn * 0.65).toLocaleString()}/mo`,
        subject: step0.subject,
        status: `FAILED (${sendRes.error})`,
        stage: lead.stage
      });
    }

    // Delay between sends
    await new Promise(r => setTimeout(r, 1100));
  }

  console.log(`\n===================================================================`);
  console.log(`                 DISPATCH CONFIRMATION TABLE                       `);
  console.log(`===================================================================`);
  console.table(results.map(r => ({
    Lead: `${r.name} (${r.company})`,
    Email: r.email,
    Burn: r.burn,
    Savings: r.savingsEst,
    Status: r.status,
    Stage: r.stage
  })));

  fs.writeFileSync('batch_20_dispatch_results.json', JSON.stringify(results, null, 2));
  console.log(`\nFull batch results saved to batch_20_dispatch_results.json`);
}

dispatch20Leads();
