@echo off
cd /d "%~dp0"
echo ==========================================================
echo   MASTER HUSTLE ENGINE - GIT COMMIT & PUSH FOR RENDER
echo ==========================================================
git add .
git commit -m "Deploy Master Hustle Engine v2.0 to Render with token governance and multi-project routing"
git push origin main
echo ==========================================================
echo   Code pushed to GitHub successfully!
echo   Render will automatically trigger a new deployment.
echo ==========================================================
pause
