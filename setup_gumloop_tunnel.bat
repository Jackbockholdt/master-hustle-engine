@echo off
TITLE Gumloop Webhook Tunnel Setup Assistant
echo ====================================================
echo   GUMLOOP WEBHOOK TUNNEL SETUP ASSISTANT
echo ====================================================
echo.
echo Local Engine Endpoint: http://localhost:3005/api/ingest-gumloop-leads
echo.
echo Option 1: Cloudflare Tunnel (Free, No Account Required)
echo   Run: npx cloudflared tunnel --url http://localhost:3005
echo   Copy the https://xxx.trycloudflare.com URL and set Webhook POST URL to:
echo   https://xxx.trycloudflare.com/api/ingest-gumloop-leads
echo.
echo Option 2: ngrok Tunnel
echo   Run: ngrok http 3005
echo   Copy the https://xxx.ngrok-free.app URL and set Webhook POST URL to:
echo   https://xxx.ngrok-free.app/api/ingest-gumloop-leads
echo.
echo Option 3: Production Live Deployment (Render / Hostinger)
echo   Set Webhook POST URL to:
echo   https://master-hustle-engine.onrender.com/api/ingest-gumloop-leads
echo.
echo ====================================================
echo Standard Gumloop Webhook JSON Payload Schema:
echo {
echo   "leads": [
echo     {
echo       "email": "contact@targetdomain.com",
echo       "firstName": "John",
echo       "company": "Target Company LLC",
echo       "phone": "555-123-4567"
echo     }
echo   ]
echo }
echo ====================================================
echo.
pause
