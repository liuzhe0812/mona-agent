---
name: "release"
description: "Build and publish Mona releases to VPS for hot-update and website download. Invoke when user asks to release, publish, deploy, or push updates to VPS."
---

# Mona Release Pipeline

Pre-check → Git commit → Bump version → Build → Update package → Changelog → Upload → Manifest → Deploy site → Verify.

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

## Step 0: Pre-release Checks

### 0.1 Check git working tree

**MUST run before any other step.** The build must use committed code so the recorded `git_hash` matches the actual binary.

```powershell
git status --short
```

If there are uncommitted changes (modified, staged, or untracked files):

1. **Ask the user** whether to commit all changes before proceeding.
2. Stage relevant files — exclude temporary files (`tmp_*`, `.codegraph/daemon.pid`, `docs/` design docs) and unrelated skill updates.
3. Commit with message like `chore(release): release v<version>`.
4. Re-run `git status --short` to confirm clean state.

**Never proceed with a dirty working tree.** If the user declines to commit, stop and explain the risk.

### 0.2 Determine version

Ask the user for version (e.g. `1.0.2`) or bump rule (`patch`/`minor`/`major`, default: `patch`).

## Step 1: Bump Version

All three files must use the same version:

| File | Field |
|------|-------|
| `src-tauri/Cargo.toml` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `pyproject.toml` | `version` |

**IMPORTANT: Use Python to write files, NOT PowerShell `Set-Content`.** PowerShell `Set-Content` writes UTF-8 BOM by default, which breaks `tomllib` parsing of `pyproject.toml`.

```python
import re
from pathlib import Path

new_version = "<determined_version>"

for path_str in ["src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "pyproject.toml"]:
    p = Path(path_str)
    content = p.read_text(encoding="utf-8")
    content = re.sub(
        r'(?<=("version"\s*:\s*"))[^"]+(?=")' if ".json" in path_str else r'(?m)^(version\s*=\s*)"[^"]*"',
        lambda m: m.group(1) + '"' + new_version + '"' if '.json' not in path_str else new_version,
        content,
    )
    p.write_text(content, encoding="utf-8")
    print(f"Updated {path_str} -> {new_version}")
```

Or if using PowerShell, add `-Encoding utf8NoBOM` (PowerShell 7+) or use `[System.IO.File]::WriteAllText()`:

```powershell
$NewVersion = "<determined_version>"

# Using .NET to avoid BOM
[System.IO.File]::WriteAllText(
    "pyproject.toml",
    ((Get-Content "pyproject.toml" -Raw) -replace '(?m)^(version\s*=\s*)"[^"]*"', "`$1`"$NewVersion`""),
    [System.Text.UTF8Encoding]::new($false)
)
# Same pattern for Cargo.toml and tauri.conf.json
```

## Step 2: Build (via windows-packager skill)

Execute the `windows-packager` skill's build pipeline (Step 1 + Step 2):

1. **Build mona-gateway** — `windows-packager` Step 1: `pip install ".[api,wecom,weixin,pdf]"`, `python -m PyInstaller src-tauri\mona-gateway.spec`, copy `dist/mona-gateway/` to `src-tauri/resources/mona-gateway/`
2. **Build Tauri Client** — `windows-packager` Step 2: `cargo tauri build`, produces NSIS installer + `mona-desktop.exe`

Output artifacts:
- `src-tauri/resources/mona-gateway/` (PyInstaller COLLECT directory)
- `src-tauri/target/release/mona-desktop.exe` (Tauri binary)
- `src-tauri/target/release/bundle/nsis/Mona_{version}_x64-setup.exe` (NSIS installer)

## Step 3: Create Update Package

The update package is a single `mona-<version>.tar.gz` containing `Mona.exe` and the `mona-gateway/` directory.

**NOTE:** The Tauri build outputs `mona-desktop.exe`, not `Mona.exe`. Rename during staging.

```powershell
$Version = "<determined_version>"
$StagingDir = "$env:TEMP\mona-update-staging"
if (Test-Path $StagingDir) { Remove-Item -Recurse -Force $StagingDir }
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null

# Rename mona-desktop.exe -> Mona.exe
Copy-Item "src-tauri\target\release\mona-desktop.exe" "$StagingDir\Mona.exe"
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

If `previousGitHash` is empty (first release), skip commit analysis and ask the user to provide items manually.

### 4.2 Also check diff stats for uncommitted features

Even after committing, review the full diff to catch features that might span many small commits:

```powershell
git diff --stat <previousGitHash>..HEAD
```

This helps identify major new modules (e.g. `webui/src/components/ide/`, `src-tauri/src/terminal/ide/`) that individual commit messages might understate.

### 4.3 Summarize with AI

Feed the collected commits AND the diff stat to the current LLM session with a prompt like:

> 你正在为 Mona 桌面端用户生成版本更新日志。以下是从上个版本到当前版本的所有代码变更。
>
> 要求：
> - 用中文撰写，面向最终用户，语言简洁自然
> - 只输出 `items` 列表（3-8 条），不要 summary 段落
> - 忽略：内部重构、测试代码、依赖更新、`site/` 官网改动、`.trae/skills/` 工具改动、`scripts/` 脚本、CI/构建配置
> - 每条用一句话描述一个用户可感知的功能或修复
> - 结合 commit message 和 diff stat 中的文件路径推断功能模块（如 `webui/src/components/ide/` = IDE 模式）
> - 输出纯 JSON：`{"items": ["...", "..."]}`
>
> Commits:
> - ...
>
> Diff stat:
> - ...

### 4.4 Write changelog data

Use the helper script to prepend the new release entry. **Set `summary` to empty string `""`** — the changelog page only shows items, no summary paragraph.

```powershell
python scripts/update_changelog.py write `
  --version $Version `
  --summary "" `
  --items "新增 SSH IDE 模式，支持远程服务器文件树浏览、多文件编辑与冲突处理" `
  --items "浏览器 AI 助手升级，支持书签栏与更智能的页面交互" `
  --items "修复通知表大整数与迁移批量插入问题"
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
npm --prefix site run build
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

### Nginx SPA fallback

The site is a SPA. Nginx must fallback non-file requests to `index.html` so routes like `/changelog` work. Verify the config contains:

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

If missing, add to `/etc/nginx/conf.d/mona.conf` and run `nginx -s reload`.

## Step 8: Verify

```powershell
curl.exe -s https://mona.lzfun.vip/updates/update.json
curl.exe -s https://mona.lzfun.vip/changelog.json
curl.exe -sI https://mona.lzfun.vip/releases/mona-<ver>.tar.gz
curl.exe -sI https://mona.lzfun.vip/releases/Mona-latest.exe
```

Check:
1. `update.json` — version matches, `git_hash` present
2. `changelog.json` — new release entry present with correct items
3. Update package — HTTP 200, size matches local file
4. NSIS installer — HTTP 200
5. Open `https://mona.lzfun.vip/changelog` in browser — page renders correctly

## Step 9: Cleanup

```powershell
Remove-Item -Recurse -Force "$env:TEMP\mona-python-build" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:TEMP\mona-update-staging" -ErrorAction SilentlyContinue
Remove-Item -Force tmp_*.py -ErrorAction SilentlyContinue
Remove-Item -Force tmp_*.txt -ErrorAction SilentlyContinue
```

## Quick Reference

| User says | Action |
|-----------|--------|
| "发布新版本" / "release" | Ask for version, then execute full pipeline (Steps 0-9) |
| "只部署官网" / "deploy site" | Build site + upload to VPS only (Step 7) |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mona.__file__` points to source dir | Rebuild with `pip install ".[extras]"` (no `-e`), verify from `C:\` |
| VPS upload fails | Check SSH: `ssh root@47.117.69.105` |
| Nginx 403 | Check permissions: `chmod -R 755 /var/www/mona/` |
| Nginx 404 on `/changelog` | Add SPA fallback: `try_files $uri $uri/ /index.html;` in nginx config |
| `cargo tauri build` fails with `--ci` error | Set `$env:CI = ""` before building |
| Update package too large | Strip `__pycache__`, `.pyc`, `.pyo` from Python runtime; exclude unused packages in spec |
| Hot-update SHA256 mismatch | Re-compute hash after upload, ensure binary mode transfer |
| PyInstaller missing import | Add to `hidden_imports` list in `src-tauri/mona-gateway.spec` |
| Changelog page shows old data | Confirm `site/public/changelog.json` was updated and redeployed |
| `previousGitHash` is empty | First release or legacy entry missing `gitHash`; ask user for manual items |
| `pyproject.toml` parse error after bump | File has UTF-8 BOM — rewrite using Python or `[System.IO.File]::WriteAllText()` with `UTF8Encoding($false)` |
| Build uses uncommitted code | Stop. Ask user to commit first. Never release with dirty working tree. |
