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
└── Python Gateway        → PyInstaller COLLECT (mona-gateway/ directory with binary + _internal/)
```

**Client machines do NOT need Python installed.** The full Python 3.12 runtime + all dependencies are embedded in the PyInstaller-built `mona-gateway/` directory.

## Prerequisites

- macOS 12+ (Monterey or later) on Apple Silicon (M1+) or Intel
- Xcode Command Line Tools: `xcode-select --install`
- Rust toolchain: `rustup target add aarch64-apple-darwin` (Apple Silicon) or `x86_64-apple-darwin` (Intel)
- Node.js >= 18 + npm
- Python 3.12+ with `pip install pyinstaller`

## Step 0: Code Changes (Required Before First Build)

The current codebase has several Windows-only hardcoded values that must be made cross-platform before macOS builds can work. Apply ALL changes below before proceeding.

### 0.1 `src-tauri/src/python.rs` — Platform-specific gateway binary name

Already done — `GATEWAY_EXE_NAME` is platform-aware:

```rust
#[cfg(windows)]
pub const GATEWAY_EXE_NAME: &str = "mona-gateway.exe";
#[cfg(not(windows))]
pub const GATEWAY_EXE_NAME: &str = "mona-gateway";
```

### 0.2 `src-tauri/src/lib.rs` — Fix `diagnose_gateway` hardcoded `.exe`

The `diagnose_gateway` function must use the platform-aware constant:

```rust
// Use python::GATEWAY_EXE_NAME instead of hardcoded "mona-gateway.exe"
```

### 0.3 `src-tauri/Cargo.toml` — Make `windows` crate Windows-only + add `libc`

```toml
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

### 0.4 `src-tauri/src/updater.rs` — Platform-aware update mechanism

The updater now uses directory-based gateway deployment. Ensure platform-specific paths:

```rust
// Gateway is now a directory, not a single file
let new_gateway_dir = staging_dir.join("mona-gateway");
let resource_gateway_dir = install_dir.join("resources").join("mona-gateway");
```

### 0.5 `src-tauri/tauri.conf.json` — macOS bundle config

```json
{
  "bundle": {
    "resources": [
      "resources/mona-gateway/"
    ],
    "macOS": {
      "minimumSystemVersion": "12.0",
      "entitlements": null,
      "exceptionDomain": "",
      "frameworks": [],
      "providerShortName": null,
      "signingIdentity": null
    }
  }
}
```

### 0.6 `src-tauri/src/license.rs` — macOS machine fingerprint

Add macOS-specific paths for `get_cpu_info()` and `get_disk_serial()`:

```rust
fn get_cpu_info() -> String {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("sh")
            .args(["-c", "sysctl -n machdep.cpu.brand_string"])
            .output();
        match output {
            Ok(out) => format!("cpu:{}", String::from_utf8_lossy(&out.stdout).trim()),
            Err(_) => "cpu:unknown".into(),
        }
    }
}

fn get_disk_serial() -> String {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("sh")
            .args(["-c", "ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/ { gsub(/\"/,\"\"); print $NF }'"])
            .output();
        match output {
            Ok(out) => format!("disk:{}", String::from_utf8_lossy(&out.stdout).trim()),
            Err(_) => "disk:unknown".into(),
        }
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

## Step 2: Build mona-gateway with PyInstaller (COLLECT / onedir mode)

The gateway is built as a **directory** using PyInstaller's COLLECT mode (same as Windows).

**If `src-tauri/resources/mona-gateway/` already exists and no Python dependencies changed, skip this step.**

```bash
# 1. Ensure mona-ai is installed (NON-EDITABLE mode)
pip install ".[api,wecom,weixin,pdf]"

# 2. Verify installation points to site-packages (NOT source directory)
pushd /tmp
MONA_FILE=$(python3 -c "import mona; print(mona.__file__)" 2>&1)
popd
if [[ "$MONA_FILE" != *"site-packages"* ]]; then
    echo "ERROR: mona-ai installed in editable mode!"
    exit 1
fi

# 3. Build with PyInstaller using the spec file
pyinstaller src-tauri/mona-gateway.spec

# 4. The output is at dist/mona-gateway/ — copy to resources
rm -rf src-tauri/resources/mona-gateway
cp -r dist/mona-gateway src-tauri/resources/mona-gateway
chmod +x src-tauri/resources/mona-gateway/mona-gateway

# 5. Verify
if [[ ! -f "src-tauri/resources/mona-gateway/mona-gateway" ]]; then
    echo "ERROR: Gateway binary not found"
    exit 1
fi
echo "Gateway built successfully"
```

**Critical rules:**
- **NEVER use `pip install -e .`** — editable mode creates `.pth` files pointing to the build machine's source directory
- **Always use the spec file** (`src-tauri/mona-gateway.spec`) — it contains all hidden imports and data file configurations
- **The output is a directory**: `dist/mona-gateway/mona-gateway` + `dist/mona-gateway/_internal/`
- **Verify from a non-source directory** — run `import mona; print(mona.__file__)` from `/tmp`

## Step 3: Build Tauri App

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

## Step 4: Code Signing (Recommended)

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
ditto -c -k --keepParent Mona.app Mona.zip
xcrun notarytool submit Mona.zip \
    --apple-id "your@email.com" \
    --team-id "TEAM_ID" \
    --password "app-specific-password" \
    --wait
xcrun stapler staple Mona.app
```

## Step 5: Verify the Build

After building, verify the installer works:

1. Mount the DMG and drag Mona to Applications
2. Launch the app — it should:
   - Find `mona-gateway/` directory via Tauri's `resource_dir()` API
   - Deploy gateway directory to `~/Library/Application Support/mona/gateway/mona-gateway/`
   - Auto-start the gateway on the configured port
   - Show the WebUI in the Tauri window
3. Close the window — app should minimize to system tray (default `run_in_background: true`)
4. Click tray icon → "退出 Mona" — should stop gateway and exit

## Resource Path Resolution (Critical)

### How Tauri bundles resources on macOS

When `tauri.conf.json` has `"resources": ["resources/mona-gateway/"]`, Tauri embeds the entire gateway directory into the app bundle. After installation, the directory is placed at:

| Mode | Resource location |
|------|-------------------|
| DMG install | `Mona.app/Contents/Resources/mona-gateway/` |
| Dev mode | `src-tauri/resources/mona-gateway/` (relative to CWD) |

### How `python.rs` finds resources

The `find_gateway_resource_dir()` function uses a 3-level fallback:

1. **Tauri `resource_dir()` API** (primary) — returns `Mona.app/Contents/Resources/`
2. **Next to executable** (fallback) — checks `exe_dir/resources/mona-gateway/` and `exe_dir/mona-gateway/`
3. **Relative path** (dev mode) — checks `resources/mona-gateway/` from CWD

### What NOT to do

- **Never use `env!("CARGO_MANIFEST_DIR")`** — compile-time constant, doesn't exist on client machines
- **Never use relative paths only** — the working directory at runtime is not `src-tauri/`
- **Never assume resources are next to the exe** — macOS bundles them in `Contents/Resources/`

## macOS Data Directory

| Path | Purpose |
|------|---------|
| `~/Library/Application Support/mona/` | App data (settings, gateway deployment) |
| `~/Library/Application Support/mona/gateway/mona-gateway/` | Deployed gateway directory |
| `~/Library/Caches/mona/` | Update staging |
| `~/.mona/config.json` | Mona configuration |

## macOS-Specific Considerations

### Universal Binary (Apple Silicon + Intel)

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
cd src-tauri
cargo tauri build --target universal-apple-darwin
cd ..
```

### Gatekeeper Quarantine

macOS quarantines downloaded apps. Workarounds:
1. **Best:** Sign + notarize with Apple Developer ID
2. **OK:** Ad-hoc sign + user right-clicks → Open
3. **Manual:** `xattr -cr /Applications/Mona.app`

### macOS App Sandbox

Mona currently does NOT use App Sandbox. For DMG distribution outside the App Store, sandbox is NOT required.

## Size Optimization

| Technique | Estimated Savings |
|-----------|-------------------|
| Strip `__pycache__` and `.pyc` | ~30% of Python deps |
| Strip `test/` and `.dist-info/` | ~10% |
| `strip` the Tauri binary | ~30% of Rust binary |
| Exclude unused packages in spec | Varies |

Typical DMG size: ~180MB (PyInstaller gateway ~80MB + Tauri ~15MB + WebUI ~5MB)

## GitHub Actions CI (Cross-Platform Build)

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

      - name: Build mona-gateway (COLLECT mode)
        run: |
          pip install ".[api,wecom,weixin,pdf]"
          pyinstaller src-tauri/mona-gateway.spec
          rm -rf src-tauri/resources/mona-gateway
          cp -r dist/mona-gateway src-tauri/resources/mona-gateway
          chmod +x src-tauri/resources/mona-gateway/mona-gateway

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
| `mona-gateway` not found after install | `find_gateway_resource_dir()` uses `resource_dir()` — ensure `AppHandle` is passed correctly |
| `ImportError: cannot import name 'BaseTool'` | mona-ai was installed in editable mode. Rebuild with `pip install ".[extras]"` (no `-e`) |
| "Mona is damaged and can't be opened" | App is not signed/notarized. Run `xattr -cr /Applications/Mona.app` or sign with Developer ID |
| Gateway fails to start | Check `~/Library/Application Support/mona/gateway/mona-gateway/mona-gateway` exists; check logs |
| `cargo tauri build` fails with `--ci` error | Set `CI=""` in environment before building |
| `windows` crate compilation error on macOS | Move `windows` crate to `[target.'cfg(windows)'.dependencies]` in Cargo.toml |
| PyInstaller missing import | Add to `hidden_imports` list in `src-tauri/mona-gateway.spec` |
| `libc` crate not found on macOS | Add `libc = "0.2"` to `[target.'cfg(not(windows))'.dependencies]` in Cargo.toml |

## File Structure Reference

```
src-tauri/
├── Cargo.toml              # Rust dependencies (windows crate under [target.'cfg(windows)'.dependencies])
├── tauri.conf.json         # Tauri bundle config (version, targets, icons, resources, macOS section)
├── build.rs                # Tauri build script
├── mona-gateway.spec       # PyInstaller spec (COLLECT mode, hidden imports, data files)
├── resources/
│   ├── README              # Notes about gateway build
│   └── mona-gateway/       # PyInstaller COLLECT output (built by Step 2)
│       ├── mona-gateway    # macOS gateway binary (no extension)
│       └── _internal/      # Python runtime + dependencies
├── src/
│   ├── lib.rs              # App setup, gateway auto-start
│   ├── gateway.rs          # Gateway process management (SIGTERM on macOS, env isolation)
│   ├── python.rs           # Gateway deployment (directory copy, platform-aware GATEWAY_EXE_NAME)
│   ├── settings.rs         # App settings (cross-platform via dirs crate)
│   ├── tray.rs             # System tray (cross-platform)
│   ├── license.rs          # License validation (macOS uses sysctl/ioreg for fingerprint)
│   ├── updater.rs          # Auto-update (macOS uses shell script, directory-based gateway)
│   └── ...
└── icons/
    ├── icon.icns           # macOS icon (required)
    ├── icon.png            # High-res icon (used by tray)
    └── ...                 # Other sizes
```
