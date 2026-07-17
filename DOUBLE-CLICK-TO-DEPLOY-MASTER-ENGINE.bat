@echo off
echo ============================================
echo  MASTER HUSTLE ENGINE - SYNC & DEPLOY
echo ============================================
echo.

echo [1/1] Syncing environment variables to Render & Triggering Redeploy...
node "%~dp0update_render_env.js"
echo.

echo ============================================
echo  ALL DONE! Your engine is deploying now on Render.
echo  Check build status at: https://dashboard.render.com
echo  Live demo: https://master-hustle-engine.onrender.com
echo ============================================
pause
