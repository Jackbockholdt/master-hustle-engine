@echo off
echo Initializing Git repository...
git init

echo Staging all files...
git add .

echo Committing files...
git commit -m "initial master engine deploy"

echo Renaming branch to main...
git branch -M main

echo Adding remote origin...
git remote add origin https://github.com/Jackbockholdt/master-hustle-engine.git

echo Pushing code to GitHub...
git push -u origin main

echo.
echo ==============================================
echo SUCCESS: Code deployed to GitHub!
echo ==============================================
pause
