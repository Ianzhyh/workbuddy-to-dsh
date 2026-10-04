@echo off
rem ===================================================================
rem  One-click launcher (ASCII only, on purpose).
rem
rem  This file must stay pure ASCII: cmd.exe parses a .cmd with the
rem  system ANSI code page BEFORE `chcp` takes effect, so any multi-byte
rem  character here corrupts the command text itself. All user-facing
rem  Chinese text comes from the Node process instead, which is safe
rem  once the console code page is UTF-8.
rem ===================================================================
chcp 65001 >nul
title WorkBuddy Bridge
cd /d "%~dp0"

echo.
echo   ========================================
echo      WorkBuddy Bridge
echo   ========================================
echo.
echo   Starting... a browser window will open.
echo.

rem ---------- locate a usable Node.js ----------
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "E:\harness\resources\runtime\bin\node.exe" set "NODE_EXE=E:\harness\resources\runtime\bin\node.exe"
if not defined NODE_EXE if exist "E:\nodejs\node.exe" set "NODE_EXE=E:\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE goto no_node

rem ---------- let the server open the browser once it is listening ----------
rem The server knows the effective port (DASHBOARD_PORT in .env), so the URL can
rem never drift from the one actually bound. Do NOT hardcode a port here.
set "DASHBOARD_OPEN_BROWSER=1"

rem ---------- run the console in the foreground ----------
"%NODE_EXE%" dashboard\server.mjs

echo.
pause
goto :eof

:no_node
echo   [!] Node.js not found.
echo.
echo   Please install Node.js first (free, keep clicking Next):
echo.
echo       https://nodejs.org/
echo.
echo   Then double-click this file again.
echo.
pause
exit /b 1
