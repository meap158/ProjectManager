@echo off
setlocal EnableDelayedExpansion
title ProjectManager
rem Starts ProjectManager. Same as: npm run launch
rem When something outside ends the launcher (PowerShell's Stop-Process leaves exit code -1), it is
rem started again, up to 10 times: another project's cleanup once matched every "launch.mjs" on the
rem machine (PM-332). A normal exit, Ctrl+C or a failed start (exit code 1) ends here as before.
cd /d "%~dp0"
set PM_RESTARTS=0
:start
node scripts\launch.mjs %*
set PM_CODE=%ERRORLEVEL%
if not "%PM_CODE%"=="-1" exit /b %PM_CODE%
if %PM_RESTARTS% GEQ 10 exit /b %PM_CODE%
set /a PM_RESTARTS+=1
echo [launch] The launcher was ended from outside (exit code -1). Starting it again (!PM_RESTARTS!/10)...
rem The old server stops itself within a few seconds once its launcher is gone.
timeout /t 5 /nobreak >nul
goto start
