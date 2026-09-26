@echo off
title MASTER HUSTLE ENGINE - SHOVEL PATENT BUYOUT DISPATCHER
cd /d "%~dp0"
echo ===================================================================
echo [1/2] Syncing targets and running Scraper Hook...
echo ===================================================================
node scrape_and_parse_targets.js

echo.
echo ===================================================================
echo [2/2] Launching Python SMTP Pitch Dispatcher (45s throttle)...
echo ===================================================================
set PYTHON_EXE=C:\Users\jack\AppData\Local\Programs\LM Studio\resources\app\.webpack\bin\extensions\backends\vendor\_amphibian\cpython3.11-win-x86@6\python.exe

if exist "%PYTHON_EXE%" (
    "%PYTHON_EXE%" send_pitch.py --throttle 45
) else (
    python send_pitch.py --throttle 45
)

echo.
pause
