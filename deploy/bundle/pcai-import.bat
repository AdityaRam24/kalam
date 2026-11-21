@echo off
setlocal
title Trinetra - PCAI import chart
rem ---------------------------------------------------------------------------
rem Builds out\trinetra-<version>-pcai-import.tgz, the chart to upload in
rem PCAI -> Tools & Frameworks -> Import Framework. Installs nothing.
rem
rem   pcai-import.bat                                    asks for the registry
rem   pcai-import.bat --registry harbor.example.com/tools
rem   pcai-import.bat --registry REPO --registry-user U --registry-password P
rem   pcai-import.bat --registry REPO --insecure-registry  (plain HTTP / self-signed)
rem
rem Same as ./install.sh --package-only, so every install.sh option works here
rem too (--llm-url, --llm-model, --no-llm, --storage-class, --no-sso, ...).
rem The image is pushed to the registry first, because the imported chart must
rem point at an image every PCAI node can pull.
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

rem No --registry on the command line: ask for it.
set "HAS_REGISTRY="
set "REG_ARGS="
for %%A in (%*) do if /i "%%~A"=="--registry" set "HAS_REGISTRY=1"
if defined HAS_REGISTRY goto :run
echo Registry the PCAI nodes pull from, e.g. harbor.example.com/tools
echo ^(leave empty to use the per-node cache that install.sh sets up on the
echo  cluster kubectl points at - only for that cluster, and only while it runs^)
set "REGISTRY="
set /p "REGISTRY=Registry: "
if not defined REGISTRY goto :run
set "REG_ARGS=--registry %REGISTRY%"
if not defined REGISTRY_USER set /p "REGISTRY_USER=Registry user (leave empty if none): "
if defined REGISTRY_USER if not defined REGISTRY_PASSWORD call :ask_password

:run
rem REGISTRY_USER / REGISTRY_PASSWORD reach install.sh through the environment.
"%GITBASH%" "%HERE%install.sh" --package-only %REG_ARGS% %*
set "RC=%errorlevel%"
if "%RC%"=="0" (
  echo.
  echo Next: PCAI -^> Tools ^& Frameworks -^> Import Framework, upload the
  echo       out\trinetra-*-pcai-import.tgz named above. Release Name in lower case
  echo       ^(e.g. trinetra^), and tick Debug so a failure shows helm's own error.
)

:done
echo.
if "%RC%"=="0" (echo [OK] Finished.) else (echo [ERROR] Stopped with exit code %RC%. The reason is printed above.)
if defined PAUSE_AT_END pause
exit /b %RC%

rem --- helpers ----------------------------------------------------------------
:ask_password
rem Typed without echo; the value only lives in this window's environment.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$s = Read-Host 'Registry password' -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`) do set "REGISTRY_PASSWORD=%%P"
exit /b 0

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
