# Mona Desktop Hot-Update Design

## Overview

Mona Desktop is a Tauri v2 application distributed as a Windows NSIS installer. It embeds a Python runtime with `mona-ai` pre-installed, running the gateway as a subprocess. This document describes the hot-update mechanism for both the Tauri client and the Python backend.

## Runtime Layout (User's Machine)

Understanding the actual file layout is critical for the update design:

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

1. **No runtime pip**: The Python runtime has mona-ai and all dependencies pre-installed in `python.tar.gz` during build. `pip` itself may be stripped from the runtime to save space (~5MB). The `install_mona()` function was intentionally removed from `python.rs`.

2. **Python + mona-ai are one unit**: The `python.tar.gz` is built by: downloading python-build-standalone → `pip install ".[api,wecom,weixin,pdf]"` → strip caches → re-pack. This means mona-ai and its entire dependency tree are bundled together.

3. **Gateway is a subprocess**: `gateway.rs` runs `python.exe -m mona gateway` using the embedded Python. In production, PYTHONPATH is NOT set; mona-ai is found via site-packages.

4. **First-launch extraction**: `python.rs` checks `.mona-python-version` marker; if missing or version mismatch, it extracts `python.tar.gz` to `%AppData%/mona/python/`.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 VPS (Nginx)                      │
│                                                  │
│  /updates/stable.json    ← Tauri client manifest │
│  /updates/backend.json   ← Python backend manifest│
│  /releases/*.exe         ← Client installers     │
│  /releases/backend-*.tar.gz ← Python+mona-ai pkg │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS
                   ▼
┌─────────────────────────────────────────────────┐
│           Mona Desktop (Tauri v2)                │
│                                                  │
│  ┌──────────────┐    ┌─────────────────────┐    │
│  │ tauri-plugin │    │  updater.rs (custom)  │    │
│  │   -updater   │    │  Backend update mod   │    │
│  └──────┬───────┘    └──────────┬──────────┘    │
│         │                       │                │
│         ▼                       ▼                │
│   Client exe replace    Replace python dir       │
│   (apply on restart)    + restart gateway proc   │
└─────────────────────────────────────────────────┘
```

## Component 1: Tauri Client Update (tauri-plugin-updater)

### Server-side

Nginx serves a static JSON manifest at `/updates/stable.json`:

```json
{
  "version": "0.2.0",
  "notes": "Bug fixes and improvements",
  "pub_date": "2026-06-02T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://<VPS_HOST>/releases/mona-0.2.0-x64-setup.exe",
      "signature": "<ed25519_signature>"
    }
  }
}
```

### Client-side

1. Add `tauri-plugin-updater = "2"` to `src-tauri/Cargo.toml`
2. Configure in `tauri.conf.json`:
   ```json
   {
     "plugins": {
       "updater": {
         "endpoints": ["https://<VPS_HOST>/updates/stable.json"],
         "pubkey": "<PUBLIC_KEY>"
       }
     }
   }
   ```
3. Register plugin in `lib.rs`: `.plugin(tauri_plugin_updater::Builder::new().build())`
4. Frontend checks on startup, downloads in background, applies on next restart

### Security

- ed25519 signature verification built into `tauri-plugin-updater`
- Private key used only during CI/CD signing; public key embedded in app

## Component 2: Python Backend Update (Custom Rust Module)

### Why NOT pip install at runtime

The original design proposed `pip install <wheel>` at runtime. This is **not viable** because:

1. **pip may not exist** in the embedded Python runtime (stripped to save ~5MB)
2. **Dependency resolution** is unreliable without a working pip + network access
3. **mona-ai and Python are one unit** — the entire `python.tar.gz` is built on the CI machine with all deps pre-resolved
4. **File locks on Windows** — gateway process holds .pyd/.dll files open, pip install can't overwrite them

### Strategy: Backend Package (site-packages overlay)

Instead of pip install, we ship a **backend package** — a tar.gz containing only the site-packages content that changed. This is much smaller than the full Python runtime (~10-20MB vs ~80MB).

**Build-time**: On the CI machine, after building the full `python.tar.gz`, diff the new site-packages against the previous release's site-packages and produce `backend-<version>.tar.gz` containing only changed/added files.

**Runtime**: The updater downloads `backend-<version>.tar.gz`, stops the gateway, extracts it over `%AppData%/mona/python/Lib/site-packages/`, and restarts the gateway.

For the rare case where Python runtime itself needs updating, we ship the full `python.tar.gz`.

### Server-side

Nginx serves `/updates/backend.json`:

```json
{
  "version": "0.2.0",
  "backend_package": {
    "version": "0.2.0",
    "url": "https://<VPS_HOST>/releases/backend-0.2.0.tar.gz",
    "sha256": "abc123...",
    "size": 15728640
  },
  "full_runtime": {
    "python_version": "3.12.13",
    "mona_version": "0.2.0",
    "url": "https://<VPS_HOST>/releases/python-0.2.0.tar.gz",
    "sha256": "def456...",
    "size": 83886080
  }
}
```

- `backend_package`: Incremental site-packages overlay (~10-20MB). Used for most updates.
- `full_runtime`: Complete Python+mona-ai archive (~80MB). Used only when Python runtime itself changes, or as a fallback.

### Version Tracking

| Component | Method | Location |
|-----------|--------|----------|
| Python runtime | `.mona-python-version` marker file | `app_data_dir()/python/` (existing) |
| mona-ai package | Read from `mona_ai-*.dist-info/METADATA` | `app_data_dir()/python/Lib/site-packages/` |

No additional marker file needed. The mona-ai version is read directly from the installed dist-info:

```rust
fn get_installed_mona_version() -> Option<String> {
    let site_packages = python_dir().join("Lib").join("site-packages");
    // Scan for mona_ai-*.dist-info/PKG-INFO or METADATA
    for entry in fs::read_dir(&site_packages).ok()? {
        let name = entry.ok()?.file_name();
        let name_str = name.to_str()?;
        if name_str.starts_with("mona_ai-") && name_str.ends_with(".dist-info") {
            // Parse version from "mona_ai-0.2.0.dist-info"
            let version = name_str
                .strip_prefix("mona_ai-")?
                .strip_suffix(".dist-info")?;
            return Some(version.to_string());
        }
    }
    None
}
```

### Update Flow

```
App startup
  │
  ├─ Fetch backend.json from VPS
  │
  ├─ Compare backend_package.version vs installed mona-ai version
  │   ├─ Same → skip
  │   └─ Different →
  │       ├─ Is Python runtime version also changed?
  │       │   ├─ Yes → download full_runtime tar.gz (full replacement)
  │       │   └─ No  → download backend_package tar.gz (site-packages overlay)
  │       ├─ Stop gateway
  │       ├─ Verify SHA256
  │       ├─ Extract archive
  │       │   ├─ Full runtime: delete old python dir → extract new one → write .mona-python-version
  │       │   └─ Backend package: extract over site-packages (overwrite existing)
  │       ├─ Start gateway
  │       └─ Verify gateway health check
  │
  └─ Done
```

### New File: `src-tauri/src/updater.rs`

Core functions:

- `check_backend_update()` — Fetch `backend.json`, compare versions, return update availability
- `perform_backend_update()` — Download backend package, verify SHA256, stop gateway, extract, start gateway
- `perform_full_runtime_update()` — Download full runtime, verify SHA256, stop gateway, replace python dir, start gateway
- `get_installed_mona_version()` — Read version from dist-info directory
- `verify_gateway_health()` — Wait for gateway `/health` endpoint after restart

### Tauri Commands

| Command | Description |
|---------|-------------|
| `check_for_updates` | Returns `{ client: {has_update, version}, backend: {has_update, version} }` |
| `update_backend` | Executes Python backend update (auto-selects backend_package or full_runtime) |
| `get_current_versions` | Returns current client and backend versions |

### Rollback Strategy

Before applying a backend update, the updater creates a snapshot of the current site-packages state:

1. Rename `%AppData%/mona/python/Lib/site-packages` to `site-packages.bak`
2. Extract new files into a fresh `site-packages` directory
3. If gateway health check fails after restart, delete new `site-packages` and rename `site-packages.bak` back
4. If health check passes, delete `site-packages.bak`

For full runtime updates, the same strategy applies at the `python/` directory level.

### Windows File Lock Handling

The gateway process must be fully stopped before any file replacement. The current `gateway.rs` uses `taskkill /PID <pid> /T /F` to kill the process tree, then calls `child.wait()` to ensure the process has exited. The updater must:

1. Call `GatewayState::stop()` and wait for it to complete
2. Add a 500ms grace period for Windows to release file locks
3. Only then proceed with file extraction

## Component 3: VPS Update Server

### Setup

Nginx static file server with HTTPS (Let's Encrypt cert).

Directory structure:
```
/var/www/mona-updates/
├── updates/
│   ├── stable.json
│   └── backend.json
└── releases/
    ├── mona-0.2.0-x64-setup.exe
    ├── backend-0.2.0.tar.gz          ← site-packages overlay (~10-20MB)
    └── python-0.2.0.tar.gz           ← full runtime (~80MB, rare)
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

## Component 4: Frontend UI

### Settings Page — Update Section

- Display current versions (client + backend)
- "Check for Updates" button
- Update status indicator (checking / update available / up to date / updating)
- Download progress bar (with size estimate)
- Release notes display

### Startup Behavior

- Silent check 5 seconds after launch
- Show badge/notification in tray menu if update available
- User clicks to enter update flow

## Component 5: CI/CD Release Pipeline

### Building the backend package

The CI pipeline produces both the full `python.tar.gz` (for the NSIS installer) and the incremental `backend-<version>.tar.gz` (for hot-update):

```powershell
# 1. Build full python.tar.gz (same as current build process)
# ... download python-build-standalone, pip install mona-ai, re-pack ...

# 2. Build backend package (site-packages overlay)
# Compare new site-packages against previous release
$OldSitePackages = "previous-release/python/Lib/site-packages"
$NewSitePackages = "build-output/python/Lib/site-packages"

# Create tar.gz of the entire new site-packages
tar -czf "backend-$Version.tar.gz" -C $NewSitePackages .

# 3. Compute SHA256
$Hash = (Get-FileHash "backend-$Version.tar.gz" -Algorithm SHA256).Hash
```

### Full release pipeline

```bash
# 1. Build Tauri client
cd src-tauri && cargo tauri build

# 2. Build Python runtime + backend package
# (see above)

# 3. Sign client binary
cargo tauri signer sign <exe>

# 4. Upload artifacts to VPS
scp releases/* vps:/var/www/mona-updates/releases/

# 5. Update manifests
# Edit stable.json and backend.json with new version, URL, signature, SHA256
```

## Security

1. **Client updates**: ed25519 signature verification (tauri-plugin-updater built-in)
2. **Backend updates**: SHA256 hash verification against manifest
3. **Transport**: HTTPS required on VPS
4. **No credential exposure**: VPS URLs are public; update artifacts are signed/hashed
5. **Rollback**: Automatic rollback on gateway health check failure

## File Change List

| File | Change |
|------|--------|
| `src-tauri/Cargo.toml` | Add `tauri-plugin-updater` dependency |
| `src-tauri/tauri.conf.json` | Add updater config + pubkey |
| `src-tauri/src/updater.rs` | **New** — Backend update module |
| `src-tauri/src/lib.rs` | Register updater plugin + commands |
| `src-tauri/src/python.rs` | Add `get_installed_mona_version()` function |
| `webui/src/` | Update settings page with update UI |

## Out of Scope

- Incremental/delta updates for the client binary (full replacement only)
- Auto-update without user confirmation (user must approve)
- macOS/Linux support (Windows-only for now)
- Update scheduling (check on startup only)
- Differential binary patching for backend package
