@echo off
title Trinetra - Export All Project Files
color 0B
cd /d "%~dp0"

echo ===================================================
echo          TRINETRA - EXPORT ALL PROJECT FILES
echo ===================================================
echo.
echo Packaging project files (excluding node_modules, .git, dist, .env)...
echo Output destination: trinetra_full_project.zip
echo.

powershell -Command "Get-ChildItem -Path . -Force -Exclude 'trinetra_full_project.zip','node_modules','.git','dist','.env' | Compress-Archive -DestinationPath 'trinetra_full_project.zip' -Force"

if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] Project packaged into 'trinetra_full_project.zip'!
    echo.
    echo On the other machine:
    echo   1. Extract the zip
    echo   2. Run setup.bat  ^(installs Node + dependencies^)
    echo   3. Run start.bat  ^(builds and launches Trinetra^)
) else (
    echo.
    echo [ERROR] Export failed. Please check PowerShell permissions or file locks.
)

echo.
pause
