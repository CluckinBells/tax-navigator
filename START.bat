@echo off
cd /d "%~dp0"
title Tax Navigator - local server

rem Full path to real Python (bypass Microsoft Store stub which just flashes).
set "PY="
if exist "C:\Python312\python.exe" set "PY=C:\Python312\python.exe"
if not defined PY if exist "C:\Python311\python.exe" set "PY=C:\Python311\python.exe"
if not defined PY if exist "C:\Python313\python.exe" set "PY=C:\Python313\python.exe"
if not defined PY if exist "C:\Python310\python.exe" set "PY=C:\Python310\python.exe"

if not defined PY (
  echo.
  echo  Python not found in C:\Python3xx
  echo  Install from https://python.org and tick "Add Python to PATH".
  echo.
  echo  Press any key to close...
  pause >nul
  exit /b
)

"%PY%" launcher.py

rem If python exits with an error, keep the window open so the message is readable.
if errorlevel 1 (
  echo.
  echo  Something went wrong. Copy the text above and send it to the assistant.
  echo.
  echo  Press any key to close...
  pause >nul
)
