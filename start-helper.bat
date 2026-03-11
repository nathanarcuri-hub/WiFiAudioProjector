@echo off
setlocal
cd /d "%~dp0"
set "ROOT=%CD%"
set "LOG_DIR=%ROOT%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "HELPER_LOG=%LOG_DIR%\helper-launch.log"
set "DOTNET_ROOT=%ROOT%\.tools\dotnet"
set "DOTNET_EXE=%DOTNET_ROOT%\dotnet.exe"
set "PATH=%DOTNET_ROOT%;%PATH%"
set "DOTNET_CLI_HOME=%ROOT%\.dotnet-cli"
set "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1"
set "DOTNET_CLI_TELEMETRY_OPTOUT=1"
set "NUGET_PACKAGES=%ROOT%\.nuget\packages"
set "NUGET_CONFIG_FILE=%ROOT%\.nuget\NuGet.Config"
set "APPDATA=%ROOT%\.dotnet-cli"
set "HELPER_DLL=%ROOT%\native\windows-capture-helper\bin\mode-compare\net8.0-windows\WindowsCaptureHelper.dll"
set "FRAME_DURATION_MS=10"

> "%HELPER_LOG%" echo ==== Helper launch %date% %time% ====

if not exist "%DOTNET_EXE%" (
  echo .NET runtime not found. Run Start WifiAudioProjector.bat first. >> "%HELPER_LOG%"
  echo .NET runtime not found. Run Start WifiAudioProjector.bat first.
  endlocal
  exit /b 1
)

if not exist "%HELPER_DLL%" (
  echo Helper DLL not found. Run Start WifiAudioProjector.bat first. >> "%HELPER_LOG%"
  echo Helper DLL not found. Run Start WifiAudioProjector.bat first.
  endlocal
  exit /b 1
)

echo Running helper DLL... >> "%HELPER_LOG%"
"%DOTNET_EXE%" "%HELPER_DLL%" --port 39393 --frame-duration-ms %FRAME_DURATION_MS% --outbound-queue-capacity 8 >> "%HELPER_LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
echo Exit code: %EXIT_CODE% >> "%HELPER_LOG%"
endlocal
exit /b %EXIT_CODE%
