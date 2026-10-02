@echo off
title Trinetra - Project Setup & Requirements Installer
color 0A

echo ===================================================
echo           TRINETRA - AUTOMATED PROJECT SETUP          
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
    echo # Trinetra Configuration > .env
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

:: 3b. Register the global 'trinetra' CLI command
echo.
echo [3b/4] Registering the global 'trinetra' command (npm link)...
:: MIGRATION: drop the pre-rename global command, if any
call npm unlink -g kalam >nul 2>&1
call npm link
if %errorlevel% neq 0 (
    echo [WARNING] 'npm link' failed. You can retry later by running install-cli.bat
    echo           (running as Administrator often fixes this).
) else (
    echo [SUCCESS] 'trinetra' command registered. Open a NEW terminal to use it.
)

:: 4. Check Optional Prerequisites (container runtime & kubectl)
::    None of these are required. Trinetra reads containers from whichever
::    runtime a machine has (Docker, containerd/crictl, nerdctl, podman), and a
::    machine with none of them still shows every VM in the SSH inventory.
echo.
echo [4/4] Checking optional cluster tools (all optional)...
set RUNTIME_FOUND=0
for %%r in (docker crictl nerdctl podman) do (
    where %%r >nul 2>nul && (
        echo [SUCCESS] %%r found.
        set RUNTIME_FOUND=1
    )
)
if "%RUNTIME_FOUND%"=="0" (
    echo [INFO] No container runtime on this machine. That is fine: add your VMs
    echo        on the Virtual Machines tab and the dashboard reads them over SSH.
)

where kubectl >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] kubectl not found. Needed only to read a cluster from THIS machine;
    echo        clusters on your VMs are read over SSH without it.
) else (
    echo [SUCCESS] kubectl is installed.
)

echo.
echo ===================================================
echo            SETUP COMPLETED SUCCESSFULLY!           
echo ===================================================
echo.
set /p START_DEV="Do you want to start Trinetra in development mode now? (Y/N): "
if /i "%START_DEV%"=="Y" (
    echo Starting dev server...
    npm run dev
) else (
    echo You can start the application anytime by running: npm run dev
)

pause
