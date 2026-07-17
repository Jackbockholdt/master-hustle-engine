# 🚀 Antigravity Master Hustle Engine

**A Production-Ready, 9-in-1 AI-Powered Micro-SaaS Backend**

Run nine high-value content generation utilities on a single Node.js/Express server. Generate daily reports via cron automation, log everything to SQLite, and send beautiful HTML emails.

---

## 💎 What's Inside?

### 9 Micro-SaaS Skills (All Active)

1. **Vintage Flipper** — Appraise vintage items, generate eBay listings
2. **KDP Books** — Optimize book launches, categories, keywords
3. **Inventor Pitches** — Write cold emails & elevator pitches for patents
4. **Voice Prompts** — AI receptionist system instructions for Vapi
5. **Review Replies** — Detect sentiment & craft smart customer responses
6. **Local SEO** — GMB optimization, keywords, posts
7. **Marketplace Ads** — Classifieds copy & FAQs
8. **Faceless Videos** — Generate 10 viral short-form video scripts
9. **Contract Proposals** — Polish construction project proposals

### Core Features

✅ **9 POST webhook endpoints** — Test each skill manually
✅ **Daily 8:00 AM cron automation** — Rotates through niches, auto-emails reports
✅ **SQLite transaction logging** — Track all executions with timestamps
✅ **Gemini 2.5 API integration** — With retry fallback & JSON validation
✅ **Premium HTML email templates** — Dark mode, responsive, gorgeous
✅ **Global error handling** — Failed jobs alert admin with full stack trace
✅ **One-click Render deployment** — Deploy in < 2 minutes

---

## 🏃 Quick Start (Local)

### 1. Clone & Install

```bash
git clone <this-repo>
cd antigravity-hustle-engine
npm install
```

### 2. Setup Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Then edit `.env`:

```env
PORT=3000
GEMINI_API_KEY=your_key_here
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_gmail_app_password
ADMIN_EMAIL=your_email@gmail.com
PS_LINK=https://your-domain.com
```

**Important:** For Gmail, use an [App Password](https://myaccount.google.com/apppasswords), not your regular password.

### 3. Start Server

```bash
npm run dev
```

Visit: `http://localhost:3000/`

You should see JSON with all 9 skills listed.

---

## 🚀 Deploy to Render (One Click)

1. Push this repo to GitHub
2. Go to [Render.com](https://render.com)
3. Click: **New** → **Web Service**
4. Connect your GitHub repo
5. Select **Node** runtime
6. Build: `npm install` | Start: `node server.js`
7. Add environment variables from `.env.example`
8. Click **Create Web Service**

Your API is live at: `https://your-service-name.onrender.com/`

---

## 📡 Testing the Skills

### Test Vintage Flipper

```bash
curl -X POST https://your-domain.onrender.com/api/vintage \
  -H "Content-Type: application/json" \
  -d '{
    "item_name": "Vintage Polaroid SX-70 Camera",
    "description": "1970s camera, untested, minor leather wear",
    "buyer_email": "test@example.com"
  }'
```

You should get back:
```json
{
  "success": true,
  "data": {
    "estimated_value_range": "$120-$250",
    "ebay_optimized_title": "Vintage Polaroid SX-70 Instant Camera 1970s...",
    "compelling_listing_description": "...",
    "key_keywords_tags": ["polaroid", "vintage", "camera", ...]
  }
}
```

And an email will be sent to `test@example.com` with a beautiful report.

### Test All Other Skills

Same pattern. POST to `/api/{niche}` with `buyer_email` required.

---

## 🔄 Cron Automation (Daily 8:00 AM)

The server automatically runs every day at 8:00 AM UTC:

1. Queries SQLite to find the last executed niche
2. Rotates to the next niche in sequence
3. Picks a random target from the niche dictionary
4. Calls Gemini API to generate content
5. Emails the "Daily Hustle Report" to `ADMIN_EMAIL`

**Manually trigger:**

```bash
curl -X POST https://your-domain.onrender.com/api/admin/trigger-daily
```

**View logs:**

```bash
curl https://your-domain.onrender.com/api/admin/logs
```

---

## 🗂️ Project Structure

```
.
├── server.js              # Main Express app + cron scheduler
├── package.json           # Dependencies
├── .env.example          # Template for environment variables
├── render.yaml           # Render blueprint for one-click deploy
└── README.md             # This file
```

---

## 📧 Email Configuration

The engine sends emails via SMTP (Gmail recommended).

**To enable Gmail SMTP:**

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Select **Mail** and **Windows Computer** (or your device)
3. Copy the 16-character app password
4. Paste into `SMTP_PASS` in `.env`

**Alternative SMTP providers:**
- SendGrid
- Mailgun
- AWS SES
- Any SMTP service

Just update `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`.

---

## 🔐 Environment Variables

| Key | Required | Description |
|-----|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `GEMINI_API_KEY` | **Yes** | Google Gemini API key |
| `SMTP_HOST` | Yes | SMTP server (e.g., smtp.gmail.com) |
| `SMTP_PORT` | Yes | SMTP port (usually 587) |
| `SMTP_USER` | Yes | SMTP username (usually your email) |
| `SMTP_PASS` | Yes | SMTP password (Gmail App Password) |
| `ADMIN_EMAIL` | Yes | Email to receive daily reports |
| `PS_LINK` | No | Link at bottom of emails (marketing) |

---

## 🛠️ API Endpoints

### Webhooks (All 9 Niches)

```
POST /api/vintage
POST /api/kdp
POST /api/inventor
POST /api/voice
POST /api/review-reply
POST /api/local-seo
POST /api/marketplace
POST /api/faceless-video
POST /api/contractor-proposal
```

Each accepts JSON with required parameters (see examples above).

### Admin Routes

```
GET  /api/admin/logs              # View all transaction logs
POST /api/admin/trigger-daily     # Manually trigger daily cron
```

### Root Route

```
GET  /                            # API documentation & status
```

---

## 📊 Database (SQLite)

Transactions are logged to `transactions.sqlite` in the root directory.

**Schema:**

```sql
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_type TEXT,
  asset_generated TEXT,
  status TEXT,
  buyer_email TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 🐛 Error Handling

If any endpoint or cron job fails:

1. Error is caught and logged to SQLite
2. Full stack trace is emailed to `ADMIN_EMAIL`
3. Response returns `{ success: false, error: "message" }`

You'll never miss a failure.

---

## 🎯 How to Sell This

### As a Template

Price: $99–$299
- Include all 9 skills
- One-click Render deployment
- Full documentation
- Email support for 30 days

### As a Service

Price: $29–$99/month per customer
- Host on your Render account
- Resell access to the 9 skills
- Each customer gets their own API key
- You handle support & updates

### As a White-Label Solution

Price: $199–$499/month
- Customer deploys to their own Render account
- Fully branded to their business
- They control billing
- You provide setup & support

---

## 📝 Customization Ideas

- Add more niches to `NICHES_DICTIONARY`
- Change cron timing (e.g., 2 PM instead of 8 AM)
- Swap Gemini for Claude/GPT-4
- Add database persistence (PostgreSQL instead of SQLite)
- Build a React dashboard UI
- Add webhook signatures for security
- Integrate with Stripe for payments

---

## ⚠️ Known Limitations (Render Free Tier)

- **Ephemeral disk**: SQLite database is wiped on redeploy
- **Fix**: Use Render's **Starter plan** ($7/month) with persistent disk, OR switch to PostgreSQL

---

## 🤝 Support & Updates

Built by Jack. Questions or improvements? Reach out.

---

## 📄 License

MIT — Use, modify, and resell freely.

---

**Ready to automate 9 income streams? Deploy now.** 🚀
