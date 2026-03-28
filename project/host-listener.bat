@echo off
setlocal
cd /d "%~dp0"
set "PROJECT_DIR=%CD%"
for %%I in ("%PROJECT_DIR%\..") do set "ROOT=%%~fI"
set "NODE_ROOT=%ROOT%\.tools\node"
set "DOTNET_ROOT=%ROOT%\.tools\dotnet"
set "NODE_MODULES_DIR=%ROOT%\node_modules"
set "ELECTRON_CMD=%NODE_MODULES_DIR%\.bin\electron.cmd"
set "HOST_MAIN=%PROJECT_DIR%\apps\host\dist\main.js"
set "PATH=%NODE_ROOT%;%DOTNET_ROOT%;%NODE_MODULES_DIR%\.bin;%PATH%"
set "NODE_PATH=%NODE_MODULES_DIR%"
set "DOTNET_CLI_HOME=%ROOT%\.dotnet-cli"
set "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1"
set "DOTNET_CLI_TELEMETRY_OPTOUT=1"
set "NUGET_PACKAGES=%ROOT%\.nuget\packages"
set "NUGET_CONFIG_FILE=%ROOT%\.nuget\NuGet.Config"
set "APPDATA=%ROOT%\.dotnet-cli"
set "WIFI_AUDIO_LOG_DIR=%ROOT%\logs"
set "WIFI_AUDIO_HELPER_EXTERNAL=1"
set "WIFI_AUDIO_HELPER_PORT=39393"
set "WIFI_AUDIO_WEB_PORT=39394"

if not exist "%ELECTRON_CMD%" (
  echo Electron launcher not found. Run Update WifiAudioProjector Dependencies.bat to install dependencies.
  pause
  endlocal
  exit /b 1
)

if not exist "%HOST_MAIN%" (
  echo Host build output not found. Run Update WifiAudioProjector Dependencies.bat to install dependencies.
  pause
  endlocal
  exit /b 1
)

call "%ELECTRON_CMD%" "%HOST_MAIN%"
endlocal
