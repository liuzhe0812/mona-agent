[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$officeEditorRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $officeEditorRoot "..\..")).Path
$engineRoot = (Resolve-Path -LiteralPath (Join-Path $officeEditorRoot "vendor\genoffice\apps\sheets\native\xlsx-engine")).Path
$cargoManifest = Join-Path $engineRoot "Cargo.toml"
$cargoConfig = Join-Path $engineRoot ".cargo\config.toml"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw "cargo was not found on PATH."
}
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
  throw "rustc was not found on PATH."
}

$rustcInfo = (& rustc -vV | Out-String)
$hostMatch = [regex]::Match($rustcInfo, "(?m)^host:\s*(.+)$")
if (-not $hostMatch.Success -or $hostMatch.Groups[1].Value.Trim() -ne "x86_64-pc-windows-msvc") {
  $rustHost = if ($hostMatch.Success) { $hostMatch.Groups[1].Value.Trim() } else { "unknown" }
  throw "xlsx-sidecar requires the Windows x64 MSVC Rust host; found '$rustHost'."
}

$cargoConfigText = Get-Content -Raw -LiteralPath $cargoConfig
if ($cargoConfigText -notmatch "\[target\.x86_64-pc-windows-msvc\]" -or $cargoConfigText -notmatch "crt-static") {
  throw "The xlsx-sidecar Cargo config does not enable the required static MSVC CRT."
}

$cargoText = Get-Content -Raw -LiteralPath $cargoManifest
$versionMatch = [regex]::Match($cargoText, '(?m)^\s*version\s*=\s*"([^"]+)"\s*$')
if (-not $versionMatch.Success) {
  throw "Could not read the xlsx-sidecar version from $cargoManifest."
}
$version = $versionMatch.Groups[1].Value

Push-Location $engineRoot
try {
  & cargo build --release --manifest-path $cargoManifest --config $cargoConfig
  if ($LASTEXITCODE -ne 0) {
    throw "xlsx-sidecar release build failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
}

$builtSidecar = Join-Path $engineRoot "target\release\xlsx-sidecar.exe"
if (-not (Test-Path -LiteralPath $builtSidecar -PathType Leaf)) {
  throw "The release sidecar was not produced at $builtSidecar."
}

$resourceRoot = Join-Path $repoRoot "src-tauri\resources\office-editor"
$resourceSidecar = Join-Path $resourceRoot "sheets\xlsx-sidecar.exe"
$manifestPath = Join-Path $resourceRoot "manifest.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resourceSidecar) | Out-Null
Copy-Item -LiteralPath $builtSidecar -Destination $resourceSidecar -Force

$resourceFile = Get-Item -LiteralPath $resourceSidecar
$size = [int64]$resourceFile.Length
$sha256 = (Get-FileHash -LiteralPath $resourceSidecar -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
  schemaVersion = 1
  platform = "windows"
  arch = "x64"
  xlsxSidecar = [ordered]@{
    path = "sheets/xlsx-sidecar.exe"
    version = $version
    size = $size
    sha256 = $sha256
  }
}
[IO.File]::WriteAllText(
  $manifestPath,
  (($manifest | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
  [Text.UTF8Encoding]::new($false)
)

$writtenManifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$entry = $writtenManifest.xlsxSidecar
$resourceRootFull = [IO.Path]::GetFullPath($resourceRoot).TrimEnd("\") + "\"
$entryPath = [IO.Path]::GetFullPath((Join-Path $resourceRoot $entry.path))
if (-not $entryPath.StartsWith($resourceRootFull, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The xlsx-sidecar manifest entry escapes the office-editor resource directory."
}
if ($writtenManifest.schemaVersion -ne 1 -or $writtenManifest.platform -ne "windows" -or $writtenManifest.arch -ne "x64") {
  throw "The generated xlsx-sidecar manifest has invalid platform metadata."
}
if ($entry.version -ne $version -or $entry.size -ne $size -or $entry.sha256.ToLowerInvariant() -ne $sha256) {
  throw "The generated xlsx-sidecar manifest does not match the copied binary."
}
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  throw "The xlsx-sidecar manifest entry does not point to a file: $entryPath"
}

Write-Host "xlsx-sidecar release ready"
Write-Host "version: $version"
Write-Host "size: $size bytes"
Write-Host "sha256: $sha256"
Write-Host "entry: $entryPath"
