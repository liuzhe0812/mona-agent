use std::path::PathBuf;

use tauri::Manager;

use crate::settings::app_data_dir;

const GATEWAY_EXE_NAME: &str = "mona-gateway.exe";

/// Directory where mona-gateway.exe is extracted to (or found)
pub fn gateway_exe_dir() -> PathBuf {
    app_data_dir().join("gateway")
}

/// Path to the mona-gateway executable
pub fn gateway_exe_path() -> PathBuf {
    gateway_exe_dir().join(GATEWAY_EXE_NAME)
}

/// Check if mona-gateway.exe has been deployed (extracted from bundle)
pub fn is_gateway_deployed() -> bool {
    gateway_exe_path().exists()
}

/// Deploy mona-gateway.exe from bundled resources to app data dir.
/// This copies the exe from the Tauri resource directory to a stable location.
/// Re-deploys if the bundled exe differs from the deployed one (different size).
pub fn deploy_gateway(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let source = find_gateway_resource(app_handle)?;
    let dest_dir = gateway_exe_dir();
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("Failed to create gateway dir: {}", e))?;

    let dest = gateway_exe_path();

    // Check if we need to (re-)deploy: missing or different size
    let need_deploy = if !dest.exists() {
        true
    } else {
        let src_meta = std::fs::metadata(&source)
            .map_err(|e| format!("Failed to read source metadata: {}", e))?;
        let dst_meta = std::fs::metadata(&dest)
            .map_err(|e| format!("Failed to read dest metadata: {}", e))?;
        let src_size = src_meta.len();
        let dst_size = dst_meta.len();
        if src_size != dst_size {
            log::info!(
                "Gateway exe size changed (source: {}, deployed: {}), re-deploying",
                src_size, dst_size
            );
            true
        } else {
            log::info!("Gateway already deployed at {:?}", dest);
            false
        }
    };

    if !need_deploy {
        return Ok(dest);
    }

    log::info!("Deploying gateway from {:?} to {:?}", source, dest);

    let copied = std::fs::copy(&source, &dest)
        .map_err(|e| format!("Failed to copy gateway exe: {}", e))?;

    log::info!("Gateway deployed: {} bytes copied", copied);

    Ok(dest)
}

/// Find the mona-gateway.exe in bundled resources
fn find_gateway_resource(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut tried: Vec<String> = Vec::new();

    // 1. Use Tauri's resource_dir() API
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let candidate = resource_dir.join(GATEWAY_EXE_NAME);
        if candidate.exists() {
            log::info!("Found gateway via resource_dir: {:?}", candidate);
            return Ok(candidate);
        }
        tried.push(format!("resource_dir/{}", GATEWAY_EXE_NAME));
        log::info!("resource_dir is {:?}, but {} not found there", resource_dir, GATEWAY_EXE_NAME);
    } else {
        tried.push("resource_dir (unavailable)".into());
    }

    // 2. Fallback: exe_dir/resources/ and exe_dir/ (NSIS installs resources here)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            for sub in &["resources", ""] {
                let candidate = if sub.is_empty() {
                    exe_dir.join(GATEWAY_EXE_NAME)
                } else {
                    exe_dir.join(sub).join(GATEWAY_EXE_NAME)
                };
                if candidate.exists() {
                    log::info!("Found gateway near exe: {:?}", candidate);
                    return Ok(candidate);
                }
                tried.push(format!("exe_dir/{}/{}", sub, GATEWAY_EXE_NAME));
            }
        }
    }

    // 3. Fallback: relative path (dev mode)
    let candidate = PathBuf::from("resources").join(GATEWAY_EXE_NAME);
    if candidate.exists() {
        log::info!("Found gateway via relative path: {:?}", candidate);
        return Ok(candidate);
    }
    tried.push(format!("resources/{}", GATEWAY_EXE_NAME));

    Err(format!(
        "Gateway executable not found. Searched: {}",
        tried.join(", ")
    ))
}

/// Find system Python (dev mode only — release builds never call this).
pub fn find_system_python() -> Option<PathBuf> {
    let python_name = if cfg!(windows) {
        "python.exe"
    } else {
        "python3"
    };

    if let Ok(path) = which::which(python_name) {
        return Some(path);
    }
    if let Ok(path) = which::which("python") {
        return Some(path);
    }

    #[cfg(windows)]
    {
        if let Some(p) = find_windows_python() {
            return Some(p);
        }
    }

    None
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
            let va = a.parent().and_then(|d| d.file_name()).and_then(OsStr::to_str).unwrap_or("");
            let vb = b.parent().and_then(|d| d.file_name()).and_then(OsStr::to_str).unwrap_or("");
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
