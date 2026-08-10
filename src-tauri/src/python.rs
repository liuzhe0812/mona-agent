use std::path::PathBuf;

use tauri::Manager;

use crate::settings::app_data_dir;

#[cfg(windows)]
pub const GATEWAY_EXE_NAME: &str = "mona-gateway.exe";
#[cfg(not(windows))]
pub const GATEWAY_EXE_NAME: &str = "mona-gateway";

/// Name of the gateway directory (both in resources and deployed location)
const GATEWAY_DIR_NAME: &str = "mona-gateway";

/// Directory where the gateway directory is deployed to
pub fn gateway_deploy_dir() -> PathBuf {
    app_data_dir().join("gateway")
}

/// Path to the deployed gateway executable
pub fn gateway_exe_path() -> PathBuf {
    gateway_deploy_dir().join(GATEWAY_DIR_NAME).join(GATEWAY_EXE_NAME)
}

/// Deploy the mona-gateway directory from bundled resources to app data dir.
/// This copies the entire directory (exe + _internal/) from the Tauri resource
/// directory to a stable location. Re-deploys if the bundled version differs
/// (detected by comparing the exe file size).
pub fn deploy_gateway(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let source_dir = find_gateway_resource_dir(app_handle)?;
    let dest_dir = gateway_deploy_dir().join(GATEWAY_DIR_NAME);

    let source_exe = source_dir.join(GATEWAY_EXE_NAME);
    if !source_exe.exists() {
        return Err(format!(
            "Gateway executable not found in source dir: {:?}",
            source_exe
        ));
    }

    let dest_exe = dest_dir.join(GATEWAY_EXE_NAME);

    // Check if we need to (re-)deploy: missing or different exe size
    let need_deploy = if !dest_exe.exists() {
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

    log::info!("Deploying gateway from {:?} to {:?}", source_dir, dest_dir);

    // Remove old deployment directory if it exists
    if dest_dir.exists() {
        std::fs::remove_dir_all(&dest_dir)
            .map_err(|e| format!("Failed to remove old gateway dir: {}", e))?;
    }

    // Copy the entire directory tree
    copy_dir_recursive(&source_dir, &dest_dir)?;

    log::info!("Gateway deployed to {:?}", dest_dir);

    Ok(dest_exe)
}

/// Recursively copy a directory tree.
fn copy_dir_recursive(source: &PathBuf, dest: &PathBuf) -> Result<u64, String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dir {:?}: {}", dest, e))?;

    let mut total_copied: u64 = 0;

    for entry in std::fs::read_dir(source)
        .map_err(|e| format!("Failed to read dir {:?}: {}", source, e))?
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
    let base = PathBuf::from(&local_app_data).join("Programs").join("Python");

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
