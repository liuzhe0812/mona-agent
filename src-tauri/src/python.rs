use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;

use crate::settings::app_data_dir;

#[cfg(windows)]
pub const GATEWAY_EXE_NAME: &str = "mona-gateway.exe";
#[cfg(not(windows))]
pub const GATEWAY_EXE_NAME: &str = "mona-gateway";

/// Name of the gateway directory (both in resources and deployed location)
const GATEWAY_DIR_NAME: &str = "mona-gateway";

/// Gateway and Services share one deployed Python tree. Startup may request
/// both at once, so replacement must remain a single operation.
static GATEWAY_DEPLOY_LOCK: Mutex<()> = Mutex::new(());

/// Directory where the gateway directory is deployed to
pub fn gateway_deploy_dir() -> PathBuf {
    app_data_dir().join("gateway")
}

/// Path to the deployed gateway executable
pub fn gateway_exe_path() -> PathBuf {
    gateway_deploy_dir()
        .join(GATEWAY_DIR_NAME)
        .join(GATEWAY_EXE_NAME)
}

/// Deploy the mona-gateway directory from bundled resources to app data dir.
/// This copies the entire directory (exe + _internal/) from the Tauri resource
/// directory to a stable location. Re-deploys if the bundled version differs
/// or the deployed executable is missing/damaged.
pub fn deploy_gateway(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let source_dir = find_gateway_resource_dir(app_handle)?;
    let dest_dir = gateway_deploy_dir().join(GATEWAY_DIR_NAME);

    // Best-effort sweep of stale dirs left by the rename fallback in
    // remove_old_gateway_dir (locked by an orphaned process at the time).
    sweep_stale_gateway_dirs();

    deploy_gateway_directory(&source_dir, &dest_dir, env!("CARGO_PKG_VERSION"))
}

fn deploy_gateway_directory(
    source_dir: &PathBuf,
    dest_dir: &PathBuf,
    version: &str,
) -> Result<PathBuf, String> {
    let _deployment_guard = GATEWAY_DEPLOY_LOCK
        .lock()
        .map_err(|error| format!("Gateway deployment lock failed: {}", error))?;

    let source_exe = source_dir.join(GATEWAY_EXE_NAME);
    if !source_exe.exists() {
        return Err(format!(
            "Gateway executable not found in source dir: {:?}",
            source_exe
        ));
    }

    let dest_exe = dest_dir.join(GATEWAY_EXE_NAME);

    // Check if we need to (re-)deploy: missing/damaged or different exe size
    let need_deploy = if !deployed_gateway_version_matches(dest_dir, version) {
        // Sidecar resources and file-based skills can change without changing
        // the gateway executable's size. Every app upgrade must redeploy them.
        true
    } else if !dest_exe.exists() {
        true
    } else if !dest_dir.join("_internal").is_dir() {
        // A previous removal partially deleted the tree (e.g. blocked by a
        // locked exe mid-way): re-deploy to repair.
        log::warn!("Deployed gateway dir damaged (missing _internal), repairing");
        true
    } else {
        let src_meta = std::fs::metadata(&source_exe)
            .map_err(|e| format!("Failed to read source metadata: {}", e))?;
        let dst_meta = std::fs::metadata(&dest_exe)
            .map_err(|e| format!("Failed to read dest metadata: {}", e))?;
        let src_size = src_meta.len();
        let dst_size = dst_meta.len();
        if src_size != dst_size {
            log::info!(
                "Gateway exe size changed (source: {}, deployed: {}), re-deploying",
                src_size,
                dst_size
            );
            true
        } else {
            log::debug!("Gateway already deployed at {:?}", dest_dir);
            false
        }
    };

    if !need_deploy {
        return Ok(dest_exe);
    }

    let staging_dir = dest_dir.with_file_name(format!(
        "{}.staging-{}-{}",
        GATEWAY_DIR_NAME,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    ));
    log::info!("Deploying gateway from {:?} to {:?}", source_dir, dest_dir);

    let deployment: Result<(), String> = (|| {
        copy_dir_recursive(source_dir, &staging_dir)?;
        std::fs::write(staging_dir.join(".mona-app-version"), version)
            .map_err(|e| format!("Failed to record deployed gateway version: {}", e))?;
        if dest_dir.exists() {
            remove_old_gateway_dir(dest_dir)?;
        }
        std::fs::rename(&staging_dir, dest_dir)
            .map_err(|e| format!("Failed to activate deployed gateway: {}", e))?;
        Ok(())
    })();
    if deployment.is_err() {
        let _ = std::fs::remove_dir_all(&staging_dir);
    }
    deployment?;

    log::info!("Gateway deployed to {:?}", dest_dir);

    Ok(dest_exe)
}

fn deployed_gateway_version_matches(dest_dir: &Path, version: &str) -> bool {
    std::fs::read_to_string(dest_dir.join(".mona-app-version"))
        .map(|deployed| deployed == version)
        .unwrap_or(false)
}

/// Move the previous deployment aside before copying the new gateway.
/// Deleting this large tree synchronously can block startup for minutes on
/// Windows, while renaming it on the same volume is fast and atomic.
fn remove_old_gateway_dir(dir: &PathBuf) -> Result<(), String> {
    #[cfg(windows)]
    kill_stale_gateway_processes();

    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let stale = dir.with_file_name(format!(
        "{}.stale-{}-{}",
        GATEWAY_DIR_NAME,
        std::process::id(),
        suffix
    ));
    const ATTEMPTS: u32 = 4;
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 1..=ATTEMPTS {
        match rename_gateway_dir(dir, &stale) {
            Ok(()) => {
                delete_directory_in_background(stale);
                return Ok(());
            }
            Err(e) => {
                last_err = Some(e);
                if attempt < ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            }
        }
    }
    Err(format!(
        "Failed to rotate old gateway directory after {} attempts: {}",
        ATTEMPTS,
        last_err
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

fn rename_gateway_dir(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

fn delete_directory_in_background(path: PathBuf) {
    std::thread::spawn(move || {
        if let Err(error) = std::fs::remove_dir_all(&path) {
            log::debug!("Deferred gateway cleanup {:?} failed: {}", path, error);
        }
    });
}

/// Delete `mona-gateway.stale-*` directories without delaying startup.
fn sweep_stale_gateway_dirs() {
    let prefix = format!("{}.stale-", GATEWAY_DIR_NAME);
    let Ok(entries) = std::fs::read_dir(gateway_deploy_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_str()
            .map(|n| n.starts_with(&prefix))
            .unwrap_or(false)
        {
            delete_directory_in_background(entry.path());
        }
    }
}

/// Kill any lingering `mona-gateway.exe` processes from previous app sessions.
/// Only called when the deployed directory is about to be replaced, so any
/// running instance is necessarily an outdated orphan that would hold locks
/// on the exe/DLLs inside.
#[cfg(windows)]
pub(crate) fn kill_stale_gateway_processes() {
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/IM", GATEWAY_EXE_NAME, "/T", "/F"]);
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
                                    // taskkill exits non-zero when no matching process exists — that is fine.
    if let Err(e) = cmd.status() {
        log::warn!("Failed to taskkill stale gateway processes: {}", e);
    }
}

/// Recursively copy a directory tree.
fn copy_dir_recursive(source: &PathBuf, dest: &PathBuf) -> Result<u64, String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("Failed to create dir {:?}: {}", dest, e))?;

    let mut total_copied: u64 = 0;

    for entry in
        std::fs::read_dir(source).map_err(|e| format!("Failed to read dir {:?}: {}", source, e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read dir entry: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            total_copied += copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            let copied = std::fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("Failed to copy {:?} to {:?}: {}", src_path, dest_path, e))?;
            total_copied += copied;
        }
    }

    Ok(total_copied)
}

/// Find the mona-gateway directory in bundled resources
fn find_gateway_resource_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut tried: Vec<String> = Vec::new();

    // 1. Use Tauri's resource_dir() API
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let candidate = resource_dir.join(GATEWAY_DIR_NAME);
        if candidate.is_dir() && candidate.join(GATEWAY_EXE_NAME).exists() {
            log::debug!("Found gateway dir via resource_dir: {:?}", candidate);
            return Ok(candidate);
        }
        tried.push(format!("resource_dir/{}", GATEWAY_DIR_NAME));
        log::debug!(
            "resource_dir is {:?}, but {} not found there",
            resource_dir,
            GATEWAY_DIR_NAME
        );
    } else {
        tried.push("resource_dir (unavailable)".into());
    }

    // 2. Fallback: exe_dir/resources/ and exe_dir/ (NSIS installs resources here)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            for sub in &["resources", ""] {
                let candidate = if sub.is_empty() {
                    exe_dir.join(GATEWAY_DIR_NAME)
                } else {
                    exe_dir.join(sub).join(GATEWAY_DIR_NAME)
                };
                if candidate.is_dir() && candidate.join(GATEWAY_EXE_NAME).exists() {
                    log::debug!("Found gateway dir near exe: {:?}", candidate);
                    return Ok(candidate);
                }
                tried.push(format!("exe_dir/{}/{}", sub, GATEWAY_DIR_NAME));
            }
        }
    }

    // 3. Fallback: relative path (dev mode)
    let candidate = PathBuf::from("resources").join(GATEWAY_DIR_NAME);
    if candidate.is_dir() && candidate.join(GATEWAY_EXE_NAME).exists() {
        log::debug!("Found gateway dir via relative path: {:?}", candidate);
        return Ok(candidate);
    }
    tried.push(format!("resources/{}", GATEWAY_DIR_NAME));

    Err(format!(
        "Gateway directory not found. Searched: {}",
        tried.join(", ")
    ))
}

/// Find system Python (dev mode only — release builds never call this).
///
/// 项目要求 Python >= 3.11（mona/__init__.py 使用 tomllib 标准库）。
/// PATH 里可能存在不满足要求的 Python（如 TRAE/Conda 自带的 3.10），
/// 因此对每个候选都验证版本，跳过 < 3.11 的。
pub fn find_system_python() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    let python_name = if cfg!(windows) {
        "python.exe"
    } else {
        "python3"
    };
    if let Ok(path) = which::which(python_name) {
        candidates.push(path);
    }
    if let Ok(path) = which::which("python") {
        candidates.push(path);
    }

    #[cfg(windows)]
    {
        if let Some(p) = find_windows_python() {
            candidates.push(p);
        }
    }

    for candidate in candidates {
        if python_version_ok(&candidate) {
            return Some(candidate);
        }
        log::debug!(
            "Skipping Python {:?}: version < 3.11 or unreachable",
            candidate
        );
    }

    None
}

/// 验证给定 python 可执行文件版本 >= 3.11。
/// 通过 `python -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"`
/// 获取版本（输出形如 "3.14"），解析后判断。
fn python_version_ok(python: &PathBuf) -> bool {
    let output = match std::process::Command::new(python)
        .args([
            "-c",
            "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')",
        ])
        .output()
    {
        Ok(o) => o,
        Err(_) => return false,
    };
    if !output.status.success() {
        return false;
    }
    let ver_str = String::from_utf8_lossy(&output.stdout);
    let ver_str = ver_str.trim();
    let parts: Vec<&str> = ver_str.split('.').collect();
    if parts.len() < 2 {
        return false;
    }
    let major: u32 = parts[0].parse().unwrap_or(0);
    let minor: u32 = parts[1].parse().unwrap_or(0);
    major > 3 || (major == 3 && minor >= 11)
}

#[cfg(windows)]
fn find_windows_python() -> Option<PathBuf> {
    use std::ffi::OsStr;

    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    let base = PathBuf::from(&local_app_data)
        .join("Programs")
        .join("Python");

    if let Ok(entries) = std::fs::read_dir(&base) {
        let mut candidates: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|s| s.starts_with("Python"))
                    .unwrap_or(false)
            })
            .map(|e| e.path().join("python.exe"))
            .filter(|p| p.exists())
            .collect();
        candidates.sort_by(|a, b| {
            let va = a
                .parent()
                .and_then(|d| d.file_name())
                .and_then(OsStr::to_str)
                .unwrap_or("");
            let vb = b
                .parent()
                .and_then(|d| d.file_name())
                .and_then(OsStr::to_str)
                .unwrap_or("");
            vb.cmp(va)
        });
        return candidates.into_iter().next();
    }

    None
}

#[cfg(test)]
mod gateway_rotation_tests {
    use super::{deployed_gateway_version_matches, deploy_gateway_directory, rename_gateway_dir, GATEWAY_EXE_NAME};
    use std::sync::{Arc, Barrier};

    #[test]
    fn app_upgrade_invalidates_gateway_even_when_executable_size_is_unchanged() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("mona-gateway.exe"), b"unchanged exe").unwrap();
        assert!(!deployed_gateway_version_matches(root.path(), "1.6.0"));
        std::fs::write(root.path().join(".mona-app-version"), "1.5.1").unwrap();
        assert!(!deployed_gateway_version_matches(root.path(), "1.6.0"));
        std::fs::write(root.path().join(".mona-app-version"), "1.6.0").unwrap();
        assert!(deployed_gateway_version_matches(root.path(), "1.6.0"));
    }

    #[test]
    fn rotates_gateway_directory_without_deleting_its_contents_first() {
        let root =
            std::env::temp_dir().join(format!("mona-gateway-rotation-{}", uuid::Uuid::new_v4()));
        let current = root.join("mona-gateway");
        let stale = root.join("mona-gateway.stale-test");
        std::fs::create_dir_all(current.join("_internal")).unwrap();
        std::fs::write(current.join("_internal").join("payload.bin"), b"payload").unwrap();

        rename_gateway_dir(&current, &stale).unwrap();

        assert!(!current.exists());
        assert_eq!(
            std::fs::read(stale.join("_internal").join("payload.bin")).unwrap(),
            b"payload"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_deployments_leave_one_complete_gateway_tree() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let destination = root.path().join("gateway/mona-gateway");
        std::fs::create_dir_all(source.join("_internal/pytz/zoneinfo/America")).unwrap();
        std::fs::write(source.join(GATEWAY_EXE_NAME), b"gateway").unwrap();
        std::fs::write(
            source.join("_internal/pytz/zoneinfo/America/Cordoba"),
            b"timezone",
        )
        .unwrap();

        let barrier = Arc::new(Barrier::new(2));
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let source = source.clone();
            let destination = destination.clone();
            let barrier = barrier.clone();
            tasks.push(std::thread::spawn(move || {
                barrier.wait();
                deploy_gateway_directory(&source, &destination, "1.6.0")
            }));
        }
        for task in tasks {
            task.join().unwrap().unwrap();
        }

        assert_eq!(
            std::fs::read(destination.join("_internal/pytz/zoneinfo/America/Cordoba")).unwrap(),
            b"timezone"
        );
        assert_eq!(std::fs::read_to_string(destination.join(".mona-app-version")).unwrap(), "1.6.0");
        assert!(
            std::fs::read_dir(destination.parent().unwrap())
                .unwrap()
                .all(|entry| !entry.unwrap().file_name().to_string_lossy().starts_with("mona-gateway.staging-"))
        );
    }
}

mod which {
    use std::path::PathBuf;

    pub fn which(name: &str) -> Result<PathBuf, ()> {
        let path_var = std::env::var("PATH").unwrap_or_default();
        let separator = if cfg!(windows) { ';' } else { ':' };

        for dir in path_var.split(separator) {
            let candidate = PathBuf::from(dir).join(name);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
        Err(())
    }
}
