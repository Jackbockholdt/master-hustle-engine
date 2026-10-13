@echo off
TITLE Master Hustle Engine - 24/7 Multi-Venture Inbox Monitor
cd /d "%~dp0"
echo ====================================================
echo    MASTER HUSTLE ENGINE - INBOX MONITORING SYSTEM
echo ====================================================
echo.
set PYTHON_EXE=C:\Users\jack\AppData\Local\Programs\LM Studio\resources\app\.webpack\bin\extensions\backends\vendor\_amphibian\cpython3.11-win-x86@6\python.exe

if exist "%PYTHON_EXE%" (
    "%PYTHON_EXE%" auto_inbox_monitor.py --interval 60
) else (
    python auto_inbox_monitor.py --interval 60
)

pause
