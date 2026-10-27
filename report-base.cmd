@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node src/audit/report-only.mjs %*
set result=%errorlevel%
pause
exit /b %result%
