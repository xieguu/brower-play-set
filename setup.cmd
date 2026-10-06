@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or later from https://nodejs.org first.
  pause
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 22) { console.error('Node.js 22 or later is required.'); process.exit(1); }"
if errorlevel 1 goto failed
call npm ci
if errorlevel 1 goto failed
call npm run browsers
if errorlevel 1 goto failed
echo Setup complete. Run start.cmd to open Browser Play Set.
pause
exit /b 0
:failed
echo Setup failed. See the error above.
pause
exit /b 1
