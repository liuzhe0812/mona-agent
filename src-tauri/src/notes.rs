use crate::settings::app_data_dir;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

const NOTES_DB_FILE: &str = "notes.sqlite3";
const VAULT_PATH_FILE: &str = "vault_path.txt";
const DEFAULT_NOTEBOOK_NAME: &str = "默认分类";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesState {
    pub notebooks: Vec<Notebook>,
    pub notes: Vec<OperationNote>,
    pub active_notebook_id: String,
    pub active_note_id: Option<String>,
    /// User-defined note AI transformation templates.
    #[serde(default)]
    pub transformations: Vec<NoteTransformation>,
}

/// A user-defined AI transformation template for notes.
/// The prompt template supports variables: {{note_title}}, {{note_content}},
/// {{note_tags}}, {{note_source}}.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTransformation {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub prompt_template: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub knowledge_base_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationNote {
    pub id: String,
    pub notebook_id: String,
    pub title: String,
    pub preview: String,
    pub created_at: String,
    pub updated_at: String,
    pub source: NoteSource,
    #[serde(default)]
    pub tags: Vec<String>,
    pub content_markdown: String,
    #[serde(default)]
    pub content_json: Option<Value>,
    #[serde(default)]
    pub plain_text: Option<String>,
    #[serde(default)]
    pub agent_chat_id: Option<String>,
    #[serde(default)]
    pub applied_agent_message_ids: Vec<String>,
    /// Context level controls how this note participates in knowledge-base
    /// retrieval: "full" (default) | "summary" | "none".
    #[serde(default = "default_context_level")]
    pub context_level: String,
    /// Note type: "note" (default) | "moc" | "daily" | "template" | "agent-experience".
    /// MOC notes are Map-of-Content index notes that organize other notes via [[links]].
    #[serde(default = "default_note_type", rename = "type")]
    pub note_type: String,
    /// Aliases used for [[wiki link]] matching besides the title.
    #[serde(default)]
    pub aliases: Vec<String>,
}

fn default_context_level() -> String {
    "full".to_string()
}

fn default_note_type() -> String {
    "note".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSource {
    pub kind: String,
    pub label: String,
}

// ---------------------------------------------------------------------------
// Vault metadata (.mona/vault.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultMeta {
    #[serde(default)]
    notebooks: HashMap<String, VaultNotebookMeta>,
    #[serde(default)]
    active_notebook_id: String,
    #[serde(default)]
    active_note_id: Option<String>,
    #[serde(default)]
    transformations: Vec<NoteTransformation>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultNotebookMeta {
    #[serde(default)]
    knowledge_base_enabled: bool,
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

fn notes_db_path() -> PathBuf {
    app_data_dir().join("notes").join(NOTES_DB_FILE)
}

// ---------------------------------------------------------------------------
// Vault path management
// ---------------------------------------------------------------------------

fn vault_path_file() -> PathBuf {
    app_data_dir().join("notes").join(VAULT_PATH_FILE)
}

pub(crate) fn read_vault_path() -> Option<PathBuf> {
    let content = fs::read_to_string(vault_path_file()).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn write_vault_path(path: &Path) -> Result<(), String> {
    let file = vault_path_file();
    let parent = file.parent().ok_or("Invalid vault path file location")?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create notes dir: {}", e))?;
    fs::write(&file, path.to_string_lossy().to_string())
        .map_err(|e| format!("Failed to write vault path: {}", e))?;
    Ok(())
}

fn vault_meta_file(vault: &Path) -> PathBuf {
    vault.join(".mona").join("vault.json")
}

fn read_vault_meta(vault: &Path) -> Result<VaultMeta, String> {
    let file = vault_meta_file(vault);
    if !file.exists() {
        return Ok(VaultMeta::default());
    }
    let content = fs::read_to_string(&file).map_err(|e| format!("Failed to read vault.json: {}", e))?;
    if content.trim().is_empty() {
        return Ok(VaultMeta::default());
    }
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse vault.json: {}", e))
}

fn write_vault_meta(vault: &Path, meta: &VaultMeta) -> Result<(), String> {
    let dir = vault.join(".mona");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create .mona dir: {}", e))?;
    let content = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("Failed to serialize vault.json: {}", e))?;
    fs::write(vault_meta_file(vault), content)
        .map_err(|e| format!("Failed to write vault.json: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn notes_vault_get_path() -> Result<Option<String>, String> {
    Ok(read_vault_path().map(|p| p.to_string_lossy().to_string()))
}

/// Register the vault's assets directory with the Tauri asset protocol and fs
/// plugin scopes, so the frontend can render images via `convertFileSrc()` and
/// write images directly via `tauri-plugin-fs`.
///
/// Must be called after the vault path is set/known. Safe to call repeatedly.
pub fn register_vault_assets_scope(app: &tauri::AppHandle, vault: &Path) {
    use tauri::Manager;
    use tauri_plugin_fs::FsExt;
    let assets_dir = vault.join("assets");
    if let Err(e) = fs::create_dir_all(&assets_dir) {
        log::warn!("Failed to ensure assets dir for scope: {}", e);
    }
    let asset_scope = app.asset_protocol_scope();
    if let Err(e) = asset_scope.allow_directory(&assets_dir, true) {
        log::warn!("Failed to allow assets dir in asset protocol scope: {}", e);
    }
    let fs_scope = app.fs_scope();
    if let Err(e) = fs_scope.allow_directory(&assets_dir, true) {
        log::warn!("Failed to allow assets dir in fs scope: {}", e);
    }
}

/// Public accessor for the configured vault path, used by `lib.rs` setup
/// to register the asset protocol scope at app startup.
pub fn read_vault_path_for_setup() -> Option<PathBuf> {
    read_vault_path()
}

#[tauri::command]
pub async fn notes_vault_set_path(
    app: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    let vault = PathBuf::from(&path);
    fs::create_dir_all(&vault).map_err(|e| format!("Failed to create vault root: {}", e))?;
    fs::create_dir_all(vault.join(".mona"))
        .map_err(|e| format!("Failed to create .mona dir: {}", e))?;
    fs::create_dir_all(vault.join("assets"))
        .map_err(|e| format!("Failed to create assets dir: {}", e))?;

    // Register the assets directory in the asset protocol scope so the
    // frontend can use convertFileSrc() to render images directly.
    register_vault_assets_scope(&app, &vault);

    write_vault_path(&vault)?;

    // One-shot migration: if the legacy SQLite DB has notes/notebooks data,
    // export them to .md files into the vault and then drop the legacy tables.
    // Only runs if the vault looks empty (no .md files yet) to avoid clobbering.
    match migrate_legacy_sqlite_to_vault(&vault) {
        Ok(Some(count)) => log::info!("Migrated {} legacy notes into vault", count),
        Ok(None) => {}
        Err(e) => log::warn!("Legacy notes migration skipped: {}", e),
    }

    Ok(())
}

/// Migrate notes/notebooks from the legacy SQLite tables into the vault as .md
/// files. Returns Some(n) if n notes were migrated, or None if there was
/// nothing to migrate (no DB, no legacy tables, or vault already had notes).
fn migrate_legacy_sqlite_to_vault(vault: &Path) -> Result<Option<usize>, String> {
    // Skip if the vault already contains .md files (user picked an existing vault).
    let vault_has_md = walkdir_md_count(vault)?;
    if vault_has_md > 0 {
        return Ok(None);
    }

    let db_path = notes_db_path();
    if !db_path.exists() {
        return Ok(None);
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open legacy notes DB: {}", e))?;

    // Check for legacy `notes` table.
    let has_notes_table: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='notes'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !has_notes_table {
        return Ok(None);
    }

    let note_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
        .unwrap_or(0);
    if note_count == 0 {
        // Still drop the empty legacy tables to keep the DB clean.
        drop_legacy_tables(&conn)?;
        return Ok(None);
    }

    // Load notebooks (id -> name) so we can map notes to folder names.
    let mut notebook_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, name FROM notebooks")
            .map_err(|e| format!("Failed to prepare notebooks query: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Failed to query notebooks: {}", e))?;
        for row in rows {
            let (id, name) = row.map_err(|e| format!("Failed to read notebook row: {}", e))?;
            notebook_names.insert(id, name);
        }
    }
    // Ensure the default notebook folder always exists in the map.
    notebook_names
        .entry("default".to_string())
        .or_insert_with(|| DEFAULT_NOTEBOOK_NAME.to_string());

    // Load active pointers from app_state so we can restore them into vault.json.
    let active_notebook_id = read_legacy_state_value(&conn, "activeNotebookId")
        .unwrap_or_else(|| DEFAULT_NOTEBOOK_NAME.to_string());
    let active_note_id = read_legacy_state_value(&conn, "activeNoteId");
    let transformations_raw = read_legacy_state_value(&conn, "transformations");

    // Load each note row and write it as .md into the matching notebook folder.
    let mut migrated: usize = 0;
    let mut used_filenames: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, notebook_id, title, preview, updated_at_label, source_kind,
                        source_label, tags_json, content_markdown, agent_chat_id,
                        applied_agent_message_ids_json, context_level
                 FROM notes",
            )
            .map_err(|e| format!("Failed to prepare notes query: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let notebook_id: String = row.get(1)?;
                let title: String = row.get(2)?;
                let _preview: String = row.get(3)?;
                let updated_at: String = row.get(4)?;
                let source_kind: String = row.get(5)?;
                let source_label: String = row.get(6)?;
                let tags_json: String = row.get(7)?;
                let content_markdown: String = row.get(8)?;
                let agent_chat_id: Option<String> = row.get(9)?;
                let applied_ids_json: String = row.get(10)?;
                let context_level: String = row.get(11)?;
                Ok((
                    id,
                    notebook_id,
                    title,
                    updated_at,
                    source_kind,
                    source_label,
                    tags_json,
                    content_markdown,
                    agent_chat_id,
                    applied_ids_json,
                    context_level,
                ))
            })
            .map_err(|e| format!("Failed to query notes: {}", e))?;

        for row in rows {
            let (
                id,
                notebook_id,
                title,
                updated_at,
                source_kind,
                source_label,
                tags_json,
                content_markdown,
                agent_chat_id,
                applied_ids_json,
                context_level,
            ) = row.map_err(|e| format!("Failed to read note row: {}", e))?;

            let folder_name = notebook_names
                .get(&notebook_id)
                .cloned()
                .unwrap_or_else(|| DEFAULT_NOTEBOOK_NAME.to_string());
            let folder_path = vault.join(&folder_name);
            fs::create_dir_all(&folder_path)
                .map_err(|e| format!("Failed to create notebook folder: {}", e))?;

            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            let applied_ids: Vec<String> =
                serde_json::from_str(&applied_ids_json).unwrap_or_default();
            let note = OperationNote {
                id: id.clone(),
                notebook_id: folder_name.clone(),
                title: title.clone(),
                preview: make_preview(&content_markdown),
                created_at: updated_at.clone(),
                updated_at: updated_at.clone(),
                source: NoteSource {
                    kind: source_kind,
                    label: source_label,
                },
                tags,
                content_markdown,
                content_json: None,
                plain_text: None,
                agent_chat_id,
                applied_agent_message_ids: applied_ids,
                context_level: if context_level.is_empty() {
                    "full".to_string()
                } else {
                    context_level
                },
                note_type: default_note_type(),
                aliases: Vec::new(),
            };

            let mut file_name = format!("{}.md", sanitize_filename(&title));
            // Resolve collisions within the same notebook folder.
            let mut counter = 1;
            while used_filenames.contains(&format!("{}/{}", folder_name, file_name)) {
                let suffix = format!("_{}", &id[..id.len().min(6)]);
                let base = file_name.trim_end_matches(".md");
                file_name = format!("{}{}.md", base, suffix);
                counter += 1;
                if counter > 100 {
                    break;
                }
            }
            used_filenames.insert(format!("{}/{}", folder_name, file_name));

            let file_path = folder_path.join(&file_name);
            fs::write(&file_path, serialize_note_to_file(&note))
                .map_err(|e| format!("Failed to write note file {:?}: {}", file_path, e))?;
            migrated += 1;
        }
    }

    // Copy legacy assets (app_data_dir/notes/assets/*) into vault/assets.
    let legacy_assets_dir = app_data_dir().join("notes").join("assets");
    if legacy_assets_dir.is_dir() {
        let vault_assets_dir = vault.join("assets");
        fs::create_dir_all(&vault_assets_dir)
            .map_err(|e| format!("Failed to create vault assets dir: {}", e))?;
        if let Ok(entries) = fs::read_dir(&legacy_assets_dir) {
            for entry in entries.flatten() {
                let from = entry.path();
                if from.is_file() {
                    let to = vault_assets_dir.join(entry.file_name());
                    let _ = fs::copy(&from, &to);
                }
            }
        }
    }

    // Write vault.json with the migrated active pointers + transformations,
    // so the UI restores the user's last selection.
    let vault_meta = VaultMeta {
        notebooks: notebook_names
            .values()
            .map(|name| (name.clone(), VaultNotebookMeta { knowledge_base_enabled: false }))
            .collect(),
        active_notebook_id,
        active_note_id,
        transformations: transformations_raw
            .and_then(|raw| serde_json::from_str::<Vec<NoteTransformation>>(&raw).ok())
            .unwrap_or_default(),
    };
    let _ = write_vault_meta(vault, &vault_meta);

    // Finally drop the legacy tables we no longer use.
    drop_legacy_tables(&conn)?;

    Ok(Some(migrated))
}

fn walkdir_md_count(dir: &Path) -> Result<usize, String> {
    let mut count = 0usize;
    let stack = vec![dir.to_path_buf()];
    let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut queue = stack;
    while let Some(cur) = queue.pop() {
        if !visited.insert(cur.clone()) {
            continue;
        }
        let entries = match fs::read_dir(&cur) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name == ".mona" || name == "assets" {
                    continue;
                }
                queue.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                count += 1;
            }
        }
    }
    Ok(count)
}

fn read_legacy_state_value(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_state WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn drop_legacy_tables(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS notes_fts_insert;
         DROP TRIGGER IF EXISTS notes_fts_update;
         DROP TRIGGER IF EXISTS notes_fts_delete;
         DROP TABLE IF EXISTS notes_fts;
         DROP TABLE IF EXISTS notes;
         DROP TABLE IF EXISTS notebooks;
         DROP TABLE IF EXISTS app_state;",
    )
    .map_err(|e| format!("Failed to drop legacy tables: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn notes_vault_pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("选择笔记仓库")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let result = rx.recv().map_err(|e| e.to_string())?;
    Ok(result
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string()))
}

// ---------------------------------------------------------------------------
// YAML frontmatter parsing / serialization (hand-written, no serde_yaml)
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct ParsedFrontmatter {
    id: Option<String>,
    notebook_id: Option<String>,
    title: Option<String>,
    source_kind: Option<String>,
    source_label: Option<String>,
    tags: Vec<String>,
    context_level: Option<String>,
    agent_chat_id: Option<String>,
    applied_agent_message_ids: Vec<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    /// Note type: "note" (default) | "moc" | "daily" | "template" | "agent-experience".
    note_type: Option<String>,
    /// Aliases used for [[wiki link]] matching besides the title.
    aliases: Vec<String>,
}

/// Split a markdown file into (frontmatter lines, body). If the file does not
/// start with a `---` frontmatter block, returns (None, full content).
fn split_frontmatter(content: &str) -> (Option<Vec<String>>, String) {
    let mut lines = content.lines();
    let first = match lines.next() {
        Some(l) => l,
        None => return (None, String::new()),
    };
    if first.trim_end() != "---" {
        return (None, content.to_string());
    }

    let mut fm_lines: Vec<String> = Vec::new();
    let mut body_lines: Vec<String> = Vec::new();
    let mut found_close = false;
    for line in lines {
        if !found_close {
            if line.trim_end() == "---" {
                found_close = true;
            } else {
                fm_lines.push(line.to_string());
            }
        } else {
            body_lines.push(line.to_string());
        }
    }

    if !found_close {
        return (None, content.to_string());
    }

    let body = body_lines.join("\n").trim_start_matches(['\n', '\r']).to_string();
    (Some(fm_lines), body)
}

fn yaml_value(raw: &str) -> String {
    let v = raw.trim();
    if v.len() >= 2 {
        let b = v.as_bytes();
        if (b[0] == b'"' && b[b.len() - 1] == b'"') || (b[0] == b'\'' && b[b.len() - 1] == b'\'') {
            return v[1..v.len() - 1].to_string();
        }
    }
    v.to_string()
}

fn split_kv(line: &str) -> Option<(&str, &str)> {
    let colon = line.find(':')?;
    Some((line[..colon].trim(), line[colon + 1..].trim()))
}

fn parse_inline_array(value: &str) -> Option<Vec<String>> {
    let v = value.trim();
    if !(v.starts_with('[') && v.ends_with(']')) {
        return None;
    }
    let inner = &v[1..v.len() - 1];
    let mut out = Vec::new();
    for item in inner.split(',') {
        let t = yaml_value(item);
        if !t.is_empty() {
            out.push(t);
        }
    }
    Some(out)
}

fn parse_frontmatter_lines(lines: &[String]) -> ParsedFrontmatter {
    let mut fm = ParsedFrontmatter::default();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].as_str();
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        let (key, value) = match split_kv(line) {
            Some(kv) => kv,
            None => {
                i += 1;
                continue;
            }
        };
        match key {
            "id" => fm.id = Some(yaml_value(value)),
            "notebookId" => fm.notebook_id = Some(yaml_value(value)),
            "title" => fm.title = Some(yaml_value(value)),
            "contextLevel" => fm.context_level = Some(yaml_value(value)),
            "agentChatId" => {
                let v = yaml_value(value);
                fm.agent_chat_id = if v.is_empty() || v == "null" || v == "~" {
                    None
                } else {
                    Some(v)
                };
            }
            "createdAt" => fm.created_at = Some(yaml_value(value)),
            "updatedAt" => fm.updated_at = Some(yaml_value(value)),
            "source" => {
                if value.is_empty() {
                    // Block-style nested object.
                    i += 1;
                    while i < lines.len() {
                        let sub = lines[i].as_str();
                        if !(sub.starts_with("  ") || sub.starts_with('\t')) {
                            break;
                        }
                        if let Some((k, v)) = split_kv(sub.trim_start()) {
                            match k {
                                "kind" => fm.source_kind = Some(yaml_value(v)),
                                "label" => fm.source_label = Some(yaml_value(v)),
                                _ => {}
                            }
                        }
                        i += 1;
                    }
                    continue;
                } else if value.starts_with('{') {
                    // Inline flow object: {kind: manual, label: 手动记录}
                    let v = value.trim();
                    if v.ends_with('}') && v.len() >= 2 {
                        let inner = &v[1..v.len() - 1];
                        for pair in inner.split(',') {
                            if let Some((k, v)) = split_kv(pair.trim()) {
                                match k {
                                    "kind" => fm.source_kind = Some(yaml_value(v)),
                                    "label" => fm.source_label = Some(yaml_value(v)),
                                    _ => {}
                                }
                            }
                        }
                    }
                }
            }
            "tags" | "appliedAgentMessageIds" | "aliases" => {
                let target = match key {
                    "tags" => &mut fm.tags,
                    "aliases" => &mut fm.aliases,
                    _ => &mut fm.applied_agent_message_ids,
                };
                if let Some(items) = parse_inline_array(value) {
                    target.extend(items);
                    i += 1;
                    continue;
                }
                // Block-style array.
                i += 1;
                while i < lines.len() {
                    let sub = lines[i].as_str();
                    let trimmed = sub.trim_start();
                    if !(trimmed.starts_with("- ") || trimmed == "-") {
                        break;
                    }
                    let item = if trimmed.len() > 1 {
                        yaml_value(&trimmed[1..].trim())
                    } else {
                        String::new()
                    };
                    target.push(item);
                    i += 1;
                }
                continue;
            }
            "type" => fm.note_type = Some(yaml_value(value)),
            _ => {}
        }
        i += 1;
    }
    fm
}

/// Quote a scalar for YAML output when it contains characters that would
/// otherwise be ambiguous.
fn yaml_scalar(s: &str) -> String {
    let needs_quote = s.is_empty()
        || s.contains(':')
        || s.contains('#')
        || s.contains('\n')
        || s.contains('"')
        || s.contains('\'')
        || s.trim_start().starts_with('-')
        || s.trim_start().starts_with('[')
        || s.trim_start().starts_with('{')
        || s.trim() != s
        || s == "null"
        || s == "~"
        || s == "true"
        || s == "false";
    if needs_quote {
        let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{}\"", escaped)
    } else {
        s.to_string()
    }
}

fn serialize_frontmatter(note: &OperationNote) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("id: {}\n", yaml_scalar(&note.id)));
    out.push_str(&format!("notebookId: {}\n", yaml_scalar(&note.notebook_id)));
    out.push_str(&format!("title: {}\n", yaml_scalar(&note.title)));
    out.push_str("source:\n");
    out.push_str(&format!("  kind: {}\n", yaml_scalar(&note.source.kind)));
    out.push_str(&format!("  label: {}\n", yaml_scalar(&note.source.label)));
    if note.tags.is_empty() {
        out.push_str("tags: []\n");
    } else {
        out.push_str("tags:\n");
        for tag in &note.tags {
            out.push_str(&format!("  - {}\n", yaml_scalar(tag)));
        }
    }
    out.push_str(&format!(
        "contextLevel: {}\n",
        yaml_scalar(if note.context_level.is_empty() {
            "full"
        } else {
            &note.context_level
        })
    ));
    match &note.agent_chat_id {
        Some(c) => out.push_str(&format!("agentChatId: {}\n", yaml_scalar(c))),
        None => out.push_str("agentChatId:\n"),
    }
    if note.applied_agent_message_ids.is_empty() {
        out.push_str("appliedAgentMessageIds: []\n");
    } else {
        out.push_str("appliedAgentMessageIds:\n");
        for id in &note.applied_agent_message_ids {
            out.push_str(&format!("  - {}\n", yaml_scalar(id)));
        }
    }
    out.push_str(&format!("createdAt: {}\n", yaml_scalar(&note.created_at)));
    out.push_str(&format!("updatedAt: {}\n", yaml_scalar(&note.updated_at)));
    if !note.aliases.is_empty() {
        out.push_str("aliases:\n");
        for alias in &note.aliases {
            out.push_str(&format!("  - {}\n", yaml_scalar(alias)));
        }
    }
    // Only write `type:` when non-default, to keep legacy files minimal.
    if !note.note_type.is_empty() && note.note_type != "note" {
        out.push_str(&format!("type: {}\n", yaml_scalar(&note.note_type)));
    }
    out.push_str("---\n");
    out
}

fn serialize_note_to_file(note: &OperationNote) -> String {
    let mut out = serialize_frontmatter(note);
    out.push('\n');
    out.push_str(&note.content_markdown);
    out
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

fn strip_markdown(md: &str) -> String {
    let mut result = String::new();
    let mut in_code_block = false;
    for line in md.lines() {
        if line.trim_start().starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            result.push_str(line);
            result.push(' ');
            continue;
        }
        let stripped: String = line
            .chars()
            .filter(|&c| !matches!(c, '#' | '*' | '_' | '`' | '>' | '|' | '[' | ']' | '(' | ')'))
            .collect();
        result.push_str(&stripped);
        result.push(' ');
    }
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn make_preview(content: &str) -> String {
    strip_markdown(content).chars().take(46).collect()
}

/// Remove filesystem-illegal characters and truncate to 80 chars.
fn sanitize_filename(title: &str) -> String {
    let sanitized: String = title
        .chars()
        .filter(|&c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let trimmed = sanitized.trim();
    let result: String = trimmed.chars().take(80).collect();
    if result.is_empty() {
        "untitled".to_string()
    } else {
        result
    }
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

fn make_snippet(content: &str, query: &str) -> String {
    let lower = content.to_lowercase();
    let q = query.to_lowercase();
    if let Some(pos) = lower.find(&q) {
        let start = floor_char_boundary(&lower, pos.saturating_sub(64));
        let end = ceil_char_boundary(&lower, (pos + q.len() + 64).min(lower.len()));
        let mut snippet = String::new();
        if start > 0 {
            snippet.push_str("...");
        }
        snippet.push_str(&content[start..end]);
        if end < content.len() {
            snippet.push_str("...");
        }
        snippet
    } else {
        content.chars().take(128).collect()
    }
}

fn collect_asset_refs(md: &str, set: &mut HashSet<String>) {
    let mut start = 0;
    while let Some(pos) = md[start..].find("assets/") {
        let abs = start + pos;
        let rest = &md[abs + "assets/".len()..];
        let end = rest
            .char_indices()
            .take_while(|(i, c)| {
                (*i == 0 && c.is_alphanumeric())
                    || (*i > 0 && (c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_'))
            })
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        let name = &rest[..end];
        if !name.is_empty() && name.contains('.') {
            set.insert(name.to_string());
        }
        start = abs + "assets/".len();
    }
}

// ---------------------------------------------------------------------------
// Vault scanning
// ---------------------------------------------------------------------------

pub(crate) fn is_notebook_folder(name: &str) -> bool {
    name != ".mona" && name != "assets"
}

pub(crate) fn parse_note_file(path: &Path, notebook_name: &str) -> Result<OperationNote, String> {
    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read note {:?}: {}", path, e))?;
    let (fm_opt, body) = split_frontmatter(&content);
    let fm = fm_opt
        .as_ref()
        .map(|lines| parse_frontmatter_lines(lines))
        .unwrap_or_default();

    let file_stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled")
        .to_string();

    let id = fm.id.unwrap_or_else(|| file_stem.clone());
    let title = fm.title.unwrap_or_else(|| file_stem.clone());
    let notebook_id = fm
        .notebook_id
        .unwrap_or_else(|| notebook_name.to_string());
    let source = NoteSource {
        kind: fm.source_kind.unwrap_or_else(|| "manual".to_string()),
        label: fm.source_label.unwrap_or_else(|| "手动记录".to_string()),
    };
    let context_level = fm.context_level.unwrap_or_else(|| "full".to_string());
    let agent_chat_id = fm.agent_chat_id.filter(|s| !s.is_empty());
    let created_at = fm.created_at.clone().unwrap_or_default();
    let updated_at = fm.updated_at.or(fm.created_at).unwrap_or_default();

    Ok(OperationNote {
        id,
        notebook_id,
        title,
        preview: make_preview(&body),
        created_at,
        updated_at,
        source,
        tags: fm.tags,
        content_markdown: body.clone(),
        content_json: None,
        plain_text: Some(strip_markdown(&body)),
        agent_chat_id,
        applied_agent_message_ids: fm.applied_agent_message_ids,
        context_level,
        note_type: fm.note_type.unwrap_or_else(default_note_type),
        aliases: fm.aliases,
    })
}

/// Scan a vault directory into notebooks and notes.
///
/// The vault root is treated as a special "root" notebook with id=""
/// (empty string). Notes placed directly in the vault root have
/// notebook_id = "". Subdirectories become regular notebooks.
fn scan_vault(
    vault: &Path,
    meta: &VaultMeta,
) -> Result<(Vec<Notebook>, Vec<OperationNote>), String> {
    let mut notebooks = Vec::new();
    let mut notes = Vec::new();

    // Scan root-level .md files (notebook_id = "") — these live directly in the
    // vault and are not wrapped in any notebook.
    if let Ok(root_entries) = fs::read_dir(vault) {
        for entry in root_entries.flatten() {
            let md_path = entry.path();
            if md_path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            match parse_note_file(&md_path, "") {
                Ok(note) => notes.push(note),
                Err(e) => log::warn!("Failed to parse note {:?}: {}", md_path, e),
            }
        }
    }

    // Scan subdirectories as notebooks.
    let entries = fs::read_dir(vault).map_err(|e| format!("Failed to read vault: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !is_notebook_folder(&name) {
            continue;
        }

        let knowledge_base_enabled = meta
            .notebooks
            .get(&name)
            .map(|m| m.knowledge_base_enabled)
            .unwrap_or(false);
        notebooks.push(Notebook {
            id: name.clone(),
            name: name.clone(),
            description: String::new(),
            knowledge_base_enabled,
        });

        if let Ok(md_entries) = fs::read_dir(&path) {
            for md_entry in md_entries.flatten() {
                let md_path = md_entry.path();
                if md_path.extension().and_then(|e| e.to_str()) != Some("md") {
                    continue;
                }
                match parse_note_file(&md_path, &name) {
                    Ok(note) => notes.push(note),
                    Err(e) => log::warn!("Failed to parse note {:?}: {}", md_path, e),
                }
            }
        }
    }

    notes.sort_by(|a, b| a.title.cmp(&b.title));
    Ok((notebooks, notes))
}

fn scan_vault_notes(vault: &Path) -> Result<Vec<OperationNote>, String> {
    let meta = read_vault_meta(vault)?;
    let (_, notes) = scan_vault(vault, &meta)?;
    Ok(notes)
}

/// Build a map of note id -> existing .md file path across the vault,
/// including both root-level .md files and those inside notebook folders.
fn scan_existing_note_files(vault: &Path) -> Result<HashMap<String, PathBuf>, String> {
    let mut map = HashMap::new();

    // Helper: register a single .md file by its frontmatter id.
    let mut register = |md_path: &Path| {
        if let Ok(content) = fs::read_to_string(md_path) {
            let (fm_opt, _) = split_frontmatter(&content);
            let id = fm_opt
                .as_ref()
                .and_then(|lines| parse_frontmatter_lines(lines).id)
                .unwrap_or_else(|| {
                    md_path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("untitled")
                        .to_string()
                });
            map.insert(id, md_path.to_path_buf());
        }
    };

    let entries = fs::read_dir(vault).map_err(|e| format!("Failed to read vault: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            // Root-level .md file
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                register(&path);
            }
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !is_notebook_folder(&name) {
            continue;
        }
        if let Ok(md_entries) = fs::read_dir(&path) {
            for md_entry in md_entries.flatten() {
                let md_path = md_entry.path();
                if md_path.extension().and_then(|e| e.to_str()) == Some("md") {
                    register(&md_path);
                }
            }
        }
    }
    Ok(map)
}

// ---------------------------------------------------------------------------
// State load / save
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn notes_load_state() -> Result<NotesState, String> {
    let vault_path = read_vault_path();
    let vault_meta = match &vault_path {
        Some(vault) => read_vault_meta(vault).unwrap_or_default(),
        None => VaultMeta::default(),
    };

    let (notebooks, notes) = match &vault_path {
        Some(vault) => scan_vault(vault, &vault_meta)?,
        None => (Vec::new(), Vec::new()),
    };

    let default_notebook_id = notebooks
        .first()
        .map(|n| n.id.clone())
        .unwrap_or_default();
    let active_notebook_id = if vault_meta.active_notebook_id.is_empty() {
        default_notebook_id
    } else if notebooks.iter().any(|n| n.id == vault_meta.active_notebook_id) {
        vault_meta.active_notebook_id.clone()
    } else {
        default_notebook_id
    };
    let active_note_id = vault_meta
        .active_note_id
        .as_deref()
        .filter(|id| notes.iter().any(|n| n.id == *id))
        .map(|s| s.to_string())
        .or_else(|| {
            notes
                .iter()
                .find(|n| n.notebook_id == active_notebook_id)
                .map(|n| n.id.clone())
        });

    Ok(NotesState {
        notebooks,
        notes,
        active_notebook_id,
        active_note_id,
        transformations: vault_meta.transformations,
    })
}

#[tauri::command]
pub async fn notes_save_state(state: NotesState) -> Result<(), String> {
    validate_state(&state)?;

    let vault = match read_vault_path() {
        Some(p) => p,
        None => return Ok(()),
    };

    let notebook_name_by_id: HashMap<String, String> = state
        .notebooks
        .iter()
        .map(|n| (n.id.clone(), n.name.clone()))
        .collect();

    // Ensure every non-root notebook in state has a corresponding folder.
    // The root notebook (id="") maps to the vault itself — no folder to create.
    for notebook in &state.notebooks {
        if notebook.id.is_empty() {
            continue;
        }
        fs::create_dir_all(vault.join(&notebook.name))
            .map_err(|e| format!("Failed to create notebook folder: {}", e))?;
    }

    // Map existing files by note id so we can detect renames and orphans.
    let mut files_by_id = scan_existing_note_files(&vault)?;
    let mut path_to_id: HashMap<PathBuf, String> = files_by_id
        .iter()
        .map(|(id, p)| (p.clone(), id.clone()))
        .collect();

    let state_note_ids: HashSet<String> =
        state.notes.iter().map(|n| n.id.clone()).collect();

    for note in &state.notes {
        // notebook_id = "" → vault root; otherwise → subdirectory by notebook name.
        let notebook_dir = if note.notebook_id.is_empty() {
            vault.to_path_buf()
        } else {
            let notebook_name = notebook_name_by_id
                .get(&note.notebook_id)
                .cloned()
                .unwrap_or_else(|| note.notebook_id.clone());
            let dir = vault.join(&notebook_name);
            fs::create_dir_all(&dir)
                .map_err(|e| format!("Failed to create notebook folder: {}", e))?;
            dir
        };

        let base = sanitize_filename(&note.title);
        let mut filename = format!("{}.md", base);
        let mut file_path = notebook_dir.join(&filename);

        // Resolve collisions with files belonging to a different note.
        let mut guard = 0;
        loop {
            let occupied_by_other = path_to_id
                .get(&file_path)
                .map(|id| id != &note.id)
                .unwrap_or(false);
            if !occupied_by_other {
                break;
            }
            guard += 1;
            let suffix_source = if note.id.len() >= 6 {
                &note.id[note.id.len() - 6..]
            } else {
                &note.id
            };
            filename = format!("{}_{}.md", base, if guard == 1 {
                suffix_source.to_string()
            } else {
                format!("{}{}", suffix_source, guard)
            });
            file_path = notebook_dir.join(&filename);
            if guard > 32 {
                break;
            }
        }

        // Remove the note's previous file if its path changed.
        if let Some(old_path) = files_by_id.get(&note.id) {
            if *old_path != file_path {
                let _ = fs::remove_file(old_path);
                path_to_id.remove(old_path);
            }
        }

        let content = serialize_note_to_file(note);
        fs::write(&file_path, content)
            .map_err(|e| format!("Failed to write note {:?}: {}", file_path, e))?;
        path_to_id.insert(file_path.clone(), note.id.clone());
        files_by_id.insert(note.id.clone(), file_path);
    }

    // Delete orphan .md files (whose note id is no longer in state).
    for (id, path) in &files_by_id {
        if !state_note_ids.contains(id) {
            let _ = fs::remove_file(path);
        }
    }

    // Remove notebook folders that are no longer in state and are empty.
    // (save_state already deleted orphan .md files, so a removed notebook's
    // folder should be empty now; only remove if empty to avoid data loss.)
    let state_notebook_names: HashSet<String> = state
        .notebooks
        .iter()
        .map(|n| n.name.clone())
        .collect();
    if let Ok(entries) = fs::read_dir(&vault) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !is_notebook_folder(&name) {
                continue;
            }
            if state_notebook_names.contains(&name) {
                continue;
            }
            // Only remove if the folder is empty (no .md files left).
            let has_md = fs::read_dir(&path)
                .ok()
                .map(|it| {
                    it.flatten()
                        .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
                })
                .unwrap_or(false);
            if !has_md {
                let _ = fs::remove_dir(&path);
            }
        }
    }

    // Persist vault metadata.
    let meta = VaultMeta {
        notebooks: state
            .notebooks
            .iter()
            .map(|n| {
                (
                    n.name.clone(),
                    VaultNotebookMeta {
                        knowledge_base_enabled: n.knowledge_base_enabled,
                    },
                )
            })
            .collect(),
        active_notebook_id: state.active_notebook_id.clone(),
        active_note_id: state.active_note_id.clone(),
        transformations: state.transformations.clone(),
    };
    write_vault_meta(&vault, &meta)?;

    // Clean up orphan images.
    cleanup_orphaned_assets_vault(&vault, &state.notes)?;

    Ok(())
}

fn validate_state(state: &NotesState) -> Result<(), String> {
    let mut notebook_ids: HashSet<&str> = HashSet::new();
    for notebook in &state.notebooks {
        if notebook.id.trim().is_empty() || notebook.name.trim().is_empty() {
            return Err("Notebook id and name are required".to_string());
        }
        if !notebook_ids.insert(notebook.id.as_str()) {
            return Err(format!("Duplicate notebook id: {}", notebook.id));
        }
    }

    if !state.notebooks.is_empty() && !state.active_notebook_id.is_empty() {
        if !notebook_ids.contains(state.active_notebook_id.as_str()) {
            return Err("Active notebook does not exist".to_string());
        }
    }

    let mut note_ids: HashSet<&str> = HashSet::new();
    for note in &state.notes {
        if note.id.trim().is_empty() {
            return Err("Note id is required".to_string());
        }
        // notebook_id = "" means the note lives in the vault root — allowed
        // even though no notebook with id="" exists in `notebooks`.
        if !note.notebook_id.is_empty()
            && !notebook_ids.is_empty()
            && !notebook_ids.contains(note.notebook_id.as_str())
        {
            return Err(format!("Note references missing notebook: {}", note.id));
        }
        if !note_ids.insert(note.id.as_str()) {
            return Err(format!("Duplicate note id: {}", note.id));
        }
    }

    if let Some(active_note_id) = &state.active_note_id {
        if !active_note_id.is_empty() && !note_ids.contains(active_note_id.as_str()) {
            return Err("Active note does not exist".to_string());
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Create from chat
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn notes_create_from_chat(
    title: String,
    content_markdown: String,
    notebook_id: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<String, String> {
    let vault = read_vault_path()
        .ok_or_else(|| "Notes vault is not configured".to_string())?;

    // notebook_id = None or "" → vault root; otherwise → subdirectory.
    let folder_name = notebook_id.unwrap_or_default();
    let notebook_dir = if folder_name.is_empty() {
        vault.to_path_buf()
    } else {
        let dir = vault.join(&folder_name);
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create notebook folder: {}", e))?;
        dir
    };

    let note_id = format!("note-{}", uuid::Uuid::new_v4());
    let now_iso = chrono::Utc::now().to_rfc3339();
    let note = OperationNote {
        id: note_id.clone(),
        notebook_id: folder_name,
        title: title.clone(),
        preview: make_preview(&content_markdown),
        created_at: now_iso.clone(),
        updated_at: now_iso,
        source: NoteSource {
            kind: "agent".to_string(),
            label: "聊天保存".to_string(),
        },
        tags: tags.unwrap_or_default(),
        content_markdown,
        content_json: None,
        plain_text: None,
        agent_chat_id: None,
        applied_agent_message_ids: Vec::new(),
        context_level: "full".to_string(),
        note_type: default_note_type(),
        aliases: Vec::new(),
    };

    let base = sanitize_filename(&title);
    let mut filename = format!("{}.md", base);
    let mut file_path = notebook_dir.join(&filename);
    let mut counter = 1;
    while file_path.exists() {
        filename = format!("{}_{}.md", base, counter);
        file_path = notebook_dir.join(&filename);
        counter += 1;
    }

    fs::write(&file_path, serialize_note_to_file(&note))
        .map_err(|e| format!("Failed to write note: {}", e))?;

    Ok(note_id)
}

// ---------------------------------------------------------------------------
// Read note content (for agent tools)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub note_id: String,
    pub title: String,
    pub content_markdown: String,
    pub tags: Vec<String>,
    pub notebook_id: String,
    pub notebook_name: String,
    pub updated_at: String,
    pub context_level: String,
}

#[tauri::command]
pub async fn notes_read_note_content(note_id: String) -> Result<NoteContent, String> {
    let vault = read_vault_path()
        .ok_or_else(|| "Notes vault is not configured".to_string())?;

    let notes = scan_vault_notes(&vault)?;
    let note = notes
        .iter()
        .find(|n| n.id == note_id)
        .ok_or_else(|| format!("Note not found: {}", note_id))?;

    let context_level = if note.context_level.is_empty() {
        "full".to_string()
    } else {
        note.context_level.clone()
    };

    if context_level == "none" {
        return Err(format!(
            "Note {} is marked as not participating in retrieval (contextLevel=none)",
            note_id
        ));
    }

    let content_markdown = if context_level == "summary" {
        note.preview.clone()
    } else {
        note.content_markdown.clone()
    };

    Ok(NoteContent {
        note_id: note.id.clone(),
        title: note.title.clone(),
        content_markdown,
        tags: note.tags.clone(),
        notebook_id: note.notebook_id.clone(),
        notebook_name: note.notebook_id.clone(),
        updated_at: note.updated_at.clone(),
        context_level,
    })
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSearchResult {
    pub note_id: String,
    pub title: String,
    pub snippet: String,
    pub rank: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notebook_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notebook_name: Option<String>,
}

fn search_notes_in_memory(
    notes: &[OperationNote],
    notebook_filter: Option<&str>,
    query: &str,
    limit: usize,
) -> Vec<NoteSearchResult> {
    let q = query.to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut results = Vec::new();
    for note in notes {
        if let Some(nb) = notebook_filter {
            if note.notebook_id != nb {
                continue;
            }
        }
        let title_l = note.title.to_lowercase();
        let content_l = note.content_markdown.to_lowercase();
        let tags_l = note.tags.join(" ").to_lowercase();
        if title_l.contains(&q) || content_l.contains(&q) || tags_l.contains(&q) {
            results.push(NoteSearchResult {
                note_id: note.id.clone(),
                title: note.title.clone(),
                snippet: make_snippet(&note.content_markdown, query),
                rank: 0.0,
                notebook_id: Some(note.notebook_id.clone()),
                notebook_name: Some(note.notebook_id.clone()),
            });
        }
    }

    results = apply_context_levels_mem(results, notes);
    results.truncate(limit);
    results
}

fn apply_context_levels_mem(
    results: Vec<NoteSearchResult>,
    notes: &[OperationNote],
) -> Vec<NoteSearchResult> {
    let map: HashMap<&str, &OperationNote> =
        notes.iter().map(|n| (n.id.as_str(), n)).collect();
    results
        .into_iter()
        .filter_map(|result| {
            let note = map.get(result.note_id.as_str())?;
            match note.context_level.as_str() {
                "none" => None,
                "summary" => Some(NoteSearchResult {
                    snippet: if note.preview.is_empty() {
                        result.snippet
                    } else {
                        note.preview.clone()
                    },
                    ..result
                }),
                _ => Some(result),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn notes_search(
    notebook_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<NoteSearchResult>, String> {
    let vault = match read_vault_path() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let notes = scan_vault_notes(&vault)?;
    Ok(search_notes_in_memory(
        &notes,
        Some(&notebook_id),
        &query,
        limit.unwrap_or(5),
    ))
}

#[tauri::command]
pub async fn notes_search_all(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<NoteSearchResult>, String> {
    let vault = match read_vault_path() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let notes = scan_vault_notes(&vault)?;
    Ok(search_notes_in_memory(
        &notes,
        None,
        &query,
        limit.unwrap_or(20),
    ))
}

// ---------------------------------------------------------------------------
// Export / images
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn notes_export_temp(note_id: String, content: String) -> Result<String, String> {
    let workspace = read_workspace_path_from_config();
    let tmp_dir = workspace.join(".mona").join("tmp").join("notes");
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let file_path = tmp_dir.join(format!("{}.md", note_id));
    fs::write(&file_path, &content).map_err(|e| format!("Failed to write temp file: {}", e))?;

    Ok(format!(".mona/tmp/notes/{}.md", note_id))
}

/// Resolve the assets directory. Prefers the vault's `assets/` folder; falls
/// back to the legacy app-data location when no vault is configured.
fn assets_dir_create() -> Result<PathBuf, String> {
    let dir = match read_vault_path() {
        Some(vault) => vault.join("assets"),
        None => app_data_dir().join("notes").join("assets"),
    };
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create notes assets dir: {}", e))?;
    Ok(dir)
}

fn cleanup_orphaned_assets_vault(vault: &Path, notes: &[OperationNote]) -> Result<(), String> {
    let assets_dir = vault.join("assets");
    if !assets_dir.exists() {
        return Ok(());
    }

    let mut referenced = HashSet::new();
    for note in notes {
        collect_asset_refs(&note.content_markdown, &mut referenced);
    }

    let entries = fs::read_dir(&assets_dir)
        .map_err(|e| format!("Failed to read assets dir: {}", e))?;
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            if !referenced.contains(name) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn notes_save_image(
    file_path: String,
    file_name: Option<String>,
) -> Result<String, String> {
    let src = PathBuf::from(&file_path);
    if !src.exists() {
        return Err(format!("Source image not found: {}", file_path));
    }

    let final_name = file_name
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.trim().to_string())
        .or_else(|| {
            src.file_name().and_then(|n| n.to_str()).map(|n| n.to_string())
        })
        .ok_or_else(|| "Cannot derive file name from path".to_string())?;

    let assets_dir = assets_dir_create()?;
    let dest = assets_dir.join(&final_name);
    fs::copy(&src, &dest).map_err(|e| format!("Failed to copy image to assets: {}", e))?;

    Ok(format!("assets/{}", final_name))
}

#[tauri::command]
pub async fn notes_get_assets_dir() -> Result<String, String> {
    let assets_dir = assets_dir_create()?;
    Ok(assets_dir.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Workspace path (used by notes_export_temp and ipc_bridge)
// ---------------------------------------------------------------------------

pub fn read_workspace_path_from_config() -> PathBuf {
    let config_path = crate::settings::mona_config_path();
    if !config_path.exists() {
        return dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".mona")
            .join("workspace");
    }
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => {
            return dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".mona")
                .join("workspace")
        }
    };
    let config: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => {
            return dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".mona")
                .join("workspace")
        }
    };
    config
        .get("workspace")
        .and_then(|w| w.as_str())
        .map(|w| PathBuf::from(w).expand_tilde())
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".mona")
                .join("workspace")
        })
}

trait PathExt {
    fn expand_tilde(self) -> PathBuf;
}

impl PathExt for PathBuf {
    fn expand_tilde(self) -> PathBuf {
        if let Ok(rest) = self.strip_prefix("~") {
            dirs::home_dir().map(|home| home.join(rest)).unwrap_or(self)
        } else {
            self
        }
    }
}
