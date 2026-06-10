$PythonVersion = "3.12.13"
$ReleaseTag = "20260510"
$Platform = "x86_64-pc-windows-msvc"
$BaseUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$ReleaseTag"
$FileName = "cpython-$PythonVersion+$ReleaseTag-$Platform-install_only.tar.gz"

$ResourcesDir = "src-tauri\resources"
$PythonArchive = "$ResourcesDir\python.tar.gz"

$TempDir = "$env:TEMP\mona-python-build"
$PythonDir = Get-ChildItem -Path $TempDir -Directory -Recurse -Filter "python" |
    Where-Object { Test-Path (Join-Path $_.FullName "python.exe") } |
    Select-Object -First 1

$PythonExe = Join-Path $PythonDir.FullName "python.exe"
Write-Output "Found Python at: $PythonExe"

# Verify installation
Push-Location "C:\"
$monaFile = & $PythonExe -c "import mona; print(mona.__file__)" 2>&1
Pop-Location
Write-Output "mona.__file__ = $monaFile"

# Strip caches
Write-Output "Stripping caches..."
Get-ChildItem $PythonDir.FullName -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force
Get-ChildItem $PythonDir.FullName -Recurse -File -Filter "*.pyc" |
    Remove-Item -Force
Get-ChildItem $PythonDir.FullName -Recurse -File -Filter "*.pyo" |
    Remove-Item -Force

# Re-pack into python.tar.gz
Write-Output "Re-packing python.tar.gz..."
tar -czf $PythonArchive -C $PythonDir.Parent.FullName (Split-Path $PythonDir.FullName -Leaf)

$Size = (Get-Item $PythonArchive).Length
Write-Output "python.tar.gz created: $Size bytes"
