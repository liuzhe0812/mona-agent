---
name: "release"
description: "Build and publish Mona releases to VPS for hot-update and website download. Invoke when user asks to release, publish, deploy, or push updates to VPS."
---

# Mona Release Pipeline

Version sync → Package build (via `windows-packager` skill) → Create update package → Generate changelog → Upload to VPS → Update manifest → Deploy website.

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

1. **Build mona-gateway** — `windows-packager` Step 1: `pip install ".[api,wecom,weixin,pdf]"`, `pyinstaller src-tauri\mona-gateway.spec`, copy `dist/mona-gateway/` to `src-tauri/resources/mona-gateway/`
2. **Build Tauri Client** — `windows-packager` Step 2: `cargo tauri build`, produces NSIS installer + `Mona.exe`

Output artifacts:
- `src-tauri/resources/mona-gateway/` (PyInstaller COLLECT directory)
- `src-tauri/target/release/Mona.exe`
- `src-tauri/target/release/bundle/nsis/Mona_{version}_x64-setup.exe`

## Step 3: Create Update Package

The update package is a single `mona-<version>.tar.gz` containing `Mona.exe` and the `mona-gateway/` directory.

```powershell
$Version = "<determined_version>"
$StagingDir = "$env:TEMP\mona-update-staging"
if (Test-Path $StagingDir) { Remove-Item -Recurse -Force $StagingDir }
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null

Copy-Item "src-tauri\target\release\Mona.exe" "$StagingDir\Mona.exe"
Copy-Item -Recurse "src-tauri\resources\mona-gateway" "$StagingDir\mona-gateway"

$UpdatePackage = "dist\mona-$Version.tar.gz"
New-Item -ItemType Directory -Path "dist" -Force | Out-Null
tar -czf $UpdatePackage -C $StagingDir Mona.exe mona-gateway

# Compute SHA256
$Hash = (Get-FileHash $UpdatePackage -Algorithm SHA256).Hash.ToLower()
$Size = (Get-Item $UpdatePackage).Length

Write-Output "Update package: $UpdatePackage"
Write-Output "SHA256: $Hash"
Write-Output "Size: $Size bytes"
```

## Step 4: Generate Changelog

The release process must record the current git hash and produce human-readable release notes from the commits since the previous release.

### 4.1 Collect git history

Use the helper script to get the current hash, previous release hash, and the commits in between:

```powershell
python scripts/update_changelog.py collect
```

Output example:

```json
{
  "currentGitHash": "abc123...",
  "previousGitHash": "def456...",
  "commitCount": 12,
  "commits": [
    {"hash": "abc123...", "subject": "feat: add SSH IDE mode", "body": ""},
    {"hash": "...", "subject": "fix: resolve update download race", "body": ""}
  ]
}
```

If `previousGitHash` is empty (first release), skip commit analysis and write a manual summary.

### 4.2 Summarize with AI

Feed the collected commits to the current LLM session with a prompt like:

> You are summarizing a Mona release for end users. Below are the commits between version X and the previous release. Convert them into a concise Chinese changelog: one short `summary` sentence and 3-8 bullet `items` in plain language. Ignore internal refactors, test-only changes, and dependency bumps unless user-visible. Output only JSON in this shape:
> ```json
> {"summary": "...", "items": ["...", "..."]}
> ```
>
> Commits:
> - ...

### 4.3 Write changelog data

Use the helper script to prepend the new release entry:

```powershell
python scripts/update_changelog.py write `
  --version $Version `
  --summary "修复了更新下载竞态，新增 SSH IDE 模式。" `
  --items "新增 SSH IDE 模式，支持多文件编辑" `
  --items "修复自动更新下载时偶发的文件占用问题" `
  --items "优化 Agent 执行结果展示"
```

This updates `site/public/changelog.json`, which the website changelog page reads at runtime.

## Step 5: Upload to VPS

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

## Step 6: Update Manifest

Update `/var/www/mona/updates/update.json` on VPS. Include the current `git_hash` so future releases can diff against it.

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
    "git_hash": current_git_hash,
}

with sftp.open("/var/www/mona/updates/update.json", "w") as f:
    f.write(json.dumps(manifest, indent=2))

sftp.close()
ssh.close()
```

## Step 7: Deploy Website

The website source in `site/` includes a changelog page that reads `site/public/changelog.json`. Build and deploy it:

```powershell
cd site
npm run build
```

Then upload `site/dist/` to VPS `/var/www/mona/dist/` via paramiko.

```python
import paramiko, os

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect("47.117.69.105", username="root", password="Alt34484!@#", timeout=10)
sftp = ssh.open_sftp()

local_dist = "site/dist"
remote_dist = "/var/www/mona/dist"

for root, dirs, files in os.walk(local_dist):
    rel = os.path.relpath(root, local_dist).replace("\\", "/")
    remote_root = f"{remote_dist}/{rel}" if rel != "." else remote_dist
    ssh.exec_command(f"mkdir -p {remote_root}")
    for f in files:
        local_path = os.path.join(root, f).replace("\\", "/")
        remote_path = f"{remote_root}/{f}"
        sftp.put(local_path, remote_path)

sftp.close()
ssh.close()
```

## Step 8: Verify

1. `curl https://mona.lzfun.vip/updates/update.json` — manifest accessible and contains `git_hash`
2. `curl -I https://mona.lzfun.vip/releases/mona-<ver>.tar.gz` — update package downloadable
3. `curl -I https://mona.lzfun.vip/releases/Mona-latest.exe` — NSIS download works
4. `curl https://mona.lzfun.vip/changelog.json` — changelog data is up to date
5. Open `https://mona.lzfun.vip/changelog` in a browser — UI matches the rest of the site

## Cleanup

```powershell
Remove-Item -Recurse -Force "$env:TEMP\mona-python-build" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:TEMP\mona-update-staging" -ErrorAction SilentlyContinue
```

## Quick Reference

| User says | Action |
|-----------|--------|
| "发布新版本" / "release" | Ask for version, then execute full pipeline (Steps 1-8) |
| "只部署官网" / "deploy site" | Build site + upload to VPS only (Step 7) |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mona.__file__` points to source dir | Rebuild with `pip install ".[extras]"` (no `-e`), verify from `C:\` |
| VPS upload fails | Check SSH: `ssh root@47.117.69.105` |
| Nginx 403 | Check permissions: `chmod -R 755 /var/www/mona/` |
| Nginx 404 | Check file paths match manifest URLs exactly |
| `cargo tauri build` fails with `--ci` error | Set `$env:CI = ""` before building |
| Update package too large | Strip `__pycache__`, `.pyc`, `.pyo` from Python runtime; exclude unused packages in spec |
| Hot-update SHA256 mismatch | Re-compute hash after upload, ensure binary mode transfer |
| PyInstaller missing import | Add to `hidden_imports` list in `src-tauri/mona-gateway.spec` |
| Changelog page shows old data | Confirm `site/public/changelog.json` was updated and redeployed |
| `previousGitHash` is empty | The existing `changelog.json` entry has no `gitHash`; for first release use manual summary |
