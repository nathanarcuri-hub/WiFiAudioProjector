param(
    [string]$ProjectRoot = (Get-Location).Path,
    [switch]$EnsureNode,
    [switch]$EnsureDotnet
)

$ErrorActionPreference = 'Stop'

if (-not $EnsureNode -and -not $EnsureDotnet) {
    $EnsureNode = $true
    $EnsureDotnet = $true
}

$toolsDir = Join-Path $ProjectRoot '.tools'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

function Get-NodeArchitecture {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        return 'arm64'
    }

    if ([Environment]::Is64BitOperatingSystem) {
        return 'x64'
    }

    return 'x86'
}

function Install-Node {
    $nodeVersion = '20.11.1'
    $nodeArch = Get-NodeArchitecture
    $nodeDir = Join-Path $toolsDir 'node'
    $nodeExe = Join-Path $nodeDir 'node.exe'

    if (Test-Path $nodeExe) {
        return
    }

    $nodeFolderName = "node-v$nodeVersion-win-$nodeArch"
    $archivePath = Join-Path $toolsDir "$nodeFolderName.zip"
    $extractRoot = Join-Path $toolsDir 'node-extract'
    $downloadUrl = "https://nodejs.org/dist/v$nodeVersion/$nodeFolderName.zip"

    Write-Host "Downloading Node from $downloadUrl"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath

    if (Test-Path $extractRoot) {
        Remove-Item -Recurse -Force $extractRoot
    }

    Expand-Archive -Path $archivePath -DestinationPath $extractRoot -Force

    $expandedDir = Join-Path $extractRoot $nodeFolderName
    if (-not (Test-Path $expandedDir)) {
        throw "Node archive did not contain $nodeFolderName"
    }

    if (Test-Path $nodeDir) {
        Remove-Item -Recurse -Force $nodeDir
    }

    Move-Item -Path $expandedDir -Destination $nodeDir
    Remove-Item -Recurse -Force $extractRoot
    Remove-Item -Force $archivePath
}

function Install-Dotnet {
    $dotnetDir = Join-Path $toolsDir 'dotnet'
    $dotnetExe = Join-Path $dotnetDir 'dotnet.exe'

    if (Test-Path $dotnetExe) {
        return
    }

    $installScript = Join-Path $ProjectRoot '.codex-dotnet-install.ps1'
    if (-not (Test-Path $installScript)) {
        throw 'The dotnet install script was not found.'
    }

    Write-Host 'Installing .NET SDK 8.0 locally'
    & $installScript -InstallDir $dotnetDir -Channel '8.0' -NoPath

    if (-not (Test-Path $dotnetExe)) {
        throw '.NET installation completed without producing dotnet.exe'
    }
}

if ($EnsureNode) {
    Install-Node
}

if ($EnsureDotnet) {
    Install-Dotnet
}
