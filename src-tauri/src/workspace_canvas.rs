use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const CANVAS_EXTENSION: &str = "mona-canvas";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCanvasDocument {
    pub version: u32,
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub origin_chat_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub content_markdown: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspaceCanvas {
    pub canvas: WorkspaceCanvasDocument,
    pub path: String,
}

fn validate_workspace_root(raw: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(raw.trim());
    if raw.trim().is_empty() || !root.is_absolute() {
        return Err("Canvas workspace root must be an absolute path".to_string());
    }
    fs::create_dir_all(&root)
        .map_err(|e| format!("Failed to create canvas workspace {:?}: {}", root, e))?;
    root.canonicalize()
        .map_err(|e| format!("Failed to resolve canvas workspace {:?}: {}", root, e))
}

fn canvas_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join("canvases");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create canvas directory {:?}: {}", dir, e))?;
    Ok(dir)
}

fn sanitize_file_stem(title: &str) -> String {
    let value: String = title
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .take(60)
        .collect();
    let trimmed = value.trim().trim_end_matches([' ', '.']);
    if trimmed.is_empty() { "未命名画布".to_string() } else { trimmed.to_string() }
}

fn validate_canvas(canvas: &WorkspaceCanvasDocument) -> Result<(), String> {
    if canvas.version != 1 {
        return Err(format!("Unsupported canvas version: {}", canvas.version));
    }
    if canvas.id.trim().is_empty() || canvas.id.contains(['/', '\\']) {
        return Err("Canvas id is invalid".to_string());
    }
    if canvas.kind != "flowchart" && canvas.kind != "mindmap" {
        return Err("Canvas kind must be flowchart or mindmap".to_string());
    }
    if canvas.title.trim().is_empty() || canvas.content_markdown.trim().is_empty() {
        return Err("Canvas title and content are required".to_string());
    }
    Ok(())
}

fn read_canvas_file(path: &Path) -> Result<WorkspaceCanvasDocument, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read canvas {:?}: {}", path, e))?;
    let canvas: WorkspaceCanvasDocument = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid canvas file {:?}: {}", path, e))?;
    validate_canvas(&canvas)?;
    Ok(canvas)
}

fn resolve_canvas_file(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if raw.trim().is_empty() || !path.is_absolute() {
        return Err("Canvas file path must be an absolute path".to_string());
    }
    let target = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve canvas path: {}", e))?;
    if !target.is_file()
        || !target
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(CANVAS_EXTENSION))
    {
        return Err("File is not a Mona canvas document".to_string());
    }
    Ok(target)
}

fn list_internal(root: &Path) -> Result<Vec<SavedWorkspaceCanvas>, String> {
    let dir = canvas_dir(root)?;
    let mut canvases = Vec::new();
    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to list canvas directory {:?}: {}", dir, e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some(CANVAS_EXTENSION) {
            continue;
        }
        if let Ok(canvas) = read_canvas_file(&path) {
            canvases.push(SavedWorkspaceCanvas {
                canvas,
                path: path.to_string_lossy().to_string(),
            });
        }
    }
    canvases.sort_by(|a, b| a.canvas.created_at.cmp(&b.canvas.created_at));
    Ok(canvases)
}

fn save_internal(
    root: &Path,
    mut canvas: WorkspaceCanvasDocument,
) -> Result<SavedWorkspaceCanvas, String> {
    validate_canvas(&canvas)?;
    let dir = canvas_dir(root)?;
    let existing = list_internal(root)?;
    let previous = existing
        .iter()
        .find(|item| item.canvas.id == canvas.id)
        .map(|item| PathBuf::from(&item.path));
    let now = chrono::Utc::now().to_rfc3339();
    if canvas.created_at.trim().is_empty() {
        canvas.created_at = previous
            .as_ref()
            .and_then(|path| read_canvas_file(path).ok())
            .map(|item| item.created_at)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| now.clone());
    }
    canvas.updated_at = now;

    let base = sanitize_file_stem(&canvas.title);
    let mut path = dir.join(format!("{}.{}", base, CANVAS_EXTENSION));
    let mut counter = 1usize;
    while path.exists() && previous.as_ref().map(|old| old != &path).unwrap_or(true) {
        path = dir.join(format!("{}-{}.{}", base, counter, CANVAS_EXTENSION));
        counter += 1;
    }
    let json = serde_json::to_string_pretty(&canvas).map_err(|e| e.to_string())?;
    fs::write(&path, format!("{}\n", json))
        .map_err(|e| format!("Failed to save canvas {:?}: {}", path, e))?;
    if let Some(old) = previous {
        if old != path {
            let _ = fs::remove_file(old);
        }
    }
    Ok(SavedWorkspaceCanvas {
        canvas,
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn workspace_canvas_save(
    workspace_root: String,
    canvas: WorkspaceCanvasDocument,
) -> Result<SavedWorkspaceCanvas, String> {
    let root = validate_workspace_root(&workspace_root)?;
    save_internal(&root, canvas)
}

#[tauri::command]
pub async fn workspace_canvas_list(
    workspace_root: String,
    chat_id: Option<String>,
) -> Result<Vec<SavedWorkspaceCanvas>, String> {
    let root = validate_workspace_root(&workspace_root)?;
    let mut items = list_internal(&root)?;
    if let Some(chat_id) = chat_id.filter(|value| !value.trim().is_empty()) {
        items.retain(|item| item.canvas.origin_chat_id.as_deref() == Some(chat_id.as_str()));
    }
    Ok(items)
}

#[tauri::command]
pub async fn workspace_canvas_read(
    workspace_root: String,
    path: String,
) -> Result<SavedWorkspaceCanvas, String> {
    let root = validate_workspace_root(&workspace_root)?;
    let target = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("Failed to resolve canvas path: {}", e))?;
    if !target.starts_with(&root)
        || target.extension().and_then(|value| value.to_str()) != Some(CANVAS_EXTENSION)
    {
        return Err("Canvas path is outside the current workspace".to_string());
    }
    let canvas = read_canvas_file(&target)?;
    Ok(SavedWorkspaceCanvas {
        canvas,
        path: target.to_string_lossy().to_string(),
    })
}

/// Opens a standalone `.mona-canvas` document selected from the operating system.
/// Unlike `workspace_canvas_read`, this intentionally permits files outside the
/// active chat workspace, but only reads validated Mona canvas files.
#[tauri::command]
pub async fn workspace_canvas_open_file(path: String) -> Result<SavedWorkspaceCanvas, String> {
    let target = resolve_canvas_file(&path)?;
    let canvas = read_canvas_file(&target)?;
    Ok(SavedWorkspaceCanvas {
        canvas,
        path: target.to_string_lossy().to_string(),
    })
}

/// Saves an already-open standalone canvas back to its original file.
#[tauri::command]
pub async fn workspace_canvas_write_file(
    path: String,
    mut canvas: WorkspaceCanvasDocument,
) -> Result<SavedWorkspaceCanvas, String> {
    let target = resolve_canvas_file(&path)?;
    validate_canvas(&canvas)?;
    canvas.updated_at = chrono::Utc::now().to_rfc3339();
    let json = serde_json::to_string_pretty(&canvas).map_err(|e| e.to_string())?;
    fs::write(&target, format!("{}\n", json))
        .map_err(|e| format!("Failed to save canvas {:?}: {}", target, e))?;
    Ok(SavedWorkspaceCanvas {
        canvas,
        path: target.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn workspace_canvas_migrate_legacy(
    workspace_root: String,
) -> Result<usize, String> {
    let root = validate_workspace_root(&workspace_root)?;
    let existing_ids: HashSet<String> = list_internal(&root)?
        .into_iter()
        .map(|item| item.canvas.id)
        .collect();
    let legacy = crate::notes::read_legacy_canvas_notes()?;
    let mut migrated = 0usize;
    for note in legacy {
        if existing_ids.contains(&note.id) {
            continue;
        }
        let canvas = WorkspaceCanvasDocument {
            version: 1,
            id: note.id,
            kind: note.note_type,
            title: note.title,
            origin_chat_id: note.origin_chat_id,
            created_at: note.created_at,
            updated_at: note.updated_at,
            content_markdown: note.content_markdown,
        };
        save_internal(&root, canvas)?;
        migrated += 1;
    }
    Ok(migrated)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("mona-workspace-canvas-test-{}", uuid::Uuid::new_v4()))
    }

    fn sample() -> WorkspaceCanvasDocument {
        WorkspaceCanvasDocument {
            version: 1,
            id: "canvas-test-1".to_string(),
            kind: "mindmap".to_string(),
            title: "产品规划".to_string(),
            origin_chat_id: Some("chat-1".to_string()),
            created_at: String::new(),
            updated_at: String::new(),
            content_markdown: "# 产品规划".to_string(),
        }
    }

    #[test]
    fn canvas_round_trip_stays_inside_workspace() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let canonical = root.canonicalize().unwrap();
        let saved = save_internal(&canonical, sample()).unwrap();
        assert!(Path::new(&saved.path).starts_with(&canonical));
        let listed = list_internal(&canonical).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].canvas.origin_chat_id.as_deref(), Some("chat-1"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn standalone_canvas_file_is_resolved_and_validated() {
        let root = temp_root();
        fs::create_dir_all(&root).unwrap();
        let canonical = root.canonicalize().unwrap();
        let saved = save_internal(&canonical, sample()).unwrap();

        let resolved = resolve_canvas_file(&saved.path).unwrap();
        assert_eq!(resolved, PathBuf::from(&saved.path).canonicalize().unwrap());
        assert!(read_canvas_file(&resolved).is_ok());
        assert!(resolve_canvas_file(&root.to_string_lossy()).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
