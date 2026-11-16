@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Dental AI Scribe - Install Only
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_and_run.ps1" -InstallOnly
pause
