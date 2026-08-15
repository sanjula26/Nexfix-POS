@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo node_modules not found. Running npm install first...
  npm install
  if errorlevel 1 pause & exit /b 1
)
echo Building web assets and Windows installer...
npm run desktop:build
if errorlevel 1 (
  echo.
  echo Desktop build failed. Keep this window open and send the error output for diagnosis.
  pause
  exit /b 1
)
echo.
echo Build complete. Check the release folder.
pause
