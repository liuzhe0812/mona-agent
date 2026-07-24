---
name: "release"
description: "Build and publish Mona releases to Qiniu Cloud (CDN) + VPS for hot-update and website download. Invoke when user asks to release, publish, deploy, or push updates."
---

# Mona Release Pipeline

Pre-check → Git commit → Bump version → Build → Update package → Changelog → Upload → Manifest → Deploy site → Verify.

## Prerequisites

- All prerequisites from the `windows-packager` skill
- Python packages: `paramiko`, `qiniu`, `zstandard` (`pip install paramiko qiniu zstandard`)
- 环境变量已配置（七牛云凭证 + VPS 密码，见 `.env.example`）：
  - `QINIU_AK` / `QINIU_SK` / `QINIU_BUCKET` / `QINIU_DOMAIN`
  - `VPS_PASSWORD`

## Distribution Architecture

| 资源 | 存储位置 | 地址 | 说明 |
|------|---------|------|------|
| NSIS 安装包 | 七牛云 Kodo + CDN | `https://dl.mona.lzfun.vip/Mona-latest.exe` | 官网下载，大文件 CDN 加速 |
| 热更新包 | 七牛云 Kodo + CDN | `https://dl.mona.lzfun.vip/mona-<ver>.tar.zst` | App 内热更新下载 |
| 更新清单 | VPS Nginx | `https://mona.lzfun.vip/updates/update.json` | 小文件，频繁更新，保留 VPS |
| 官网站点 | VPS Nginx | `https://mona.lzfun.vip/` | SPA |

## VPS Configuration

Already set up at `47.117.69.105`. Key paths:

| Path | Purpose |
|------|---------|
| `/var/www/mona/dist/` | Official website (SPA) |
| `/var/www/mona/updates/update.json` | Hot-update manifest (small file, kept on VPS) |
| `/etc/nginx/conf.d/mona.conf` | Nginx config |

> 安装包和热更新包已迁移到七牛云 CDN（`dl.mona.lzfun.vip`），不再上传到 VPS `/var/www/mona/releases/`。

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

1. **Build mona-gateway** — `windows-packager` Step 1: `pip install ".[api,wecom,weixin,pdf]"`, `python -m PyInstaller src-tauri\mona-gateway.spec`, copy `dist/mona-gateway/` to `src-tauri/resources/mona-gateway/`. **Step 1 ends with a `doctor` smoke test** (`mona-gateway.exe doctor`) that verifies critical dependencies (playwright, lark_oapi, fitz, boto3) import correctly in the packaged build — this must pass before proceeding.
2. **Build Tauri Client** — `windows-packager` Step 2: `cargo tauri build`, produces NSIS installer + `mona-desktop.exe`

Output artifacts:
- `src-tauri/resources/mona-gateway/` (PyInstaller COLLECT directory)
- `src-tauri/target/release/mona-desktop.exe` (Tauri binary)
- `src-tauri/target/release/bundle/nsis/Mona_{version}_x64-setup.exe` (NSIS installer)

## Step 3: Create Update Package

The update package is a single `mona-<version>.tar.zst` containing `Mona.exe` and the `mona-gateway/` directory.

**NOTE:** The Tauri build outputs `mona-desktop.exe`, not `Mona.exe`. Rename during staging.

```powershell
$Version = "<determined_version>"
$StagingDir = "$env:TEMP\mona-update-staging"
if (Test-Path $StagingDir) { Remove-Item -Recurse -Force $StagingDir }
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null

# Rename mona-desktop.exe -> Mona.exe
Copy-Item "src-tauri\target\release\mona-desktop.exe" "$StagingDir\Mona.exe"
# IMPORTANT: PowerShell `Copy-Item -Recurse source dest` nests source INSIDE dest if dest already exists.
# Since $StagingDir was just recreated empty, `mona-gateway` subdir doesn't exist yet, so this is safe.
# But to be defensive against re-runs, explicitly create the target dir and copy contents with `\*`.
New-Item -ItemType Directory -Path "$StagingDir\mona-gateway" -Force | Out-Null
Copy-Item -Recurse "src-tauri\resources\mona-gateway\*" "$StagingDir\mona-gateway"
# Verify NO nested mona-gateway/ directory was created (regression check)
if (Test-Path "$StagingDir\mona-gateway\mona-gateway") {
    throw "Nested mona-gateway/ directory detected! Staging copy failed. Aborting."
}

$UpdatePackage = "dist\mona-$Version.tar.zst"
New-Item -ItemType Directory -Path "dist" -Force | Out-Null

# Use the Python build script: it cleans __pycache__/.pyc/.dist-info/tests
# from staging before packing, and uses zstd level 22 for max compression.
# This typically shrinks the update package by ~30-40% vs raw `tar --zstd`.
python scripts\build_update_package.py $Version $StagingDir $UpdatePackage

# Compute SHA256 and size (script prints them too, but we need them in PS vars)
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

## Step 5: Upload to Qiniu Cloud + Update Manifest

安装包和热更新包上传到七牛云 CDN（`dl.mona.lzfun.vip`），清单 `update.json` 更新到 VPS。使用统一脚本 `scripts/release_upload.py`（自动从 `.env` 读取凭证，无需手动设置环境变量）：

```powershell
python scripts/release_upload.py `
  $Version `
  "src-tauri/target/release/bundle/nsis/Mona_${Version}_x64-setup.exe" `
  "dist/mona-$Version.tar.zst" `
  $Hash `
  $ReleaseNotes `
  $CurrentGitHash
```

脚本内部逻辑：
1. 上传 NSIS → 七牛 `Mona-latest.exe`（覆盖，触发 CDN 预取）
2. 上传热更新包 → 七牛 `mona-<version>.tar.zst`
3. 生成 `update.json` 清单（`url` 指向七牛 CDN）→ SFTP 到 VPS

生成的 `update.json` 结构：

```json
{
  "version": "<version>",
  "notes": "<release_notes>",
  "pub_date": "<UTC timestamp>",
  "url": "https://dl.mona.lzfun.vip/mona-<version>.tar.zst",
  "sha256": "<hash>",
  "size": <bytes>,
  "git_hash": "<current_git_hash>"
}
```

## Step 6: Deploy Website

The website source in `site/` includes a changelog page that reads `site/public/changelog.json`. Build and deploy using the unified script (reads VPS credentials from `.env`):

```powershell
python scripts/deploy_site.py
```

脚本自动完成：构建 `site/dist/` → SFTP 上传到 VPS `/var/www/mona/dist/`。

### Nginx SPA fallback（一次性配置，无需每次发布检查）

The site is a SPA. Nginx must fallback non-file requests to `index.html` so routes like `/changelog` work. Verify the config contains:

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

If missing, add to `/etc/nginx/conf.d/mona.conf` and run `nginx -s reload`.

## Step 7: Verify

```powershell
curl.exe -s https://mona.lzfun.vip/updates/update.json
curl.exe -s https://mona.lzfun.vip/changelog.json
curl.exe -sI https://dl.mona.lzfun.vip/mona-<ver>.tar.zst
curl.exe -sI https://dl.mona.lzfun.vip/Mona-latest.exe
```

Check:
1. `update.json` — version matches, `git_hash` present, `url` 指向 `dl.mona.lzfun.vip`
2. `changelog.json` — new release entry present with correct items
3. Update package — HTTP 200, size matches local file
4. NSIS installer — HTTP 200
5. Open `https://mona.lzfun.vip/changelog` in browser — page renders correctly

## Step 8: Cleanup

```powershell
Remove-Item -Recurse -Force "$env:TEMP\mona-python-build" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:TEMP\mona-update-staging" -ErrorAction SilentlyContinue
Remove-Item -Force tmp_*.py -ErrorAction SilentlyContinue
Remove-Item -Force tmp_*.txt -ErrorAction SilentlyContinue
```

## Quick Reference

| User says | Action |
|-----------|--------|
| "发布新版本" / "release" | Ask for version, then execute full pipeline (Steps 0-8) |
| "只部署官网" / "deploy site" | Build site + upload to VPS only (Step 6) |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mona.__file__` points to source dir | Rebuild with `pip install ".[extras]"` (no `-e`), verify from `C:\` |
| VPS upload fails | Check SSH: `ssh root@47.117.69.105` |
| 七牛上传 401 / 403 | AK/SK 错误或已失效，去控制台重新生成并更新环境变量 |
| 七牛上传 404 | bucket 名错误，或 bucket 不存在 |
| CDN 下载 404 | CNAME 未生效或未配置；检查 DNS 解析 `nslookup dl.mona.lzfun.vip` |
| CDN 下载旧版本 | CDN 缓存未刷新，脚本会自动预取；手动刷新去七牛控制台 CDN → 缓存刷新 |
| Nginx 403 | Check permissions: `chmod -R 755 /var/www/mona/` |
| Nginx 404 on `/changelog` | Add SPA fallback: `try_files $uri $uri/ /index.html;` in nginx config |
| `cargo tauri build` fails with `--ci` error | Set `$env:CI = ""` before building |
| Update package too large | `build_update_package.py` already strips `__pycache__`/`.pyc`/`.dist-info`/`tests` and uses zstd-22. If still too large: check for nested `mona-gateway/mona-gateway/` (file count doubled = nesting bug); then exclude unused packages in `mona-gateway.spec` |
| Update package size suddenly doubled vs previous release | Almost certainly the `Copy-Item -Recurse` nesting bug. Verify with: `tar -tf dist/mona-<ver>.tar.zst \| Measure-Object` — if count ≈ 2× previous, staging dir had nested `mona-gateway/mona-gateway/`. Re-run Step 3 with the fixed staging commands. |
| Hot-update SHA256 mismatch | Re-compute hash after upload, ensure binary mode transfer |
| PyInstaller missing import | Step 1 smoke test (`mona-gateway.exe doctor`) catches this before release. To fix: add `collect_submodules('<package>')` to `src-tauri/mona-gateway.spec` and rebuild |
| Changelog page shows old data | Confirm `site/public/changelog.json` was updated and redeployed |
| `previousGitHash` is empty | First release or legacy entry missing `gitHash`; ask user for manual items |
| `pyproject.toml` parse error after bump | File has UTF-8 BOM — rewrite using Python or `[System.IO.File]::WriteAllText()` with `UTF8Encoding($false)` |
| Build uses uncommitted code | Stop. Ask user to commit first. Never release with dirty working tree. |
