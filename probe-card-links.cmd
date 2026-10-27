@echo off
setlocal
cd /d "%~dp0"
node --use-env-proxy probe-card-links.mjs %*
set "probe_exit=%errorlevel%"
echo.
pause
exit /b %probe_exit%
