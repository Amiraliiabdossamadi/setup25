@echo off
call npm install
call npm run build
echo.
echo Installer: dist\MaxNet-Setup.exe
pause
