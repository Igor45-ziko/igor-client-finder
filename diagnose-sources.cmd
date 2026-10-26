@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org/
  pause
  exit /b 1
)
node --use-env-proxy scripts/diagnose-sources.mjs
set result=%errorlevel%
echo.
pause
exit /b %result%
