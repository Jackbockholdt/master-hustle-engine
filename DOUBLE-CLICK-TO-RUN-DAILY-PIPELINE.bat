@echo off
TITLE Master Hustle Engine - Daily Pipeline Runner
echo ====================================================
echo    MASTER HUSTLE ENGINE - DAILY PIPELINE RUNNER
echo ====================================================
echo.
echo [1/2] Checking Node.js environment...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH.
    pause
    exit /b 1
)

echo [2/2] Running 5-step daily pipeline sequence...
node run_daily_pipeline.js
pause
