use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;

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
/// 1. Extract mona-<version>.tar.gz → staging/Mona(.exe) + staging/mona-gateway/
/// 2. Stop gateway AND services (both run from the same deployed exe;
///    leaving services alive would orphan it on exit, locking the deployed
///    dir and breaking the re-deploy on next launch — os error 5)
/// 3. Backup resources/mona-gateway/ → mona-gateway.bak/
/// 4. Copy new mona-gateway/ → resources/mona-gateway/
/// 5. Copy Mona(.exe) → Mona(.exe).new (staged for swap)
/// 6. Write .update-pending marker
pub fn install_update(
    package_path: &Path,
    gateway_state: &crate::GatewayState,
    services_state: &crate::ServicesState,
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

    // 3. Backup existing gateway directory in resources
    let install_dir = get_install_dir()?;
    let resource_gateway_dir = install_dir.join("resources").join("mona-gateway");
    if resource_gateway_dir.exists() {
        let bak_path = install_dir.join("resources").join("mona-gateway.bak");
        let _ = fs::remove_dir_all(&bak_path);
        fs::rename(&resource_gateway_dir, &bak_path)
            .map_err(|e| format!("Failed to backup gateway dir: {}", e))?;
    }

    // 4. Copy new gateway directory to resources
    let _ = app_handle.emit(
        "update-progress",
        UpdateProgress {
            stage: "installing".to_string(),
            percent: 70,
            message: "安装网关...".to_string(),
        },
    );

    fs::create_dir_all(install_dir.join("resources"))
        .map_err(|e| format!("Failed to create resources dir: {}", e))?;
    copy_dir_recursive(&new_gateway_dir, &resource_gateway_dir)?;

    // 5. Stage new exe
    let _ = app_handle.emit(
        "update-progress",
        UpdateProgress {
            stage: "installing".to_string(),
            percent: 85,
            message: "准备更新客户端...".to_string(),
        },
    );

    // 按当前运行 exe 的文件名替换（NSIS 产物为 mona-desktop.exe），
    // 避免硬编码 Mona.exe 导致快捷方式仍指向旧版本。
    let exe_name = current_exe_name()?;
    let exe_new = install_dir.join(format!("{}.new", exe_name));

    fs::copy(&new_exe, &exe_new)
        .map_err(|e| format!("Failed to stage new exe: {}", e))?;

    // 6. Write .update-pending marker
    let marker = app_data_dir().join(".update-pending");
    fs::write(&marker, "pending")
        .map_err(|e| format!("Failed to write update marker: {}", e))?;

    // 7. Cleanup staging
    let _ = fs::remove_dir_all(staging_dir);

    log::info!("Update installed, pending restart to apply");
    Ok(())
}

/// Launch the helper script to swap the exe and restart.
#[cfg(windows)]
pub fn launch_update_restart() -> Result<(), String> {
    let install_dir = get_install_dir()?;
    let current_pid = std::process::id();
    let exe_name = current_exe_name()?;

    let script_content = format!(
        r#"@echo off
:wait
tasklist /FI "PID eq {pid}" 2>nul | find "{pid}" >nul
if %ERRORLEVEL%==0 (
    timeout /t 1 /nobreak >nul
    goto wait
)
cd /d "{install_dir}"
move /y "{exe_name}.new" "{exe_name}" >nul 2>&1
start "" "{exe_name}"
del "{exe_name}.old" >nul 2>&1
del "%~f0" >nul 2>&1
"#,
        pid = current_pid,
        install_dir = install_dir.display(),
        exe_name = exe_name,
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

#[cfg(not(windows))]
pub fn launch_update_restart() -> Result<(), String> {
    let install_dir = get_install_dir()?;
    let current_pid = std::process::id();
    let exe_name = current_exe_name()?;

    let script_content = format!(
        r#"#!/bin/bash
while kill -0 {pid} 2>/dev/null; do
    sleep 1
done
cd "{install_dir}"
mv -f "{exe_name}.new" "{exe_name}" 2>/dev/null
chmod +x "{exe_name}"
open "{exe_name}"
rm -f "{exe_name}.old" "$0"
"#,
        pid = current_pid,
        install_dir = install_dir.display(),
        exe_name = exe_name,
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

    // Remove marker
    let _ = fs::remove_file(&marker);

    let install_dir = get_install_dir()?;

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

const MANIFEST_URL_PRIMARY: &str = "https://www.mona-ai.cn/updates/update.json";
const MANIFEST_URL_FALLBACK: &str = "https://mona.lzfun.vip/updates/update.json";

/// 依次尝试主备域名拉取更新清单。主域名 (www.mona-ai.cn) 可能被 SNI 阻断，
/// 回退到已备案的 mona.lzfun.vip（同一 VPS）。
pub async fn fetch_manifest_with_fallback() -> Result<UpdateManifest, String> {
    match fetch_manifest(MANIFEST_URL_PRIMARY).await {
        Ok(m) => Ok(m),
        Err(_) => fetch_manifest(MANIFEST_URL_FALLBACK).await,
    }
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let manifest = fetch_manifest_with_fallback().await?;
    let current = get_app_version();
    let has_update = check_update_available(&current, &manifest.version);
    Ok(UpdateCheckResult {
        has_update,
        current_version: current,
        latest_version: manifest.version,
        notes: manifest.notes,
        size: Some(manifest.size),
    })
}

#[tauri::command]
pub async fn perform_update(
    state: tauri::State<'_, crate::GatewayState>,
    services_state: tauri::State<'_, crate::ServicesState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let manifest = fetch_manifest_with_fallback().await?;

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
                    download_url: "https://www.mona-ai.cn/".to_string(),
                },
            );
            return Err("Update download failed, user notified".to_string());
        }
    };

    install_update(&package_path, &state, &services_state, &app_handle)?;

    launch_update_restart()?;

    // Exit the current process so the helper script can swap the exe
    std::process::exit(0);
}

#[tauri::command]
pub async fn get_current_version() -> Result<String, String> {
    Ok(get_app_version())
}
