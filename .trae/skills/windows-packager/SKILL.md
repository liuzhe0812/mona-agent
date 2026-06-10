---
name: "windows-packager"
description: "Build out-of-the-box Windows installer for Tauri+Python desktop apps. Invoke when user asks to package, build installer, create MSI/NSIS, or bundle Python runtime for Windows."
---

# Windows Packager

Build a self-contained Windows installer for Mona (Tauri + Python + WebUI) that works out-of-the-box with zero additional setup.

## Architecture Overview

```
Mona Installer
├── Tauri (Rust)          → Desktop shell (tray, window, gateway management)
├── WebUI (React + Vite)  → Frontend bundled into Tauri
└── Python Runtime        → Embedded python-build-standalone + pre-installed mona-ai
```

**Client machines do NOT need Python installed.** The full Python 3.12 runtime + all dependencies are embedded in the installer.

## Prerequisites

- Windows 10/11 x86_64
- Rust toolchain: `rustup target add x86_64-pc-windows-msvc`
- Node.js >= 18 + bun (or npm)
- Visual Studio Build Tools (C++ workload)

## Build Pipeline

### Step 0: Version Management

The version is managed by the `release` skill. If you are running a standalone package build (not a release), the version should already be set correctly in both files:

| File | Field | Example |
|------|-------|---------|
| `src-tauri/Cargo.toml` | `version` | `version = "0.1.0"` |
| `src-tauri/tauri.conf.json` | `version` | `"version": "0.1.0"` |

**If the user asks to bump version during packaging**, update both files:

```powershell
$NewVersion = "<determined_version>"

# 1. tauri.conf.json
$confContent = Get-Content "src-tauri\tauri.conf.json" -Raw
$confContent = $confContent -replace "(?<=`"version`":\s*`")[^`"]+(?=`")", $NewVersion
Set-Content "src-tauri\tauri.conf.json" $confContent

# 2. Cargo.toml
$CargoToml = Get-Content "src-tauri\Cargo.toml" -Raw
$CargoToml = $CargoToml -replace '(?m)^(version\s*=\s*)"[^"]*"', "`$1`"$NewVersion`""
Set-Content "src-tauri\Cargo.toml" $CargoToml
```

**After updating, confirm both files have the same version before proceeding.**

### Step 1: Prepare Python Runtime

The Python runtime must include the interpreter AND all mona-ai dependencies pre-installed so users never need pip or network access.

**If `python.tar.gz` already exists and no Python dependencies changed, skip this step.**

```powershell
$PythonVersion = "3.12.13"
$ReleaseTag = "20260510"
$Platform = "x86_64-pc-windows-msvc"
$BaseUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$ReleaseTag"
$FileName = "cpython-$PythonVersion+$ReleaseTag-$Platform-install_only.tar.gz"

# 1. Download python-build-standalone (skip if already downloaded)
$ResourcesDir = "src-tauri\resources"
New-Item -ItemType Directory -Path $ResourcesDir -Force | Out-Null
$PythonArchive = "$ResourcesDir\python.tar.gz"

# 2. Extract to temp dir
$TempDir = "$env:TEMP\mona-python-build"
if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
tar -xzf $PythonArchive -C $TempDir

# 3. Find the python directory (python-build-standalone extracts to python/)
$PythonDir = Get-ChildItem -Path $TempDir -Directory -Recurse -Filter "python" |
    Where-Object { Test-Path (Join-Path $_.FullName "python.exe") } |
    Select-Object -First 1

# 4. Install mona-ai with ALL optional dependencies (NON-EDITABLE mode)
$PythonExe = Join-Path $PythonDir.FullName "python.exe"
$ErrorActionPreference = "Continue"
& $PythonExe -m pip install ".[api,wecom,weixin,pdf]" --no-warn-script-location 2>&1 | Out-Null

# 5. Verify installation (must point to site-packages, NOT source directory)
Push-Location "C:\"
$monaFile = & $PythonExe -c "import mona; print(mona.__file__)" 2>&1
Pop-Location
if ($monaFile -notmatch "site-packages") {
    throw "mona-ai installed in editable mode! mona.__file__=$monaFile"
}

# 6. Clean up caches to reduce size
Get-ChildItem $PythonDir.FullName -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force
Get-ChildItem $PythonDir.FullName -Recurse -File -Filter "*.pyc" |
    Remove-Item -Force
Get-ChildItem $PythonDir.FullName -Recurse -File -Filter "*.pyo" |
    Remove-Item -Force

# 7. Re-pack into python.tar.gz
tar -czf $PythonArchive -C $PythonDir.Parent.FullName (Split-Path $PythonDir.FullName -Leaf)

# 8. Cleanup
Remove-Item -Recurse -Force $TempDir
```

**Critical rules:**
- **NEVER use `pip install -e .`** — editable mode creates `.pth` files pointing to the build machine's source directory, which won't exist on client machines. Always use `pip install ".[extras]"` without `-e`.
- **Verify from a non-source directory** — Python resolves imports from CWD first. Run `import mona; print(mona.__file__)` from `C:\` to confirm it points to `site-packages/mona/__init__.py`, not the source tree.
- Always install `mona-ai[api]` at minimum — the gateway requires `aiohttp`
- Install all optional deps you want to ship (`wecom`, `weixin`, `pdf`, etc.)
- Strip `__pycache__`, `.pyc`, `.pyo` to reduce archive size
- The version marker file (`.mona-python-version`) is written at runtime, not in the archive
- The `PYTHON_VERSION` constant in `src-tauri/src/python.rs` must match the downloaded Python version

### Step 2: Build Tauri Installer

WebUI build is handled automatically by `cargo tauri build` via `beforeBuildCommand` in `tauri.conf.json`.

```powershell
cd src-tauri
$env:CI = ""
cargo tauri build
cd ..
```

**Note:** Set `$env:CI = ""` to avoid the `--ci` flag error that occurs when the `CI` environment variable is set to `"1"`.

Output locations (version comes from Step 0):
- MSI installer: `src-tauri/target/release/bundle/msi/Mona_{version}_x64_en-US.msi`
- NSIS installer: `src-tauri/target/release/bundle/nsis/Mona_{version}_x64-setup.exe`

### Step 3: Verify the Build

After building, verify the installer works:

1. Install Mona on a clean Windows machine (or VM)
2. Launch the app — it should:
   - Find `python.tar.gz` via Tauri's `resource_dir()` API
   - Extract Python runtime to `%AppData%/mona/python/`
   - Auto-start the gateway on the configured port
   - Show the WebUI in the Tauri window
3. **No CMD windows should appear** — all `Command::new()` calls use `CREATE_NO_WINDOW` on Windows
4. Close the window — app should minimize to system tray (default `run_in_background: true`)
5. Right-click tray icon → "退出 Mona" — should stop gateway and exit

## Resource Path Resolution (Critical)

This is the #1 cause of "works in dev, fails after install" bugs.

### How Tauri bundles resources

When `tauri.conf.json` has `"resources": ["resources/*"]`, Tauri embeds `python.tar.gz` into the installer. After installation, the file is placed in a platform-specific directory:

| Installer | Resource location |
|-----------|-------------------|
| NSIS (per-user) | `C:\Users\{user}\AppData\Local\com.mona.desktop\resources\` |
| MSI (per-machine) | `C:\Program Files\Mona\resources\` |
| Dev mode | `src-tauri/resources/` (relative to CWD) |

### How `python.rs` finds resources

The `find_python_resource()` function uses a 3-level fallback:

1. **Tauri `resource_dir()` API** (primary) — `app_handle.path().resource_dir()` returns the correct path regardless of install method. This is the only reliable way in packaged builds.
2. **Next to executable** (fallback) — checks `exe_dir/python.tar.gz`
3. **Relative path** (dev mode) — checks `resources/python.tar.gz` from CWD

**Important:** `initialize_python()` requires an `AppHandle` parameter because of this. The call chain is:

```
Frontend command / setup callback
  → GatewayState::start(settings, app_handle)
    → GatewayManager::start(settings, app_handle)
      → python::initialize_python(app_handle)
        → find_python_resource(app_handle)
          → app_handle.path().resource_dir()
```

### What NOT to do

- **Never use `env!("CARGO_MANIFEST_DIR")`** — this is a compile-time constant pointing to the build machine's source directory. It does NOT exist on client machines.
- **Never use relative paths only** — the working directory at runtime is not `src-tauri/`.
- **Never assume resources are next to the exe** — NSIS puts them in a subdirectory.

## Python Runtime Lifecycle (Runtime Code)

The Rust code in `src-tauri/src/python.rs` handles Python initialization at app startup:

1. Check `%AppData%/mona/python/.mona-python-version` — if version matches, skip extraction
2. If not initialized, find `python.tar.gz` via `resource_dir()` and extract to `%AppData%/mona/python/`
3. Write version marker file
4. The `gateway.rs` then uses this Python to run `python -m mona gateway`

**No runtime `pip install`** — all dependencies are pre-installed in the archive.

## Gateway PYTHONPATH Detection

`gateway.rs` sets `PYTHONPATH` only in dev mode. It detects dev mode by checking if a `mona/` package directory exists relative to the exe's parent. In packaged builds, `mona-ai` is installed in `site-packages`, so `PYTHONPATH` is not set.

```rust
// Only set PYTHONPATH in dev mode (when source tree exists next to exe)
if let Ok(exe_path) = std::env::current_exe() {
    if let Some(exe_dir) = exe_path.parent() {
        let project_root = exe_dir.parent().unwrap_or(exe_dir);
        let mona_pkg_dir = project_root.join("mona");
        if mona_pkg_dir.is_dir() {
            // Dev mode: set PYTHONPATH to project root
        }
    }
}
```

## Windows CMD Window Suppression

All `std::process::Command` calls on Windows must use `CREATE_NO_WINDOW` (`0x08000000`) to prevent CMD flash:

```rust
#[cfg(windows)]
{
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
}
```

Files that require this flag:
- `src/gateway.rs` — Python gateway start + taskkill
- `src/lib.rs` — `open::that()` browser launch
- `src/tray.rs` — `open::that()` browser launch
- `src/license.rs` — `wmic` commands for hardware ID
- `src/terminal/shell/local.rs` — `where` command for executable lookup

## Updating Icons

When the logo changes:

1. **Ensure `logo.png` has transparent background** (RGBA mode, not RGB with white bg). If the logo has a white background, strip it first:
   ```python
   from PIL import Image
   img = Image.open("logo.png").convert("RGBA")
   # Remove white background
   r, g, b, a = img.split()
   diff = ImageChops.difference(Image.merge("RGB", (r, g, b)), Image.new("RGB", img.size, (255, 255, 255)))
   alpha = diff.convert("L").point(lambda x: 255 if x > 10 else 0)
   img.putalpha(alpha)
   img.save("logo.png")
   ```

2. **Regenerate Tauri icons:**
   ```powershell
   cd src-tauri
   cargo tauri icon ..\logo.png
   ```

3. **Update WebUI brand images** in `webui/public/brand/` if needed.

4. **Clear Windows icon cache** after installing:
   ```powershell
   Remove-Item "$env:LOCALAPPDATA\IconCache.db" -Force -ErrorAction SilentlyContinue
   Remove-Item "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache*" -Force -ErrorAction SilentlyContinue
   Stop-Process -Name explorer -Force; Start-Sleep 2; Start-Process explorer
   ```

## Size Optimization

| Technique | Estimated Savings |
|-----------|-------------------|
| Strip `__pycache__` and `.pyc` | ~30% of Python deps |
| Strip `test/` and `.dist-info/` | ~10% |
| Use `--no-compile` in pip | Avoids `.pyc` generation |
| Remove `pip`, `setuptools` from runtime | ~5MB |
| UPX compress the Tauri exe | ~30% of Rust binary |

Typical installer size: ~170MB (Python runtime ~80MB + deps ~80MB + Tauri ~10MB)

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Python runtime not found after install | `find_python_resource()` uses `resource_dir()` API — ensure `AppHandle` is passed correctly through the call chain |
| `ImportError: cannot import name 'BaseTool'` | mona-ai was installed in editable mode (`.pth` points to source dir). Rebuild python.tar.gz with `pip install ".[extras]"` (no `-e`) |
| `mona.__file__` points to source directory | Same as above — editable install. Verify from `C:\` not the project root |
| CMD windows flash on launch | Add `creation_flags(0x08000000)` to all `Command::new()` calls on Windows |
| Gateway fails to start | Check `%AppData%/mona/python/python.exe` exists; check logs in `%AppData%/mona/` |
| First launch is slow | Expected — Python extraction takes 10-30s; subsequent launches are instant |
| MSI install fails | Ensure no previous version running; try `msiexec /i Mona.msi /log install.log` |
| NSIS exe blocked by SmartScreen | Sign the installer with a code signing certificate |
| Python deps missing at runtime | Ensure `pip install` in build script includes all `[api]`, `[wecom]`, etc. extras |
| `taskkill` fails to stop gateway | Gateway process may have child processes; `taskkill /T /F` handles this |
| Port conflict | Gateway auto-searches ports `gateway_port` to `gateway_port + 5` |
| `error: invalid value '1' for '--ci'` | Set `$env:CI = ""` before running `cargo tauri build` |
| Taskbar shows old icon | Windows icon cache; regenerate icons with `cargo tauri icon ..\logo.png` and clear cache |
| Version mismatch between MSI and Cargo.toml | Both `tauri.conf.json` and `Cargo.toml` must have the same `version` — see Step 0 |
| Icon has white background on taskbar | `logo.png` must be RGBA with transparent background, not RGB with white pixels |
| `CARGO_MANIFEST_DIR` path not found | Never use `env!("CARGO_MANIFEST_DIR")` — it's a compile-time constant pointing to build machine source dir. Use runtime detection instead. |

## File Structure Reference

```
src-tauri/
├── Cargo.toml              # Rust dependencies + desktop app version
├── tauri.conf.json         # Tauri bundle config (version, targets, icons, resources)
├── build.rs                # Tauri build script
├── resources/
│   ├── README              # Notes about Python runtime
│   └── python.tar.gz       # Pre-built Python + mona-ai (generated by build script)
├── src/
│   ├── lib.rs              # App setup, gateway auto-start, open::that with CREATE_NO_WINDOW
│   ├── gateway.rs          # Gateway process management (start/stop/health, needs AppHandle, CREATE_NO_WINDOW)
│   ├── python.rs           # Python runtime init (uses resource_dir() via AppHandle, NO pip install)
│   ├── settings.rs         # App settings (run_in_background, auto_start_gateway, port)
│   ├── tray.rs             # System tray (show window, open browser, quit, CREATE_NO_WINDOW)
│   ├── license.rs          # License validation (wmic with CREATE_NO_WINDOW)
│   ├── terminal/shell/local.rs  # Shell utils (where with CREATE_NO_WINDOW)
│   └── ...
└── icons/                  # App icons for Windows (generated by cargo tauri icon)
```
