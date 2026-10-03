@echo off
TITLE Master Hustle Engine Launcher
echo ====================================================
echo    MASTER HUSTLE ENGINE & ANTIGRAVITY ARCHITECTURE
echo ====================================================
echo.
echo [1/3] Checking Node.js environment...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH.
    pause
    exit /b 1
)

echo [2/3] Installing dependencies if needed...
if not exist node_modules (
    call npm install
)

echo [3/3] Starting Master Hustle Engine Server...
echo Open http://localhost:3005 in your web browser.
echo.
node server.js
pause
