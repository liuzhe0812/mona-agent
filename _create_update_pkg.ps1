$StagingDir = "$env:TEMP\mona-update-staging"
if (Test-Path $StagingDir) { Remove-Item -Recurse -Force $StagingDir }
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null

Copy-Item "src-tauri\target\release\mona-desktop.exe" "$StagingDir\Mona.exe"
Copy-Item "src-tauri\resources\python.tar.gz" "$StagingDir\python.tar.gz"

$UpdatePackage = "dist\mona-1.0.2.tar.gz"
if (Test-Path "dist") {} else { New-Item -ItemType Directory -Path "dist" -Force | Out-Null }
tar -czf $UpdatePackage -C $StagingDir Mona.exe python.tar.gz

$Hash = (Get-FileHash $UpdatePackage -Algorithm SHA256).Hash.ToLower()
$Size = (Get-Item $UpdatePackage).Length

Write-Output "Update package: $UpdatePackage"
Write-Output "SHA256: $Hash"
Write-Output "Size: $Size bytes ($([math]::Round($Size / 1MB, 1)) MB)"
