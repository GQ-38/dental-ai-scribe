@echo off
setlocal
cd /d "%~dp0"
title Dental AI Scribe Diagnostic Launcher
powershell.exe -NoExit -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
