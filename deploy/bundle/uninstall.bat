@echo off
setlocal
title Trinetra - Uninstall
rem ---------------------------------------------------------------------------
rem Windows entry point for uninstall.sh (runs it through Git Bash).
rem
rem   uninstall.bat              the helm release; keeps the data PVC and secrets
rem   uninstall.bat --purge      also the PVC, secrets, namespace and node image
rem                              cache (an import chart built without --registry
rem                              pulls from that cache, so it stops working)
rem   uninstall.bat -n NS -r RELEASE --context CTX
rem ---------------------------------------------------------------------------

set "HERE=%~dp0"
set "HERE=%HERE:\=/%"
set "RC=0"
call :detect_double_click %1

call :find_bash
if errorlevel 1 (set "RC=1" & goto :done)

if defined PAUSE_AT_END (
  rem A double-click should not remove anything without asking.
  for /f "delims=" %%C in ('kubectl config current-context 2^>nul') do echo Cluster: %%C
  choice /c YN /n /m "Remove Trinetra (release 'trinetra' in namespace 'trinetra'; data is kept)? [Y/N] "
  if errorlevel 2 (echo Cancelled. & goto :done)
)

"%GITBASH%" "%HERE%uninstall.sh" %*
set "RC=%errorlevel%"

:done
echo.
if "%RC%"=="0" (echo [OK] Finished.) else (echo [ERROR] Stopped with exit code %RC%. The reason is printed above.)
if defined PAUSE_AT_END pause
exit /b %RC%

rem --- helpers ----------------------------------------------------------------
:detect_double_click
set "PAUSE_AT_END="
if not "%~1"=="" exit /b 0
echo "%cmdcmdline%" | find /i "%~nx0" >nul && set "PAUSE_AT_END=1"
exit /b 0

:find_bash
rem Git for Windows' bash only. Never C:\Windows\System32\bash.exe, which is
rem WSL: a different machine, with a different kubectl config.
set "GITBASH="
for %%B in ("%ProgramW6432%\Git\bin\bash.exe" "%ProgramFiles%\Git\bin\bash.exe" "%ProgramFiles(x86)%\Git\bin\bash.exe" "%LocalAppData%\Programs\Git\bin\bash.exe") do (
  if not defined GITBASH if exist "%%~B" set "GITBASH=%%~B"
)
if defined GITBASH exit /b 0
for /f "delims=" %%G in ('where git.exe 2^>nul') do (
  if not defined GITBASH if exist "%%~dpG..\bin\bash.exe" set "GITBASH=%%~dpG..\bin\bash.exe"
  if not defined GITBASH if exist "%%~dpG..\..\bin\bash.exe" set "GITBASH=%%~dpG..\..\bin\bash.exe"
)
if defined GITBASH exit /b 0
echo [ERROR] Git Bash was not found. Install Git for Windows from https://git-scm.com/download/win
echo         ^(it brings the bash the uninstaller uses^), then run this again.
exit /b 1
