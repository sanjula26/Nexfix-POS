@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo node_modules not found. Running npm install first...
  npm install
  if errorlevel 1 pause & exit /b 1
)
echo Starting Nexfix POS...
npm run dev -- --host 0.0.0.0
