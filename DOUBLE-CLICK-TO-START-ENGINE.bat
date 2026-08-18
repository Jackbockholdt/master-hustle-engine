@echo off
REM Starts the Master Hustle Engine on this machine.
REM
REM This script does NOT commit, push, or deploy anything. It only runs the
REM server locally. Deploys happen through a pull request on GitHub.

cd /d "%~dp0"

if not exist "node_modules\" (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 goto fail
)

if not exist ".env" (
  echo.
  echo WARNING: no .env file found in this folder.
  echo The engine will still start, but AI generation and outbound sending
  echo stay disabled until you copy .env.example to .env and fill it in.
  echo.
)

echo.
echo Starting the engine on http://localhost:3005
echo Admin dashboard: http://localhost:3005/admin/pitch
echo Press Ctrl+C to stop.
echo.

npm start
if errorlevel 1 goto fail
goto end

:fail
echo.
echo ==============================================
echo The engine did not start. Read the error above.
echo ==============================================

:end
pause
