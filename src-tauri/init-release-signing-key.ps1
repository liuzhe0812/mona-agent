[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$keyDirectory = Join-Path $env:LOCALAPPDATA "Mona\release-keys"
$keyPath = Join-Path $keyDirectory "mona-update.key"
$publicKeyPath = "$keyPath.pub"
$passwordPath = "$keyPath.password"

foreach ($path in @($keyPath, $publicKeyPath, $passwordPath)) {
  if (Test-Path -LiteralPath $path) {
    throw "Mona release key already exists; refusing to overwrite: $path"
  }
}

New-Item -ItemType Directory -Force -Path $keyDirectory | Out-Null
$passwordBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes)
$password = [Convert]::ToBase64String($passwordBytes)
$logPath = Join-Path $env:TEMP "mona-signer-generate.log"

try {
  & cargo tauri signer generate --ci --password $password -w $keyPath *> $logPath
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri signer key generation failed."
  }
  [IO.File]::WriteAllText($passwordPath, $password, [Text.UTF8Encoding]::new($false))

  $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $keyDirectory /inheritance:r /grant:r `
    "*$($userSid):(OI)(CI)F" `
    "*S-1-5-18:(OI)(CI)F" `
    "*S-1-5-32-544:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to restrict the Mona release key directory ACL."
  }
} finally {
  Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
}

Write-Host "Mona release signing key initialized at $keyDirectory"

