//! Materials module: Tauri commands for materials file operations.
//!
//! 资料库 Rust 端：提供文件复制（上传）、目录递归扫描、路径校验等能力。
//! 所有路径操作都限制在 `<vault>/.mona/materials/` 内。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::notes;

/// Materials entry kind for directory listings.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialsEntry {
    pub name: String,
    pub path: String,
    pub kind: String, // "directory" | "file"
    pub size: Option<u64>,
    pub mtime: Option<u64>,
}

/// Resolve the materials root directory for the current vault.
/// Returns `(vault_path, materials_root)` or an error if vault is not configured.
fn resolve_materials_root() -> Result<(PathBuf, PathBuf), String> {
    let vault = notes::read_vault_path()
        .ok_or_else(|| "Notes vault not configured".to_string())?;
    let materials = vault.join(".mona").join("materials");
    // Ensure subdirectories exist
    for sub in ["raw", "text", "wiki"] {
        let dir = materials.join(sub);
        if !dir.exists() {
            fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
        }
    }
    Ok((vault, materials))
}

/// Canonical path validation: ensure `path` is inside `materials_root`.
/// Returns the resolved path on success.
///
/// 对尚不存在的路径（如待写入的目标文件），canonicalize 其父目录后拼接文件名，
/// 避免 Windows 上 `canonicalize` 因路径不存在而报错。
fn ensure_within(path: &Path, materials_root: &Path) -> Result<PathBuf, String> {
    let resolved = if path.exists() {
        path.canonicalize()
            .map_err(|e| format!("Path resolution failed: {}", e))?
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| "Invalid path: no parent".to_string())?;
        let parent_resolved = parent
            .canonicalize()
            .map_err(|e| format!("Parent path resolution failed: {}", e))?;
        let name = path
            .file_name()
            .ok_or_else(|| "Invalid path: no file name".to_string())?;
        parent_resolved.join(name)
    };
    let root_resolved = materials_root
        .canonicalize()
        .map_err(|e| format!("Materials root resolution failed: {}", e))?;
    if !resolved.starts_with(&root_resolved) {
        return Err("Path escapes materials directory".to_string());
    }
    Ok(resolved)
}

/// Convert a relative path string to an absolute path under `materials/raw/`.
fn resolve_raw_path(rel: &str, materials_root: &Path) -> Result<PathBuf, String> {
    let rel = rel.trim().trim_start_matches('/');
    if rel.is_empty() || rel.contains("..") {
        return Err("Invalid relative path".to_string());
    }
    Ok(materials_root.join("raw").join(rel))
}

/// Convert an absolute path to a POSIX relative path under materials root.
fn relative_to_materials(path: &Path, materials_root: &Path) -> String {
    path.strip_prefix(materials_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// `materials_import_files`: Copy user-selected files into `raw/<target_dir>/`.
///
/// 前端通过 Tauri dialog 选择文件后，调用此命令复制到资料库 raw 目录。
/// 不通过 HTTP 上传文件体，避免大文件传输开销。
#[tauri::command]
pub async fn materials_import_files(
    source_paths: Vec<String>,
    target_dir: String,
) -> Result<Vec<MaterialsEntry>, String> {
    let (_vault, materials_root) = resolve_materials_root()?;
    let target_dir = target_dir.trim().trim_start_matches('/');

    let target_path = if target_dir.is_empty() {
        materials_root.join("raw")
    } else {
        materials_root.join("raw").join(target_dir)
    };
    ensure_within(&target_path, &materials_root)?;
    fs::create_dir_all(&target_path)
        .map_err(|e| format!("Failed to create target dir: {}", e))?;

    let mut imported: Vec<MaterialsEntry> = Vec::new();
    for src_str in &source_paths {
        let src = PathBuf::from(src_str);
        if !src.exists() {
            return Err(format!("Source file not found: {}", src.display()));
        }
        let name = src
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?;
        let dst = target_path.join(name);
        ensure_within(&dst, &materials_root)?;

        // Copy file (supports both files and directories recursively)
        if src.is_dir() {
            copy_dir_recursive(&src, &dst)
                .map_err(|e| format!("Failed to copy directory {}: {}", src.display(), e))?;
        } else {
            fs::copy(&src, &dst)
                .map_err(|e| format!("Failed to copy {}: {}", src.display(), e))?;
        }

        let stat = fs::metadata(&dst).map_err(|e| format!("Stat failed: {}", e))?;
        imported.push(MaterialsEntry {
            name: name.to_string(),
            path: relative_to_materials(&dst, &materials_root),
            kind: if stat.is_dir() { "directory".into() } else { "file".into() },
            size: if stat.is_file() { Some(stat.len()) } else { None },
            mtime: None,
        });
    }

    Ok(imported)
}

/// `materials_list_dir`: Recursively list entries under a directory.
///
/// 递归扫描 raw/ 下指定子目录（默认根目录），返回文件和文件夹列表。
/// 与 Python `/api/materials/files` 端点互补——此命令用于前端快速列表，
/// Python 端点额外返回提取状态等需要解析 text/ 的字段。
#[tauri::command]
pub async fn materials_list_dir(subdir: Option<String>) -> Result<Vec<MaterialsEntry>, String> {
    let (_vault, materials_root) = resolve_materials_root()?;
    let target = match subdir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(rel) => {
            let p = materials_root.join("raw").join(rel);
            ensure_within(&p, &materials_root)?
        }
        None => materials_root.join("raw"),
    };

    if !target.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<MaterialsEntry> = Vec::new();
    for child in fs::read_dir(&target).map_err(|e| e.to_string())?.flatten() {
        let path = child.path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let metadata = child.metadata().map_err(|e| e.to_string())?;
        entries.push(MaterialsEntry {
            name: name.clone(),
            path: relative_to_materials(&path, &materials_root),
            kind: if metadata.is_dir() { "directory".into() } else { "file".into() },
            size: if metadata.is_file() { Some(metadata.len()) } else { None },
            mtime: metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
        });
    }

    // Directories first, then files, both alphabetical
    entries.sort_by(|a, b| {
        let dir_cmp = (a.kind != "directory").cmp(&(b.kind != "directory"));
        if dir_cmp != std::cmp::Ordering::Equal {
            return dir_cmp;
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    Ok(entries)
}

/// `materials_ensure_initialized`: Make sure the materials directory structure exists.
///
/// 由笔记 vault 初始化时调用，确保 `.mona/materials/{raw,text,wiki}/` 存在。
#[tauri::command]
pub async fn materials_ensure_initialized() -> Result<bool, String> {
    let (_vault, _materials_root) = resolve_materials_root()?;
    Ok(true)
}

/// `materials_get_wiki_dir`: Return the absolute path to `<vault>/.mona/materials/wiki/`.
///
/// 供 notes_links.rs 在扩展扫描时使用——但目前通过直接调
/// `notes::read_vault_path()` 获取 vault 后拼接，无需走 IPC。
/// 此命令保留给前端预览/打开外部程序等场景。
#[tauri::command]
pub async fn materials_get_wiki_dir() -> Result<Option<String>, String> {
    let vault = notes::read_vault_path().ok_or_else(|| "Vault not configured".to_string())?;
    let wiki_dir = vault.join(".mona").join("materials").join("wiki");
    Ok(if wiki_dir.exists() {
        Some(wiki_dir.to_string_lossy().to_string())
    } else {
        None
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Recursively copy a directory.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        fs::create_dir_all(dst)?;
    }
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &dest)?;
        } else {
            fs::copy(&path, &dest)?;
        }
    }
    Ok(())
}
