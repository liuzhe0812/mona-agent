---
name: "macos-packager"
description: "Build macOS installer (DMG) for Tauri+Python desktop app. Invoke when user asks to package for Mac, build macOS installer, or create DMG."
---

# macOS Packager

Build a self-contained macOS installer (DMG) for Mona (Tauri + Python + WebUI) that works out-of-the-box with zero additional setup.

## Architecture Overview

```
Mona.app
├── Tauri (Rust)          → Desktop shell (tray, window, gateway management)
├── WebUI (React + Vite)  → Frontend bundled into Tauri
└── Python Runtime        → Embedded python-build-standalone + pre-installed mona-ai
```

**Client machines do NOT need Python installed.** The full Python 3.12 runtime + all dependencies are embedded in the app bundle.

## Prerequisites

- macOS 12+ (Monterey or later) on Apple Silicon (M1+) or Intel
- Xcode Command Line Tools: `xcode-select --install`
- Rust toolchain: `rustup target add aarch64-apple-darwin` (Apple Silicon) or `x86_64-apple-darwin` (Intel)
- Node.js >= 18 + npm
- Python 3.12+ (for building mona-gateway)

## Step 0: Code Changes (Required Before First Build)

The current codebase has several Windows-only hardcoded values that must be made cross-platform before macOS builds can work. Apply ALL changes below before proceeding.

### 0.1 `src-tauri/src/python.rs` — Platform-specific gateway binary name

Change the hardcoded `GATEWAY_EXE_NAME` constant:

```rust
// BEFORE:
const GATEWAY_EXE_NAME: &str = "mona-gateway.exe";

// AFTER:
#[cfg(windows)]
const GATEWAY_EXE_NAME: &str = "mona-gateway.exe";
#[cfg(not(windows))]
const GATEWAY_EXE_NAME: &str = "mona-gateway";
```

### 0.2 `src-tauri/src/lib.rs` — Fix `diagnose_gateway` hardcoded `.exe`

The `diagnose_gateway` function hardcodes `mona-gateway.exe` in resource candidate paths. Replace all occurrences with the platform-aware constant:

```rust
// BEFORE (in diagnose_gateway):
let c = rd.join("mona-gateway.exe");
// ...
let c = if sub.is_empty() { ed.join("mona-gateway.exe") } else { ed.join(sub).join("mona-gateway.exe") };

// AFTER:
let c = rd.join(python::GATEWAY_EXE_NAME);
// ...
let c = if sub.is_empty() { ed.join(python::GATEWAY_EXE_NAME) } else { ed.join(sub).join(python::GATEWAY_EXE_NAME) };
```

Note: `GATEWAY_EXE_NAME` must be made `pub` in `python.rs` for this to work:

```rust
#[cfg(windows)]
pub const GATEWAY_EXE_NAME: &str = "mona-gateway.exe";
#[cfg(not(windows))]
pub const GATEWAY_EXE_NAME: &str = "mona-gateway";
```

### 0.3 `src-tauri/Cargo.toml` — Make `windows` crate Windows-only + add `libc`

The `windows` crate is currently an unconditional dependency. Move it to a target-specific section. Also add `libc` which is used by `gateway.rs` for `SIGTERM` on non-Windows but is currently missing from dependencies:

```toml
# BEFORE:
windows = { version = "0.61", features = [
    "Win32_UI_Shell",
    "Win32_UI_WindowsAndMessaging",
    "Win32_Storage_FileSystem",
    "Win32_Graphics_Gdi",
    "Win32_Foundation",
] }

# AFTER (move to bottom of file):
[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = [
    "Win32_UI_Shell",
    "Win32_UI_WindowsAndMessaging",
    "Win32_Storage_FileSystem",
    "Win32_Graphics_Gdi",
    "Win32_Foundation",
] }

[target.'cfg(not(windows))'.dependencies]
libc = "0.2"
```

**Why:** `gateway.rs` line 129 uses `libc::kill(pid as i32, libc::SIGTERM)` inside a `#[cfg(not(windows))]` block, but `libc` is not listed as a dependency. This compiles on Windows only because the block is excluded; on macOS it will fail to link.

### 0.4 `src-tauri/src/updater.rs` — Platform-aware update mechanism

The updater is entirely Windows-specific. Add `#[cfg]` blocks for macOS:

**`install_update` function** — platform-specific binary names:

```rust
// BEFORE:
let new_exe = staging_dir.join("Mona.exe");
let new_gateway = staging_dir.join("mona-gateway.exe");

// AFTER:
#[cfg(windows)]
let new_exe = staging_dir.join("Mona.exe");
#[cfg(not(windows))]
let new_exe = staging_dir.join("Mona");

#[cfg(windows)]
let new_gateway = staging_dir.join("mona-gateway.exe");
#[cfg(not(windows))]
let new_gateway = staging_dir.join("mona-gateway");
```

Similarly, update the resource path and backup logic:

```rust
// BEFORE:
let resource_gateway = install_dir.join("resources").join("mona-gateway.exe");
let bak_path = resource_gateway.with_extension("exe.bak");

// AFTER:
let resource_gateway = install_dir.join("resources").join(python::GATEWAY_EXE_NAME);
#[cfg(windows)]
let bak_path = resource_gateway.with_extension("exe.bak");
#[cfg(not(windows))]
let bak_path = resource_gateway.with_extension("bak");
```

**`launch_update_restart` function** — macOS uses a shell script instead of batch:

```rust
#[cfg(windows)]
pub fn launch_update_restart() -> Result<(), String> {
    // ... existing Windows batch script logic ...
}

#[cfg(not(windows))]
pub fn launch_update_restart() -> Result<(), String> {
    let install_dir = get_install_dir()?;
    let current_pid = std::process::id();

    let script_content = format!(
        r#"#!/bin/bash
while kill -0 {pid} 2>/dev/null; do
    sleep 1
done
cd "{install_dir}"
mv -f "Mona.new" "Mona" 2>/dev/null
chmod +x "Mona"
open "Mona"
rm -f "Mona.old" "$0"
"#,
        pid = current_pid,
        install_dir = install_dir.display()
    );

    let script_path = install_dir.join("_update_restart.sh");
    fs::write(&script_path, &script_content)
        .map_err(|e| format!("Failed to write update script: {}", e))?;

    // Make executable
    std::process::Command::new("chmod")
        .args(["+x", &script_path.display().to_string()])
        .status()
        .map_err(|e| format!("Failed to chmod script: {}", e))?;

    std::process::Command::new("bash")
        .arg(&script_path.display().to_string())
        .spawn()
        .map_err(|e| format!("Failed to launch update script: {}", e))?;

    Ok(())
}
```

**`cleanup_after_update` function** — platform-specific file names:

```rust
// BEFORE:
let gateway_bak = install_dir.join("resources").join("mona-gateway.exe.bak");
let exe_old = install_dir.join("Mona.exe.old");

// AFTER:
let gateway_bak = install_dir.join("resources")
    .join(format!("{}.bak", python::GATEWAY_EXE_NAME));
#[cfg(windows)]
let exe_old = install_dir.join("Mona.exe.old");
#[cfg(not(windows))]
let exe_old = install_dir.join("Mona.old");
```

### 0.5 `src-tauri/tauri.conf.json` — Add macOS bundle config

Add a `macOS` section under `bundle`:

```json
{
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "resources": [
      "resources/mona-gateway"
    ],
    "macOS": {
      "minimumSystemVersion": "12.0",
      "entitlements": null,
      "exceptionDomain": "",
      "frameworks": [],
      "providerShortName": null,
      "signingIdentity": null
    },
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper",
        "silent": true
      }
    }
  }
}
```

**Important:** The `resources` field must use the platform-appropriate name. Since Tauri doesn't support per-platform resource names in `tauri.conf.json`, use a build script or symlink approach:

- Option A: On macOS, name the gateway binary `mona-gateway` (no extension) in `src-tauri/resources/`
- Option B: Use a build script (`build.rs`) to copy the correct file

**Recommended approach:** Keep `resources/mona-gateway.exe` for Windows and create `resources/mona-gateway` for macOS. Use a conditional resources list:

```json
"resources": [
  "resources/mona-gateway*"
]
```

This glob pattern matches both `mona-gateway.exe` (Windows) and `mona-gateway` (macOS).

### 0.6 `src-tauri/src/license.rs` — macOS machine fingerprint

The `get_cpu_info()` and `get_disk_serial()` functions use `/proc/cpuinfo` and `lsblk` on non-Windows, which are Linux-specific. Add macOS-specific paths:

```rust
fn get_cpu_info() -> String {
    #[cfg(windows)]
    {
        // ... existing Windows code ...
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("sh")
            .args(["-c", "sysctl -n machdep.cpu.brand_string"])
            .output();
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                format!("cpu:{}", stdout.trim())
            }
            Err(_) => "cpu:unknown".into(),
        }
    }
    #[cfg(target_os = "linux")]
    {
        // ... existing Linux code ...
    }
}

fn get_disk_serial() -> String {
    #[cfg(windows)]
    {
        // ... existing Windows code ...
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("sh")
            .args(["-c", "ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/ { gsub(/\"/,\"\"); print $NF }'"])
            .output();
        match output {
            Ok(out) => {
                let uuid = String::from_utf8_lossy(&out.stdout).trim().to_string();
                format!("disk:{}", uuid)
            }
            Err(_) => "disk:unknown".into(),
        }
    }
    #[cfg(target_os = "linux")]
    {
        // ... existing Linux code ...
    }
}
```

## Step 1: Version Management

Same as `windows-packager` — both `tauri.conf.json` and `Cargo.toml` must have the same version.

```bash
NEW_VERSION="<determined_version>"

# 1. tauri.conf.json
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" src-tauri/tauri.conf.json

# 2. Cargo.toml
sed -i '' "s/^version = \"[^\"]*\"/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml
```

**After updating, confirm both files have the same version before proceeding.**

## Step 2: Prepare Python Runtime

The Python runtime must include the interpreter AND all mona-ai dependencies pre-installed.

**If `python.tar.gz` already exists and no Python dependencies changed, skip this step.**

```bash
PYTHON_VERSION="3.12.13"
RELEASE_TAG="20260510"

# Detect platform
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
    PLATFORM="aarch64-apple-darwin"
else
    PLATFORM="x86_64-apple-darwin"
fi

BASE_URL="https://github.com/astral-sh/python-build-standalone/releases/download/$RELEASE_TAG"
FILE_NAME="cpython-$PYTHON_VERSION+$RELEASE_TAG-$PLATFORM-install_only.tar.gz"

RESOURCES_DIR="src-tauri/resources"
mkdir -p "$RESOURCES_DIR"
PYTHON_ARCHIVE="$RESOURCES_DIR/python.tar.gz"

# 1. Download python-build-standalone (skip if already downloaded)
if [[ ! -f "$PYTHON_ARCHIVE" ]]; then
    echo "Downloading python-build-standalone..."
    curl -fSL -o "$PYTHON_ARCHIVE" "$BASE_URL/$FILE_NAME"
else
    echo "python.tar.gz already exists, skipping download"
fi

# 2. Extract to temp dir
TEMP_DIR=$(mktemp -d)
echo "Extracting python..."
tar -xzf "$PYTHON_ARCHIVE" -C "$TEMP_DIR"

# 3. Find the python directory
PYTHON_DIR=$(find "$TEMP_DIR" -name "python3*" -type f -path "*/bin/*" | head -1 | xargs dirname | xargs dirname)
if [[ -z "$PYTHON_DIR" ]]; then
    PYTHON_DIR=$(find "$TEMP_DIR" -name "python" -type d | head -1)
fi

PYTHON_BIN="$PYTHON_DIR/bin/python3"
if [[ ! -f "$PYTHON_BIN" ]]; then
    PYTHON_BIN="$PYTHON_DIR/bin/python"
fi
echo "Found Python at: $PYTHON_BIN"

# 4. Install mona-ai with ALL optional dependencies (NON-EDITABLE mode)
echo "Installing mona-ai..."
$PYTHON_BIN -m pip install ".[api,wecom,weixin,pdf]" --no-warn-script-location 2>&1 | tail -5

# 5. Verify installation (must point to site-packages, NOT source directory)
pushd /tmp
MONA_FILE=$($PYTHON_BIN -c "import mona; print(mona.__file__)" 2>&1)
popd
echo "mona.__file__ = $MONA_FILE"
if [[ "$MONA_FILE" != *"site-packages"* ]]; then
    echo "ERROR: mona-ai installed in editable mode!"
    exit 1
fi

# 6. Clean up caches to reduce size
find "$PYTHON_DIR" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null
find "$PYTHON_DIR" -type f -name "*.pyc" -delete 2>/dev/null
find "$PYTHON_DIR" -type f -name "*.pyo" -delete 2>/dev/null

# 7. Re-pack into python.tar.gz
echo "Re-packing python.tar.gz..."
PARENT_DIR=$(dirname "$PYTHON_DIR")
DIR_NAME=$(basename "$PYTHON_DIR")
tar -czf "$PYTHON_ARCHIVE" -C "$PARENT_DIR" "$DIR_NAME"

SIZE=$(du -h "$PYTHON_ARCHIVE" | cut -f1)
echo "python.tar.gz created: $SIZE"

# 8. Cleanup
rm -rf "$TEMP_DIR"
```

**Critical rules:**
- **NEVER use `pip install -e .`** — editable mode creates `.pth` files pointing to the build machine's source directory
- **Verify from a non-source directory** — run `import mona; print(mona.__file__)` from `/tmp` to confirm it points to `site-packages`
- Always install `mona-ai[api]` at minimum — the gateway requires `aiohttp`
- Strip `__pycache__`, `.pyc`, `.pyo` to reduce archive size

## Step 3: Build mona-gateway Binary

The `mona-gateway` binary is a standalone executable that runs the Mona gateway server. Build it using PyInstaller:

```bash
# Ensure mona-ai is installed in the current Python environment
pip install ".[api,wecom,weixin,pdf]"

# Build with PyInstaller
pyinstaller --onefile --name mona-gateway \
    --hidden-import=mona \
    --hidden-import=mona.gateway \
    --hidden-import=mona.api \
    --hidden-import=aiohttp \
    -c \
    $(python -c "import mona.gateway; print(mona.gateway.__file__)")

# Copy to resources
cp dist/mona-gateway src-tauri/resources/mona-gateway
chmod +x src-tauri/resources/mona-gateway
```

**Note:** If the gateway entry point is defined in `pyproject.toml` as a console script, use:

```bash
pyinstaller --onefile --name mona-gateway \
    --hidden-import=mona \
    --hidden-import=mona.gateway \
    --hidden-import=mona.api \
    --hidden-import=aiohttp \
    $(which mona-gateway)

cp dist/mona-gateway src-tauri/resources/mona-gateway
chmod +x src-tauri/resources/mona-gateway
```

## Step 4: Build Tauri App

WebUI build is handled automatically by `cargo tauri build` via `beforeBuildCommand` in `tauri.conf.json`.

```bash
cd src-tauri
cargo tauri build
cd ..
```

Output locations:
- App bundle: `src-tauri/target/release/bundle/macos/Mona.app`
- DMG installer: `src-tauri/target/release/bundle/dmg/Mona_{version}_aarch64.dmg` (Apple Silicon)
- DMG installer: `src-tauri/target/release/bundle/dmg/Mona_{version}_x64.dmg` (Intel)

## Step 5: Code Signing (Recommended)

Without code signing, macOS Gatekeeper will block the app. Users must right-click → Open to bypass.

### Ad-hoc signing (no Apple Developer account needed, for personal use):

```bash
# Sign the app bundle
codesign --force --deep --sign - src-tauri/target/release/bundle/macos/Mona.app

# Verify
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/Mona.app
```

### Developer ID signing (for distribution outside App Store):

Requires an Apple Developer account ($99/year).

```bash
# List available signing identities
security find-identity -v -p codesigning

# Sign with Developer ID
codesign --force --deep --sign "Developer ID Application: Your Name (TEAM_ID)" \
    src-tauri/target/release/bundle/macos/Mona.app

# Notarize (required for Gatekeeper to allow without warnings)
# Step 1: Create DMG or zip
ditto -c -k --keepParent Mona.app Mona.zip

# Step 2: Submit for notarization
xcrun notarytool submit Mona.zip \
    --apple-id "your@email.com" \
    --team-id "TEAM_ID" \
    --password "app-specific-password" \
    --wait

# Step 3: Staple the ticket
xcrun stapler staple Mona.app
```

## Step 6: Verify the Build

After building, verify the installer works:

1. Mount the DMG and drag Mona to Applications
2. Launch the app — it should:
   - Find `mona-gateway` via Tauri's `resource_dir()` API
   - Deploy gateway to `~/Library/Application Support/mona/gateway/`
   - Auto-start the gateway on the configured port
   - Show the WebUI in the Tauri window
3. Close the window — app should minimize to system tray (default `run_in_background: true`)
4. Click tray icon → "退出 Mona" — should stop gateway and exit

## Resource Path Resolution (Critical)

### How Tauri bundles resources on macOS

When `tauri.conf.json` has `"resources": ["resources/mona-gateway*"]`, Tauri embeds the gateway binary into the app bundle. After installation, the file is placed at:

| Mode | Resource location |
|------|-------------------|
| DMG install | `Mona.app/Contents/Resources/mona-gateway` |
| Dev mode | `src-tauri/resources/mona-gateway` (relative to CWD) |

### How `python.rs` finds resources

The `find_gateway_resource()` function uses a 3-level fallback (same as Windows):

1. **Tauri `resource_dir()` API** (primary) — returns `Mona.app/Contents/Resources/`
2. **Next to executable** (fallback) — checks `exe_dir/mona-gateway`
3. **Relative path** (dev mode) — checks `resources/mona-gateway` from CWD

### What NOT to do

- **Never use `env!("CARGO_MANIFEST_DIR")`** — compile-time constant, doesn't exist on client machines
- **Never use relative paths only** — the working directory at runtime is not `src-tauri/`
- **Never assume resources are next to the exe** — macOS bundles them in `Contents/Resources/`

## macOS Data Directory

| Path | Purpose |
|------|---------|
| `~/Library/Application Support/mona/` | App data (settings, gateway deployment) |
| `~/Library/Application Support/mona/gateway/` | Deployed mona-gateway binary |
| `~/Library/Caches/mona/` | Update staging |
| `~/.mona/config.json` | Mona configuration |

These are resolved by `dirs::data_dir()` and `dirs::cache_dir()` which return the correct macOS paths.

## macOS-Specific Considerations

### Universal Binary (Apple Silicon + Intel)

To build a Universal binary that runs natively on both architectures:

```bash
# Build for both architectures
rustup target add aarch64-apple-darwin x86_64-apple-darwin

cd src-tauri
cargo tauri build --target universal-apple-darwin
cd ..
```

This produces a single `Mona.app` containing both architectures. The DMG will be larger but works on all Macs.

### Gatekeeper Quarantine

macOS quarantines downloaded apps. Users see "Mona is damaged and can't be opened" if the app isn't signed/notarized. Workarounds:

1. **Best:** Sign + notarize with Apple Developer ID
2. **OK:** Ad-hoc sign + user right-clicks → Open
3. **Manual:** `xattr -cr /Applications/Mona.app`

### macOS App Sandbox

Mona currently does NOT use App Sandbox. If you want to distribute via the Mac App Store, you must:

1. Enable sandbox in entitlements
2. Use `NSOpenPanel`/`NSSavePanel` for file access
3. Store data in the sandbox container
4. Use `security-scoped bookmarks` for persistent file access

For DMG distribution outside the App Store, sandbox is NOT required.

## Size Optimization

| Technique | Estimated Savings |
|-----------|-------------------|
| Strip `__pycache__` and `.pyc` | ~30% of Python deps |
| Strip `test/` and `.dist-info/` | ~10% |
| Use `--no-compile` in pip | Avoids `.pyc` generation |
| Remove `pip`, `setuptools` from runtime | ~5MB |
| `strip` the Tauri binary | ~30% of Rust binary |

Typical DMG size: ~180MB (Python runtime ~80MB + deps ~80MB + Tauri ~15MB)

## GitHub Actions CI (Cross-Platform Build)

Since you cannot build macOS packages on Windows, use GitHub Actions for automated macOS builds:

```yaml
# .github/workflows/build-macos.yml
name: Build macOS

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to build'
        required: true

jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: aarch64-apple-darwin,x86_64-apple-darwin

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: |
          npm install
          pip install pyinstaller

      - name: Build mona-gateway
        run: |
          pip install ".[api,wecom,weixin,pdf]"
          pyinstaller --onefile --name mona-gateway \
            --hidden-import=mona \
            --hidden-import=mona.gateway \
            --hidden-import=mona.api \
            --hidden-import=aiohttp \
            $(which mona-gateway)
          cp dist/mona-gateway src-tauri/resources/mona-gateway
          chmod +x src-tauri/resources/mona-gateway

      - name: Build Tauri (Universal)
        run: |
          cd src-tauri
          cargo tauri build --target universal-apple-darwin
        env:
          CI: ""

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: Mona-macOS
          path: |
            src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
            src-tauri/target/universal-apple-darwin/release/bundle/macos/*.app
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mona-gateway` not found after install | `find_gateway_resource()` uses `resource_dir()` — ensure `AppHandle` is passed correctly |
| `ImportError: cannot import name 'BaseTool'` | mona-ai was installed in editable mode. Rebuild with `pip install ".[extras]"` (no `-e`) |
| `mona.__file__` points to source directory | Same as above — verify from `/tmp` not the project root |
| "Mona is damaged and can't be opened" | App is not signed/notarized. Run `xattr -cr /Applications/Mona.app` or sign with Developer ID |
| Gateway fails to start | Check `~/Library/Application Support/mona/gateway/mona-gateway` exists; check logs |
| First launch is slow | Expected — Python extraction takes time; subsequent launches are instant |
| `cargo tauri build` fails with `--ci` error | Set `CI=""` in environment before building |
| `windows` crate compilation error on macOS | Move `windows` crate to `[target.'cfg(windows)'.dependencies]` in Cargo.toml |
| PyInstaller binary doesn't run on other Macs | Build on the oldest macOS you want to support; or use `--target-arch` flag |
| Universal binary build fails | Ensure both `aarch64-apple-darwin` and `x86_64-apple-darwin` targets are installed via rustup |
| `libc` crate not found on macOS | Add `libc = "0.2"` to `[target.'cfg(not(windows))'.dependencies]` in Cargo.toml (Step 0.3) |

## File Structure Reference

```
src-tauri/
├── Cargo.toml              # Rust dependencies (windows crate under [target.'cfg(windows)'.dependencies])
├── tauri.conf.json         # Tauri bundle config (version, targets, icons, resources, macOS section)
├── build.rs                # Tauri build script
├── resources/
│   ├── README              # Notes about Python runtime
│   ├── mona-gateway        # macOS gateway binary (PyInstaller-built, no extension)
│   └── python.tar.gz       # Pre-built Python + mona-ai (generated by build script)
├── src/
│   ├── lib.rs              # App setup, gateway auto-start, open::that for macOS
│   ├── gateway.rs          # Gateway process management (SIGTERM on macOS)
│   ├── python.rs           # Gateway deployment (platform-aware GATEWAY_EXE_NAME)
│   ├── settings.rs         # App settings (cross-platform via dirs crate)
│   ├── tray.rs             # System tray (cross-platform)
│   ├── license.rs          # License validation (macOS uses sysctl/ioreg for fingerprint)
│   ├── updater.rs          # Auto-update (macOS uses shell script instead of batch)
│   └── ...
└── icons/
    ├── icon.icns           # macOS icon (required)
    ├── icon.png            # High-res icon (used by tray)
    └── ...                 # Other sizes
```
