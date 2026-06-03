---
name: "release"
description: "Build and publish Mona releases (client + backend) to VPS for hot-update. Invoke when user asks to release, publish, deploy, or push updates to VPS."
---

# Mona Release Pipeline

Build the Mona desktop client and Python backend, then publish them to the VPS update server for hot-update distribution.

## Prerequisites

- Windows 10/11 x86_64 build machine
- All prerequisites from the `windows-packager` skill (Rust, Node.js, VS Build Tools)
- SSH access to the VPS update server
- Tauri signer key (for client update signing)

## VPS Configuration

The VPS hosts a Nginx static file server. One-time setup:

```bash
# On VPS: create directory structure
mkdir -p /var/www/mona-updates/updates
mkdir -p /var/www/mona-updates/releases

# Install Nginx + certbot
apt update && apt install -y nginx certbot python3-certbot-nginx

# Nginx config: /etc/nginx/sites-available/mona-updates
server {
    listen 80;
    server_name <VPS_HOST>;
    root /var/www/mona-updates;

    location /updates/ {
        add_header Cache-Control "no-cache, must-revalidate";
    }

    location /releases/ {
        add_header Cache-Control "public, max-age=86400";
    }
}

# Enable site + HTTPS
ln -s /etc/nginx/sites-available/mona-updates /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d <VPS_HOST>
```

## Release Types

| Type | What gets published | When |
|------|-------------------|------|
| `client` | NSIS exe + stable.json | Tauri/Rust/WebUI changes |
| `backend` | backend-<ver>.tar.gz + backend.json | mona-ai Python code changes |
| `full` | All of the above + python-<ver>.tar.gz | Both client and backend changed |
| `backend-only` | backend-<ver>.tar.gz + backend.json | Backend-only hotfix (no client rebuild) |

## Step 0: Determine Version and Release Type

Ask the user:

1. **Release type**: `client` / `backend` / `full` / `backend-only`
2. **Version**: specific version (e.g. `0.2.0`) or bump rule (`patch`/`minor`/`major`). Default: `patch`

Version sync rules:

| File | Field | Must match? |
|------|-------|-------------|
| `src-tauri/Cargo.toml` | `version` | Yes, for `client`/`full` |
| `src-tauri/tauri.conf.json` | `version` | Yes, for `client`/`full` |
| `pyproject.toml` | `version` | Yes, for `backend`/`full`/`backend-only` |

The Tauri client version and Python package version are **independent** and do NOT need to match each other. But within each component, the version must be consistent.

## Step 1: Bump Version

### For client/full releases

```powershell
$TauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$CurrentVersion = $TauriConf.version
$Parts = $CurrentVersion -split '\.'
$Major = [int]$Parts[0]; $Minor = [int]$Parts[1]; $Patch = [int]$Parts[2]

# Apply bump rule or use specified version
$NewVersion = "<determined_version>"

# Update tauri.conf.json
$TauriConf.version = $NewVersion
$TauriConf | ConvertTo-Json -Depth 10 | Set-Content "src-tauri\tauri.conf.json"

# Update Cargo.toml
$CargoToml = Get-Content "src-tauri\Cargo.toml" -Raw
$CargoToml = $CargoToml -replace '(?m)^(version\s*=\s*)"[^"]*"', "`$1`"$NewVersion`""
Set-Content "src-tauri\Cargo.toml" $CargoToml
```

### For backend/full/backend-only releases

```powershell
$Pyproject = Get-Content "pyproject.toml" -Raw
$Pyproject = $Pyproject -replace '(?m)^(version\s*=\s*)"[^"]*"', "`$1`"$BackendVersion`""
Set-Content "pyproject.toml" $Pyproject
```

## Step 2: Build Python Runtime (for client/full/backend releases)

This step produces both `python.tar.gz` (for the NSIS installer) and the site-packages content needed for the backend package.

```powershell
$PythonVersion = "3.12.13"
$ReleaseTag = "20260510"
$Platform = "x86_64-pc-windows-msvc"
$BaseUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$ReleaseTag"
$FileName = "cpython-$PythonVersion+$ReleaseTag-$Platform-install_only.tar.gz"

# 1. Download python-build-standalone
$ResourcesDir = "src-tauri\resources"
New-Item -ItemType Directory -Path $ResourcesDir -Force | Out-Null
$PythonArchive = "$ResourcesDir\python.tar.gz"
Invoke-WebRequest -Uri "$BaseUrl/$FileName" -OutFile $PythonArchive -UseBasicParsing

# 2. Extract to temp dir
$TempDir = "$env:TEMP\mona-python-build"
if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
tar -xzf $PythonArchive -C $TempDir

# 3. Find the python directory
$PythonDir = Get-ChildItem -Path $TempDir -Directory -Recurse -Filter "python" |
    Where-Object { Test-Path (Join-Path $_.FullName "python.exe") } |
    Select-Object -First 1

# 4. Install mona-ai with ALL optional dependencies (NON-EDITABLE)
$PythonExe = Join-Path $PythonDir.FullName "python.exe"
& $PythonExe -m pip install ".[api,wecom,weixin,pdf]" --no-warn-script-location 2>&1 | Out-Null

# 5. Verify installation
Push-Location "C:\"
$monaFile = & $PythonExe -c "import mona; print(mona.__file__)" 2>&1
Pop-Location
if ($monaFile -notmatch "site-packages") {
    throw "mona-ai installed in editable mode! mona.__file__=$monaFile"
}

# 6. Strip caches
Get-ChildItem $PythonDir.FullName -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force
Get-ChildItem $PythonDir.FullName -Recurse -File -Filter "*.pyc" |
    Remove-Item -Force
Get-ChildItem $PythonDir.FullName -Recurse -File -Filter "*.pyo" |
    Remove-Item -Force

# 7. Re-pack into python.tar.gz (for NSIS installer embedding)
tar -czf $PythonArchive -C $PythonDir.Parent.FullName (Split-Path $PythonDir.FullName -Leaf)

# 8. Keep temp dir for backend package creation (Step 4)
# Do NOT delete $TempDir yet
```

**Critical**: NEVER use `pip install -e .`. Always verify from `C:\` that `mona.__file__` points to `site-packages`.

## Step 3: Build Tauri Client (for client/full releases)

```powershell
cd src-tauri
$env:CI = ""
cargo tauri build
cd ..
```

Output:
- NSIS installer: `src-tauri\target\release\bundle\nsis\Mona_{version}_x64-setup.exe`
- MSI installer: `src-tauri\target\release\bundle\msi\Mona_{version}_x64_en-US.msi`

## Step 4: Build Backend Package (for backend/full/backend-only releases)

The backend package is a tar.gz of the **entire site-packages directory** from the newly built Python runtime. This is the artifact that gets downloaded by the hot-updater.

```powershell
$TempDir = "$env:TEMP\mona-python-build"
$PythonDir = Get-ChildItem -Path $TempDir -Directory -Recurse -Filter "python" |
    Where-Object { Test-Path (Join-Path $_.FullName "python.exe") } |
    Select-Object -First 1
$SitePackages = Join-Path $PythonDir.FullName "Lib" "site-packages"

# Create backend package: tar.gz of entire site-packages
$BackendPackage = "dist\backend-$BackendVersion.tar.gz"
New-Item -ItemType Directory -Path "dist" -Force | Out-Null
tar -czf $BackendPackage -C $SitePackages .

# Compute SHA256
$Hash = (Get-FileHash $BackendPackage -Algorithm SHA256).Hash.ToLower()
$Size = (Get-Item $BackendPackage).Length

Write-Output "Backend package: $BackendPackage"
Write-Output "SHA256: $Hash"
Write-Output "Size: $Size bytes"
```

For `backend-only` releases (no Python runtime rebuild), use the existing Python runtime:

```powershell
# Use the existing python.tar.gz from resources
$ExistingArchive = "src-tauri\resources\python.tar.gz"
$TempDir = "$env:TEMP\mona-python-backend-only"
if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
tar -xzf $ExistingArchive -C $TempDir

# Re-install mona-ai with new code
$PythonDir = Get-ChildItem -Path $TempDir -Directory -Recurse -Filter "python" |
    Where-Object { Test-Path (Join-Path $_.FullName "python.exe") } |
    Select-Object -First 1
$PythonExe = Join-Path $PythonDir.FullName "python.exe"
& $PythonExe -m pip install ".[api,wecom,weixin,pdf]" --force-reinstall --no-warn-script-location 2>&1 | Out-Null

# Strip caches and create backend package (same as above)
```

## Step 5: Sign Client Binary (for client/full releases)

```powershell
# Generate signing key (first time only)
# cargo tauri signer generate -w ~/.tauri/myapp.key

# Sign the NSIS installer
$env:TAURI_SIGNING_PRIVATE_KEY = "<PRIVATE_KEY>"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<PASSWORD>"
$Signature = cargo tauri signer sign "src-tauri\target\release\bundle\nsis\Mona_{version}_x64-setup.exe"
```

If no signing key exists yet, the first release can be unsigned. Document the public key for embedding in `tauri.conf.json`.

## Step 6: Upload to VPS

```powershell
# Upload release artifacts
scp "src-tauri\target\release\bundle\nsis\Mona_{version}_x64-setup.exe" root@<VPS_HOST>:/var/www/mona-updates/releases/
scp "dist\backend-$BackendVersion.tar.gz" root@<VPS_HOST>:/var/www/mona-updates/releases/

# For full releases, also upload the complete Python runtime
scp "src-tauri\resources\python.tar.gz" root@<VPS_HOST>:/var/www/mona-updates/releases/python-$BackendVersion.tar.gz
```

## Step 7: Update Manifests

### stable.json (for client/full releases)

SSH into VPS and update `/var/www/mona-updates/updates/stable.json`:

```json
{
  "version": "<CLIENT_VERSION>",
  "notes": "<RELEASE_NOTES>",
  "pub_date": "<ISO_8601_TIMESTAMP>",
  "platforms": {
    "windows-x86_64": {
      "url": "https://<VPS_HOST>/releases/Mona_<CLIENT_VERSION>_x64-setup.exe",
      "signature": "<SIGNATURE_FROM_STEP_5>"
    }
  }
}
```

### backend.json (for backend/full/backend-only releases)

SSH into VPS and update `/var/www/mona-updates/updates/backend.json`:

```json
{
  "version": "<BACKEND_VERSION>",
  "backend_package": {
    "version": "<BACKEND_VERSION>",
    "url": "https://<VPS_HOST>/releases/backend-<BACKEND_VERSION>.tar.gz",
    "sha256": "<SHA256_FROM_STEP_4>",
    "size": <SIZE_FROM_STEP_4>
  },
  "full_runtime": {
    "python_version": "3.12.13",
    "mona_version": "<BACKEND_VERSION>",
    "url": "https://<VPS_HOST>/releases/python-<BACKEND_VERSION>.tar.gz",
    "sha256": "<SHA256_OF_PYTHON_TAR_GZ>",
    "size": <SIZE_OF_PYTHON_TAR_GZ>
  }
}
```

For `backend-only` releases, the `full_runtime` section can be left unchanged from the previous release.

## Step 8: Verify

1. Check that manifest URLs are accessible: `curl -I https://<VPS_HOST>/releases/backend-<ver>.tar.gz`
2. Check that manifests are served with correct cache headers: `curl -I https://<VPS_HOST>/updates/backend.json`
3. If possible, test the update on a separate machine running the previous version

## Cleanup

```powershell
# Remove temp build directories
Remove-Item -Recurse -Force "$env:TEMP\mona-python-build" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:TEMP\mona-python-backend-only" -ErrorAction SilentlyContinue
```

## Quick Reference: Release Commands

| User says | Action |
|-----------|--------|
| "发布新版本" / "release" | Ask for type + version, then execute full pipeline |
| "只更新后端" / "backend only" | Skip Steps 3, 5; only build + upload backend package |
| "发布客户端" / "client only" | Skip Steps 4; only build + upload client + sign |
| "全量发布" / "full release" | Execute all steps |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mona.__file__` points to source dir | Rebuild with `pip install ".[extras]"` (no `-e`), verify from `C:\` |
| VPS upload fails | Check SSH key auth: `ssh root@<VPS_HOST>` |
| Nginx 403 | Check file permissions: `chmod -R 755 /var/www/mona-updates/` |
| Nginx 404 | Check file paths match manifest URLs exactly |
| `cargo tauri build` fails with `--ci` error | Set `$env:CI = ""` before building |
| Backend package too large | Strip `__pycache__`, `.pyc`, `.pyo`, `test/`, `tests/` from site-packages |
| Signature verification fails on client | Ensure public key in `tauri.conf.json` matches the signing private key |
