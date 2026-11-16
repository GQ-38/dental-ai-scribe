@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Dental AI Scribe - 关闭全部
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0一键关闭全部.ps1"
