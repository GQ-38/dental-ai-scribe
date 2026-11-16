@echo off
chcp 65001
setlocal enabledelayedexpansion
set output=目录完整清单.txt
echo ============================================== > !output!
echo 生成时间：%date% %time% >> !output!
echo 根目录路径：%cd% >> !output!
echo ============================================== >> !output!
echo. >> !output!

:: 先用dir输出所有文件平铺列表兜底
echo 【平铺文件全列表】 >> !output!
dir /s /b >> !output!
echo. >> !output!
echo ============================================== >> !output!
echo 【树形目录结构】 >> !output!
echo. >> !output!

:: 强制完整树形，关闭分页
tree /F /A > !output! 2>&1

echo 文件导出完成，查看：%cd%\!output!
pause