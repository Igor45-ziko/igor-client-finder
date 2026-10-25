@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
node --use-env-proxy src/cli.mjs %*
set result=%errorlevel%
echo.
pause
exit /b %result%
