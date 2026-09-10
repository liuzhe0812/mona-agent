[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path,
  [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-SignToolPath {
  $fromPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($fromPath) {
    return $fromPath.Source
  }

  $kitsRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
  $signTool = Get-ChildItem -Path $kitsRoot -Filter signtool.exe -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.DirectoryName -match "\\x64$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $signTool) {
    throw "signtool.exe was not found. Install the Windows SDK before building a signed release."
  }
  return $signTool.FullName
}

function Assert-CodeSigningCertificate {
  $thumbprint = ($env:MONA_SIGNING_CERT_THUMBPRINT -replace "\s", "").ToUpperInvariant()
  if (-not $thumbprint) {
    throw "MONA_SIGNING_CERT_THUMBPRINT is required for a signed release."
  }

  $certificate = Get-Item -Path "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
  if (-not $certificate) {
    throw "No signing certificate with thumbprint $thumbprint was found in Cert:\CurrentUser\My."
  }
  if (-not $certificate.HasPrivateKey) {
    throw "The signing certificate $thumbprint has no private key."
  }
  if ($certificate.NotAfter -le (Get-Date)) {
    throw "The signing certificate $thumbprint has expired."
  }

  $codeSigningOid = "1.3.6.1.5.5.7.3.3"
  $hasCodeSigningUsage = $certificate.EnhancedKeyUsageList |
    Where-Object { $_.ObjectId.Value -eq $codeSigningOid }
  if (-not $hasCodeSigningUsage) {
    throw "The certificate $thumbprint is not valid for code signing."
  }
  return $certificate
}

function Assert-ValidSignature {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SignTool,
    [Parameter(Mandatory = $true)]
    [string]$ArtifactPath
  )

  & $SignTool verify /pa /tw /v $ArtifactPath
  if ($LASTEXITCODE -ne 0) {
    throw "Authenticode verification failed for $ArtifactPath."
  }
}

$artifactPath = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
$signTool = Get-SignToolPath

if ($VerifyOnly) {
  Assert-ValidSignature -SignTool $signTool -ArtifactPath $artifactPath
  return
}

$certificate = Assert-CodeSigningCertificate
$timestampUrl = $env:MONA_SIGNING_TIMESTAMP_URL
if (-not $timestampUrl) {
  $timestampUrl = "http://timestamp.digicert.com"
}

& $signTool sign /sha1 $certificate.Thumbprint /fd SHA256 /tr $timestampUrl /td SHA256 /v $artifactPath
if ($LASTEXITCODE -ne 0) {
  throw "Authenticode signing failed for $artifactPath."
}

Assert-ValidSignature -SignTool $signTool -ArtifactPath $artifactPath
