@echo off
echo ============================================
echo  MASTER HUSTLE ENGINE - CLEAN & PUSH FIX
echo ============================================
echo.

cd /d "%~dp0"

echo [1/4] Resetting git history to main...
git reset --mixed origin/main 2>&1

echo [2/4] Removing files containing hardcoded secrets...
del /q "DEPLOY-EVERYTHING.bat" 2>nul
del /q "update_render_key.js" 2>nul
git rm "DEPLOY-EVERYTHING.bat" 2>nul
git rm "update_render_key.js" 2>nul
echo.

echo [3/4] Staging and committing clean files...
git add -A 2>&1
git commit -m "fix: validate email format to prevent relay exceptions" 2>&1
echo.

echo [4/4] Pushing clean branch to GitHub...
git push origin fix-email-validation --force 2>&1
echo.

echo ============================================
echo  ALL DONE! 
echo  Opening GitHub Compare/Merge page...
start "" "https://github.com/Jackbockholdt/master-hustle-engine/compare/main...fix-email-validation?expand=1"
echo ============================================
pause
