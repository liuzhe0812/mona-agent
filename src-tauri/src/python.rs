use std::fs;
use std::path::PathBuf;

use tauri::Manager;

use crate::settings::app_data_dir;

const PYTHON_VERSION_MARKER: &str = ".mona-python-version";
pub const PYTHON_VERSION: &str = "3.12.13";

pub fn python_dir() -> PathBuf {
    app_data_dir().join("python")
}

pub fn python_executable() -> PathBuf {
    let dir = python_dir();
    if cfg!(windows) {
        dir.join("python.exe")
    } else {
        dir.join("bin").join("python3")
    }
}

pub fn version_marker_path() -> PathBuf {
    python_dir().join(PYTHON_VERSION_MARKER)
}

pub fn is_python_initialized() -> bool {
    let exe = python_executable();
    let marker = version_marker_path();
    if !exe.exists() || !marker.exists() {
        return false;
    }
    match fs::read_to_string(&marker) {
        Ok(v) => v.trim() == PYTHON_VERSION,
        Err(_) => false,
    }
}

pub fn initialize_python(app_handle: &tauri::AppHandle) -> Result<(), String> {
    if is_python_initialized() {
        log::info!("Python already initialized at {:?}", python_dir());
        return Ok(());
    }

    // Extract to app_data_dir, NOT python_dir.
    // The tar contains a top-level "python/" directory, so extracting to
    // app_data_dir produces: app_data_dir/python/python.exe
    // If we extracted to python_dir, we'd get: python_dir/python/python.exe (wrong!)
    let base_dir = app_data_dir();
    fs::create_dir_all(&base_dir).map_err(|e| format!("Failed to create app data dir: {}", e))?;

    let resource_tar = find_python_resource(app_handle)?;
    extract_python(&resource_tar, &base_dir)?;

    fs::write(version_marker_path(), PYTHON_VERSION)
        .map_err(|e| format!("Failed to write version marker: {}", e))?;

    log::info!("Python initialization complete");
    Ok(())
}

fn find_python_resource(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let searched = |locations: &[String]| {
        if locations.is_empty() {
            " (none searched)".to_string()
        } else {
            locations.join(", ")
        }
    };

    let mut tried: Vec<String> = Vec::new();

    // 1. Use Tauri's resource_dir() API — the correct way to find bundled resources
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        for name in &["python.tar.gz", "python-install.tar.gz"] {
            let candidate = resource_dir.join(name);
            if candidate.exists() {
                log::info!("Found Python resource via resource_dir: {:?}", candidate);
                return Ok(candidate);
            }
            tried.push(format!("resource_dir/{}", name));
        }
        log::info!("resource_dir is {:?}, but no python tar found there", resource_dir);
    } else {
        tried.push("resource_dir (unavailable)".into());
    }

    // 2. Fallback: exe_dir/resources/ (NSIS installs resources here)
    //    and exe_dir/ (some installers place resources next to exe)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            for sub in &["resources", ""] {
                for name in &["python.tar.gz", "python-install.tar.gz"] {
                    let candidate = if sub.is_empty() {
                        exe_dir.join(name)
                    } else {
                        exe_dir.join(sub).join(name)
                    };
                    if candidate.exists() {
                        log::info!("Found Python resource near exe: {:?}", candidate);
                        return Ok(candidate);
                    }
                    tried.push(format!("exe_dir/{}/{}", sub, name));
                }
            }
        }
    }

    // 3. Fallback: relative path (works in dev mode from src-tauri/)
    for name in &["python.tar.gz", "python-install.tar.gz"] {
        let candidate = PathBuf::from("resources").join(name);
        if candidate.exists() {
            log::info!("Found Python resource via relative path: {:?}", candidate);
            return Ok(candidate);
        }
        tried.push(format!("resources/{}", name));
    }

    Err(format!(
        "Python runtime not found. Searched: {}",
        searched(&tried)
    ))
}

fn extract_python(tar_path: &PathBuf, dest: &PathBuf) -> Result<(), String> {
    log::info!("Extracting Python from {:?} to {:?}", tar_path, dest);

    let file = fs::File::open(tar_path).map_err(|e| format!("Failed to open tar: {}", e))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);

    archive.unpack(dest).map_err(|e| format!("Failed to extract: {}", e))?;

    log::info!("Python extraction complete");
    Ok(())
}

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
