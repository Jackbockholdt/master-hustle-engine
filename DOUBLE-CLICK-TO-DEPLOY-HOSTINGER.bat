@echo off
cd /d "%~dp0"
title Hostinger Deployment Orchestrator - Master Hustle Engine
echo ==========================================================
echo   MASTER HUSTLE ENGINE - HOSTINGER DEPLOYMENT CHECKER
echo ==========================================================
node deploy\deploy_to_hostinger.js
echo.
pause
