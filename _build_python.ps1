$ErrorActionPreference = "Continue"

$PythonVersion = "3.12.13"
$ReleaseTag = "20260510"
$Platform = "x86_64-pc-windows-msvc"
$BaseUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$ReleaseTag"
$FileName = "cpython-$PythonVersion+$ReleaseTag-$Platform-install_only.tar.gz"

$ResourcesDir = "src-tauri\resources"
$PythonArchive = "$ResourcesDir\python.tar.gz"

# 1. Download python-build-standalone (skip if exists)
if (-not (Test-Path $PythonArchive)) {
    Write-Output "Downloading python-build-standalone..."
    Invoke-WebRequest -Uri "$BaseUrl/$FileName" -OutFile $PythonArchive -UseBasicParsing
} else {
    Write-Output "python.tar.gz already exists, skipping download"
}

# 2. Extract to temp dir
$TempDir = "$env:TEMP\mona-python-build"
if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
Write-Output "Extracting python..."
tar -xzf $PythonArchive -C $TempDir

# 3. Find the python directory
$PythonDir = Get-ChildItem -Path $TempDir -Directory -Recurse -Filter "python" |
    Where-Object { Test-Path (Join-Path $_.FullName "python.exe") } |
    Select-Object -First 1

if (-not $PythonDir) {
    throw "Could not find python directory"
}

$PythonExe = Join-Path $PythonDir.FullName "python.exe"
Write-Output "Found Python at: $PythonExe"

# 4. Install mona-ai with ALL optional dependencies (NON-EDITABLE)
Write-Output "Installing mona-ai..."
& $PythonExe -m pip install ".[api,wecom,weixin,pdf]" --no-warn-script-location 2>&1 | Select-Object -Last 5

# 5. Verify installation
Push-Location "C:\"
$monaFile = & $PythonExe -c "import mona; print(mona.__file__)" 2>&1
Pop-Location
Write-Output "mona.__file__ = $monaFile"
if ($monaFile -notmatch "site-packages") {
    throw "mona-ai installed in editable mode!"
}

# Verify sqlite-vec is installed
$vecCheck = & $PythonExe -c "import sqlite_vec; print('sqlite-vec OK')" 2>&1
Write-Output "sqlite-vec check: $vecCheck"

# Verify lancedb is NOT installed
$lanceCheck = & $PythonExe -c "import lancedb" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Output "WARNING: lancedb is still installed, removing..."
    & $PythonExe -m pip uninstall lancedb pyarrow -y 2>&1 | Select-Object -Last 3
}

# 6. Strip caches
Write-Output "Stripping caches..."
Get-ChildItem $PythonDir.FullName -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force
Get-ChildItem $PythonDir.FullName -Recurse -File -Filter "*.pyc" |
    Remove-Item -Force
Get-ChildItem $PythonDir.FullName -Recurse -File -Filter "*.pyo" |
    Remove-Item -Force

# 7. Re-pack into python.tar.gz
Write-Output "Re-packing python.tar.gz..."
tar -czf $PythonArchive -C $PythonDir.Parent.FullName (Split-Path $PythonDir.FullName -Leaf)

$Size = (Get-Item $PythonArchive).Length
Write-Output "python.tar.gz created: $([math]::Round($Size / 1MB, 1)) MB"
