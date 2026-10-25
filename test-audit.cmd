@echo off
setlocal
cd /d "%~dp0"
call start-audit.cmd --limit 5
exit /b %errorlevel%
