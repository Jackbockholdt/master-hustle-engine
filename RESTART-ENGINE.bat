@echo off
TITLE Master Hustle Engine - Clean Restart
cd /d "%~dp0"

echo ====================================================
echo    MASTER HUSTLE ENGINE - CLEAN RESTART
echo ====================================================
echo.

echo [1/4] Freeing port 3005...
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3005" ^| findstr "LISTENING"') do (
    echo       Killing process PID %%P holding port 3005
    taskkill /F /PID %%P >nul 2>&1
    set FOUND=1
)
if "%FOUND%"=="0" echo       Port 3005 was already free.

timeout /t 2 /nobreak >nul

echo [2/4] Verifying port 3005 is clear...
netstat -ano | findstr ":3005" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo.
    echo    ERROR: Port 3005 is STILL in use.
    echo    Run this in an Administrator terminal:  taskkill /F /IM node.exe
    echo.
    pause
    exit /b 1
)
echo       Port 3005 is clear.

echo [3/4] Checking Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo    ERROR: Node.js not found in PATH.
    pause
    exit /b 1
)
for /f "delims=" %%V in ('node -v') do echo       Node %%V

echo [4/4] Starting server...
echo.
echo ----------------------------------------------------
echo  If you do NOT see the ANTIGRAVITY ENGINE CORE banner
echo  below, the server FAILED to start. Read the error.
echo ----------------------------------------------------
echo.

node server.js

echo.
echo ====================================================
echo  SERVER STOPPED. If this closed immediately, an
echo  error is printed above. Copy it and send it over.
echo ====================================================
pause
