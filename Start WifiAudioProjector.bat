@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "ROOT=%CD%"
set "LOG_DIR=%ROOT%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "STAMP=%DATE:~10,4%-%DATE:~4,2%-%DATE:~7,2%_%TIME:~0,2%-%TIME:~3,2%-%TIME:~6,2%"
set "STAMP=%STAMP: =0%"
set "LOG_FILE=%LOG_DIR%\run-host-%STAMP%.log"
set "TOOLS_DIR=%ROOT%\.tools"
set "NODE_ROOT=%TOOLS_DIR%\node"
set "NODE_EXE=%NODE_ROOT%\node.exe"
set "NPM_CMD=%NODE_ROOT%\npm.cmd"
set "DOTNET_ROOT=%TOOLS_DIR%\dotnet"
set "DOTNET_EXE=%DOTNET_ROOT%\dotnet.exe"
set "HELPER_OUTPUT=%ROOT%\native\windows-capture-helper\bin\mode-compare\net8.0-windows"
set "HELPER_DLL=%HELPER_OUTPUT%\WindowsCaptureHelper.dll"
set "HOST_BAT=%ROOT%\host-listener.bat"
set "HELPER_BAT=%ROOT%\start-helper.bat"

if not exist "%TOOLS_DIR%" mkdir "%TOOLS_DIR%"
if not exist "%ROOT%\.dotnet-cli" mkdir "%ROOT%\.dotnet-cli"
if not exist "%ROOT%\.nuget" mkdir "%ROOT%\.nuget"
if not exist "%ROOT%\.nuget\packages" mkdir "%ROOT%\.nuget\packages"

if not exist "%ROOT%\.nuget\NuGet.Config" (
  > "%ROOT%\.nuget\NuGet.Config" echo ^<?xml version="1.0" encoding="utf-8"?^>
  >> "%ROOT%\.nuget\NuGet.Config" echo ^<configuration^>
  >> "%ROOT%\.nuget\NuGet.Config" echo   ^<packageSources^>
  >> "%ROOT%\.nuget\NuGet.Config" echo     ^<clear /^>
  >> "%ROOT%\.nuget\NuGet.Config" echo     ^<add key="nuget.org" value="https://api.nuget.org/v3/index.json" /^>
  >> "%ROOT%\.nuget\NuGet.Config" echo   ^</packageSources^>
  >> "%ROOT%\.nuget\NuGet.Config" echo ^</configuration^>
)

> "%LOG_FILE%" echo ==== WifiAudioProjector host run started %date% %time% ====

set "PATH=%NODE_ROOT%;%DOTNET_ROOT%;%PATH%"
set "DOTNET_CLI_HOME=%ROOT%\.dotnet-cli"
set "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1"
set "DOTNET_CLI_TELEMETRY_OPTOUT=1"
set "NUGET_PACKAGES=%ROOT%\.nuget\packages"
set "NUGET_CONFIG_FILE=%ROOT%\.nuget\NuGet.Config"
set "APPDATA=%ROOT%\.dotnet-cli"

call :announce "Checking for Node:"
if exist "%NODE_EXE%" (
  call :announce "Success"
) else (
  call :announce "Node not found, obtaining Node..."
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\bootstrap-runtime.ps1" -ProjectRoot "%ROOT%" -EnsureNode >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto bootstrap_failed
  call :announce "Success"
)

call :announce "Checking for .NET:"
if exist "%DOTNET_EXE%" (
  call :announce "Success"
) else (
  call :announce ".NET not found, obtaining .NET..."
  powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\bootstrap-runtime.ps1" -ProjectRoot "%ROOT%" -EnsureDotnet >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto bootstrap_failed
  call :announce "Success"
)

call :announce "Checking for Electron and npm dependencies:"
if exist "%ROOT%\node_modules\.bin\electron.cmd" (
  call :announce "Success"
) else (
  call :announce "Electron not found, obtaining npm dependencies..."
  call "%NPM_CMD%" ci >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto npm_failed
  call :announce "Success"
)

call :announce "Checking host build output:"
set "HOST_BUILD_READY="
if exist "%ROOT%\apps\host\dist\main.js" (
  if exist "%ROOT%\packages\protocol\dist\index.js" (
    set "HOST_BUILD_READY=1"
  )
)

if defined HOST_BUILD_READY (
  call :announce "Success"
) else (
  call :announce "Build output not found, building project..."
  call "%NPM_CMD%" run build >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto build_failed
  call :announce "Success"
)

call :announce "Checking Windows capture helper:"
if exist "%HELPER_DLL%" (
  call :announce "Success"
) else (
  call :announce "Helper not found, building helper..."
  "%DOTNET_EXE%" build "%ROOT%\native\windows-capture-helper\WindowsCaptureHelper.csproj" -c Release -o "%HELPER_OUTPUT%" >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto helper_failed
  call :announce "Success"
)

call :announce "Starting host in background..."
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c ""%HOST_BAT%""' -WindowStyle Hidden -WorkingDirectory '%ROOT%'"

ping 127.0.0.1 -n 6 >nul

call :announce "Starting helper minimized..."
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c ""%HELPER_BAT%""' -WindowStyle Minimized -WorkingDirectory '%ROOT%'"

call :announce "Launched WifiAudioProjector."
call :announce "Log saved to %LOG_FILE%"
endlocal
exit /b 0

:bootstrap_failed
call :announce "Runtime bootstrap failed. See %LOG_FILE% for details."
pause
endlocal
exit /b 1

:npm_failed
call :announce "npm dependency restore failed. See %LOG_FILE% for details."
pause
endlocal
exit /b 1

:build_failed
call :announce "Project build failed. See %LOG_FILE% for details."
pause
endlocal
exit /b 1

:helper_failed
call :announce "Helper build failed. See %LOG_FILE% for details."
pause
endlocal
exit /b 1

:announce
echo %~1
>> "%LOG_FILE%" echo %~1
exit /b 0
