# ⚡ Quick Start — 5 Minutes to Live

Follow these steps to get your Antigravity Master Hustle Engine running.

---

## Step 1: Get Your API Keys (2 min)

### Google Gemini API Key
1. Go to: https://aistudio.google.com/app/apikeys
2. Click **"Create API Key"**
3. Copy the key (looks like: `AIzaSy...`)

### Gmail App Password
1. Go to: https://myaccount.google.com/apppasswords
2. Select **Mail** and your device
3. Google gives you a 16-char password
4. Copy it (looks like: `abcd efgh ijkl mnop`)

---

## Step 2: Deploy on Render (2 min)

1. Push this repo to GitHub (or fork it)
2. Go to: https://render.com/deploy
3. Paste your GitHub repo URL
4. Click **"Connect"**
5. Fill in these environment variables:
   - `GEMINI_API_KEY` ← from Step 1
   - `SMTP_USER` ← your Gmail address
   - `SMTP_PASS` ← from Step 1
   - `ADMIN_EMAIL` ← where you want daily reports
6. Click **"Create Web Service"**

**Done!** Your API is live in 30 seconds.

---

## Step 3: Test It Works (1 min)

Replace `YOUR_EMAIL` and visit in your browser or curl:

```bash
curl -X POST https://YOUR_SERVICE.onrender.com/api/vintage \
  -H "Content-Type: application/json" \
  -d '{
    "item_name": "Vintage Camera",
    "description": "1970s Polaroid",
    "buyer_email": "YOUR_EMAIL@gmail.com"
  }'
```

Check your email — you should see a beautiful "Daily Hustle Report" in your inbox.

---

## What Happens Next

✅ **Every day at 8:00 AM UTC**, the server automatically:
1. Picks the next niche (Vintage → KDP → Inventor → etc.)
2. Generates premium content via Gemini
3. Emails you a formatted report

✅ **You can also trigger manually** anytime:
```bash
curl -X POST https://YOUR_SERVICE.onrender.com/api/admin/trigger-daily
```

✅ **View all transaction logs**:
```bash
curl https://YOUR_SERVICE.onrender.com/api/admin/logs
```

---

## All 9 Skills (Ready to Use)

Test any of these by POSTing to the endpoints below:

```
POST /api/vintage              # Vintage item appraisals
POST /api/kdp                  # Book launch optimization
POST /api/inventor             # Inventor cold emails
POST /api/voice                # AI receptionist prompts
POST /api/review-reply         # Customer review responses
POST /api/local-seo            # GMB optimization
POST /api/marketplace          # Classifieds copy
POST /api/faceless-video       # Viral video scripts
POST /api/contractor-proposal  # Construction proposals
```

Each endpoint accepts JSON with `buyer_email` (required) + niche-specific parameters.

---

## Troubleshooting

**"Cannot GET /"**
- Render is still starting up (takes 30 sec). Wait and refresh.

**Emails not arriving**
- Check spam folder
- Verify `SMTP_PASS` is correct (Gmail App Password, not your regular password)
- Make sure `ADMIN_EMAIL` and `SMTP_USER` are valid

**"GEMINI_API_KEY is not defined"**
- You forgot to add `GEMINI_API_KEY` to Render environment variables
- Go to Render dashboard → Settings → Environment Variables → Add it

**Cron not running at 8 AM**
- Cron is scheduled in UTC. Your 8 AM might be a different timezone.
- To test, manually trigger: `curl -X POST https://YOUR_SERVICE.onrender.com/api/admin/trigger-daily`

---

## Next Steps

- **Read the full README.md** for advanced customization
- **View your logs**: `GET /api/admin/logs`
- **Customize the 9 niches** in server.js
- **Add your own niches** by following the same pattern
- **Change cron time** (search for `0 8 * * *` in server.js)
- **Move to Starter Plan** on Render ($7/month) for persistent database

---

**You're live!** 🚀

Send this to your customers. They'll be up and running in 5 minutes.
