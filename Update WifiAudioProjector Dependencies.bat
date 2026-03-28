@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "ROOT=%CD%"
set "PROJECT_DIR=%ROOT%\project"
set "LOG_DIR=%ROOT%\logs"
set "TOOLS_DIR=%ROOT%\.tools"
set "NODE_ROOT=%TOOLS_DIR%\node"
set "NODE_EXE=%NODE_ROOT%\node.exe"
set "NPM_CMD=%NODE_ROOT%\npm.cmd"
set "DOTNET_ROOT=%TOOLS_DIR%\dotnet"
set "DOTNET_EXE=%DOTNET_ROOT%\dotnet.exe"
set "NODE_MODULES_DIR=%ROOT%\node_modules"
set "DOTNET_CLI_HOME=%ROOT%\.dotnet-cli"
set "NUGET_ROOT=%ROOT%\.nuget"
set "NUGET_PACKAGES=%NUGET_ROOT%\packages"
set "NUGET_CONFIG_FILE=%NUGET_ROOT%\NuGet.Config"
set "HELPER_OUTPUT=%PROJECT_DIR%\native\windows-capture-helper\bin\mode-compare\net8.0-windows"
set "START_BAT=%ROOT%\Start WifiAudioProjector.bat"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if not exist "%TOOLS_DIR%" mkdir "%TOOLS_DIR%"
if not exist "%DOTNET_CLI_HOME%" mkdir "%DOTNET_CLI_HOME%"
if not exist "%NUGET_ROOT%" mkdir "%NUGET_ROOT%"
if not exist "%NUGET_PACKAGES%" mkdir "%NUGET_PACKAGES%"

if not exist "%NUGET_CONFIG_FILE%" (
  > "%NUGET_CONFIG_FILE%" echo ^<?xml version="1.0" encoding="utf-8"?^>
  >> "%NUGET_CONFIG_FILE%" echo ^<configuration^>
  >> "%NUGET_CONFIG_FILE%" echo   ^<packageSources^>
  >> "%NUGET_CONFIG_FILE%" echo     ^<clear /^>
  >> "%NUGET_CONFIG_FILE%" echo     ^<add key="nuget.org" value="https://api.nuget.org/v3/index.json" /^>
  >> "%NUGET_CONFIG_FILE%" echo   ^</packageSources^>
  >> "%NUGET_CONFIG_FILE%" echo ^</configuration^>
)

set "STAMP=%DATE:~10,4%-%DATE:~4,2%-%DATE:~7,2%_%TIME:~0,2%-%TIME:~3,2%-%TIME:~6,2%"
set "STAMP=%STAMP: =0%"
set "LOG_FILE=%LOG_DIR%\dependency-update-%STAMP%.log"

set "PATH=%NODE_ROOT%;%DOTNET_ROOT%;%NODE_MODULES_DIR%\.bin;%PATH%"
set "NODE_PATH=%NODE_MODULES_DIR%"
set "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1"
set "DOTNET_CLI_TELEMETRY_OPTOUT=1"
set "APPDATA=%DOTNET_CLI_HOME%"

> "%LOG_FILE%" echo ==== WifiAudioProjector dependency update started %date% %time% ====
echo WifiAudioProjector Dependency Update
echo.
echo This script manages:
echo   - .tools\node ^(Node.js runtime 20.11.1^)
echo   - .tools\dotnet ^(.NET SDK 8.0^)
echo   - node_modules ^(Electron, Express, ws, qrcode, bonjour-service, @roamhq/wrtc, TypeScript^)
echo   - .nuget, .dotnet-cli, logs
echo   - project\apps\host\dist and project\packages\protocol\dist
echo   - project\native\windows-capture-helper\bin and obj
echo.
echo Stopping any running WAP processes first...
>> "%LOG_FILE%" echo Stopping any running WAP processes first...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$repo=[System.IO.Path]::GetFullPath('%ROOT%'); $targets=Get-Process electron,node,WindowsCaptureHelper -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and ([System.IO.Path]::GetFullPath($_.Path)).StartsWith($repo, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false } }; if ($targets) { $targets | Stop-Process -Force }" >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
  echo Could not automatically stop running WAP processes. Continuing anyway...
  >> "%LOG_FILE%" echo Could not automatically stop running WAP processes. Continuing anyway...
) else (
  echo Finished stopping any running WAP processes.
  >> "%LOG_FILE%" echo Finished stopping any running WAP processes.
)

echo Updating dependency bundle:
echo  - .tools\node
echo  - .tools\dotnet
echo  - node_modules
echo  - project\apps\host\dist
echo  - project\packages\protocol\dist
echo  - project\native\windows-capture-helper
>> "%LOG_FILE%" echo Updating dependency bundle:
>> "%LOG_FILE%" echo  - .tools\node
>> "%LOG_FILE%" echo  - .tools\dotnet
>> "%LOG_FILE%" echo  - node_modules
>> "%LOG_FILE%" echo  - project\apps\host\dist
>> "%LOG_FILE%" echo  - project\packages\protocol\dist
>> "%LOG_FILE%" echo  - project\native\windows-capture-helper

echo Checking for Node:
>> "%LOG_FILE%" echo Checking for Node:
if exist "%NODE_EXE%" (
  echo Success
  >> "%LOG_FILE%" echo Success
) else (
  echo Node not found, obtaining Node...
  >> "%LOG_FILE%" echo Node not found, obtaining Node...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\bootstrap-runtime.ps1" -ProjectRoot "%ROOT%" -EnsureNode >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto bootstrap_failed
  echo Success
  >> "%LOG_FILE%" echo Success
)

echo Checking for .NET:
>> "%LOG_FILE%" echo Checking for .NET:
if exist "%DOTNET_EXE%" (
  echo Success
  >> "%LOG_FILE%" echo Success
) else (
  echo .NET not found, obtaining .NET...
  >> "%LOG_FILE%" echo .NET not found, obtaining .NET...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\bootstrap-runtime.ps1" -ProjectRoot "%ROOT%" -EnsureDotnet >> "%LOG_FILE%" 2>&1
  if errorlevel 1 goto bootstrap_failed
  echo Success
  >> "%LOG_FILE%" echo Success
)

echo Refreshing Electron and npm dependencies...
>> "%LOG_FILE%" echo Refreshing Electron and npm dependencies...
call "%NPM_CMD%" ci >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto npm_failed
echo Success
>> "%LOG_FILE%" echo Success

echo Building host and protocol output...
>> "%LOG_FILE%" echo Building host and protocol output...
call "%NPM_CMD%" run build >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto build_failed
echo Success
>> "%LOG_FILE%" echo Success

echo Building Windows capture helper...
>> "%LOG_FILE%" echo Building Windows capture helper...
"%DOTNET_EXE%" build "%PROJECT_DIR%\native\windows-capture-helper\WindowsCaptureHelper.csproj" -c Release -o "%HELPER_OUTPUT%" >> "%LOG_FILE%" 2>&1
if errorlevel 1 goto helper_failed
echo Success
>> "%LOG_FILE%" echo Success

echo Dependency update complete.
echo Run "%START_BAT%" to start WAP.
>> "%LOG_FILE%" echo Dependency update complete.
>> "%LOG_FILE%" echo Run "%START_BAT%" to start WAP.
pause
endlocal
exit /b 0

:bootstrap_failed
echo Runtime bootstrap failed. See %LOG_FILE% for details.
>> "%LOG_FILE%" echo Runtime bootstrap failed. See %LOG_FILE% for details.
echo.
echo Recent log output:
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Tail 20 '%LOG_FILE%'"
echo.
pause
endlocal
exit /b 1

:npm_failed
echo npm dependency restore failed. See %LOG_FILE% for details.
>> "%LOG_FILE%" echo npm dependency restore failed. See %LOG_FILE% for details.
echo.
echo Recent log output:
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Tail 20 '%LOG_FILE%'"
echo.
pause
endlocal
exit /b 1

:build_failed
echo Project build failed. See %LOG_FILE% for details.
>> "%LOG_FILE%" echo Project build failed. See %LOG_FILE% for details.
echo.
echo Recent log output:
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Tail 20 '%LOG_FILE%'"
echo.
pause
endlocal
exit /b 1

:helper_failed
echo Helper build failed. See %LOG_FILE% for details.
>> "%LOG_FILE%" echo Helper build failed. See %LOG_FILE% for details.
echo.
echo Recent log output:
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Tail 20 '%LOG_FILE%'"
echo.
pause
endlocal
exit /b 1
