@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules\playwright\package.json (
  echo Run setup.cmd first.
  pause
  exit /b 1
)
call npm start
if errorlevel 1 pause
