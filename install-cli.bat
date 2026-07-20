@echo off
title Kalam - Install Global CLI
color 0B

echo ===================================================
echo        INSTALLING THE 'kalam' GLOBAL COMMAND
echo ===================================================
echo.

cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found in PATH. Install it first ^(run setup.bat^).
    pause
    exit /b 1
)

echo [1/2] Registering 'kalam' globally via npm link...
call npm link
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] npm link failed. Try running this window as Administrator.
    pause
    exit /b 1
)

echo.
echo [2/2] Verifying the command is available...
where kalam >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARNING] 'kalam' is linked but not on PATH yet.
    echo   Close this terminal and open a NEW one, then run: kalam help
) else (
    echo [SUCCESS] 'kalam' is ready!
)

echo.
echo ===================================================
echo   Done. Open a NEW terminal and try:
echo.
echo     kalam help
echo     kalam solve "MLIS deployment failed, pod OOMKilled"
echo     kalam ask "what is HPE Private Cloud AI?"
echo     kalam train
echo ===================================================
echo.
echo Note: commands that need AI will auto-start the backend for you.
echo For best answers, put your GEMINI_API_KEY in the .env file.
echo.
pause
