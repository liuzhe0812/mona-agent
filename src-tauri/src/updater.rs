use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use semver::Version;
use sha2::{Digest, Sha256};
use tauri::Emitter;

use crate::settings::app_data_dir;

static UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateDownloadError {
    pub message: String,
    pub download_url: String,
}

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

/// Get the app version from the compile-time Cargo.toml version.
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
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
    match (Version::parse(current), Version::parse(latest)) {
        (Ok(current), Ok(latest)) => latest > current,
        _ => false,
    }
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
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
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

    log::info!(
        "Update package verified: {} ({} bytes)",
        file_name,
        downloaded
    );
    Ok(dest_path)
}

// ---------------------------------------------------------------------------
// Extract + install
// ---------------------------------------------------------------------------

/// Extract the update package and install files.
///
/// Steps:
/// 1. Extract the archive → staging/Mona(.exe) + staging/mona-gateway/.
///    Gateway includes _internal/desktop-resources/office-editor/, so even
///    older clients copying only this tree install the full Office resources.
/// 2. Stop gateway AND services (both run from the same deployed exe;
///    leaving services alive would orphan it on exit, locking the deployed
///    dir and breaking the re-deploy on next launch — os error 5)
/// 3. Backup resources/mona-gateway/ → mona-gateway.bak/
/// 4. Copy new mona-gateway/ → resources/mona-gateway/
/// 5. Copy Mona(.exe) → Mona(.exe).new (staged for swap)
/// 6. Write .update-pending marker
pub fn install_update(
    package_path: &Path,
    target_version: &str,
    gateway_state: &crate::GatewayState,
    services_state: &crate::ServicesState,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    let package_dir = package_path
        .parent()
        .ok_or("Cannot determine staging directory")?;
    let extraction = tempfile::Builder::new().prefix("extract-")
        .tempdir_in(package_dir).map_err(|e| format!("无法准备解压目录：{e}"))?;
    let staging_dir = extraction.path();

    // 1. Extract the outer tar.gz
    let _ = app_handle.emit(
        "update-progress",
        UpdateProgress {
            stage: "extracting".to_string(),
            percent: 30,
            message: "解压更新包...".to_string(),
        },
    );

    extract_update_archive(package_path, staging_dir)?;

    #[cfg(windows)]
    let new_exe = staging_dir.join("Mona.exe");
    #[cfg(not(windows))]
    let new_exe = staging_dir.join("Mona");

    let new_gateway_dir = staging_dir.join("mona-gateway");

    if !new_exe.exists() {
        return Err("Update package missing main executable".to_string());
    }
    if !new_gateway_dir.is_dir() {
        return Err("Update package missing gateway directory".to_string());
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
    services_state.stop()?;
    // Grace period for file locks
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Stage all files before replacing the existing resource tree.
    let install_dir = get_install_dir()?;
    let _ = app_handle.emit(
        "update-progress",
        UpdateProgress {
            stage: "installing".to_string(),
            percent: 70,
            message: "安装网关...".to_string(),
        },
    );

    let exe_name = current_exe_name()?;
    let marker = app_data_dir().join(".update-pending");
    install_update_files(&new_gateway_dir, &new_exe, &install_dir, &exe_name, &marker, target_version)?;

    // The extraction directory is owned by this attempt and cleaned on drop.
    if let Err(error) = fs::remove_file(package_path) {
        log::warn!("Could not remove installed update archive: {}", error);
    }

    log::info!("Update installed, pending restart to apply");
    Ok(())
}

fn install_update_files(
    gateway_source: &Path,
    executable_source: &Path,
    install_dir: &Path,
    exe_name: &str,
    marker: &Path,
    version: &str,
) -> Result<(), String> {
    let resources = install_dir.join("resources");
    let gateway = resources.join("mona-gateway");
    let backup = resources.join("mona-gateway.bak");
    let executable_new = install_dir.join(format!("{exe_name}.new"));
    if backup.exists() || marker.exists() {
        return Err("上一次更新尚未完成，请重启应用后重试。".to_string());
    }
    fs::create_dir_all(&resources).map_err(|e| format!("无法准备更新目录：{e}"))?;
    let staging = tempfile::Builder::new().prefix(".mona-update-")
        .tempdir_in(&resources).map_err(|e| format!("无法暂存更新文件：{e}"))?;
    copy_dir_recursive(gateway_source, &staging.path().join("mona-gateway"))?;
    fs::copy(executable_source, staging.path().join("Mona.new"))
        .map_err(|e| format!("无法暂存新主程序：{e}"))?;

    let had_gateway = gateway.exists();
    if had_gateway {
        fs::rename(&gateway, &backup).map_err(|e| format!("无法备份旧版本：{e}"))?;
    }
    let result: Result<(), String> = (|| {
        fs::rename(staging.path().join("mona-gateway"), &gateway)
            .map_err(|e| format!("无法替换更新资源：{e}"))?;
        fs::rename(staging.path().join("Mona.new"), &executable_new)
            .map_err(|e| format!("无法准备主程序替换：{e}"))?;
        fs::write(marker, version).map_err(|e| format!("无法记录更新状态：{e}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        if had_gateway {
            restore_gateway_backup(install_dir)
                .map_err(|rollback| format!("{error}；恢复旧版本失败：{rollback}"))?;
        } else if gateway.exists() {
            fs::remove_dir_all(&gateway).map_err(|e| format!("{error}；清理新资源失败：{e}"))?;
        }
        if executable_new.is_file() {
            fs::remove_file(&executable_new).map_err(|e| format!("{error}；清理主程序失败：{e}"))?;
        }
        if marker.is_file() {
            fs::remove_file(marker).map_err(|e| format!("{error}；清理更新状态失败：{e}"))?;
        }
        return Err(error);
    }
    Ok(())
}

fn restore_gateway_backup(install_dir: &Path) -> Result<(), String> {
    let resources = install_dir.join("resources");
    let backup = resources.join("mona-gateway.bak");
    if !backup.exists() {
        return Ok(());
    }
    let gateway = resources.join("mona-gateway");
    if gateway.exists() {
        fs::remove_dir_all(&gateway).map_err(|e| format!("无法移除失败的更新资源：{e}"))?;
    }
    fs::rename(backup, gateway).map_err(|e| format!("无法恢复旧版本资源：{e}"))
}

/// Launch the helper script to swap the exe and restart.
#[cfg(windows)]
pub fn launch_update_restart() -> Result<(), String> {
    let install_dir = get_install_dir()?;
    let current_pid = std::process::id();
    let exe_name = current_exe_name()?;
    let status_path = app_data_dir().join(".update-status");

    let script_content =
        build_windows_restart_script(current_pid, &install_dir, &exe_name, &status_path);

    let script_path = install_dir.join("_update_restart.bat");
    fs::write(&script_path, &script_content)
        .map_err(|e| format!("Failed to write update script: {}", e))?;

    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/c", &script_path.display().to_string()]);
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.spawn()
        .map_err(|e| format!("Failed to launch update script: {}", e))?;

    Ok(())
}

#[cfg(windows)]
fn build_windows_restart_script(
    current_pid: u32,
    install_dir: &Path,
    exe_name: &str,
    status_path: &Path,
) -> String {
    format!(
        r#"@echo off
setlocal
> "{status_path}" echo pending
:wait
tasklist /FI "PID eq {pid}" /NH 2>nul | findstr /R /C:"[ ]{pid}[ ]" >nul
if not errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto wait
)
cd /d "{install_dir}"
set /a retry_count=0
:replace
move /y "{exe_name}.new" "{exe_name}" >nul 2>&1
if not exist "{exe_name}.new" goto replace_ok
set /a retry_count+=1
if %retry_count% GEQ 15 goto replace_failed
timeout /t 1 /nobreak >nul
goto replace
:replace_ok
> "{status_path}" echo success
start "" "{exe_name}"
del "{exe_name}.old" >nul 2>&1
del "%~f0" >nul 2>&1
exit /b 0
:replace_failed
> "{status_path}" echo failed
start "" "{exe_name}"
del "%~f0" >nul 2>&1
exit /b 1
"#,
        pid = current_pid,
        install_dir = install_dir.display(),
        exe_name = exe_name,
        status_path = status_path.display(),
    )
}

#[cfg(not(windows))]
pub fn launch_update_restart() -> Result<(), String> {
    let install_dir = get_install_dir()?;
    let current_pid = std::process::id();
    let exe_name = current_exe_name()?;
    let status_path = app_data_dir().join(".update-status");

    let script_content = format!(
        r#"#!/bin/bash
printf 'pending\n' > "{status_path}"
while kill -0 {pid} 2>/dev/null; do
    sleep 1
done
cd "{install_dir}"
attempt=0
while [ "$attempt" -lt 15 ]; do
    if mv -f "{exe_name}.new" "{exe_name}" 2>/dev/null; then
        chmod +x "{exe_name}"
        printf 'success\n' > "{status_path}"
        open "{exe_name}"
        rm -f "{exe_name}.old" "$0"
        exit 0
    fi
    attempt=$((attempt + 1))
    sleep 1
done
printf 'failed\n' > "{status_path}"
open "{exe_name}"
rm -f "$0"
exit 1
"#,
        pid = current_pid,
        install_dir = install_dir.display(),
        exe_name = exe_name,
        status_path = status_path.display(),
    );

    let script_path = install_dir.join("_update_restart.sh");
    fs::write(&script_path, &script_content)
        .map_err(|e| format!("Failed to write update script: {}", e))?;

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

/// Cleanup after a successful update (called on next launch).
pub fn cleanup_after_update() -> Result<(), String> {
    let marker = app_data_dir().join(".update-pending");
    if !marker.exists() {
        return Ok(());
    }

    log::debug!("Cleaning up after update...");

    let expected_version = fs::read_to_string(&marker)
        .unwrap_or_default()
        .trim()
        .to_string();
    let status_path = app_data_dir().join(".update-status");
    let update_status = fs::read_to_string(&status_path)
        .unwrap_or_default()
        .trim()
        .to_string();
    let current_version = get_app_version();

    if update_status == "failed"
        || (!expected_version.is_empty()
            && expected_version != "pending"
            && expected_version != current_version)
    {
        restore_gateway_backup(&get_install_dir()?)?;
        let message = format!(
            "更新文件替换失败：目标版本 {}，当前仍为 {}。请关闭其他 Mona 进程后重试。",
            expected_version, current_version
        );
        let _ = fs::write(app_data_dir().join(".update-error"), &message);
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_file(&status_path);
        return Err(message);
    }

    // Remove marker
    let _ = fs::remove_file(&marker);
    let _ = fs::remove_file(&status_path);
    let _ = fs::remove_file(app_data_dir().join(".update-error"));

    let install_dir = get_install_dir()?;

    #[cfg(windows)]
    if let Err(e) = sync_windows_uninstall_version(&install_dir, &current_version) {
        log::warn!("Failed to sync Windows installed-app version: {}", e);
    }

    // Remove old gateway backup directory
    let gateway_bak = install_dir.join("resources").join("mona-gateway.bak");
    if gateway_bak.exists() {
        let _ = fs::remove_dir_all(&gateway_bak);
    }

    // 按当前 exe 名清理 .old 备份；同时清理历史遗留的 Mona.exe.old
    let exe_name = current_exe_name()?;
    let exe_old = install_dir.join(format!("{}.old", exe_name));
    if exe_old.exists() {
        let _ = fs::remove_file(&exe_old);
    }

    log::debug!("Update cleanup complete");
    Ok(())
}

#[cfg(windows)]
fn sync_windows_uninstall_version(install_dir: &Path, version: &str) -> Result<(), String> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};

    const USER_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Mona";
    const MACHINE_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Mona";
    const MACHINE_WOW64_KEY: &str =
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Mona";

    let expected_location = normalize_windows_path(install_dir.to_string_lossy().as_ref());
    let candidates = [
        (CURRENT_USER, USER_KEY),
        (LOCAL_MACHINE, MACHINE_KEY),
        (LOCAL_MACHINE, MACHINE_WOW64_KEY),
    ];
    let mut matched = false;

    for (root, path) in candidates {
        let key = match root.options().read().write().open(path) {
            Ok(key) => key,
            Err(_) => continue,
        };
        if key.get_string("DisplayName").unwrap_or_default() != "Mona" {
            continue;
        }
        let installed_location = key.get_string("InstallLocation").unwrap_or_default();
        if normalize_windows_path(&installed_location) != expected_location {
            continue;
        }
        key.set_string("DisplayVersion", version)
            .map_err(|e| format!("Failed to update DisplayVersion: {}", e))?;
        matched = true;
    }

    if matched {
        Ok(())
    } else {
        Err("Mona uninstall registry entry was not found for this installation".to_string())
    }
}

#[cfg(windows)]
fn normalize_windows_path(path: &str) -> String {
    path.trim()
        .trim_matches('"')
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_lowercase()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn extract_update_archive(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|e| format!("Failed to open archive: {}", e))?;

    // 同时兼容旧版 gzip 和新版 zstd 压缩包
    let extension = archive_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    if extension.eq_ignore_ascii_case("zst") || archive_path.to_string_lossy().ends_with(".tar.zst") {
        let decoder = zstd::stream::read::Decoder::new(file)
            .map_err(|e| format!("Failed to create zstd decoder: {}", e))?;
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(dest_dir)
            .map_err(|e| format!("Failed to extract zstd archive: {}", e))?;
    } else {
        let gz = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(gz);
        archive
            .unpack(dest_dir)
            .map_err(|e| format!("Failed to extract gzip archive: {}", e))?;
    }

    Ok(())
}

fn get_install_dir() -> Result<PathBuf, String> {
    let exe_path = std::env::current_exe().map_err(|e| format!("Cannot get exe path: {}", e))?;
    exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Cannot determine install directory".to_string())
}

/// 获取当前运行的可执行文件名（如 "mona-desktop.exe" 或 "Mona.exe"）。
/// 热更新时按此文件名替换原文件，避免硬编码 Mona.exe 导致快捷方式
/// 仍指向旧文件（NSIS 安装产物为 mona-desktop.exe）。
fn current_exe_name() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Cannot get exe path: {}", e))?;
    exe.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Cannot determine exe name".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installation_fixture(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let install = root.join("install");
        let source = root.join("new-gateway");
        fs::create_dir_all(install.join("resources/mona-gateway")).unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(install.join("resources/mona-gateway/payload"), b"old gateway").unwrap();
        fs::write(install.join("mona-desktop.exe"), b"old desktop").unwrap();
        fs::write(source.join("payload"), b"new gateway").unwrap();
        let executable = root.join("new-desktop.exe");
        fs::write(&executable, b"new desktop").unwrap();
        (install, source, executable)
    }

    #[test]
    fn incomplete_update_preserves_existing_installation() {
        let root = tempfile::tempdir().unwrap();
        let (install, source, executable) = installation_fixture(root.path());
        fs::remove_file(&executable).unwrap();
        let marker = root.path().join("pending");
        assert!(install_update_files(&source, &executable, &install, "mona-desktop.exe", &marker, "1.6.1").is_err());
        assert_eq!(fs::read(install.join("resources/mona-gateway/payload")).unwrap(), b"old gateway");
        assert_eq!(fs::read(install.join("mona-desktop.exe")).unwrap(), b"old desktop");
        assert!(!install.join("resources/mona-gateway.bak").exists());
        assert!(!marker.exists());
    }

    #[test]
    fn marker_write_failure_restores_old_files() {
        let root = tempfile::tempdir().unwrap();
        let (install, source, executable) = installation_fixture(root.path());
        let marker = root.path().join("missing-parent/pending");
        assert!(install_update_files(&source, &executable, &install, "mona-desktop.exe", &marker, "1.6.1").is_err());
        assert_eq!(fs::read(install.join("resources/mona-gateway/payload")).unwrap(), b"old gateway");
        assert_eq!(fs::read(install.join("mona-desktop.exe")).unwrap(), b"old desktop");
        assert!(!install.join("mona-desktop.exe.new").exists());
        assert!(!install.join("resources/mona-gateway.bak").exists());
    }

    #[test]
    fn completed_install_keeps_backup_for_failed_executable_swap() {
        let root = tempfile::tempdir().unwrap();
        let (install, source, executable) = installation_fixture(root.path());
        let marker = root.path().join("pending");
        install_update_files(&source, &executable, &install, "mona-desktop.exe", &marker, "1.6.1").unwrap();
        assert_eq!(fs::read_to_string(marker).unwrap(), "1.6.1");
        assert_eq!(fs::read(install.join("resources/mona-gateway/payload")).unwrap(), b"new gateway");
        assert_eq!(fs::read(install.join("mona-desktop.exe.new")).unwrap(), b"new desktop");
        restore_gateway_backup(&install).unwrap();
        assert_eq!(fs::read(install.join("resources/mona-gateway/payload")).unwrap(), b"old gateway");
        assert_eq!(fs::read(install.join("mona-desktop.exe")).unwrap(), b"old desktop");
    }

    #[test]
    fn update_check_only_accepts_a_strictly_newer_semantic_version() {
        assert!(check_update_available("1.6.0", "1.6.1"));
        assert!(!check_update_available("1.6.0", "1.6.0"));
        assert!(!check_update_available("1.6.0", "1.5.1"));
        assert!(!check_update_available("1.6.0", "invalid"));
    }

    #[test]
    fn legacy_gateway_copy_installs_office_resources_without_using_stale_sibling() {
        let tmp = tempfile::tempdir().unwrap();
        let staging = tmp.path().join("staging/mona-gateway");
        let new_office = staging.join("_internal/desktop-resources/office-editor");
        fs::create_dir_all(new_office.join("templates")).unwrap();
        fs::create_dir_all(new_office.join("sheets")).unwrap();
        fs::write(new_office.join("manifest.json"), b"new manifest").unwrap();
        fs::write(new_office.join("sheets/xlsx-sidecar.exe"), b"new sidecar").unwrap();
        for name in ["blank.docx", "blank.xlsx", "blank.pptx"] {
            fs::write(new_office.join("templates").join(name), b"new template").unwrap();
        }
        let install = tmp.path().join("install");
        let old_office = install.join("resources/office-editor");
        fs::create_dir_all(&old_office).unwrap();
        fs::write(old_office.join("manifest.json"), b"old manifest").unwrap();

        // This is the unchanged copy operation shipped in older clients.
        copy_dir_recursive(&staging, &install.join("resources/mona-gateway")).unwrap();
        let active = crate::services::office_resources_root(&install, false).join("office-editor");
        assert_eq!(fs::read(active.join("manifest.json")).unwrap(), b"new manifest");
        assert_eq!(fs::read(active.join("sheets/xlsx-sidecar.exe")).unwrap(), b"new sidecar");
        for name in ["blank.docx", "blank.xlsx", "blank.pptx"] {
            assert_eq!(fs::read(active.join("templates").join(name)).unwrap(), b"new template");
        }
        assert_eq!(fs::read(old_office.join("manifest.json")).unwrap(), b"old manifest");
    }

    #[test]
    fn test_extract_zstd_archive() {
        // Create a minimal tar.zst in memory and verify extraction handles both formats.
        let tmp = std::env::temp_dir().join("mona-test-zstd");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let archive_path = tmp.join("test.tar.zst");
        {
            let file = fs::File::create(&archive_path).unwrap();
            let mut enc = zstd::stream::write::Encoder::new(file, 3).unwrap();
            {
                let mut tar = tar::Builder::new(&mut enc);
                let mut header = tar::Header::new_gnu();
                header.set_path("Mona.exe").unwrap();
                header.set_size(4);
                header.set_cksum();
                tar.append(&header, b"exe\n" as &[u8]).unwrap();
            }
            enc.finish().unwrap();
        }

        let out = tmp.join("out");
        extract_update_archive(&archive_path, &out).unwrap();
        assert!(out.join("Mona.exe").exists());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(windows)]
    #[test]
    fn windows_restart_script_retries_and_records_result() {
        let script = build_windows_restart_script(
            1234,
            Path::new(r"C:\Program Files\Mona"),
            "mona-desktop.exe",
            Path::new(r"C:\Users\test\AppData\Roaming\Mona\.update-status"),
        );

        assert!(script.contains("set /a retry_count=0"));
        assert!(script.contains("if not exist \"mona-desktop.exe.new\" goto replace_ok"));
        assert!(script.contains("if %retry_count% GEQ 15 goto replace_failed"));
        assert!(script.contains("echo success"));
        assert!(script.contains("echo failed"));
    }

    #[cfg(windows)]
    #[test]
    fn normalizes_windows_install_paths() {
        assert_eq!(
            normalize_windows_path(r#""D:\Apps\Mona\""#),
            normalize_windows_path(r"d:/apps/mona")
        );
    }
}

/// Recursively copy a directory tree.
fn copy_dir_recursive(source: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dir {:?}: {}", dest, e))?;

    for entry in fs::read_dir(source)
        .map_err(|e| format!("Failed to read dir {:?}: {}", source, e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("Failed to copy {:?} to {:?}: {}", src_path, dest_path, e))?;
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

const MANIFEST_URL_PRIMARY: &str = "https://mona-ai.cn/updates/update.json";
const MANIFEST_URL_FALLBACK: &str = "https://www.mona-ai.cn/updates/update.json";

/// 优先从 Mona 根域名拉取更新清单，连接失败时回退到 www 兼容域名。
pub async fn fetch_manifest_with_fallback() -> Result<UpdateManifest, String> {
    match fetch_manifest(MANIFEST_URL_PRIMARY).await {
        Ok(m) => Ok(m),
        Err(_) => fetch_manifest(MANIFEST_URL_FALLBACK).await,
    }
}

#[tauri::command]
pub async fn check_for_updates(app_handle: tauri::AppHandle) -> Result<UpdateCheckResult, String> {
    let manifest = fetch_manifest_with_fallback().await?;
    Version::parse(&manifest.version).map_err(|_| "更新信息中的版本号无效，请稍后重试。".to_string())?;
    let current = get_app_version();
    let has_update = check_update_available(&current, &manifest.version);
    let result = UpdateCheckResult {
        has_update,
        current_version: current,
        latest_version: manifest.version,
        notes: manifest.notes,
        size: Some(manifest.size),
    };
    let _ = app_handle.emit("update-available", &result);
    Ok(result)
}

#[tauri::command]
pub async fn perform_update(
    state: tauri::State<'_, crate::GatewayState>,
    services_state: tauri::State<'_, crate::ServicesState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let _update_guard = UPDATE_LOCK.try_lock()
        .map_err(|_| "正在更新，请勿重复操作。".to_string())?;
    let manifest = fetch_manifest_with_fallback().await?;
    if !check_update_available(&get_app_version(), &manifest.version) {
        return Err("当前没有可安装的新版本，请重新检查更新。".to_string());
    }

    let staging_dir = dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("mona")
        .join("update");

    let package_path = match download_and_verify(
        &manifest.url,
        &manifest.sha256,
        manifest.size,
        &staging_dir,
        &app_handle,
    )
    .await
    {
        Ok(path) => path,
        Err(e) => {
            let _ = app_handle.emit(
                "update-download-failed",
                UpdateDownloadError {
                    message: e,
                    download_url: "https://mona-ai.cn/".to_string(),
                },
            );
            return Err("Update download failed, user notified".to_string());
        }
    };

    let result = install_update(
        &package_path,
        &manifest.version,
        &state,
        &services_state,
        &app_handle,
    ).and_then(|()| {
        if let Err(error) = launch_update_restart() {
            restore_gateway_backup(&get_install_dir()?)?;
            let marker = app_data_dir().join(".update-pending");
            fs::remove_file(marker).map_err(|e| format!("{error}；清理更新状态失败：{e}"))?;
            return Err(error);
        }
        Ok(())
    });
    if let Err(error) = result {
        if get_install_dir()?.join("resources/mona-gateway.bak").exists() {
            return Err(format!("{error}；已保留旧版本备份，请重启应用后重试。"));
        }
        let settings = crate::settings::load_settings();
        let gateway_restart = state.start(&settings, &app_handle);
        let services_restart = services_state.start(&settings, &app_handle);
        if let Err(restart) = gateway_restart.and(services_restart) {
            return Err(format!("{error}；旧文件已恢复，请重启应用：{restart}"));
        }
        return Err(error);
    }

    // Exit the current process so the helper script can swap the exe
    std::process::exit(0);
}

#[tauri::command]
pub async fn get_current_version() -> Result<String, String> {
    Ok(get_app_version())
}

#[tauri::command]
pub fn take_update_error() -> Result<Option<String>, String> {
    let path = app_data_dir().join(".update-error");
    if !path.exists() {
        return Ok(None);
    }
    let message = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read update error: {}", e))?;
    let _ = fs::remove_file(&path);
    let message = message.trim().to_string();
    Ok((!message.is_empty()).then_some(message))
}
