@echo off
TITLE Master Hustle Engine - White Label SaaS Outbound Campaign
cd /d "%~dp0"
echo ===================================================================
echo   MASTER HUSTLE ENGINE - WHITE LABEL SAAS PROSPECTING & DISPATCH
echo ===================================================================
echo.

echo [Step 1/2] Running SaaS & Agency Scraper / Lead Enrichment...
node scrape_saas_targets.js
if %errorlevel% neq 0 (
    echo [!] Error occurred during lead scraping.
    pause
    exit /b 1
)

echo.
echo ===================================================================
echo [Step 2/2] Launching Python Outbound Campaign (45-60s Jitter Throttle)...
echo ===================================================================
set PYTHON_EXE=C:\Users\jack\AppData\Local\Programs\LM Studio\resources\app\.webpack\bin\extensions\backends\vendor\_amphibian\cpython3.11-win-x86@6\python.exe

if exist "%PYTHON_EXE%" (
    "%PYTHON_EXE%" send_saas_campaign.py --throttle-min 45 --throttle-max 60
) else (
    python send_saas_campaign.py --throttle-min 45 --throttle-max 60
)

echo.
echo ===================================================================
echo Campaign run finished. Check saas_outreach_log.jsonl for audit history.
echo ===================================================================
pause
