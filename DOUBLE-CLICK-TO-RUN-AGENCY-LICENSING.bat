@echo off
cd /d "%~dp0"
echo ==========================================================
echo   MASTER HUSTLE ENGINE - B2B AGENCY LICENSING PIPELINE
echo   Product: JackBuckholdt/master-hustle-engine on Render
echo ==========================================================
echo Step 1: Ingesting & Triaging Target Agency Decision Makers...
echo Step 2: Running 3-Tier Token Optimization & Margin Calculation...
echo Step 3: Generating Personalized Outreach & 2-Step Follow-Ups...
echo Step 4: Syncing State to CRM Tracker (crm_leads_tracker.json)...
echo.
node workflows/agency_licensing_pipeline.js
echo.
echo ==========================================================
echo   Licensing Pipeline Complete!
echo   Check crm_leads_tracker.json for detailed lead records.
echo ==========================================================
pause
