# Mona Desktop Hot-Update Design

## Overview

Mona Desktop is a Tauri v2 application distributed as a Windows NSIS installer. It embeds a Python runtime with `mona-ai` pre-installed, running the gateway as a subprocess. This document describes the hot-update mechanism for the application.

**Core principle**: One version, one package, one update flow. The entire app (Tauri client + Python runtime + mona-ai) is updated as a single unit — there is no separate "client update" or "backend update".

## Runtime Layout (User's Machine)

```
C:\Program Files\Mona\                    ← NSIS install directory
├── Mona.exe                              ← Tauri client (Rust + WebUI)
├── resources\
│   └── python.tar.gz                     ← Embedded Python+mona-ai archive
└── ...

%AppData%\mona\                           ← Runtime data directory
├── python\                               ← Extracted on first launch from python.tar.gz
│   ├── python.exe                        ← Embedded Python 3.12
│   ├── Lib\site-packages\mona\           ← mona-ai package (PRE-INSTALLED)
│   ├── Lib\site-packages\mona_ai-*.dist-info\
│   ├── .mona-python-version              ← Python version marker
│   └── ...
├── settings.json                         ← Tauri client settings
└── ...

%USERPROFILE%\.mona\                      ← mona-ai config directory
├── config.json                           ← API keys, model config
├── workspace\                            ← User workspace
└── ...
```

### Key Constraints

1. **No runtime pip**: The Python runtime has mona-ai and all dependencies pre-installed in `python.tar.gz` during build. `pip` itself may be stripped from the runtime to save space (~5MB).

2. **Python + mona-ai are one unit**: The `python.tar.gz` is built by: downloading python-build-standalone → `pip install ".[api,wecom,weixin,pdf]"` → strip caches → re-pack. This means mona-ai and its entire dependency tree are bundled together.

3. **Gateway is a subprocess**: `gateway.rs` runs `python.exe -m mona gateway` using the embedded Python. In production, PYTHONPATH is NOT set; mona-ai is found via site-packages.

4. **First-launch extraction**: `python.rs` checks `.mona-python-version` marker; if missing or version mismatch, it extracts `python.tar.gz` to `%AppData%/mona/python/`.

5. **Windows exe lock**: The running `Mona.exe` cannot be overwritten. Exe replacement requires a restart with a helper script.

## Architecture

```
┌──────────────────────────────────────────┐
│              VPS (Nginx)                 │
│                                          │
│  /updates/update.json  ← Update manifest │
│  /releases/mona-*.tar.gz ← Update pkg   │
└──────────────────┬───────────────────────┘
                   │ HTTPS
                   ▼
┌──────────────────────────────────────────┐
│        Mona Desktop (Tauri v2)           │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │       updater.rs (custom)          │  │
│  │                                    │  │
│  │  1. Check manifest                │  │
│  │  2. Download update package       │  │
│  │  3. Verify SHA256                 │  │
│  │  4. Stop gateway                  │  │
│  │  5. Replace python.tar.gz         │  │
│  │  6. Delete python/ (force re-ext) │  │
│  │  7. Stage new exe                 │  │
│  │  8. Restart via helper script     │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

## Update Package

A single `mona-<version>.tar.gz` containing the entire application:

```
mona-0.2.0.tar.gz
├── Mona.exe                  ← New Tauri client binary
└── python.tar.gz             ← New Python runtime + mona-ai
```

Size estimate: ~90MB (10MB exe + 80MB Python runtime). Since updates are holistic, this is expected.

## VPS Update Server

### Directory Structure

```
/var/www/mona-updates/
├── updates/
│   └── update.json           ← Single manifest
└── releases/
    └── mona-0.2.0.tar.gz     ← Update package
```

### Manifest: `update.json`

```json
{
  "version": "0.2.0",
  "notes": "Bug fixes and improvements",
  "pub_date": "2026-06-02T12:00:00Z",
  "url": "https://mona.lzfun.vip/releases/mona-0.2.0.tar.gz",
  "sha256": "abc123...",
  "size": 94371840
}
```

### Nginx Config

```nginx
server {
    listen 443 ssl;
    server_name <VPS_HOST>;

    ssl_certificate /etc/letsencrypt/live/<VPS_HOST>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<VPS_HOST>/privkey.pem;

    root /var/www/mona-updates;

    location /updates/ {
        add_header Cache-Control "no-cache, must-revalidate";
    }

    location /releases/ {
        add_header Cache-Control "public, max-age=86400";
    }
}
```

## Version Tracking

The app has a single version number. It is stored in two places:

| Location | Purpose |
|----------|---------|
| `Mona.exe` (compiled-in) | Tauri client version from `tauri.conf.json` |
| `mona_ai-*.dist-info/METADATA` | mona-ai package version in site-packages |

The updater reads the current version from the dist-info directory (same logic as the existing `get_installed_mona_version()` pattern). The manifest version is compared against this.

```rust
fn get_installed_version() -> Option<String> {
    let site_packages = python_dir().join("Lib").join("site-packages");
    for entry in fs::read_dir(&site_packages).ok()? {
        let name = entry.ok()?.file_name();
        let name_str = name.to_str()?;
        if name_str.starts_with("mona_ai-") && name_str.ends_with(".dist-info") {
            let version = name_str
                .strip_prefix("mona_ai-")?
                .strip_suffix(".dist-info")?;
            return Some(version.to_string());
        }
    }
    None
}
```

## Update Flow

```
App startup (5s delay)
  │
  ├─ Fetch update.json from VPS
  │
  ├─ Compare manifest.version vs installed version
  │   ├─ Same → skip, mark "up to date"
  │   └─ Different → notify user
  │
  ├─ User clicks "Update"
  │   │
  │   ├─ Download mona-<version>.tar.gz to staging dir
  │   │   (%LOCALAPPDATA%/mona/update/)
  │   │
  │   ├─ Verify SHA256 against manifest
  │   │
  │   ├─ Extract to staging dir
  │   │   ├── Mona.exe
  │   │   └── python.tar.gz
  │   │
  │   ├─ Stop gateway process (GatewayState::stop())
  │   │
  │   ├─ Replace Python runtime:
  │   │   ├── Copy python.tar.gz → <install_dir>/resources/python.tar.gz
  │   │   └── Delete %AppData%/mona/python/ (force re-extraction on next launch)
  │   │
  │   ├─ Stage exe for replacement:
  │   │   ├── Copy Mona.exe → <install_dir>/Mona.exe.new
  │   │   └── Write .update-pending marker in %AppData%/mona/
  │   │
  │   └─ Launch helper script & exit current process
  │
  └─ Helper script (update.bat):
      ├── Wait for current Mona.exe process to exit
      ├── Rename Mona.exe → Mona.exe.old
      ├── Rename Mona.exe.new → Mona.exe
      ├── Start Mona.exe
      ├── Delete Mona.exe.old
      └── Delete self
```

### On Next Launch (after update)

1. `python.rs` detects missing `python/` directory (or version mismatch)
2. Re-extracts `python.tar.gz` → `%AppData%/mona/python/`
3. Gateway starts normally
4. App reports current version matches manifest — "up to date"

## Exe Replacement Strategy

On Windows, the running `Mona.exe` cannot be overwritten or renamed. The solution is a helper batch script that runs after the current process exits:

```bat
@echo off
:: Wait for the current process to exit
:wait
tasklist /FI "PID eq %1" 2>nul | find "%1" >nul
if %ERRORLEVEL%==0 (
    timeout /t 1 /nobreak >nul
    goto wait
)

:: Swap the exe
cd /d "%~dp0"
move /y "Mona.exe.new" "Mona.exe" >nul 2>&1

:: Start the new version
start "" "Mona.exe"

:: Cleanup
del "Mona.exe.old" >nul 2>&1
del "%~f0" >nul 2>&1
```

The updater:
1. Writes this script to a temp file
2. Launches it with the current process PID as argument
3. Exits the current process

This is a well-established pattern used by many Windows desktop applications.

## Rollback Strategy

Before applying the update, the updater preserves the previous state:

1. **Python runtime**: Rename `%AppData%/mona/python/` to `python.bak/` before deletion
2. **Python archive**: Rename `resources/python.tar.gz` to `python.tar.gz.bak` before replacement
3. **Exe**: The old exe is preserved as `Mona.exe.old` by the helper script

If the updated app fails to start or the gateway health check fails:

1. The helper script (or a recovery mode on next launch) detects the failure
2. Restores `python.bak/` → `python/`
3. Restores `python.tar.gz.bak` → `python.tar.gz`
4. Restores `Mona.exe.old` → `Mona.exe`

If the health check passes, cleanup deletes all `.bak` and `.old` files.

## Windows File Lock Handling

The gateway process must be fully stopped before any file replacement:

1. Call `GatewayState::stop()` and wait for it to complete
2. Add a 500ms grace period for Windows to release file locks on `.pyd`/`.dll` files
3. Only then proceed with file operations

## New File: `src-tauri/src/updater.rs`

Core functions:

| Function | Description |
|----------|-------------|
| `check_for_update()` | Fetch `update.json`, compare versions, return update availability |
| `perform_update()` | Download package, verify SHA256, stop gateway, replace files, stage exe, restart |
| `get_installed_version()` | Read version from `mona_ai-*.dist-info` directory |
| `verify_gateway_health()` | Wait for gateway `/health` endpoint after restart |
| `create_update_script()` | Generate the helper batch script for exe swap |

## Tauri Commands

| Command | Description |
|---------|-------------|
| `check_for_updates` | Returns `{ has_update: bool, current_version: str, latest_version: str, notes: str }` |
| `perform_update` | Executes the full update flow |
| `get_current_version` | Returns current installed version |

## Frontend UI

### Settings Page — Update Section

- Display current version
- "Check for Updates" button
- Update status indicator (checking / update available / up to date / updating)
- Download progress bar (with size estimate)
- Release notes display

### Startup Behavior

- Silent check 5 seconds after launch
- Show badge/notification if update available
- User clicks to enter update flow

## CI/CD Release Pipeline

The CI pipeline produces the update package alongside the NSIS installer:

```powershell
# 1. Build Tauri client
cd src-tauri && cargo tauri build
# Produces: Mona.exe (in target/release/)

# 2. Build Python runtime (same as current build process)
# ... download python-build-standalone, pip install mona-ai, re-pack ...
# Produces: python.tar.gz

# 3. Build update package
mkdir update-staging
copy target\release\Mona.exe update-staging\
copy python.tar.gz update-staging\
tar -czf "mona-$Version.tar.gz" -C update-staging Mona.exe python.tar.gz

# 4. Compute SHA256
$Hash = (Get-FileHash "mona-$Version.tar.gz" -Algorithm SHA256).Hash

# 5. Build NSIS installer (for first-time installs)
# ... standard tauri build process ...

# 6. Upload to VPS
scp "mona-$Version.tar.gz" vps:/var/www/mona-updates/releases/

# 7. Update manifest
# Edit update.json with new version, URL, SHA256, size
```

## Security

1. **SHA256 verification**: Update package hash verified against manifest before application
2. **Transport**: HTTPS required on VPS
3. **No credential exposure**: VPS URLs are public; update artifacts are hash-verified
4. **Rollback**: Automatic rollback on gateway health check failure
5. **No code execution from untrusted sources**: The helper script is generated locally, not downloaded

## File Change List

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add dependencies (reqwest, sha2, etc.) |
| `src-tauri/src/updater.rs` | **New** — Update module |
| `src-tauri/src/lib.rs` | Register updater commands |
| `src-tauri/src/python.rs` | Add `get_installed_version()` function |
| `webui/src/` | Update settings page with update UI |

## Out of Scope

- Incremental/delta updates (full package replacement only)
- Auto-update without user confirmation (user must approve)
- macOS/Linux support (Windows-only for now)
- Update scheduling (check on startup only)
- Differential binary patching
