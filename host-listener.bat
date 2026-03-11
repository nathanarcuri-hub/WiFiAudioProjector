@echo off
setlocal
cd /d "%~dp0"
set "ROOT=%CD%"
set "NODE_ROOT=%ROOT%\.tools\node"
set "DOTNET_ROOT=%ROOT%\.tools\dotnet"
set "PATH=%NODE_ROOT%;%DOTNET_ROOT%;%PATH%"
set "DOTNET_CLI_HOME=%ROOT%\.dotnet-cli"
set "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1"
set "DOTNET_CLI_TELEMETRY_OPTOUT=1"
set "NUGET_PACKAGES=%ROOT%\.nuget\packages"
set "NUGET_CONFIG_FILE=%ROOT%\.nuget\NuGet.Config"
set "APPDATA=%ROOT%\.dotnet-cli"
set "WIFI_AUDIO_HELPER_EXTERNAL=1"
set "WIFI_AUDIO_HELPER_PORT=39393"
set "WIFI_AUDIO_WEB_PORT=39394"

if not exist "%ROOT%\node_modules\.bin\electron.cmd" (
  echo Electron launcher not found. Run Start WifiAudioProjector.bat first.
  pause
  endlocal
  exit /b 1
)

call "%ROOT%\node_modules\.bin\electron.cmd" apps/host/dist/main.js
endlocal
