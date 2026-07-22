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
└── Python Gateway        → PyInstaller COLLECT (mona-gateway/ directory with exe + _internal/)
```

**Client machines do NOT need Python installed.** The full Python 3.12 runtime + all dependencies are embedded in the PyInstaller-built `mona-gateway/` directory.

## Prerequisites

- Windows 10/11 x86_64
- Rust toolchain: `rustup target add x86_64-pc-windows-msvc`
- Node.js >= 18 + bun (or npm)
- Visual Studio Build Tools (C++ workload)
- Python 3.12+ with `pip install pyinstaller`

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

### Step 1: Build mona-gateway with PyInstaller (COLLECT / onedir mode)

The gateway is built as a **directory** (not a single exe) using PyInstaller's COLLECT mode. This avoids the slow onefile extraction at runtime and eliminates gateway startup failures caused by antivirus scanning.

**If `src-tauri/resources/mona-gateway/` already exists and no Python dependencies changed, skip this step.**

```powershell
# 1. Ensure mona-ai is installed (NON-EDITABLE mode)
pip install ".[api,wecom,weixin,pdf]"

# 2. Verify installation points to site-packages (NOT source directory)
Push-Location "C:\"
$monaFile = python -c "import mona; print(mona.__file__)" 2>&1
Pop-Location
if ($monaFile -notmatch "site-packages") {
    throw "mona-ai installed in editable mode! mona.__file__=$monaFile"
}

# 3. Build with PyInstaller using the spec file
pyinstaller src-tauri\mona-gateway.spec

# 4. The output is at dist/mona-gateway/ — copy to resources
#    (Remove old single-file gateway if it exists)
if (Test-Path "src-tauri\resources\mona-gateway.exe") {
    Remove-Item "src-tauri\resources\mona-gateway.exe" -Force
}
if (Test-Path "src-tauri\resources\mona-gateway") {
    Remove-Item "src-tauri\resources\mona-gateway" -Recurse -Force
}
# IMPORTANT: PowerShell `Copy-Item -Recurse source dest` nests source INSIDE dest if dest already exists.
# Explicitly create empty target dir and copy CONTENTS with `\*` to avoid nested mona-gateway/mona-gateway/.
New-Item -ItemType Directory -Path "src-tauri\resources\mona-gateway" -Force | Out-Null
Copy-Item -Recurse "dist\mona-gateway\*" "src-tauri\resources\mona-gateway"

# 5. Verify
$gatewayExe = "src-tauri\resources\mona-gateway\mona-gateway.exe"
if (-not (Test-Path $gatewayExe)) {
    throw "Gateway exe not found at $gatewayExe"
}
# Regression check: ensure no nested mona-gateway/mona-gateway/ directory was created
if (Test-Path "src-tauri\resources\mona-gateway\mona-gateway") {
    throw "Nested mona-gateway/mona-gateway/ detected! Copy-Item nesting bug. Aborting."
}
Write-Output "Gateway built successfully: $gatewayExe"
```

**Critical rules:**
- **NEVER use `pip install -e .`** — editable mode creates `.pth` files pointing to the build machine's source directory, which won't exist on client machines
- **Always use the spec file** (`src-tauri/mona-gateway.spec`) — it contains all hidden imports and data file configurations
- **The output is a directory**, not a single file: `dist/mona-gateway/mona-gateway.exe` + `dist/mona-gateway/_internal/`
- **Verify from a non-source directory** — run `import mona; print(mona.__file__)` from `C:\` to confirm it points to `site-packages/mona/__init__.py`

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
   - Find `mona-gateway/` directory via Tauri's `resource_dir()` API
   - Deploy gateway directory to `%AppData%/mona/gateway/mona-gateway/`
   - Auto-start the gateway on the configured port
   - Show the WebUI in the Tauri window
3. **No CMD windows should appear** — all `Command::new()` calls use `CREATE_NO_WINDOW` on Windows
4. Close the window — app should minimize to system tray (default `run_in_background: true`)
5. Right-click tray icon → "退出 Mona" — should stop gateway and exit

## Resource Path Resolution (Critical)

This is the #1 cause of "works in dev, fails after install" bugs.

### How Tauri bundles resources

When `tauri.conf.json` has `"resources": ["resources/mona-gateway/"]`, Tauri embeds the entire `mona-gateway/` directory into the installer. After installation, the directory is placed at:

| Installer | Resource location |
|-----------|-------------------|
| NSIS (per-user) | `C:\Users\{user}\AppData\Local\com.mona.desktop\resources\mona-gateway\` |
| MSI (per-machine) | `C:\Program Files\Mona\resources\mona-gateway\` |
| Dev mode | `src-tauri/resources/mona-gateway/` (relative to CWD) |

### How `python.rs` finds resources

The `find_gateway_resource_dir()` function uses a 3-level fallback:

1. **Tauri `resource_dir()` API** (primary) — `app_handle.path().resource_dir()` returns the correct path regardless of install method. This is the only reliable way in packaged builds.
2. **Next to executable** (fallback) — checks `exe_dir/resources/mona-gateway/` and `exe_dir/mona-gateway/`
3. **Relative path** (dev mode) — checks `resources/mona-gateway/` from CWD

**Important:** `deploy_gateway()` requires an `AppHandle` parameter because of this. The call chain is:

```
Frontend command / setup callback
  → GatewayState::start(settings, app_handle)
    → GatewayManager::start(settings, app_handle)
      → python::deploy_gateway(app_handle)
        → find_gateway_resource_dir(app_handle)
          → app_handle.path().resource_dir()
```

### What NOT to do

- **Never use `env!("CARGO_MANIFEST_DIR")`** — this is a compile-time constant pointing to the build machine's source directory. It does NOT exist on client machines.
- **Never use relative paths only** — the working directory at runtime is not `src-tauri/`.
- **Never assume resources are next to the exe** — NSIS puts them in a subdirectory.

## Gateway Deployment Lifecycle (Runtime Code)

The Rust code in `src-tauri/src/python.rs` handles gateway deployment at app startup:

1. Find `mona-gateway/` directory in bundled resources via `resource_dir()`
2. Compare exe file size with deployed version at `%AppData%/mona/gateway/mona-gateway/mona-gateway.exe`
3. If different or missing, copy entire directory tree to `%AppData%/mona/gateway/mona-gateway/`
4. The `gateway.rs` then runs the deployed exe with environment isolation

**No runtime `pip install`** — all dependencies are pre-bundled by PyInstaller.

## Gateway Environment Isolation

`gateway.rs` applies strict environment isolation when launching the gateway in release mode:

- **Strips harmful variables:** `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`, `VIRTUAL_ENV`, `CONDA_PREFIX`, `CONDA_DEFAULT_ENV`, `CONDA_SHLVL`, `CONDA_PYTHON_EXE`, `CONDA_PROMPT_MODIFIER`, `PIP_TARGET`, `PIP_PREFIX`, `PIP_USER`, `PIP_REQUIRE_VIRTUALENV`
- **Sets safety variables:** `PYTHONUNBUFFERED=1`, `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `PYTHONNOUSERSITE=1`, `NO_COLOR=1`

This prevents Conda/Anaconda/user site-packages from interfering with the packaged gateway.

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
| UPX compress the Tauri exe | ~30% of Rust binary |
| Exclude unused packages in spec | Varies (torch, matplotlib, etc.) |

Typical installer size: ~170MB (PyInstaller gateway ~80MB + Tauri ~10MB + WebUI ~5MB)

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Gateway not found after install | `find_gateway_resource_dir()` uses `resource_dir()` — ensure `AppHandle` is passed correctly through the call chain |
| `ImportError: cannot import name 'BaseTool'` | mona-ai was installed in editable mode. Rebuild with `pip install ".[extras]"` (no `-e`) |
| `mona.__file__` points to source directory | Same as above — editable install. Verify from `C:\` not the project root |
| CMD windows flash on launch | Add `creation_flags(0x08000000)` to all `Command::new()` calls on Windows |
| Gateway fails to start within 90s | Check `%AppData%/mona/gateway/mona-gateway/mona-gateway.exe` exists; check logs in `%AppData%/mona/` |
| Gateway crashes on machines with Conda | Environment isolation strips `CONDA_PREFIX`, `PYTHONPATH`, etc. — ensure `strip_harmful_python_env()` is called |
| Port conflict | Gateway auto-searches ports `gateway_port` to `gateway_port + 5`, waits 10s for port to free |
| `error: invalid value '1' for '--ci'` | Set `$env:CI = ""` before running `cargo tauri build` |
| Taskbar shows old icon | Windows icon cache; regenerate icons with `cargo tauri icon ..\logo.png` and clear cache |
| Version mismatch between MSI and Cargo.toml | Both `tauri.conf.json` and `Cargo.toml` must have the same `version` — see Step 0 |
| Icon has white background on taskbar | `logo.png` must be RGBA with transparent background, not RGB with white pixels |
| `CARGO_MANIFEST_DIR` path not found | Never use `env!("CARGO_MANIFEST_DIR")` — it's a compile-time constant pointing to build machine source dir. Use runtime detection instead. |
| PyInstaller missing import | Add to `hidden_imports` list in `src-tauri/mona-gateway.spec` |
| `resource path doesn't exist` build error | Ensure `src-tauri/resources/mona-gateway/` directory exists (with at least `.gitkeep`) before `cargo tauri build` |

## File Structure Reference

```
src-tauri/
├── Cargo.toml              # Rust dependencies + desktop app version
├── tauri.conf.json         # Tauri bundle config (version, targets, icons, resources)
├── build.rs                # Tauri build script
├── mona-gateway.spec       # PyInstaller spec (COLLECT mode, hidden imports, data files)
├── resources/
│   ├── README              # Notes about gateway build
│   └── mona-gateway/       # PyInstaller COLLECT output (built by Step 1)
│       ├── mona-gateway.exe
│       └── _internal/      # Python runtime + dependencies
├── src/
│   ├── lib.rs              # App setup, gateway auto-start, open::that with CREATE_NO_WINDOW
│   ├── gateway.rs          # Gateway process management (start/stop/health, env isolation, needs AppHandle)
│   ├── python.rs           # Gateway deployment (directory copy, resource_dir via AppHandle, NO pip install)
│   ├── settings.rs         # App settings (run_in_background, auto_start_gateway, port)
│   ├── updater.rs          # Auto-update (directory-based gateway backup/replace)
│   ├── tray.rs             # System tray (show window, open browser, quit, CREATE_NO_WINDOW)
│   ├── license.rs          # License validation (wmic with CREATE_NO_WINDOW)
│   ├── terminal/shell/local.rs  # Shell utils (where with CREATE_NO_WINDOW)
│   └── ...
└── icons/                  # App icons for Windows (generated by cargo tauri icon)
```
