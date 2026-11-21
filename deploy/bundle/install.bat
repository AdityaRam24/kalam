@echo off
setlocal
title Trinetra - Install
rem ---------------------------------------------------------------------------
rem Windows entry point for the bundle installer. Double-click it, or run it
rem from cmd / PowerShell with the same options as install.sh:
rem
rem   install.bat                                        everything auto-detected
rem   install.bat --registry harbor.example.com/tools    push to your registry
rem   install.bat --help                                 every option
rem
rem It runs the bundle's install.sh through Git Bash (Git for Windows), so a
rem Windows install does exactly what a Linux one does. kubectl must point at
rem the cluster (kubectl config current-context).
rem ---------------------------------------------------------------------------

set "HERE=%~dp0"
set "HERE=%HERE:\=/%"
set "RC=0"
call :detect_double_click %1

if not exist "%~dp0chart\" (
  echo [ERROR] Run this from the extracted bundle folder ^(trinetra-^<version^>\^).
  echo         To build a bundle from the source tree, run deploy\bundle\build-bundle.bat.
  set "RC=1" & goto :done
)

call :find_bash
if errorlevel 1 (set "RC=1" & goto :done)

"%GITBASH%" "%HERE%install.sh" %*
set "RC=%errorlevel%"

:done
echo.
if "%RC%"=="0" (echo [OK] Finished.) else (echo [ERROR] Stopped with exit code %RC%. The reason is printed above.)
if defined PAUSE_AT_END pause
exit /b %RC%

rem --- helpers ----------------------------------------------------------------
:detect_double_click
rem Pause at the end only when started from Explorer with no arguments, so the
rem window does not vanish before the result can be read.
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
echo         ^(it brings the bash, tar and awk the installer uses^), then run this again.
exit /b 1
