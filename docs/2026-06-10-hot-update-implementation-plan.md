# Hot-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the hot-update mechanism for Mona Desktop — a single-package update flow that replaces the entire app (Tauri client + Python runtime) in-place.

**Architecture:** Rust updater module (`updater.rs`) handles checking the VPS manifest, downloading the update package, verifying SHA256, replacing files, and launching a helper script for exe swap. Frontend settings page shows update status and progress. The update package is a single `mona-<version>.tar.gz` containing `Mona.exe` and `python.tar.gz`.

**Tech Stack:** Rust (reqwest, sha2, tokio, serde), Tauri v2 commands, React + TypeScript frontend, batch script for Windows exe swap.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src-tauri/src/updater.rs` | Create | Core update logic: check manifest, download, verify, replace, restart |
| `src-tauri/src/lib.rs` | Modify | Register updater module and commands |
| `src-tauri/Cargo.toml` | Modify | Add `flate2` and `tar` dependencies |
| `webui/src/lib/tauri.ts` | Modify | Add updater invoke functions and types |
| `webui/src/components/settings/SettingsView.tsx` | Modify | Add update section in AboutSettings |

---

### Task 1: Add Rust dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add `flate2` and `tar` crates to Cargo.toml**

Add these two dependencies needed for extracting the `.tar.gz` update package:

```toml
flate2 = "1"
tar = "0.4"
```

These should be added in the `[dependencies]` section, after the existing `base64` line. The project already has `reqwest`, `sha2`, `serde`, `serde_json`, and `tokio` — no need to add those.

---

### Task 2: Create `updater.rs` — core update module

**Files:**
- Create: `src-tauri/src/updater.rs`

- [ ] **Step 1: Create the updater module with all core functions**

```rust
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::settings::app_data_dir;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: String,
    pub notes: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateProgress {
    pub stage: String,
    pub percent: u8,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

/// Read the installed mona-ai version from the dist-info directory name.
pub fn get_installed_version() -> Option<String> {
    let site_packages = app_data_dir()
        .join("python")
        .join("Lib")
        .join("site-packages");

    if !site_packages.exists() {
        return None;
    }

    let entries = fs::read_dir(&site_packages).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
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

// ---------------------------------------------------------------------------
// Manifest fetching
// ---------------------------------------------------------------------------

/// Fetch the update manifest from the VPS.
pub async fn fetch_manifest(manifest_url: &str) -> Result<UpdateManifest, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(manifest_url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch manifest: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Manifest request failed: HTTP {}", resp.status()));
    }

    resp.json::<UpdateManifest>()
        .await
        .map_err(|e| format!("Failed to parse manifest: {}", e))
}

/// Check if an update is available by comparing versions.
pub fn check_update_available(current: &str, latest: &str) -> bool {
    current != latest
}

// ---------------------------------------------------------------------------
// Download + verify
// ---------------------------------------------------------------------------

/// Download the update package to a staging directory and verify its SHA256.
/// Returns the path to the downloaded file.
pub async fn download_and_verify(
    url: &str,
    expected_sha256: &str,
    expected_size: u64,
    staging_dir: &Path,
    app_handle: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    fs::create_dir_all(staging_dir)
        .map_err(|e| format!("Failed to create staging dir: {}", e))?;

    let file_name = url.rsplit('/').next().unwrap_or("update.tar.gz");
    let dest_path = staging_dir.join(file_name);
    let mut dest_file = fs::File::create(&dest_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let client = reqwest::Client::new();
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download error: {}", e))? {
        dest_file
            .write_all(&chunk)
            .map_err(|e| format!("Write error: {}", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        // Emit progress
        let percent = if expected_size > 0 {
            ((downloaded as f64 / expected_size as f64) * 100.0).min(100.0) as u8
        } else {
            0
        };
        let _ = app_handle.emit(
            "update-progress",
            UpdateProgress {
                stage: "downloading".to_string(),
                percent,
                message: format!(
                    "下载中... {}/{} MB",
                    downloaded / 1_048_576,
                    expected_size / 1_048_576
                ),
            },
        );
    }

    dest_file
        .flush()
        .map_err(|e| format!("Flush error: {}", e))?;

    // Verify SHA256
    let hash_result = hex::encode(hasher.finalize());
    if hash_result.to_lowercase() != expected_sha256.to_lowercase() {
        let _ = fs::remove_file(&dest_path);
        return Err(format!(
            "SHA256 verification failed\nExpected: {}\nGot: {}",
            expected_sha256, hash_result
        ));
    }

    log::info!("Update package verified: {} ({} bytes)", file_name, downloaded);
    Ok(dest_path)
}

// ---------------------------------------------------------------------------
// Extract + install
// ---------------------------------------------------------------------------

/// Extract the update package and install files.
///
/// Steps:
/// 1. Extract mona-<version>.tar.gz → staging/Mona.exe + staging/python.tar.gz
/// 2. Stop gateway
/// 3. Backup python/ → python.bak/
/// 4. Backup resources/python.tar.gz → python.tar.gz.bak
/// 5. Copy new python.tar.gz → resources/python.tar.gz
/// 6. Delete python/ (force re-extraction on next launch)
/// 7. Copy Mona.exe → Mona.exe.new (staged for swap)
/// 8. Write .update-pending marker
pub fn install_update(
    package_path: &Path,
    gateway_state: &crate::GatewayState,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    let staging_dir = package_path
        .parent()
        .ok_or("Cannot determine staging directory")?;

    // 1. Extract the outer tar.gz
    let _ = app_handle.emit(
        "update-progress",
        UpdateProgress {
            stage: "extracting".to_string(),
            percent: 30,
            message: "解压更新包...".to_string(),
        },
    );

    extract_tar_gz(package_path, staging_dir)?;

    let new_exe = staging_dir.join("Mona.exe");
    let new_python_tar = staging_dir.join("python.tar.gz");

    if !new_exe.exists() {
        return Err("Update package missing Mona.exe".to_string());
    }
    if !new_python_tar.exists() {
        return Err("Update package missing python.tar.gz".to_string());
    }

    // 2. Stop gateway
    let _ = app_handle.emit(
        "update-progress",
        UpdateProgress {
            stage: "stopping".to_string(),
            percent: 50,
            message: "停止网关...".to_string(),
        },
    );

    gateway_state.stop()?;
    // Grace period for Windows file locks
    std::thread::sleep(std::time::Duration::from_millis(500));

    // 3. Backup python runtime directory
    let python_dir = app_data_dir().join("python");
    let python_bak = app_data_dir().join("python.bak");
    if python_dir.exists() {
        if python_bak.exists() {
            let _ = fs::remove_dir_all(&python_bak);
        }
        fs::rename(&python_dir, &python_bak)
            .map_err(|e| format!("Failed to backup python dir: {}", e))?;
    }

    // 4. Backup existing python.tar.gz in resources
    let install_dir = get_install_dir()?;
    let resource_python_tar = install_dir.join("resources").join("python.tar.gz");
    if resource_python_tar.exists() {
        let bak_path = resource_python_tar.with_extension("tar.gz.bak");
        let _ = fs::remove_file(&bak_path);
        fs::rename(&resource_python_tar, &bak_path)
            .map_err(|e| format!("Failed to backup python.tar.gz: {}", e))?;
    }

    // 5. Copy new python.tar.gz to resources
    let _ = app_handle.emit(
        "update-progress",
        UpdateProgress {
            stage: "installing".to_string(),
            percent: 70,
            message: "安装 Python 运行时...".to_string(),
        },
    );

    fs::create_dir_all(install_dir.join("resources"))
        .map_err(|e| format!("Failed to create resources dir: {}", e))?;
    fs::copy(&new_python_tar, &resource_python_tar)
        .map_err(|e| format!("Failed to copy python.tar.gz: {}", e))?;

    // 6. Stage new exe
    let _ = app_handle.emit(
        "update-progress",
        UpdateProgress {
            stage: "installing".to_string(),
            percent: 85,
            message: "准备更新客户端...".to_string(),
        },
    );

    let exe_new = install_dir.join("Mona.exe.new");
    fs::copy(&new_exe, &exe_new)
        .map_err(|e| format!("Failed to stage new exe: {}", e))?;

    // 7. Write .update-pending marker
    let marker = app_data_dir().join(".update-pending");
    fs::write(&marker, "pending")
        .map_err(|e| format!("Failed to write update marker: {}", e))?;

    // 8. Cleanup staging
    let _ = fs::remove_dir_all(staging_dir);

    log::info!("Update installed, pending restart to apply");
    Ok(())
}

/// Launch the helper batch script to swap the exe and restart.
pub fn launch_update_restart() -> Result<(), String> {
    let install_dir = get_install_dir()?;
    let current_pid = std::process::id();

    let script_content = format!(
        r#"@echo off
:wait
tasklist /FI "PID eq {pid}" 2>nul | find "{pid}" >nul
if %ERRORLEVEL%==0 (
    timeout /t 1 /nobreak >nul
    goto wait
)
cd /d "{install_dir}"
move /y "Mona.exe.new" "Mona.exe" >nul 2>&1
start "" "Mona.exe"
del "Mona.exe.old" >nul 2>&1
del "%~f0" >nul 2>&1
"#,
        pid = current_pid,
        install_dir = install_dir.display()
    );

    let script_path = install_dir.join("_update_restart.bat");
    fs::write(&script_path, &script_content)
        .map_err(|e| format!("Failed to write update script: {}", e))?;

    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/c", &script_path.display().to_string()]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.spawn()
        .map_err(|e| format!("Failed to launch update script: {}", e))?;

    Ok(())
}

/// Cleanup after a successful update (called on next launch).
pub fn cleanup_after_update() -> Result<(), String> {
    let marker = app_data_dir().join(".update-pending");
    if !marker.exists() {
        return Ok(());
    }

    log::info!("Cleaning up after update...");

    // Remove marker
    let _ = fs::remove_file(&marker);

    // Remove old backups
    let python_bak = app_data_dir().join("python.bak");
    if python_bak.exists() {
        let _ = fs::remove_dir_all(&python_bak);
    }

    let install_dir = get_install_dir()?;
    let python_tar_bak = install_dir.join("resources").join("python.tar.gz.bak");
    if python_tar_bak.exists() {
        let _ = fs::remove_file(&python_tar_bak);
    }

    let exe_old = install_dir.join("Mona.exe.old");
    if exe_old.exists() {
        let _ = fs::remove_file(&exe_old);
    }

    log::info!("Update cleanup complete");
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn extract_tar_gz(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|e| format!("Failed to open archive: {}", e))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    archive
        .unpack(dest_dir)
        .map_err(|e| format!("Failed to extract archive: {}", e))?;
    Ok(())
}

fn get_install_dir() -> Result<PathBuf, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("Cannot get exe path: {}", e))?;
    exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Cannot determine install directory".to_string())
}
```

---

### Task 3: Register updater module and commands in `lib.rs`

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add `mod updater;` declaration**

Add `mod updater;` at the top of `lib.rs`, after the existing module declarations (after line 8 `mod tray;`).

- [ ] **Step 2: Add Tauri commands for update checking and performing**

Add these three command functions before the `run()` function:

```rust
#[tauri::command]
async fn check_for_updates() -> Result<updater::UpdateCheckResult, String> {
    let manifest_url = "https://mona.mchost.guru/updates/update.json";
    let manifest = updater::fetch_manifest(manifest_url).await?;
    let current = updater::get_installed_version().unwrap_or_else(|| "unknown".to_string());
    let has_update = updater::check_update_available(&current, &manifest.version);
    Ok(updater::UpdateCheckResult {
        has_update,
        current_version: current,
        latest_version: manifest.version,
        notes: manifest.notes,
        size: Some(manifest.size),
    })
}

#[tauri::command]
async fn perform_update(
    state: tauri::State<'_, GatewayState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let manifest_url = "https://mona.mchost.guru/updates/update.json";
    let manifest = updater::fetch_manifest(manifest_url).await?;

    let staging_dir = dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("mona")
        .join("update");

    let package_path = updater::download_and_verify(
        &manifest.url,
        &manifest.sha256,
        manifest.size,
        &staging_dir,
        &app_handle,
    )
    .await?;

    updater::install_update(&package_path, &state, &app_handle)?;

    updater::launch_update_restart()?;

    // Exit the current process so the helper script can swap the exe
    std::process::exit(0);
}

#[tauri::command]
async fn get_current_version() -> Result<String, String> {
    Ok(updater::get_installed_version().unwrap_or_else(|| "unknown".to_string()))
}
```

Note: Add `use std::path::PathBuf;` to the imports at the top if not already present.

- [ ] **Step 3: Register commands in the invoke handler**

Add `check_for_updates`, `perform_update`, `get_current_version` to the `tauri::generate_handler![]` macro, after the `license::bind_device` entry.

- [ ] **Step 4: Add update cleanup on startup**

In the `setup` closure, after the gateway auto-start block (after line 446 `}`), add:

```rust
// Cleanup after update (remove backups, markers)
if let Err(e) = updater::cleanup_after_update() {
    log::warn!("Update cleanup failed: {}", e);
}
```

---

### Task 4: Add updater functions to `webui/src/lib/tauri.ts`

**Files:**
- Modify: `webui/src/lib/tauri.ts`

- [ ] **Step 1: Add updater types and invoke functions**

Add these at the end of the file, before the closing of the file:

```typescript
// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  has_update: boolean;
  current_version: string;
  latest_version: string;
  notes: string | null;
  size: number | null;
}

export interface UpdateProgress {
  stage: string;
  percent: number;
  message: string;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>("check_for_updates");
}

export async function performUpdate(): Promise<void> {
  return invoke<void>("perform_update");
}

export async function getCurrentVersion(): Promise<string> {
  return invoke<string>("get_current_version");
}
```

---

### Task 5: Add update UI in the About settings section

**Files:**
- Modify: `webui/src/components/settings/SettingsView.tsx`

- [ ] **Step 1: Add import for updater functions**

Add to the imports from `@/lib/tauri`:

```typescript
import {
  isTauri,
  getDesktopSettings,
  updateDesktopSettings,
  getGatewayStatus,
  checkForUpdates,
  performUpdate,
  getCurrentVersion,
  type UpdateCheckResult,
  type UpdateProgress,
  type DesktopAppSettings,
  type SidebarShortcuts,
} from "@/lib/tauri";
```

Also add `Download` and `RefreshCw` to the lucide-react imports:

```typescript
import {
  // ... existing imports ...
  Download,
  RefreshCw,
  // ... rest of existing imports ...
} from "lucide-react";
```

- [ ] **Step 2: Add update section to `AboutSettings` component**

Add the following state variables at the top of the `AboutSettings` function, after the existing state declarations:

```typescript
const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
const [updateChecking, setUpdateChecking] = useState(false);
const [updateDownloading, setUpdateDownloading] = useState(false);
const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
```

Add a `useEffect` to listen for update progress events and auto-check:

```typescript
useEffect(() => {
  if (!isTauri()) return;

  // Listen for update progress
  let unlisten: (() => void) | null = null;
  (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<UpdateProgress>("update-progress", (event) => {
        setUpdateProgress(event.payload);
      });
    } catch {}
  })();

  return () => {
    unlisten?.();
  };
}, []);
```

Add the check and update handler functions:

```typescript
const handleCheckUpdate = async () => {
  if (updateChecking) return;
  setUpdateChecking(true);
  setUpdateCheck(null);
  try {
    const result = await checkForUpdates();
    setUpdateCheck(result);
  } catch (e) {
    setUpdateCheck({
      has_update: false,
      current_version: appVersion,
      latest_version: "",
      notes: null,
      size: null,
    });
  } finally {
    setUpdateChecking(false);
  }
};

const handlePerformUpdate = async () => {
  if (updateDownloading) return;
  setUpdateDownloading(true);
  try {
    await performUpdate();
    // performUpdate calls process::exit(0), so this line may not be reached
  } catch (e) {
    setUpdateDownloading(false);
  }
};
```

Then add a new section in the JSX, after the "产品信息" section and before the "授权" section:

```tsx
<section>
  <SettingsSectionTitle>{tx("settings.about.update", "软件更新")}</SettingsSectionTitle>
  <SettingsGroup>
    <SettingsRow
      title={tx("settings.about.currentVersion", "当前版本")}
    >
      <span className="text-[13px] text-muted-foreground">{appVersion || "..."}</span>
    </SettingsRow>
    <SettingsRow
      title={tx("settings.about.checkUpdate", "检查更新")}
      description={
        updateCheck?.has_update
          ? tx("settings.about.newVersionAvailable", "发现新版本 {{version}}").replace(
              "{{version}}",
              updateCheck.latest_version,
            )
          : updateCheck && !updateCheck.has_update
            ? tx("settings.about.alreadyUpToDate", "已是最新版本")
            : undefined
      }
    >
      <div className="flex items-center gap-2">
        {updateCheck?.has_update && !updateDownloading ? (
          <Button
            size="sm"
            variant="outline"
            onClick={handlePerformUpdate}
            className="rounded-full"
          >
            <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {tx("settings.about.downloadAndInstall", "下载并安装")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={handleCheckUpdate}
          disabled={updateChecking || updateDownloading}
          className="rounded-full"
        >
          {updateChecking ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          )}
          {updateChecking
            ? tx("settings.about.checking", "检查中...")
            : tx("settings.about.checkNow", "立即检查")}
        </Button>
      </div>
    </SettingsRow>
    {updateDownloading && updateProgress ? (
      <div className="px-4 py-3 sm:px-5">
        <div className="mb-1.5 flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">{updateProgress.message}</span>
          <span className="font-medium text-foreground">{updateProgress.percent}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${updateProgress.percent}%` }}
          />
        </div>
      </div>
    ) : null}
    {updateCheck?.notes ? (
      <div className="px-4 py-3 text-[13px] text-muted-foreground sm:px-5">
        {updateCheck.notes}
      </div>
    ) : null}
  </SettingsGroup>
</section>
```

---

### Task 6: Verify compilation

- [ ] **Step 1: Run `cargo check` in the `src-tauri` directory**

Run: `cd src-tauri && cargo check`

Expected: Compilation succeeds with no errors. Warnings are acceptable.

- [ ] **Step 2: Run `npm run build:tauri` in the `webui` directory to verify frontend**

Run: `cd webui && npm run build:tauri`

Expected: Build succeeds with no TypeScript errors.

---

### Task 7: Add startup auto-check for updates

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add auto-check on startup**

In the `setup` closure, after the update cleanup block added in Task 3, add a delayed auto-check that emits an event to the frontend:

```rust
// Auto-check for updates 5 seconds after launch
let app_handle_for_update = app.handle().clone();
tauri::async_runtime::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    match updater::fetch_manifest("https://mona.mchost.guru/updates/update.json").await {
        Ok(manifest) => {
            let current = updater::get_installed_version().unwrap_or_else(|| "unknown".to_string());
            if updater::check_update_available(&current, &manifest.version) {
                let _ = app_handle_for_update.emit(
                    "update-available",
                    updater::UpdateCheckResult {
                        has_update: true,
                        current_version: current,
                        latest_version: manifest.version,
                        notes: manifest.notes,
                        size: Some(manifest.size),
                    },
                );
                log::info!("Update available: {}", manifest.version);
            }
        }
        Err(e) => {
            log::info!("Update check failed: {}", e);
        }
    }
});
```

- [ ] **Step 2: Listen for `update-available` event in frontend**

In the `AboutSettings` component, add a listener for the `update-available` event alongside the `update-progress` listener:

```typescript
useEffect(() => {
  if (!isTauri()) return;

  let unlistenProgress: (() => void) | null = null;
  let unlistenAvailable: (() => void) | null = null;

  (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenProgress = await listen<UpdateProgress>("update-progress", (event) => {
        setUpdateProgress(event.payload);
      });
      unlistenAvailable = await listen<UpdateCheckResult>("update-available", (event) => {
        setUpdateCheck(event.payload);
      });
    } catch {}
  })();

  return () => {
    unlistenProgress?.();
    unlistenAvailable?.();
  };
}, []);
```

---

## Summary

This plan implements a complete hot-update flow:

1. **Rust backend** (`updater.rs`): Manifest fetch, download with progress, SHA256 verification, file replacement, helper script for exe swap, rollback support
2. **Tauri commands**: `check_for_updates`, `perform_update`, `get_current_version`
3. **Frontend UI**: Update section in About settings with check/download/install flow, progress bar, startup auto-check notification
4. **Helper script**: Batch file that waits for the old process to exit, swaps the exe, and starts the new version
