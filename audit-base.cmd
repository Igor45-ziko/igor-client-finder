@echo off
setlocal
cd /d "%~dp0"
call start-audit.cmd --saved-base %*
exit /b %errorlevel%
