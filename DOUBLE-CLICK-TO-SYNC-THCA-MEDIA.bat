@echo off
cd /d "%~dp0"
echo ==========================================================
echo   THCA REVIEW SITE - GOOGLE DRIVE TO WORDPRESS MEDIA SYNC
echo   Domain: jacksplugreviews.com
echo ==========================================================
echo Step 1: Parsing 9 Google Drive Links and Downloading Assets...
echo Step 2: Uploading to WordPress Media Library...
echo Step 3: Generating Gutenberg Page Layout with Embeds...
echo.
node import_gdrive_thca_media.js
echo.
echo ==========================================================
echo   Sync Complete!
echo   Page output saved in: thca_generated_page.html
echo ==========================================================
pause
