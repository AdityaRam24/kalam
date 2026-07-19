@echo off
title Kalam - Project Setup & Requirements Installer
color 0A

echo ===================================================
echo           KALAM - AUTOMATED PROJECT SETUP          
echo ===================================================
echo.

:: 1. Check if Node.js & npm are installed
echo [1/4] Checking system prerequisites...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARNING] Node.js is not installed or not in PATH!
    echo Attempting to install Node.js using winget...
    winget install --id OpenJS.NodeJS -e --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to auto-install Node.js via winget.
        echo Please download and install Node.js manually from https://nodejs.org/
        pause
        exit /b 1
    )
    echo [SUCCESS] Node.js installed successfully. Please restart this script or command prompt if needed.
) else (
    echo [SUCCESS] Node.js detected:
    node -v
)

where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] npm was not found. Please verify your Node.js installation.
    pause
    exit /b 1
)

:: 2. Check for .env file
echo.
echo [2/4] Verifying environment configuration (.env)...
if not exist ".env" (
    echo Creating default .env file...
    echo # Kalam Configuration > .env
    echo PORT=3001 >> .env
    echo GEMINI_API_KEY= >> .env
    echo [SUCCESS] Created .env file. Add your GEMINI_API_KEY if using Google Gemini.
) else (
    echo [SUCCESS] .env file already exists.
)

:: 3. Install project dependencies
echo.
echo [3/4] Installing project requirements and dependencies (npm install)...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install encountered an issue.
    pause
    exit /b 1
)
echo [SUCCESS] All dependencies successfully installed.

:: 4. Check Optional Prerequisites (Docker & kubectl)
echo.
echo [4/4] Checking optional cluster tools (Docker / kubectl)...
where docker >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Docker is not detected in PATH. (Required only for container management features)
) else (
    echo [SUCCESS] Docker is installed.
)

where kubectl >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] kubectl is not detected in PATH. (Required only for Kubernetes cluster operations)
) else (
    echo [SUCCESS] kubectl is installed.
)

echo.
echo ===================================================
echo            SETUP COMPLETED SUCCESSFULLY!           
echo ===================================================
echo.
set /p START_DEV="Do you want to start Kalam in development mode now? (Y/N): "
if /i "%START_DEV%"=="Y" (
    echo Starting dev server...
    npm run dev
) else (
    echo You can start the application anytime by running: npm run dev
)

pause
