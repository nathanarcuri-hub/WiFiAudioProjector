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
set "ELECTRON_CMD=%NODE_MODULES_DIR%\.bin\electron.cmd"
set "DOTNET_CLI_HOME=%ROOT%\.dotnet-cli"
set "NUGET_ROOT=%ROOT%\.nuget"
set "NUGET_PACKAGES=%NUGET_ROOT%\packages"
set "NUGET_CONFIG_FILE=%NUGET_ROOT%\NuGet.Config"
set "HOST_BUILD_DIR=%PROJECT_DIR%\apps\host\dist"
set "HOST_MAIN=%HOST_BUILD_DIR%\main.js"
set "PROTOCOL_BUILD_DIR=%PROJECT_DIR%\packages\protocol\dist"
set "PROTOCOL_MAIN=%PROTOCOL_BUILD_DIR%\index.js"
set "HELPER_OUTPUT=%PROJECT_DIR%\native\windows-capture-helper\bin\mode-compare\net8.0-windows"
set "HELPER_DLL=%HELPER_OUTPUT%\WindowsCaptureHelper.dll"
set "HOST_BAT=%PROJECT_DIR%\host-listener.bat"
set "HELPER_BAT=%PROJECT_DIR%\start-helper.bat"
set "WIFI_AUDIO_LOG_DIR=%LOG_DIR%"
set "UPDATE_BAT=%ROOT%\Update WifiAudioProjector Dependencies.bat"

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
set "LOG_FILE=%LOG_DIR%\run-host-%STAMP%.log"

set "PATH=%NODE_ROOT%;%DOTNET_ROOT%;%NODE_MODULES_DIR%\.bin;%PATH%"
set "NODE_PATH=%NODE_MODULES_DIR%"
set "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1"
set "DOTNET_CLI_TELEMETRY_OPTOUT=1"
set "APPDATA=%DOTNET_CLI_HOME%"
> "%LOG_FILE%" echo ==== WifiAudioProjector start requested %date% %time% ====
if not exist "%NODE_EXE%" goto start_requires_dependencies
if not exist "%DOTNET_EXE%" goto start_requires_dependencies
if not exist "%ELECTRON_CMD%" goto start_requires_dependencies
if not exist "%HOST_MAIN%" goto start_requires_dependencies
if not exist "%PROTOCOL_MAIN%" goto start_requires_dependencies
if not exist "%HELPER_DLL%" goto start_requires_dependencies

echo Starting WAP...
>> "%LOG_FILE%" echo Starting WAP...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c ""%HOST_BAT%""' -WindowStyle Hidden -WorkingDirectory '%ROOT%'"

ping 127.0.0.1 -n 6 >nul

echo Starting helper in background...
>> "%LOG_FILE%" echo Starting helper in background...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c ""%HELPER_BAT%""' -WindowStyle Hidden -WorkingDirectory '%ROOT%'"

echo Launched WifiAudioProjector.
echo Log saved to %LOG_FILE%
>> "%LOG_FILE%" echo Launched WifiAudioProjector.
>> "%LOG_FILE%" echo Log saved to %LOG_FILE%
endlocal
exit /b 0

:start_requires_dependencies
echo WAP is not ready to launch yet.
echo Run "%UPDATE_BAT%" to install or refresh dependencies.
>> "%LOG_FILE%" echo WAP is not ready to launch yet.
>> "%LOG_FILE%" echo Run "%UPDATE_BAT%" to install or refresh dependencies.
pause
endlocal
exit /b 1
