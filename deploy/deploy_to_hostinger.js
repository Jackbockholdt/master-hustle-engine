/**
 * deploy/deploy_to_hostinger.js
 * Automated deployment script for Hostinger (via SSH / SFTP / Git)
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const configPath = path.join(__dirname, 'hostinger_config.json');
let hostingerConfig = {};
if (fs.existsSync(configPath)) {
  hostingerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

console.log(`
===================================================================
             HOSTINGER DEPLOYMENT ORCHESTRATOR
===================================================================
Target Hostinger IP : ${hostingerConfig.domains?.[0]?.records?.[0]?.value || '212.1.208.188'}
Configured Domains  :
  1. https://${hostingerConfig.domains?.[0]?.domain || 'jacksplugreviews.com'}
  2. https://${hostingerConfig.domains?.[1]?.domain || 'misscallproject.com'}

Environment Variables Configured:
  - NODE_ENV:             ${process.env.NODE_ENV}
  - PORT:                 ${process.env.PORT}
  - SMTP_USER:            ${process.env.SMTP_USER}
  - ADMIN_EMAIL:          ${process.env.ADMIN_EMAIL}
  - GEMINI_MODEL:         ${process.env.GEMINI_MODEL}
  - GEMINI_FLAGSHIP:      ${process.env.GEMINI_FLAGSHIP_MODEL}
  - GEMINI_API_KEY:       ${process.env.GEMINI_API_KEY ? 'Present (AQ.Ab8RN...)' : 'Missing'}
===================================================================
`);

console.log(`
DEPLOYMENT MODES FOR HOSTINGER:

1. Hostinger VPS (SSH & PM2 Automated Process):
   Run in your VPS terminal or via SSH:
   ----------------------------------------------------------------
   git clone https://github.com/Jackbockholdt/margin-engine-core.git /var/www/master-hustle-engine
   cd /var/www/master-hustle-engine
   npm install
   pm2 start server.js --name "master-hustle-engine" --env production
   pm2 save
   pm2 startup
   ----------------------------------------------------------------

2. Hostinger hPanel (Git / Node.js Deployment):
   - In hPanel -> Advanced -> Git:
     Repository: https://github.com/Jackbockholdt/margin-engine-core.git
     Branch: main
   - In hPanel -> Advanced -> Node.js:
     App Root: /public_html (or subfolder)
     Application Startup File: server.js
     Node Version: 18.x or 20.x
     Click "Start App"
`);
