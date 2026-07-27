@echo off
title Kalam - Start (Production)
color 0A
cd /d "%~dp0"

echo ===================================================
echo               KALAM - ONE-CLICK START
echo ===================================================
echo.

:: 1. Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Run setup.bat first.
    pause
    exit /b 1
)

:: 2. Install dependencies if missing
if not exist "node_modules" (
    echo [1/3] Installing dependencies (first run)...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
) else (
    echo [1/3] Dependencies already installed.
)

:: 3. Build the frontend if no build exists yet
if not exist "dist\index.html" (
    echo [2/3] Building the frontend (one-time)...
    call npm run build
    if %errorlevel% neq 0 (
        echo [ERROR] Build failed.
        pause
        exit /b 1
    )
) else (
    echo [2/3] Frontend build found (dist\). Delete the dist folder to force a rebuild.
)

:: 4. Start the server and open the browser
echo [3/3] Starting Kalam on http://localhost:3001 ...
start "" http://localhost:3001
call npx tsx server/index.ts

pause
