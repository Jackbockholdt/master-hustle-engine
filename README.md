# Unified Autonomous Backend Engine

A production-ready, highly optimized backend engine that runs nine text-only micro-SaaS utilities under a single Node.js/Express environment. It stores execution logs locally in SQLite, integrates with Gemini 2.5 API for text generation with retry verification, and sends beautifully styled HTML emails directly to admin or buyers.

## Key Features

1. **Core System & Database**:
   - Initialized a local SQLite database (`transactions.sqlite`).
   - Created a `logs` table to track execution logs (`id`, `timestamp`, `product_type`, `asset_generated`, and `status`).
   - Single global error-handling wrapper that catches any route or cron failure, sending the full stack trace to the `ADMIN_EMAIL`.

2. **Daily Rotation Engine (Autopilot)**:
   - Configured with `node-cron` to execute daily at **8:00 AM server time**.
   - Rotates through the 9 micro-SaaS niches, checking the database for the last executed niche and choosing the next one in sequence.
   - Selects a random target example from a pool of 5 realistic target payloads per niche.
   - Passes the payload to Gemini and sends the "Daily Hustle Report" directly to the `ADMIN_EMAIL`.

3. **Gemini & Nodemailer Wrappers**:
   - Forces `responseMimeType: 'application/json'` on all API calls.
   - Validates JSON keys strictly according to niche requirements, retrying once if keys are missing or output is malformed.
   - Compiles output into a gorgeous HSL-styled premium dark mode HTML email template titled `Daily Hustle Report - [Niche Name]`.

4. **Active Webhook Endpoints**:
   - Offers backup POST endpoints for all 9 niches (e.g. `/api/vintage`, `/api/voice`, `/api/local-seo`, etc.).
   - Accepts standard JSON payloads, processes assets, logs to SQLite, and mails the generated copy directly to the `buyer_email`.

---

## Enabled Micro-SaaS Niches & Endpoints

1. **Vintage Flipper (`/api/vintage`)**
2. **KDP Books (`/api/kdp`)**
3. **Inventor Pitches (`/api/inventor`)**
4. **Voice Prompts (`/api/voice`)**
5. **Review Replies (`/api/review-reply`)**
6. **Local SEO (`/api/local-seo`)**
7. **Marketplace Ads (`/api/marketplace`)**
8. **Faceless Videos (`/api/faceless-video`)**
9. **Contract Proposals (`/api/contractor-proposal`)**

---

## Local Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Create a `.env` file in the root directory:
```env
PORT=3000
GEMINI_API_KEY=your_google_gemini_key

# SMTP Credentials
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password_here

# Admin Email Alert Receiver
ADMIN_EMAIL=jackbockholdt88@gmail.com

# Marketing link at bottom of emails
PS_LINK=https://jacksplugreviews.com
```

### 3. Start Development Server
```bash
npm run dev
```

---

## Render.com Deployment Steps

1. Create a new Web Service on [Render.com](https://render.com).
2. Connect your Git Repository.
3. Select **Node** runtime.
4. Set Build Command:
   ```bash
   npm install
   ```
5. Set Start Command:
   ```bash
   npm start
   ```
6. Add the environment variables from your `.env` in the "Environment" settings tab.
7. Since sqlite is a local file, note that Render's free tier has an ephemeral disk. For persistent SQLite database storage on Render, attach a persistent Disk volume mount at `/opt/render/project/src` or configure your DB path to write to a persistent directory.
