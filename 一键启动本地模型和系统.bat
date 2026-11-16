@echo off
setlocal
cd /d "%~dp0"
title Dental AI Scribe Launcher

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
set "START_RC=%ERRORLEVEL%"

if not "%START_RC%"=="0" (
    echo.
    echo Launcher failed. See logs\startup-latest.log
    pause
)

exit /b %START_RC%
