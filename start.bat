@echo off
chcp 65001 >nul
title GitHub 热榜 App
cd /d %~dp0
echo 正在启动 GitHub 热榜 App ...
echo 启动后请保持本窗口开启（最小化即可），手机与电脑连同一 Wi-Fi 即可访问。
echo.
node server.js
pause
