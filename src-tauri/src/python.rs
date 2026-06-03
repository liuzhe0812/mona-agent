use std::fs;
use std::path::PathBuf;

use crate::settings::app_data_dir;

const PYTHON_VERSION_MARKER: &str = ".mona-python-version";
const PYTHON_VERSION: &str = "3.12.13";

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

pub fn initialize_python() -> Result<(), String> {
    let dir = python_dir();
    if is_python_initialized() {
        log::info!("Python already initialized at {:?}", dir);
        return Ok(());
    }

    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create python dir: {}", e))?;

    let resource_tar = find_python_resource()?;
    extract_python(&resource_tar, &dir)?;

    fs::write(version_marker_path(), PYTHON_VERSION)
        .map_err(|e| format!("Failed to write version marker: {}", e))?;

    log::info!("Python initialization complete");
    Ok(())
}

fn find_python_resource() -> Result<PathBuf, String> {
    let candidates = [
        PathBuf::from("resources").join("python.tar.gz"),
        PathBuf::from("resources").join("python-install.tar.gz"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }

    Err(
        "Python runtime not found in resources. Please run the download script first.".to_string(),
    )
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
