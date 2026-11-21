@echo off
setlocal
title Trinetra - Build install bundle
rem ---------------------------------------------------------------------------
rem Builds deploy\bundle\dist\trinetra-<version>-bundle.tgz from this source
rem tree: the app image (assembled with crane, no Docker), the Helm chart with
rem the latest changes, helm/crane binaries, and the install scripts (.sh and
rem .bat). Runs build-bundle.sh through Git Bash.
rem
rem Needs Node.js/npm, Python 3.8+, Git for Windows and internet access for the
rem first build (tools and the base image are cached in deploy\bundle\.cache).
rem
rem   build-bundle.bat                  full build, runs the test suite first
rem   set SKIP_TESTS=1 && build-bundle.bat   skip the tests
rem ---------------------------------------------------------------------------

set "HERE=%~dp0"
set "HERE=%HERE:\=/%"
set "RC=0"
call :detect_double_click %1

call :find_bash
if errorlevel 1 (set "RC=1" & goto :done)

"%GITBASH%" "%HERE%build-bundle.sh" %*
set "RC=%errorlevel%"
rem Outside a ( ) block on purpose: a ")" in the folder path would end it early.
if not "%RC%"=="0" goto :done
echo.
echo Bundle written to %~dp0dist\
echo Next, on the machine whose kubectl points at PCAI:
echo   tar -xzf trinetra-^<version^>-bundle.tgz
echo   cd trinetra-^<version^>
echo   pcai-import.bat      chart for PCAI Import Framework
echo   install.bat          or install directly with helm

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
rem Git for Windows' bash only. Never C:\Windows\System32\bash.exe (WSL).
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
echo         and run this again.
exit /b 1
