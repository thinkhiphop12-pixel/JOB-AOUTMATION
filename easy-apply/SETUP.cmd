@echo off
title Job bot setup
echo Setting up the job bot. This takes a few minutes the first time.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
pause
