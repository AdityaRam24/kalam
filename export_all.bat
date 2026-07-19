@echo off
title Kalam - Export All Project Files
color 0B

echo ===================================================
echo          KALAM - EXPORT ALL PROJECT FILES          
echo ===================================================
echo.
echo Packaging all project files (ignoring .gitignore)...
echo Output destination: kalam_full_project.zip
echo.

powershell -Command "Get-ChildItem -Path . -Exclude 'kalam_full_project.zip' | Compress-Archive -DestinationPath 'kalam_full_project.zip' -Force"

if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] All files packaged into 'kalam_full_project.zip'!
    echo You can now copy 'kalam_full_project.zip' and 'setup.bat' to your other laptop.
) else (
    echo.
    echo [ERROR] Export failed. Please check PowerShell permissions or file locks.
)

echo.
pause
