'use strict';

const tls = require('tls');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

/**
 * Dispatches an email via Gmail SMTP (TLS port 465) using configured credentials.
 * @param {object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.subject - Email subject line
 * @param {string} params.bodyText - Plain text body
 * @param {string} [params.bodyHtml] - Optional HTML body
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
function sendSmtpEmail({ to, subject, bodyText, bodyHtml = null }) {
  return new Promise((resolve, reject) => {
    const smtpUser = process.env.SMTP_USER || 'jbockholdt4@gmail.com';
    const smtpPass = process.env.SMTP_PASS;
    const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
    const smtpPort = 465;

    if (!smtpPass) {
      return reject(new Error('SMTP_PASS is not configured in .env'));
    }
    if (!to) {
      return reject(new Error('Recipient email "to" is required'));
    }

    const socket = tls.connect(smtpPort, smtpHost, { rejectUnauthorized: false }, () => {});
    socket.setEncoding('utf8');

    let step = 0;
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        socket.destroy();
        reject(new Error('SMTP connection timed out after 20s'));
      }
    }, 20000);

    socket.on('data', data => {
      if (finished) return;

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
      } else if (step === 4) {
        if (data.startsWith('235')) {
          step = 5;
          socket.write(`MAIL FROM:<${smtpUser}>\r\n`);
        } else {
          finished = true;
          clearTimeout(timeout);
          socket.write('QUIT\r\n');
          socket.end();
          return reject(new Error(`SMTP Authentication failed: ${data.trim()}`));
        }
      } else if (step === 5 && data.startsWith('250')) {
        step = 6;
        socket.write(`RCPT TO:<${to}>\r\n`);
      } else if (step === 6 && data.startsWith('250')) {
        step = 7;
        socket.write('DATA\r\n');
      } else if (step === 7 && data.startsWith('354')) {
        step = 8;
        const formattedHtml = bodyHtml || bodyText.replace(/\n/g, '<br>');
        const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2)}@gmail.com>`;
        const msg = [
          `From: "Jack Bockholdt | Antigravity AI" <${smtpUser}>`,
          `To: ${to}`,
          `Subject: ${subject}`,
          `Message-ID: ${messageId}`,
          'MIME-Version: 1.0',
          'Content-Type: text/html; charset=utf-8',
          '',
          formattedHtml,
          '.'
        ].join('\r\n');
        socket.write(msg + '\r\n');
      } else if (step === 8 && data.startsWith('250')) {
        finished = true;
        clearTimeout(timeout);
        socket.write('QUIT\r\n');
        socket.end();
        resolve({
          success: true,
          recipient: to,
          serverReceipt: data.trim()
        });
      }
    });

    socket.on('error', err => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}

module.exports = { sendSmtpEmail };
