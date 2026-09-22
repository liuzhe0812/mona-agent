[CmdletBinding()]
param(
  [switch]$NoBundle
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-PathWithinDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Directory,
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $resolvedDirectory = [IO.Path]::GetFullPath($Directory).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $directoryPrefix = $resolvedDirectory + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedPath.StartsWith($directoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Description escapes its containing directory: $Path"
  }

  return $resolvedPath
}

function Assert-NoReparsePoints {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Directory,
    [Parameter(Mandatory = $true)]
    [string]$Description
  )

  $resolvedPath = [IO.Path]::GetFullPath($Path)
  $resolvedDirectory = [IO.Path]::GetFullPath($Directory).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $directoryPrefix = $resolvedDirectory + [IO.Path]::DirectorySeparatorChar
  if ($resolvedPath -ne $resolvedDirectory -and -not $resolvedPath.StartsWith($directoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Description is outside its checked directory: $Path"
  }

  $currentPath = $resolvedPath
  while ($true) {
    $currentItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
    if (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Description uses a reparse point, which is not allowed in a release resource path: $currentPath"
    }
    if ($currentPath -eq $resolvedDirectory) {
      break
    }
    $parentPath = Split-Path -Parent $currentPath
    if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -eq $currentPath) {
      throw "Could not validate the containing directory for $($Description): $Path"
    }
    $currentPath = $parentPath
  }
}

function Get-OfficeSidecarManifestState {
  param(
    [Parameter(Mandatory = $true)]
    [string]$GatewayDirectory
  )

  $gatewayDirectoryCandidate = [IO.Path]::GetFullPath($GatewayDirectory)
  $resolvedGatewayDirectory = (Resolve-Path -LiteralPath $gatewayDirectoryCandidate -ErrorAction Stop).Path
  $officeDirectory = Join-Path $gatewayDirectoryCandidate "_internal\desktop-resources\office-editor"
  if (-not (Test-Path -LiteralPath $officeDirectory -PathType Container)) {
    throw "Bundled Office resource directory was not found: $officeDirectory"
  }
  Assert-NoReparsePoints -Path $officeDirectory -Directory $gatewayDirectoryCandidate -Description "Bundled Office resource directory"
  $resolvedOfficeDirectory = (Resolve-Path -LiteralPath $officeDirectory -ErrorAction Stop).Path

  $manifestPath = Join-Path $resolvedOfficeDirectory "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Bundled Office resource manifest was not found: $manifestPath"
  }
  Assert-NoReparsePoints -Path $manifestPath -Directory $officeDirectory -Description "Office manifest"
  $resolvedManifestPath = (Resolve-Path -LiteralPath $manifestPath -ErrorAction Stop).Path
  Assert-PathWithinDirectory -Path $resolvedManifestPath -Directory $resolvedOfficeDirectory -Description "Office manifest" | Out-Null

  try {
    $manifest = Get-Content -LiteralPath $resolvedManifestPath -Raw | ConvertFrom-Json
  } catch {
    throw "Could not parse bundled Office manifest $resolvedManifestPath`: $($_.Exception.Message)"
  }

  if ($manifest.schemaVersion -ne 1 -or [string]$manifest.platform -ne "windows" -or [string]$manifest.arch -ne "x64") {
    throw "Bundled Office manifest must target schemaVersion=1, platform=windows, arch=x64: $resolvedManifestPath"
  }
  foreach ($templateRelativePath in @("templates\blank.docx", "templates\blank.xlsx", "templates\blank.pptx")) {
    $templatePath = Join-Path $officeDirectory $templateRelativePath
    if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
      throw "Bundled Office template was not found: $templatePath"
    }
    Assert-NoReparsePoints -Path $templatePath -Directory $officeDirectory -Description "Office template"
  }
  $licensesDirectory = Join-Path $officeDirectory "licenses"
  if (-not (Test-Path -LiteralPath $licensesDirectory -PathType Container)) {
    throw "Bundled Office licenses directory was not found: $licensesDirectory"
  }
  Assert-NoReparsePoints -Path $licensesDirectory -Directory $officeDirectory -Description "Office licenses directory"

  $sidecarProperty = $manifest.PSObject.Properties["xlsxSidecar"]
  if ($null -eq $sidecarProperty -or $null -eq $sidecarProperty.Value) {
    throw "Bundled Office manifest does not define xlsxSidecar: $resolvedManifestPath"
  }
  $sidecarEntry = $sidecarProperty.Value

  $sidecarRelativePath = [string]$sidecarEntry.path
  if ([string]::IsNullOrWhiteSpace($sidecarRelativePath)) {
    throw "Bundled Office manifest has an empty xlsxSidecar.path: $resolvedManifestPath"
  }
  if ([IO.Path]::IsPathRooted($sidecarRelativePath)) {
    throw "Bundled Office xlsxSidecar.path must be relative: $sidecarRelativePath"
  }

  $sidecarCandidatePath = Join-Path $resolvedOfficeDirectory ($sidecarRelativePath -replace '/', '\')
  if (-not (Test-Path -LiteralPath $sidecarCandidatePath -PathType Leaf)) {
    throw "Bundled Office xlsx sidecar was not found: $sidecarCandidatePath"
  }
  Assert-NoReparsePoints -Path $sidecarCandidatePath -Directory $officeDirectory -Description "Office xlsxSidecar.path"
  $resolvedSidecarPath = (Resolve-Path -LiteralPath $sidecarCandidatePath -ErrorAction Stop).Path
  Assert-PathWithinDirectory -Path $resolvedSidecarPath -Directory $resolvedOfficeDirectory -Description "Office xlsxSidecar.path" | Out-Null

  $declaredSizeProperty = $sidecarEntry.PSObject.Properties["size"]
  $declaredHashProperty = $sidecarEntry.PSObject.Properties["sha256"]
  if ($null -eq $declaredSizeProperty -or $null -eq $declaredHashProperty) {
    throw "Bundled Office xlsxSidecar must declare size and sha256: $resolvedManifestPath"
  }
  try {
    $declaredSize = [int64]$declaredSizeProperty.Value
  } catch {
    throw "Bundled Office xlsxSidecar.size is not an integer: $resolvedManifestPath"
  }
  if ($declaredSize -lt 0) {
    throw "Bundled Office xlsxSidecar.size cannot be negative: $resolvedManifestPath"
  }
  $declaredHash = [string]$declaredHashProperty.Value
  if ($declaredHash -notmatch "^[0-9a-fA-F]{64}$") {
    throw "Bundled Office xlsxSidecar.sha256 is not a SHA-256 value: $resolvedManifestPath"
  }

  $sidecar = Get-Item -LiteralPath $resolvedSidecarPath -ErrorAction Stop
  $actualHash = (Get-FileHash -LiteralPath $resolvedSidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sidecar.Length -ne $declaredSize -or $actualHash -ne $declaredHash.ToLowerInvariant()) {
    throw "Bundled Office xlsx sidecar does not match manifest before signing: $resolvedSidecarPath"
  }

  return [pscustomobject]@{
    GatewayDirectory          = $resolvedGatewayDirectory
    OfficeDirectory           = $resolvedOfficeDirectory
    OfficeDirectoryCandidate = $officeDirectory
    ManifestPath              = $resolvedManifestPath
    ManifestPathCandidate     = $manifestPath
    Manifest                  = $manifest
    SidecarPath               = $resolvedSidecarPath
  }
}

function Update-OfficeSidecarManifest {
  param(
    [Parameter(Mandatory = $true)]
    [pscustomobject]$ManifestState
  )

  $manifest = $ManifestState.Manifest
  $officeDirectory = [string]$ManifestState.OfficeDirectoryCandidate
  if ([string]::IsNullOrWhiteSpace($officeDirectory)) {
    $officeDirectory = $ManifestState.OfficeDirectory
  }
  $manifestPath = [string]$ManifestState.ManifestPathCandidate
  if ([string]::IsNullOrWhiteSpace($manifestPath)) {
    $manifestPath = $ManifestState.ManifestPath
  }
  Assert-NoReparsePoints -Path $manifestPath -Directory $officeDirectory -Description "Office manifest"
  $sidecarRelativePath = [string]$manifest.xlsxSidecar.path
  if ([string]::IsNullOrWhiteSpace($sidecarRelativePath) -or [IO.Path]::IsPathRooted($sidecarRelativePath)) {
    throw "Bundled Office xlsxSidecar.path must remain a relative path after signing."
  }
  $sidecarCandidatePath = Join-Path $officeDirectory ($sidecarRelativePath -replace '/', '\')
  if (-not (Test-Path -LiteralPath $sidecarCandidatePath -PathType Leaf)) {
    throw "Bundled Office xlsx sidecar was not found after signing: $sidecarCandidatePath"
  }
  Assert-NoReparsePoints -Path $sidecarCandidatePath -Directory $officeDirectory -Description "Office xlsxSidecar.path"
  $resolvedSidecarPath = (Resolve-Path -LiteralPath $sidecarCandidatePath -ErrorAction Stop).Path
  Assert-PathWithinDirectory -Path $resolvedSidecarPath -Directory $ManifestState.OfficeDirectory -Description "Office xlsxSidecar.path" | Out-Null

  $sidecar = Get-Item -LiteralPath $resolvedSidecarPath -ErrorAction Stop
  $sidecarHash = (Get-FileHash -LiteralPath $resolvedSidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()

  # Only these two manifest fields describe bytes changed by Authenticode.
  $manifest.xlsxSidecar.size = [int64]$sidecar.Length
  $manifest.xlsxSidecar.sha256 = $sidecarHash

  $manifestDirectory = Split-Path -Parent $manifestPath
  $temporaryManifestPath = Join-Path $manifestDirectory (".manifest.json.$PID.tmp")
  try {
    $json = $manifest | ConvertTo-Json -Depth 100
    $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($temporaryManifestPath, $json, $utf8WithoutBom)
    Move-Item -LiteralPath $temporaryManifestPath -Destination $manifestPath -Force
  } catch {
    if (Test-Path -LiteralPath $temporaryManifestPath -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryManifestPath -Force -ErrorAction SilentlyContinue
    }
    throw "Could not refresh bundled Office manifest $manifestPath`: $($_.Exception.Message)"
  }
}

$srcTauriDirectory = (Resolve-Path -LiteralPath $PSScriptRoot -ErrorAction Stop).Path
$releaseSigner = Join-Path $srcTauriDirectory "sign-update-artifact.mjs"
$gatewayDirectory = Join-Path $srcTauriDirectory "resources\mona-gateway"
$tauriConfigPath = Join-Path $srcTauriDirectory "tauri.conf.json"

if (-not (Test-Path -LiteralPath $releaseSigner -PathType Leaf)) {
  throw "Windows update signer was not found: $releaseSigner"
}
if (-not (Test-Path -LiteralPath $gatewayDirectory -PathType Container)) {
  throw "Bundled gateway directory was not found: $gatewayDirectory"
}

$resolvedTauriConfigPath = (Resolve-Path -LiteralPath $tauriConfigPath -ErrorAction Stop).Path
try {
  $tauriConfig = Get-Content -LiteralPath $resolvedTauriConfigPath -Raw | ConvertFrom-Json
} catch {
  throw "Could not parse Tauri release config $resolvedTauriConfigPath`: $($_.Exception.Message)"
}
$releaseVersion = [string]$tauriConfig.version
if ([string]::IsNullOrWhiteSpace($releaseVersion)) {
  throw "Tauri release config does not define a product version: $resolvedTauriConfigPath"
}
$productName = [string]$tauriConfig.productName
if ([string]::IsNullOrWhiteSpace($productName)) {
  throw "Tauri release config does not define productName: $resolvedTauriConfigPath"
}

$configuredTargetDirectory = $env:CARGO_TARGET_DIR
if ([string]::IsNullOrWhiteSpace($configuredTargetDirectory)) {
  $targetDirectory = [IO.Path]::GetFullPath((Join-Path $srcTauriDirectory "target"))
} elseif ([IO.Path]::IsPathRooted($configuredTargetDirectory)) {
  $targetDirectory = [IO.Path]::GetFullPath($configuredTargetDirectory)
} else {
  # cargo is invoked from src-tauri below, so resolve a relative target dir
  # against the same directory that cargo will use as its working directory.
  $targetDirectory = [IO.Path]::GetFullPath((Join-Path $srcTauriDirectory $configuredTargetDirectory))
}
$releaseDirectory = Join-Path $targetDirectory "release"
$mainExecutable = Join-Path $releaseDirectory "mona-desktop.exe"
$installerDirectory = Join-Path $releaseDirectory "bundle\nsis"
$installerFileName = "{0}_{1}_x64-setup.exe" -f ($productName -replace "[^A-Za-z0-9._-]", "_"), $releaseVersion
$installerPath = Join-Path $installerDirectory $installerFileName

# Validate the unsigned bytes before any signer can mutate them. This reads
# only the packaged Gateway copy; the source manifest is never rewritten.
$null = Get-OfficeSidecarManifestState -GatewayDirectory $gatewayDirectory

$buildStartedAt = [DateTime]::UtcNow
Push-Location $srcTauriDirectory
try {
  $tauriArguments = @("tauri", "build", "--config", "tauri.windows.release.conf.json")
  if ($NoBundle) {
    $tauriArguments += "--no-bundle"
  } else {
    $tauriArguments += @("--bundles", "nsis")
  }
  & cargo @tauriArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri Windows release build failed."
  }
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $mainExecutable -PathType Leaf)) {
  throw "Built Mona executable was not found: $mainExecutable"
}
$mainFile = Get-Item -LiteralPath $mainExecutable
$mainProductVersion = [string]$mainFile.VersionInfo.ProductVersion
if ($mainProductVersion -ne $releaseVersion) {
  throw "Built Mona executable version $mainProductVersion does not match Tauri version $($releaseVersion): $mainExecutable"
}
if (-not $NoBundle) {
  # Verify exactly this release's NSIS output. Do not accept an older MSI or
  # installer merely because it happens to be present under target/release.
  if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "NSIS installer for version $releaseVersion was not produced: $installerPath"
  }
  $installerFile = Get-Item -LiteralPath $installerPath
  if ($installerFile.LastWriteTimeUtc -lt $buildStartedAt) {
    throw "NSIS installer was not refreshed by this build: $installerPath"
  }
  & node $releaseSigner $installerPath
  if ($LASTEXITCODE -ne 0) {
    throw "NSIS installer Ed25519 signing failed: $installerPath"
  }
  if (-not (Test-Path -LiteralPath "$installerPath.sig" -PathType Leaf)) {
    throw "NSIS installer signature was not produced: $installerPath.sig"
  }
}

Write-Host "Windows release verification passed for Mona $releaseVersion (free Ed25519 update signature)."
