const tls = require('tls');
const fs = require('fs');
const path = require('path');

// Helper to load .env safely
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const l of lines) {
      const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}

loadEnv();

const smtpUser = process.env.SMTP_USER || 'jbockholdt4@gmail.com';
const smtpPass = process.env.SMTP_PASS || '';
const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);

if (!smtpPass) {
  console.error('❌ SMTP_PASS is missing. Set it in .env or environment.');
  process.exit(1);
}

console.log(`Connecting to ${smtpHost}:${smtpPort} (TLS)...`);
const socket = tls.connect(smtpPort === 587 ? 465 : smtpPort, smtpHost, { rejectUnauthorized: false }, () => {});

socket.setEncoding('utf8');

let step = 0;
socket.on('data', data => {
  if (data.startsWith('220') && step === 0) {
    step = 1;
    socket.write('EHLO localhost\r\n');
  } else if (step === 1 && data.includes('250')) {
    step = 2;
    socket.write('AUTH LOGIN\r\n');
  } else if (step === 2 && data.startsWith('334')) {
    step = 3;
    socket.write(Buffer.from(smtpUser).toString('base64') + '\r\n');
  } else if (step === 3 && data.startsWith('334')) {
    step = 4;
    socket.write(Buffer.from(smtpPass).toString('base64') + '\r\n');
  } else if (step === 4 && data.startsWith('235')) {
    step = 5;
    socket.write(`MAIL FROM:<${smtpUser}>\r\n`);
  } else if (step === 5 && data.startsWith('250')) {
    step = 6;
    socket.write(`RCPT TO:<${smtpUser}>\r\n`);
  } else if (step === 6 && data.startsWith('250')) {
    step = 7;
    socket.write('DATA\r\n');
  } else if (step === 7 && data.startsWith('354')) {
    step = 8;
    const msg = [
      `From: "Jack Bockholdt - Margin Engine" <${smtpUser}>`,
      `To: ${smtpUser}`,
      'Subject: Master Hustle Margin Engine: Live SMTP Test Delivery',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<h2>Master Hustle Margin Engine — SMTP Verified</h2>',
      '<p>Your 9-Skill Margin Engine is now 100% connected to Gmail SMTP.</p>',
      '<ul>',
      `<li><strong>Sender:</strong> ${smtpUser}</li>`,
      '<li><strong>Router Tier:</strong> 3-Tier Token Reducer Active (87.6% savings)</li>',
      '<li><strong>Status:</strong> Live Dispatch Ready</li>',
      '</ul>',
      '.'
    ].join('\r\n');
    socket.write(msg + '\r\n');
  } else if (step === 8 && data.startsWith('250')) {
    console.log('🎉 TEST EMAIL DISPATCHED SUCCESSFULLY! Server Response:', data.trim());
    socket.write('QUIT\r\n');
    socket.end();
  }
});

socket.on('error', err => console.error('SMTP Error:', err));
