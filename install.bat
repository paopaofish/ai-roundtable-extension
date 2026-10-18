@echo off
chcp 65001 >nul
setlocal
set "EXT_DIR=%~dp0"
if "%EXT_DIR:~-1%"=="\" set "EXT_DIR=%EXT_DIR:~0,-1%"

echo.
echo   AI 圆桌 · 扩展安装助手
echo   ================================================
echo.
echo   扩展目录：
echo   %EXT_DIR%
echo.

rem 把路径放进剪贴板，稍后选文件夹时可以直接粘贴
echo %EXT_DIR% | clip >nul 2>&1
echo   [1/3] 扩展路径已复制到剪贴板
echo.

echo   [2/3] 正在打开扩展管理页 …
start "" msedge "edge://extensions/" >nul 2>&1
if errorlevel 1 start "" chrome "chrome://extensions/" >nul 2>&1
timeout /t 2 >nul

echo   [3/3] 正在打开扩展文件夹 …
start "" explorer "%EXT_DIR%"

echo.
echo   ================================================
echo   接下来只需三步：
echo     1. 在扩展页左下角打开「开发人员模式」
echo     2. 点「加载解压缩的扩展」
echo     3. 在弹出的选择框里按 Ctrl+V 粘贴路径后回车
echo.
echo   安装完成后，点浏览器工具栏上的图标即可打开控制台。
echo.
pause
