---
name: "release"
description: "Build and publish Mona releases to VPS for hot-update and website download. Invoke when user asks to release, publish, deploy, or push updates to VPS."
---

# Mona Release Pipeline

Version sync → Package build (via `windows-packager` skill) → Create update package → Upload to VPS → Update manifest → Deploy website.

## Prerequisites

- All prerequisites from the `windows-packager` skill
- Python `paramiko` package installed (`pip install paramiko`)

## VPS Configuration

Already set up at `47.117.69.105`. Key paths:

| Path | Purpose |
|------|---------|
| `/var/www/mona/dist/` | Official website (SPA) |
| `/var/www/mona/updates/update.json` | Hot-update manifest |
| `/var/www/mona/releases/` | Release packages (NSIS + hot-update) |
| `/etc/nginx/conf.d/mona.conf` | Nginx config |

## Step 1: Bump Version

All three files must use the same version:

| File | Field |
|------|-------|
| `src-tauri/Cargo.toml` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `pyproject.toml` | `version` |

Ask the user for version (e.g. `1.0.2`) or bump rule (`patch`/`minor`/`major`, default: `patch`).

```powershell
$NewVersion = "<determined_version>"

# Update tauri.conf.json
$confContent = Get-Content "src-tauri\tauri.conf.json" -Raw
$confContent = $confContent -replace "(?<=`"version`":\s*`")[^`"]+(?=`")", $NewVersion
Set-Content "src-tauri\tauri.conf.json" $confContent

# Update Cargo.toml
$CargoToml = Get-Content "src-tauri\Cargo.toml" -Raw
$CargoToml = $CargoToml -replace '(?m)^(version\s*=\s*)"[^"]*"', "`$1`"$NewVersion`""
Set-Content "src-tauri\Cargo.toml" $CargoToml

# Update pyproject.toml
$Pyproject = Get-Content "pyproject.toml" -Raw
$Pyproject = $Pyproject -replace '(?m)^(version\s*=\s*)"[^"]*"', "`$1`"$NewVersion`""
Set-Content "pyproject.toml" $Pyproject
```

## Step 2: Build (via windows-packager skill)

Execute the `windows-packager` skill's build pipeline (Step 1 + Step 2):

1. **Build Python Runtime** — `windows-packager` Step 1: download python-build-standalone, `pip install ".[api,wecom,weixin,pdf]"`, strip caches, re-pack `python.tar.gz`
2. **Build Tauri Client** — `windows-packager` Step 2: `cargo tauri build`, produces NSIS installer + `Mona.exe`

Output artifacts:
- `src-tauri/resources/python.tar.gz`
- `src-tauri/target/release/Mona.exe`
- `src-tauri/target/release/bundle/nsis/Mona_{version}_x64-setup.exe`

## Step 3: Create Update Package

The update package is a single `mona-<version>.tar.gz` containing `Mona.exe` and `python.tar.gz`.

```powershell
$Version = "<determined_version>"
$StagingDir = "$env:TEMP\mona-update-staging"
if (Test-Path $StagingDir) { Remove-Item -Recurse -Force $StagingDir }
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null

Copy-Item "src-tauri\target\release\Mona.exe" "$StagingDir\Mona.exe"
Copy-Item "src-tauri\resources\python.tar.gz" "$StagingDir\python.tar.gz"

$UpdatePackage = "dist\mona-$Version.tar.gz"
New-Item -ItemType Directory -Path "dist" -Force | Out-Null
tar -czf $UpdatePackage -C $StagingDir Mona.exe python.tar.gz

# Compute SHA256
$Hash = (Get-FileHash $UpdatePackage -Algorithm SHA256).Hash.ToLower()
$Size = (Get-Item $UpdatePackage).Length

Write-Output "Update package: $UpdatePackage"
Write-Output "SHA256: $Hash"
Write-Output "Size: $Size bytes"
```

## Step 4: Upload to VPS

Use Python paramiko (Windows lacks native sshpass):

```python
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.117.69.105", username="root", password="Alt34484!@#", timeout=10)
sftp = ssh.open_sftp()

# Upload NSIS installer as Mona-latest.exe (for website download)
sftp.put(
    "src-tauri/target/release/bundle/nsis/Mona_{version}_x64-setup.exe",
    "/var/www/mona/releases/Mona-latest.exe",
)

# Upload update package
sftp.put(
    f"dist/mona-{version}.tar.gz",
    f"/var/www/mona/releases/mona-{version}.tar.gz",
)

sftp.close()
ssh.close()
```

## Step 5: Update Manifest

Update `/var/www/mona/updates/update.json` on VPS:

```python
import paramiko, json
from datetime import datetime, timezone

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.117.69.105", username="root", password="Alt34484!@#", timeout=10)
sftp = ssh.open_sftp()

manifest = {
    "version": version,
    "notes": release_notes,
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "url": f"https://mona.lzfun.vip/releases/mona-{version}.tar.gz",
    "sha256": sha256_hash,
    "size": file_size,
}

with sftp.open("/var/www/mona/updates/update.json", "w") as f:
    f.write(json.dumps(manifest, indent=2))

sftp.close()
ssh.close()
```

## Step 6: Deploy Website (if site changed)

If the website source in `site/` has changed:

```powershell
cd site
npm run build
```

Then upload `site/dist/` to VPS `/var/www/mona/dist/` via paramiko.

## Step 7: Verify

1. `curl https://mona.lzfun.vip/updates/update.json` — manifest accessible
2. `curl -I https://mona.lzfun.vip/releases/mona-<ver>.tar.gz` — update package downloadable
3. `curl -I https://mona.lzfun.vip/releases/Mona-latest.exe` — NSIS download works

## Cleanup

```powershell
Remove-Item -Recurse -Force "$env:TEMP\mona-python-build" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:TEMP\mona-update-staging" -ErrorAction SilentlyContinue
```

## Quick Reference

| User says | Action |
|-----------|--------|
| "发布新版本" / "release" | Ask for version, then execute full pipeline (Steps 1-7) |
| "只部署官网" / "deploy site" | Build site + upload to VPS only (Step 6) |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mona.__file__` points to source dir | Rebuild with `pip install ".[extras]"` (no `-e`), verify from `C:\` |
| VPS upload fails | Check SSH: `ssh root@47.117.69.105` |
| Nginx 403 | Check permissions: `chmod -R 755 /var/www/mona/` |
| Nginx 404 | Check file paths match manifest URLs exactly |
| `cargo tauri build` fails with `--ci` error | Set `$env:CI = ""` before building |
| Update package too large | Strip `__pycache__`, `.pyc`, `.pyo` from Python runtime |
| Hot-update SHA256 mismatch | Re-compute hash after upload, ensure binary mode transfer |
