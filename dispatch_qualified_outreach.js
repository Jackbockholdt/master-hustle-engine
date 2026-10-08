/**
 * dispatch_qualified_outreach.js
 * Automated Outreach Dispatch for Qualified Leads in pipeline.db via Production SMTP
 */

const tls = require('tls');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const { generateOutreachSequence } = require('./skills/skill4_outreach_copy');
const { transitionStage } = require('./skills/skill7_pipeline_manager');

const SMTP_USER = process.env.SMTP_USER || 'jbockholdt4@gmail.com';
const SMTP_PASS = process.env.SMTP_PASS || 'bgbrkujgpgbijsep';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = 465;

if (!SMTP_PASS) {
  console.error('❌ Missing SMTP_PASS in environment.');
  process.exit(1);
}

const db = new DatabaseSync(path.join(__dirname, 'pipeline.db'));

function sendEmailSmtp(toEmail, subject, bodyHtml, bodyText) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(SMTP_PORT, SMTP_HOST, { rejectUnauthorized: false }, () => {});
    socket.setEncoding('utf8');

    let step = 0;
    let serverResp = '';

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ success: false, error: 'SMTP Timeout' });
    }, 15000);

    socket.on('data', data => {
      serverResp += data;
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
        // In production outreach, send to target email (or admin copy)
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
          `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #222;">`,
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

async function runBatchDispatch() {
  console.log(`===================================================================`);
  console.log(`    AUTOMATED OUTREACH DISPATCH LOOP: QUALIFIED LEADS            `);
  console.log(`===================================================================`);
  console.log(`Sender Account : ${SMTP_USER}`);
  console.log(`SMTP Host      : ${SMTP_HOST}:${SMTP_PORT} (TLS)`);
  console.log(`Timestamp      : ${new Date().toISOString()}`);
  console.log(`===================================================================\n`);

  // Fetch unique qualified leads from pipeline.db
  const rawLeads = db.prepare(`
    SELECT id, name, company, email, industry, stage, estimated_burn 
    FROM pipeline_leads 
    WHERE email IS NOT NULL AND email != ''
    ORDER BY id ASC
  `).all();

  // Deduplicate by email
  const seenEmails = new Set();
  const leads = [];
  for (const l of rawLeads) {
    if (!seenEmails.has(l.email)) {
      seenEmails.add(l.email);
      leads.push(l);
    }
  }

  console.log(`Found ${leads.length} unique leads to process in batch dispatch.\n`);

  const dispatchResults = [];

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const burn = lead.estimated_burn || 3500;
    
    // Generate 3-step outreach sequence
    const outreach = generateOutreachSequence({
      lead: {
        name: lead.name,
        company: lead.company,
        industry: lead.industry || 'Digital Marketing & AI Services',
        email: lead.email,
        monthlyBurn: burn
      }
    });

    const step0 = outreach.sequence[0];
    console.log(`[${i + 1}/${leads.length}] Dispatching Step 0 to: ${lead.name} (${lead.company} <${lead.email}>)...`);
    console.log(`     Subject: "${step0.subject}"`);

    // Perform SMTP Dispatch
    const sendRes = await sendEmailSmtp(lead.email, step0.subject, step0.body, step0.body);

    if (sendRes.success) {
      console.log(`     ✅ Sent via SMTP (Status: 250 OK)`);
      
      // Update SQLite Stage & Audit Log
      try {
        transitionStage(lead.id, 'contacted', `Step 0 Outreach Dispatched via SMTP: "${step0.subject}"`);
      } catch (e) {}

      dispatchResults.push({
        id: lead.id,
        name: lead.name,
        company: lead.company,
        email: lead.email,
        monthlyBurn: `$${burn.toLocaleString()}/mo`,
        savingsEst: `$${Math.round(burn * 0.65).toLocaleString()}/mo`,
        subject: step0.subject,
        status: 'DELIVERED (250 OK)',
        stage: 'contacted'
      });
    } else {
      console.log(`     ⚠️ SMTP Delivery Note: ${sendRes.error}`);
      dispatchResults.push({
        id: lead.id,
        name: lead.name,
        company: lead.company,
        email: lead.email,
        monthlyBurn: `$${burn.toLocaleString()}/mo`,
        savingsEst: `$${Math.round(burn * 0.65).toLocaleString()}/mo`,
        subject: step0.subject,
        status: `FAILED (${sendRes.error})`,
        stage: lead.stage
      });
    }

    // Rate-limiting delay between SMTP connections
    await new Promise(r => setTimeout(r, 1200));
  }

  console.log(`\n===================================================================`);
  console.log(`                 DISPATCH CONFIRMATION SUMMARY                     `);
  console.log(`===================================================================`);
  console.table(dispatchResults.map(r => ({
    Lead: `${r.name} (${r.company})`,
    Email: r.email,
    Burn: r.monthlyBurn,
    Savings: r.savingsEst,
    Status: r.status,
    Stage: r.stage
  })));

  fs.writeFileSync('last_dispatch_summary.json', JSON.stringify(dispatchResults, null, 2));
  console.log(`\nFull dispatch report written to last_dispatch_summary.json`);
}

runBatchDispatch();
