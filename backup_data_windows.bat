@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%i"
set "TARGET=backups\%STAMP%"
mkdir "%TARGET%" >nul 2>nul

if exist "data\dental_records.db" copy /y "data\dental_records.db" "%TARGET%\" >nul
if exist "exports" xcopy "exports" "%TARGET%\exports\" /E /I /Y >nul
if exist ".env" copy /y ".env" "%TARGET%\" >nul

echo 备份完成：%TARGET%
pause
