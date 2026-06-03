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

Version numbers must be kept in sync across two files (the Tauri desktop version):

| File | Field | Example |
|------|-------|---------|
| `src-tauri/Cargo.toml` | `version` | `version = "0.1.0"` |
| `src-tauri/tauri.conf.json` | `version` | `"version": "0.1.0"` |

The Python package version in `pyproject.toml` is independent and does NOT need to match.

**Version bump rules:**

- If the user specifies a version (e.g. "打包 0.2.0"), use that exact version
- If the user specifies a bump rule:
  - `patch` — increment last segment: `0.1.0` → `0.1.1`
  - `minor` — increment middle segment, reset last: `0.1.0` → `0.2.0`
  - `major` — increment first segment, reset others: `0.1.0` → `1.0.0`
- **If no version is specified, default to `patch` bump** — increment the last segment by 1

**Implementation:**

```powershell
# Read current version from tauri.conf.json
$TauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$CurrentVersion = $TauriConf.version

# Determine new version
# - If user specified a version: use it directly
# - If user specified a rule (major/minor/patch): apply it
# - If nothing specified: default to patch bump
$Parts = $CurrentVersion -split '\.'
$Major = [int]$Parts[0]
$Minor = [int]$Parts[1]
$Patch = [int]$Parts[2]

# Default: patch bump
$NewMajor = $Major
$NewMinor = $Minor
$NewPatch = $Patch + 1

$NewVersion = "$NewMajor.$NewMinor.$NewPatch"

# Update both files
# 1. tauri.conf.json
$TauriConf.version = $NewVersion
$TauriConf | ConvertTo-Json -Depth 10 | Set-Content "src-tauri\tauri.conf.json"

# 2. Cargo.toml — replace the version line
$CargoToml = Get-Content "src-tauri\Cargo.toml" -Raw
$CargoToml = $CargoToml -replace '(?m)^(version\s*=\s*)"[^"]*"', "`$1`"$NewVersion`""
Set-Content "src-tauri\Cargo.toml" $CargoToml

Write-Output "Version bumped: $CurrentVersion -> $NewVersion"
```

**After updating, confirm both files have the same version before proceeding.**

### Step 1: Prepare Python Runtime

The Python runtime must include the interpreter AND all mona-ai dependencies pre-installed so users never need pip or network access.

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

### Step 2: Build WebUI

```powershell
cd webui
npm install
npm run build:tauri
cd ..
```

This produces `src-tauri/dist/` which Tauri embeds as the frontend.

If the WebUI is already built and no frontend changes were made, this step can be skipped — `cargo tauri build` runs `beforeBuildCommand` automatically.

### Step 3: Build Tauri Installer

```powershell
cd src-tauri
$env:CI = ""
cargo tauri build
cd ..
```

**Note:** Set `$env:CI = ""` to avoid the `--ci` flag error that occurs when the `CI` environment variable is set to `"1"` (common in some terminal environments).

Output locations (version comes from Step 0):
- MSI installer: `src-tauri/target/release/bundle/msi/Mona_{version}_x64_en-US.msi`
- NSIS installer: `src-tauri/target/release/bundle/nsis/Mona_{version}_x64-setup.exe`

### Step 4: Verify the Build

After building, verify the installer works:

1. Install Mona on a clean Windows machine (or VM)
2. Launch the app — it should:
   - Extract Python runtime from `resources/python.tar.gz` to `%AppData%/mona/python/`
   - Auto-start the gateway on the configured port
   - Show the WebUI in the Tauri window
3. **No CMD windows should appear** — all `Command::new()` calls use `CREATE_NO_WINDOW` on Windows
4. Close the window — app should minimize to system tray (default `run_in_background: true`)
5. Right-click tray icon → "退出 Mona" — should stop gateway and exit

## Tauri Bundle Configuration

The `src-tauri/tauri.conf.json` controls the installer format:

```json
{
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "resources": [
      "resources/*"
    ]
  }
}
```

**`resources/*`** is critical — this embeds `python.tar.gz` into the installer.

## Python Runtime Lifecycle (Runtime Code)

The Rust code in `src-tauri/src/python.rs` handles Python initialization at app startup:

1. Check `%AppData%/mona/python/.mona-python-version` — if version matches, skip extraction
2. If not initialized, extract `resources/python.tar.gz` to `%AppData%/mona/python/`
3. Write version marker file
4. The `gateway.rs` then uses this Python to run `python -m mona gateway`

**No runtime `pip install`** — all dependencies are pre-installed in the archive. The `install_mona()` function has been removed from `python.rs`.

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

When the logo changes, regenerate all icon formats:

```powershell
cd src-tauri
cargo tauri icon ..\logo.png
```

Also update WebUI brand images in `webui/public/brand/` if needed.

## Size Optimization

| Technique | Estimated Savings |
|-----------|-------------------|
| Strip `__pycache__` and `.pyc` | ~30% of Python deps |
| Strip `test/` and `.dist-info/` | ~10% |
| Use `--no-compile` in pip | Avoids `.pyc` generation |
| Remove `pip`, `setuptools` from runtime | ~5MB |
| UPX compress the Tauri exe | ~30% of Rust binary |

Typical installer size: ~170MB (Python runtime ~80MB + deps ~80MB + Tauri ~10MB)

## CI/CD Integration (GitHub Actions)

```yaml
name: Build Windows Installer
on:
  push:
    tags: ["v*"]
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: x86_64-pc-windows-msvc
      - name: Setup bun
        run: npm install -g bun
      - name: Build Python runtime
        run: powershell -File scripts/build-python-runtime.ps1
      - name: Build WebUI
        run: cd webui && bun install && bun run build:tauri
      - name: Build Tauri
        run: cd src-tauri && cargo tauri build
        env:
          CI: ""
      - uses: actions/upload-artifact@v4
        with:
          name: Mona-installer
          path: |
            src-tauri/target/release/bundle/msi/*.msi
            src-tauri/target/release/bundle/nsis/*.exe
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ImportError: cannot import name 'BaseTool'` | mona-ai was installed in editable mode (`.pth` points to source dir). Rebuild python.tar.gz with `pip install ".[extras]"` (no `-e`) |
| `mona.__file__` points to source directory | Same as above — editable install. Verify from `C:\` not the project root |
| CMD windows flash on launch | Add `creation_flags(0x08000000)` to all `Command::new()` calls on Windows |
| `python.tar.gz` not found in resources | Run the Python runtime build script first |
| Gateway fails to start | Check `%AppData%/mona/python/python.exe` exists; check logs in `%AppData%/mona/` |
| First launch is slow | Expected — Python extraction takes 10-30s; subsequent launches are instant |
| MSI install fails | Ensure no previous version running; try `msiexec /i Mona.msi /log install.log` |
| NSIS exe blocked by SmartScreen | Sign the installer with a code signing certificate |
| Python deps missing at runtime | Ensure `pip install` in build script includes all `[api]`, `[wecom]`, etc. extras |
| `taskkill` fails to stop gateway | Gateway process may have child processes; `taskkill /T /F` handles this |
| Port conflict | Gateway auto-searches ports `gateway_port` to `gateway_port + 5` |
| `error: invalid value '1' for '--ci'` | Set `$env:CI = ""` before running `cargo tauri build` |
| `npm error Missing script: "build:web"` | Ensure `tauri.conf.json` uses `"npm run build:tauri"` not `"npm run build:web && npm run build"` |
| Taskbar shows old icon | Windows icon cache may be stale; run `cargo tauri icon ..\logo.png` and rebuild |
| Version mismatch between MSI and Cargo.toml | Both `tauri.conf.json` and `Cargo.toml` must have the same `version` — see Step 0 |

## File Structure Reference

```
src-tauri/
├── Cargo.toml              # Rust dependencies + desktop app version
├── tauri.conf.json         # Tauri bundle config (version, targets, icons, resources)
├── build.rs                # Tauri build script
├── download-python.ps1     # Download python-build-standalone (raw, no deps)
├── resources/
│   ├── README              # Notes about Python runtime
│   └── python.tar.gz       # Pre-built Python + mona-ai (generated by build script)
├── src/
│   ├── lib.rs              # App setup, gateway auto-start, open::that with CREATE_NO_WINDOW
│   ├── gateway.rs          # Gateway process management (start/stop/health check, CREATE_NO_WINDOW)
│   ├── python.rs           # Python runtime initialization (extract + version check, NO pip install)
│   ├── settings.rs         # App settings (run_in_background, auto_start_gateway, port)
│   ├── tray.rs             # System tray (show window, open browser, quit, CREATE_NO_WINDOW)
│   ├── license.rs          # License validation (wmic with CREATE_NO_WINDOW)
│   ├── terminal/shell/local.rs  # Shell utils (where with CREATE_NO_WINDOW)
│   └── ...
└── icons/                  # App icons for Windows (generated by cargo tauri icon)
```
