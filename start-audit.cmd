@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
echo Website audit. The first run may download free tools from the Internet.
echo Existing outputs and cache will be preserved. No messages will be sent.
node --use-env-proxy scripts/bootstrap-audit.mjs %*
set result=%errorlevel%
echo.
pause
exit /b %result%
