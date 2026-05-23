$ErrorActionPreference = "Stop"

$PythonVersion = "3.12.9"
$PythonTag = "cpython-$PythonVersion+20250416"
$Platform = "x86_64-pc-windows-msvc"
$BaseUrl = "https://github.com/indygreg/python-build-standalone/releases/download/20250416"

$FileName = "$PythonTag-$Platform-install_only.tar.gz"
$Url = "$BaseUrl/$FileName"

$ResourcesDir = Join-Path $PSScriptRoot "resources"
if (-not (Test-Path $ResourcesDir)) {
    New-Item -ItemType Directory -Path $ResourcesDir -Force | Out-Null
}

$DestPath = Join-Path $ResourcesDir "python.tar.gz"

if (Test-Path $DestPath) {
    Write-Host "Python archive already exists at $DestPath"
    Write-Host "Delete it and re-run to download again."
    exit 0
}

Write-Host "Downloading python-build-standalone $PythonVersion for Windows..."
Write-Host "URL: $Url"

Invoke-WebRequest -Uri $Url -OutFile $DestPath -UseBasicParsing

$FileSize = (Get-Item $DestPath).Length / 1MB
Write-Host "Download complete. Size: $([math]::Round($FileSize, 1)) MB"
Write-Host "Saved to: $DestPath"
