@echo off
title ProjectManager - Server
rem Starts ProjectManager. Same as: npm run launch
cd /d "%~dp0"
node scripts\launch.mjs %*
