@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build.ps1"
set "BUILD_RESULT=%ERRORLEVEL%"
echo.
if not "%BUILD_RESULT%"=="0" echo Build failed. Read the error above; nothing was sent to a TV.
pause
exit /b %BUILD_RESULT%
