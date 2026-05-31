@echo off
cd /d "%~dp0\.."
echo Pulling latest code from GitHub...
git fetch origin main
git reset --hard origin/main
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
node_modules\electron\dist\electron.exe .
pause
