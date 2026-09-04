@echo off
setlocal
cd /d "%~dp0"

rem Dry-runs the Outscraper scrape against the live engine and prints the real
rem yield. Queues nothing, emails nothing. The Maps scrape itself does bill
rem Outscraper credits, so the script asks before it spends any.

where powershell >/dev/null 2>&1
if errorlevel 1 (
  echo PowerShell was not found on this machine.
  pause
  exit /b 1
)

if not exist "tools\check-outscraper.ps1" (
  echo Could not find tools\check-outscraper.ps1
  echo Run this from inside the master-hustle-engine folder.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "tools\check-outscraper.ps1" %*

echo.
pause
