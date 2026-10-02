@echo off
title Trinetra - Install Global CLI
color 0B

echo ===================================================
echo        INSTALLING THE 'trinetra' GLOBAL COMMAND
echo ===================================================
echo.

cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found in PATH. Install it first ^(run setup.bat^).
    pause
    exit /b 1
)

echo [1/2] Registering 'trinetra' globally via npm link...
:: MIGRATION: drop the pre-rename global command, if any
call npm unlink -g kalam >nul 2>&1
call npm link
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] npm link failed. Try running this window as Administrator.
    pause
    exit /b 1
)

echo.
echo [2/2] Verifying the command is available...
where trinetra >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARNING] 'trinetra' is linked but not on PATH yet.
    echo   Close this terminal and open a NEW one, then run: trinetra help
) else (
    echo [SUCCESS] 'trinetra' is ready!
)

echo.
echo ===================================================
echo   Done. Open a NEW terminal and try:
echo.
echo     trinetra help
echo     trinetra solve "MLIS deployment failed, pod OOMKilled"
echo     trinetra ask "what is HPE Private Cloud AI?"
echo     trinetra train
echo ===================================================
echo.
echo Note: commands that need AI will auto-start the backend for you.
echo For best answers, put your GEMINI_API_KEY in the .env file.
echo.
pause
