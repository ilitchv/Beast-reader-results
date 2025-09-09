@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm i
)
echo Starting server...
call npm run dev
pause