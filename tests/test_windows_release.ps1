[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$productionScript = Join-Path $repositoryRoot "src-tauri\build-windows-release.ps1"
$tokens = $null
$parseErrors = $null
$productionAst = [System.Management.Automation.Language.Parser]::ParseFile(
  $productionScript,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
  throw ($parseErrors | Out-String)
}

# Load only the pure validation helpers. The production script body is never
# invoked, so this test cannot access a certificate, sign an artifact, or run cargo.
$functionNames = @(
  "Assert-PathWithinDirectory",
  "Assert-NoReparsePoints",
  "Get-OfficeSidecarManifestState",
  "Update-OfficeSidecarManifest"
)
$functionText = foreach ($functionName in $functionNames) {
  $functionAst = $productionAst.Find({
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $functionName
    }, $true)
  if ($null -eq $functionAst) {
    throw "Production helper was not found: $functionName"
  }
  $functionAst.Extent.Text
}
Invoke-Expression ($functionText -join "`n")

function New-OfficeFixture {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root
  )

  $officeDirectory = Join-Path $Root "_internal\desktop-resources\office-editor"
  New-Item -ItemType Directory -Path (Join-Path $officeDirectory "sheets") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $officeDirectory "templates") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $officeDirectory "licenses") -Force | Out-Null
  foreach ($templateName in @("blank.docx", "blank.xlsx", "blank.pptx")) {
    [IO.File]::WriteAllText((Join-Path $officeDirectory "templates\$templateName"), "template")
  }

  $sidecarPath = Join-Path $officeDirectory "sheets\xlsx-sidecar.exe"
  [IO.File]::WriteAllBytes($sidecarPath, [byte[]](1, 2, 3, 4))
  $sidecarHash = (Get-FileHash -LiteralPath $sidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $manifest = [ordered]@{
    schemaVersion = 1
    platform = "windows"
    arch = "x64"
    extra = [ordered]@{ keep = "yes" }
    xlsxSidecar = [ordered]@{
      path = "sheets/xlsx-sidecar.exe"
      version = "0.1.0"
      size = 4
      sha256 = $sidecarHash
    }
  }
  $manifestPath = Join-Path $officeDirectory "manifest.json"
  [IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 10),
    ([System.Text.UTF8Encoding]::new($false))
  )

  return [pscustomobject]@{
    OfficeDirectory = $officeDirectory
    ManifestPath = $manifestPath
    SidecarPath = $sidecarPath
  }
}

function Remove-TestPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) {
    return
  }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    [IO.Directory]::Delete($Path)
  } elseif ($item.PSIsContainer) {
    [IO.Directory]::Delete($Path, $true)
  } else {
    [IO.File]::Delete($Path)
  }
}

$testRoots = @()
try {
  $normalRoot = Join-Path ([IO.Path]::GetTempPath()) ("mona-release-wrapper-normal-" + [Guid]::NewGuid().ToString("N"))
  $testRoots += $normalRoot
  New-Item -ItemType Directory -Path $normalRoot -Force | Out-Null
  $normalFixture = New-OfficeFixture -Root $normalRoot

  $state = Get-OfficeSidecarManifestState -GatewayDirectory $normalRoot
  [IO.File]::WriteAllBytes($normalFixture.SidecarPath, [byte[]](1, 2, 3, 4, 5, 6))
  Update-OfficeSidecarManifest -ManifestState $state
  $updatedManifest = Get-Content -LiteralPath $normalFixture.ManifestPath -Raw | ConvertFrom-Json
  $updatedHash = (Get-FileHash -LiteralPath $normalFixture.SidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($updatedManifest.xlsxSidecar.size -ne 6 -or
      $updatedManifest.xlsxSidecar.sha256 -ne $updatedHash -or
      $updatedManifest.xlsxSidecar.version -ne "0.1.0" -or
      $updatedManifest.extra.keep -ne "yes") {
    throw "Sidecar manifest refresh did not preserve fields or update size/hash."
  }

  [IO.File]::WriteAllBytes($normalFixture.SidecarPath, [byte[]](9, 8, 7))
  try {
    Get-OfficeSidecarManifestState -GatewayDirectory $normalRoot | Out-Null
    throw "A sidecar hash mismatch was accepted before signing."
  } catch {
    if ($_.Exception.Message -notmatch "does not match manifest before signing") {
      throw
    }
  }

  $missingTemplateRoot = Join-Path ([IO.Path]::GetTempPath()) ("mona-release-wrapper-template-" + [Guid]::NewGuid().ToString("N"))
  $testRoots += $missingTemplateRoot
  New-Item -ItemType Directory -Path $missingTemplateRoot -Force | Out-Null
  $missingTemplateFixture = New-OfficeFixture -Root $missingTemplateRoot
  [IO.File]::Delete((Join-Path $missingTemplateFixture.OfficeDirectory "templates\blank.pptx"))
  try {
    Get-OfficeSidecarManifestState -GatewayDirectory $missingTemplateRoot | Out-Null
    throw "A missing Office template was accepted."
  } catch {
    if ($_.Exception.Message -notmatch "Office template was not found") {
      throw
    }
  }

  $escapeRoot = Join-Path ([IO.Path]::GetTempPath()) ("mona-release-wrapper-escape-" + [Guid]::NewGuid().ToString("N"))
  $testRoots += $escapeRoot
  New-Item -ItemType Directory -Path $escapeRoot -Force | Out-Null
  $escapeFixture = New-OfficeFixture -Root $escapeRoot
  $outsidePath = Join-Path $escapeRoot "outside.exe"
  [IO.File]::WriteAllBytes($outsidePath, [byte[]](1, 2, 3, 4))
  $escapeManifest = Get-Content -LiteralPath $escapeFixture.ManifestPath -Raw | ConvertFrom-Json
  $escapeManifest.xlsxSidecar.path = "..\..\..\outside.exe"
  [IO.File]::WriteAllText(
    $escapeFixture.ManifestPath,
    ($escapeManifest | ConvertTo-Json -Depth 10),
    ([System.Text.UTF8Encoding]::new($false))
  )
  try {
    Get-OfficeSidecarManifestState -GatewayDirectory $escapeRoot | Out-Null
    throw "A sidecar path escaping Office resources was accepted."
  } catch {
    if ($_.Exception.Message -notmatch "outside its checked directory") {
      throw
    }
  }

  $ancestorRoot = Join-Path ([IO.Path]::GetTempPath()) ("mona-release-wrapper-ancestor-" + [Guid]::NewGuid().ToString("N"))
  $ancestorTarget = Join-Path ([IO.Path]::GetTempPath()) ("mona-release-wrapper-ancestor-target-" + [Guid]::NewGuid().ToString("N"))
  $testRoots += $ancestorRoot
  $testRoots += $ancestorTarget
  New-Item -ItemType Directory -Path $ancestorRoot, $ancestorTarget -Force | Out-Null
  New-OfficeFixture -Root $ancestorTarget | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $ancestorRoot "_internal") -Target (Join-Path $ancestorTarget "_internal") | Out-Null
  try {
    Get-OfficeSidecarManifestState -GatewayDirectory $ancestorRoot | Out-Null
    throw "An Office ancestor Junction was accepted."
  } catch {
    if ($_.Exception.Message -notmatch "reparse point") {
      throw
    }
  }

  $sidecarRoot = Join-Path ([IO.Path]::GetTempPath()) ("mona-release-wrapper-sidecar-" + [Guid]::NewGuid().ToString("N"))
  $sidecarTarget = Join-Path ([IO.Path]::GetTempPath()) ("mona-release-wrapper-sidecar-target-" + [Guid]::NewGuid().ToString("N"))
  $testRoots += $sidecarRoot
  $testRoots += $sidecarTarget
  New-Item -ItemType Directory -Path $sidecarRoot, $sidecarTarget -Force | Out-Null
  $sidecarFixture = New-OfficeFixture -Root $sidecarRoot
  $targetSheets = Join-Path $sidecarTarget "sheets"
  New-Item -ItemType Directory -Path $targetSheets -Force | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $targetSheets "xlsx-sidecar.exe"), [byte[]](1, 2, 3, 4))
  $sidecarManifest = Get-Content -LiteralPath $sidecarFixture.ManifestPath -Raw | ConvertFrom-Json
  $sidecarManifest.xlsxSidecar.sha256 = (Get-FileHash -LiteralPath (Join-Path $targetSheets "xlsx-sidecar.exe") -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText(
    $sidecarFixture.ManifestPath,
    ($sidecarManifest | ConvertTo-Json -Depth 10),
    ([System.Text.UTF8Encoding]::new($false))
  )
  [IO.Directory]::Delete((Join-Path $sidecarFixture.OfficeDirectory "sheets"), $true)
  New-Item -ItemType Junction -Path (Join-Path $sidecarFixture.OfficeDirectory "sheets") -Target $targetSheets | Out-Null
  try {
    Get-OfficeSidecarManifestState -GatewayDirectory $sidecarRoot | Out-Null
    throw "A sidecar parent Junction was accepted."
  } catch {
    if ($_.Exception.Message -notmatch "reparse point") {
      throw
    }
  }

  Write-Host "Windows release wrapper regression tests passed."
} finally {
  foreach ($root in $testRoots) {
    if (Test-Path -LiteralPath $root -PathType Container) {
      $junctions = Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
        Sort-Object FullName -Descending
      foreach ($junction in $junctions) {
        Remove-TestPath -Path $junction.FullName
      }
    }
  }
  foreach ($root in $testRoots) {
    Remove-TestPath -Path $root
  }
}
