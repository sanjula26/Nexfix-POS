@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo Nexfix POS - Windows Setup
echo ============================================
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22 LTS and run this again.
  pause
  exit /b 1
)
node -v
npm -v
echo.
echo Installing project dependencies...
npm install
if errorlevel 1 (
  echo.
  echo Dependency installation failed.
  pause
  exit /b 1
)
echo.
echo Setup completed successfully.
echo Next: run start-local.bat
pause
