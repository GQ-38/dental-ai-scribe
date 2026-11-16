@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv311\Scripts\python.exe" (
    echo 尚未安装环境，请先双击“一键安装并运行.bat”。
    pause
    exit /b 1
)
".venv311\Scripts\python.exe" diagnose.py
pause
