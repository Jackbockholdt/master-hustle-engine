# 🚀 Autopilot Niche Engine Starter Kit
## The 9-in-1 Micro-SaaS AI Boilerplate

Stop spending weeks writing backend boilerplate. The **Autopilot Niche Engine** is a production-ready, highly optimized Node.js, Express, node-cron, and SQLite backend engine designed to run **nine text-processing micro-SaaS utilities** on a single server.

It is fully structured to deploy to Render.com in **one click** and includes local database transaction logging, Gemini 2.5 API integration with retry fail-safes, and beautiful custom SMTP email outputs.

---

## 💎 What's Included Out of the Box?

### 1. Nine High-Value Micro-SaaS Webhook Endpoints
Each endpoint accepts standard JSON payloads, calls Gemini, logs transactions locally to SQLite, and emails the results directly to the buyer's inbox:
* **Vintage Flipper (`/api/vintage`)**: Generates vintage appraisal values, eBay optimized titles, keyword tags, and item descriptions.
* **KDP Books (`/api/kdp`)**: Recommends categories, optimized book titles/subtitles, and SEO-friendly HTML Amazon book descriptions.
* **Inventor Pitches (`/api/inventor`)**: Writes elevator pitches, cold email subject lines, body copy, and licensing value propositions.
* **Voice Prompts (`/api/voice`)**: Drafts extensive 800+ word system receptionist instructions for voice platforms like Vapi.co.
* **Review Replies (`/api/review-reply`)**: Detects customer sentiment (positive/negative/neutral) and crafts polite under-80-word responses.
* **Local SEO (`/api/local-seo`)**: Optimizes GMB business profiles with keyword-rich bios, target terms, and promotional posts.
* **Marketplace Ads (`/api/marketplace`)**: Writes high-converting classified listing copy and anti-lowballer FAQs.
* **Faceless Videos (`/api/faceless-video`)**: Generates vaults of 10 short-form video scripts (hooks, visual directions, spoken narration, and caption copies).
* **Contract Proposals (`/api/contractor-proposal`)**: Polishes raw scopes of work into professional construction project proposals.

---

## 2. Autonomous Cron Rotation Engine (Autopilot)
* Fires automatically every day at **8:00 AM server time** using `node-cron`.
* Queries the SQLite database to see what niche ran yesterday.
* Advances to the next niche in the rotation.
* Selects a random target example from an internal dictionary of **45 realistic test cases** (5 per niche).
* Generates premium assets via Gemini and emails a clean, responsive HTML "Daily Hustle Report - [Niche Name]" directly to the admin on autopilot.

---

## 3. Core Developer Features
* **SQL Logging Database**: Stores transaction metrics in `transactions.sqlite` within a structured `logs` table.
* **Global Error Notification**: If a cron job or webhook endpoint fails, the system immediately catches the error and emails a full stack trace to the `ADMIN_EMAIL` using Nodemailer.
* **Gemini retry wrapper**: Automatically detects malformed responses or missing keys and retries the generation once.
* **Render Blueprint (`render.yaml`)**: One-click deployment file to configure all environment variables and database paths automatically.

---

## 4. 🔀 Standalone AI Failover Router ($2,000–$5,000)
* **Enterprise-grade multi-model failover**: Automatically routes failed API calls through Gemini → OpenAI → Claude to guarantee 100% uptime.
* **Real-time health monitoring dashboard**: Live status page showing model availability, response times, and failover events.
* **Intelligent retry logic**: Exponential backoff with automatic model switching — zero manual intervention required.
* **Webhook catch-all**: Intercepts failed webhook deliveries and re-routes them through healthy models before the client ever notices.
* **Sold standalone** or bundled with the Master Hustle Engine for maximum value.

---

## 🛠️ How to Deploy in 1-Click (Render.com)

1. Upload the files to your GitHub repository.
2. Click the link below (replace with your repository link):
   `https://render.com/deploy?repo=https://github.com/Jackbockholdt/master-hustle-engine`
3. Enter your environmental keys (`GEMINI_API_KEY`, `SMTP_USER`, `SMTP_PASS`, `ADMIN_EMAIL`).
4. Click **Create Web Service**. You are live!

---

## 💼 How to Monetize This Template

* **As a Boilerplate Product**: Sell access to this private repository on Gumroad or Lemon Squeezy to developers wanting to speed up their SaaS builds.
* **No-Code Backend Service**: Offer this API backend to no-coders connecting Framer, Webflow, or bubble.io forms to Make.com/Zapier.
* **White-Label Agency Tool**: Deploy the engine for agencies looking to provide automated daily reports or SEO tools for their clients.
