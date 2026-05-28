use crate::settings::app_data_dir;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

const NOTES_DB_FILE: &str = "notes.sqlite3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesState {
    pub notebooks: Vec<Notebook>,
    pub notes: Vec<OperationNote>,
    #[serde(default)]
    pub knowledge_categories: Vec<KnowledgeCategory>,
    #[serde(default)]
    pub knowledge_items: Vec<KnowledgeItem>,
    pub active_notebook_id: String,
    pub active_note_id: Option<String>,
    #[serde(default)]
    pub active_knowledge_category_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub id: String,
    pub name: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteSource {
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCategory {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeItem {
    pub id: String,
    pub category_id: String,
    pub title: String,
    pub summary: String,
    pub content: String,
    pub source_note_id: String,
    pub source_note_title: String,
    pub source_description: String,
    pub updated_at: String,
    pub tags: Vec<String>,
    #[serde(default)]
    pub linked_notes: Vec<KnowledgeLinkedNote>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeLinkedNote {
    pub note_id: String,
    pub note_title: String,
    pub description: String,
    pub linked_at: String,
}

fn notes_db_path() -> PathBuf {
    app_data_dir().join("notes").join(NOTES_DB_FILE)
}

fn open_notes_db() -> Result<Connection, String> {
    let path = notes_db_path();
    let parent = path.parent().ok_or("Invalid notes database path")?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create notes dir: {}", e))?;

    let conn = Connection::open(&path).map_err(|e| format!("Failed to open notes database: {}", e))?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| format!("Failed to enable notes foreign keys: {}", e))?;
    initialize_schema(&conn)?;
    seed_default_notebooks(&conn)?;
    seed_default_knowledge_categories(&conn)?;
    Ok(conn)
}

fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS notebooks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            knowledge_base_enabled INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            notebook_id TEXT NOT NULL,
            title TEXT NOT NULL,
            preview TEXT NOT NULL,
            updated_at_label TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_label TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            content_markdown TEXT NOT NULL,
            content_json TEXT,
            plain_text TEXT,
            agent_chat_id TEXT,
            applied_agent_message_ids_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            modified_at TEXT NOT NULL,
            FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            parent_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_items (
            id TEXT PRIMARY KEY,
            category_id TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            content TEXT NOT NULL,
            source_note_id TEXT NOT NULL,
            source_note_title TEXT NOT NULL,
            source_description TEXT NOT NULL,
            updated_at_label TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            linked_notes_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            modified_at TEXT NOT NULL,
            FOREIGN KEY (category_id) REFERENCES knowledge_categories(id) ON DELETE CASCADE
        );
        "#,
    )
    .map_err(|e| format!("Failed to initialize notes schema: {}", e))?;

    ensure_column(conn, "knowledge_categories", "parent_id", "TEXT")?;
    ensure_column(
        conn,
        "knowledge_items",
        "linked_notes_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )
}

fn ensure_column(
    conn: &Connection,
    table: &'static str,
    column: &'static str,
    definition: &'static str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| format!("Failed to inspect {} schema: {}", table, e))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to read {} schema: {}", table, e))?;
    let columns = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect {} schema: {}", table, e))?;

    if columns.iter().any(|name| name == column) {
        return Ok(());
    }

    conn.execute(
        &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, definition),
        [],
    )
    .map_err(|e| format!("Failed to add {}.{}: {}", table, column, e))?;
    Ok(())
}

fn seed_default_notebooks(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM notebooks", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count notebooks: {}", e))?;
    if count > 0 {
        return Ok(());
    }

    let now = chrono::Utc::now().to_rfc3339();
    let defaults = [
        (
            "default",
            "默认笔记本",
            "记录资料、想法、处理过程和 Agent 输出",
            true,
        ),
        (
            "work",
            "工作笔记",
            "记录项目、会议、任务和日常工作内容",
            false,
        ),
        (
            "personal",
            "个人笔记",
            "保存阅读摘录、灵感和临时记录",
            false,
        ),
    ];

    for (id, name, description, knowledge_base_enabled) in defaults {
        conn.execute(
            "INSERT INTO notebooks (id, name, description, knowledge_base_enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, description, bool_to_i64(knowledge_base_enabled), now],
        )
        .map_err(|e| format!("Failed to seed notebooks: {}", e))?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO app_state (key, value) VALUES ('activeNotebookId', 'default')",
        [],
    )
    .map_err(|e| format!("Failed to seed notes state: {}", e))?;

    Ok(())
}

fn seed_default_knowledge_categories(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM knowledge_categories", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count knowledge categories: {}", e))?;
    if count > 0 {
        return Ok(());
    }

    let now = chrono::Utc::now().to_rfc3339();
    let defaults = [("inbox", "未分类", None::<String>)];

    for (id, name, parent_id) in defaults {
        conn.execute(
            "INSERT INTO knowledge_categories (id, name, description, parent_id, created_at, updated_at)
             VALUES (?1, ?2, '', ?3, ?4, ?4)",
            params![id, name, parent_id, now],
        )
        .map_err(|e| format!("Failed to seed knowledge categories: {}", e))?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO app_state (key, value) VALUES ('activeKnowledgeCategoryId', 'inbox')",
        [],
    )
    .map_err(|e| format!("Failed to seed knowledge state: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn notes_load_state() -> Result<NotesState, String> {
    let conn = open_notes_db()?;
    let notebooks = load_notebooks(&conn)?;
    let notes = load_notes(&conn)?;
    let knowledge_categories = load_knowledge_categories(&conn)?;
    let knowledge_items = load_knowledge_items(&conn)?;
    let default_notebook_id = notebooks
        .first()
        .map(|notebook| notebook.id.clone())
        .ok_or("Notes database has no notebooks")?;
    let default_knowledge_category_id = knowledge_categories
        .first()
        .map(|category| category.id.clone())
        .ok_or("Notes database has no knowledge categories")?;
    let active_notebook_id = read_state_value(&conn, "activeNotebookId")?
        .filter(|id| notebooks.iter().any(|notebook| notebook.id == *id))
        .unwrap_or(default_notebook_id);
    let active_note_id = read_state_value(&conn, "activeNoteId")?
        .filter(|id| notes.iter().any(|note| note.id == *id))
        .or_else(|| {
            notes
                .iter()
                .find(|note| note.notebook_id == active_notebook_id)
                .map(|note| note.id.clone())
        });
    let active_knowledge_category_id = read_state_value(&conn, "activeKnowledgeCategoryId")?
        .filter(|id| {
            knowledge_categories
                .iter()
                .any(|category| category.id == *id)
        })
        .unwrap_or(default_knowledge_category_id);

    Ok(NotesState {
        notebooks,
        notes,
        knowledge_categories,
        knowledge_items,
        active_notebook_id,
        active_note_id,
        active_knowledge_category_id,
    })
}

#[tauri::command]
pub async fn notes_save_state(state: NotesState) -> Result<(), String> {
    validate_state(&state)?;

    let mut conn = open_notes_db()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start notes transaction: {}", e))?;

    tx.execute("DELETE FROM notes", [])
        .map_err(|e| format!("Failed to clear notes: {}", e))?;
    tx.execute("DELETE FROM notebooks", [])
        .map_err(|e| format!("Failed to clear notebooks: {}", e))?;
    tx.execute("DELETE FROM app_state", [])
        .map_err(|e| format!("Failed to clear notes state: {}", e))?;
    tx.execute("DELETE FROM knowledge_items", [])
        .map_err(|e| format!("Failed to clear knowledge items: {}", e))?;
    tx.execute("DELETE FROM knowledge_categories", [])
        .map_err(|e| format!("Failed to clear knowledge categories: {}", e))?;

    let now = chrono::Utc::now().to_rfc3339();
    for notebook in &state.notebooks {
        tx.execute(
            "INSERT INTO notebooks (id, name, description, knowledge_base_enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                &notebook.id,
                &notebook.name,
                &notebook.description,
                bool_to_i64(notebook.knowledge_base_enabled),
                &now,
            ],
        )
        .map_err(|e| format!("Failed to save notebook: {}", e))?;
    }

    for note in &state.notes {
        let tags_json = to_json_string(&note.tags)?;
        let content_json = note.content_json.as_ref().map(to_json_string).transpose()?;
        let applied_ids_json = to_json_string(&note.applied_agent_message_ids)?;
        tx.execute(
            "INSERT INTO notes (
                id, notebook_id, title, preview, updated_at_label, source_kind, source_label,
                tags_json, content_markdown, content_json, plain_text, agent_chat_id,
                applied_agent_message_ids_json, created_at, modified_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
            params![
                &note.id,
                &note.notebook_id,
                &note.title,
                &note.preview,
                &note.updated_at,
                &note.source.kind,
                &note.source.label,
                &tags_json,
                &note.content_markdown,
                &content_json,
                &note.plain_text,
                &note.agent_chat_id,
                &applied_ids_json,
                &now,
            ],
        )
        .map_err(|e| format!("Failed to save note: {}", e))?;
    }

    for category in &state.knowledge_categories {
        tx.execute(
            "INSERT INTO knowledge_categories (id, name, description, parent_id, created_at, updated_at)
             VALUES (?1, ?2, '', ?3, ?4, ?4)",
            params![&category.id, &category.name, &category.parent_id, &now],
        )
        .map_err(|e| format!("Failed to save knowledge category: {}", e))?;
    }

    for item in &state.knowledge_items {
        let tags_json = to_json_string(&item.tags)?;
        let linked_notes_json = to_json_string(&item.linked_notes)?;
        tx.execute(
            "INSERT INTO knowledge_items (
                id, category_id, title, summary, content, source_note_id, source_note_title,
                source_description, updated_at_label, tags_json, linked_notes_json, created_at, modified_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            params![
                &item.id,
                &item.category_id,
                &item.title,
                &item.summary,
                &item.content,
                &item.source_note_id,
                &item.source_note_title,
                &item.source_description,
                &item.updated_at,
                &tags_json,
                &linked_notes_json,
                &now,
            ],
        )
        .map_err(|e| format!("Failed to save knowledge item: {}", e))?;
    }

    tx.execute(
        "INSERT INTO app_state (key, value) VALUES ('activeNotebookId', ?1)",
        params![&state.active_notebook_id],
    )
    .map_err(|e| format!("Failed to save active notebook: {}", e))?;
    if let Some(active_note_id) = &state.active_note_id {
        tx.execute(
            "INSERT INTO app_state (key, value) VALUES ('activeNoteId', ?1)",
            params![active_note_id],
        )
            .map_err(|e| format!("Failed to save active note: {}", e))?;
    }
    tx.execute(
        "INSERT INTO app_state (key, value) VALUES ('activeKnowledgeCategoryId', ?1)",
        params![&state.active_knowledge_category_id],
    )
    .map_err(|e| format!("Failed to save active knowledge category: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit notes transaction: {}", e))
}

fn load_notebooks(conn: &Connection) -> Result<Vec<Notebook>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, knowledge_base_enabled
             FROM notebooks
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| format!("Failed to prepare notebooks query: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Notebook {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                knowledge_base_enabled: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|e| format!("Failed to query notebooks: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read notebooks: {}", e))
}

fn load_notes(conn: &Connection) -> Result<Vec<OperationNote>, String> {
    #[derive(Debug)]
    struct NoteRow {
        id: String,
        notebook_id: String,
        title: String,
        preview: String,
        updated_at: String,
        source_kind: String,
        source_label: String,
        tags_json: String,
        content_markdown: String,
        content_json: Option<String>,
        plain_text: Option<String>,
        agent_chat_id: Option<String>,
        applied_agent_message_ids_json: String,
    }

    let mut stmt = conn
        .prepare(
            "SELECT
                id, notebook_id, title, preview, updated_at_label, source_kind, source_label,
                tags_json, content_markdown, content_json, plain_text, agent_chat_id,
                applied_agent_message_ids_json
             FROM notes
             ORDER BY modified_at DESC, id ASC",
        )
        .map_err(|e| format!("Failed to prepare notes query: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(NoteRow {
                id: row.get(0)?,
                notebook_id: row.get(1)?,
                title: row.get(2)?,
                preview: row.get(3)?,
                updated_at: row.get(4)?,
                source_kind: row.get(5)?,
                source_label: row.get(6)?,
                tags_json: row.get(7)?,
                content_markdown: row.get(8)?,
                content_json: row.get(9)?,
                plain_text: row.get(10)?,
                agent_chat_id: row.get(11)?,
                applied_agent_message_ids_json: row.get(12)?,
            })
        })
        .map_err(|e| format!("Failed to query notes: {}", e))?;

    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read notes: {}", e))?;

    rows.into_iter()
        .map(|row| {
            let tags = parse_json_field(&row.tags_json, "tags_json")?;
            let content_json = row
                .content_json
                .as_deref()
                .map(|raw| parse_json_field::<Value>(raw, "content_json"))
                .transpose()?;
            let applied_agent_message_ids = parse_json_field(
                &row.applied_agent_message_ids_json,
                "applied_agent_message_ids_json",
            )?;

            Ok(OperationNote {
                id: row.id,
                notebook_id: row.notebook_id,
                title: row.title,
                preview: row.preview,
                updated_at: row.updated_at,
                source: NoteSource {
                    kind: row.source_kind,
                    label: row.source_label,
                },
                tags,
                content_markdown: row.content_markdown,
                content_json,
                plain_text: row.plain_text,
                agent_chat_id: row.agent_chat_id,
                applied_agent_message_ids,
            })
        })
        .collect()
}

fn load_knowledge_categories(conn: &Connection) -> Result<Vec<KnowledgeCategory>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, parent_id
             FROM knowledge_categories
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| format!("Failed to prepare knowledge categories query: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(KnowledgeCategory {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
            })
        })
        .map_err(|e| format!("Failed to query knowledge categories: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read knowledge categories: {}", e))
}

fn load_knowledge_items(conn: &Connection) -> Result<Vec<KnowledgeItem>, String> {
    #[derive(Debug)]
    struct KnowledgeItemRow {
        id: String,
        category_id: String,
        title: String,
        summary: String,
        content: String,
        source_note_id: String,
        source_note_title: String,
        source_description: String,
        updated_at: String,
        tags_json: String,
        linked_notes_json: String,
    }

    let mut stmt = conn
        .prepare(
            "SELECT
                id, category_id, title, summary, content, source_note_id, source_note_title,
                source_description, updated_at_label, tags_json, linked_notes_json
             FROM knowledge_items
             ORDER BY modified_at DESC, id ASC",
        )
        .map_err(|e| format!("Failed to prepare knowledge items query: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(KnowledgeItemRow {
                id: row.get(0)?,
                category_id: row.get(1)?,
                title: row.get(2)?,
                summary: row.get(3)?,
                content: row.get(4)?,
                source_note_id: row.get(5)?,
                source_note_title: row.get(6)?,
                source_description: row.get(7)?,
                updated_at: row.get(8)?,
                tags_json: row.get(9)?,
                linked_notes_json: row.get(10)?,
            })
        })
        .map_err(|e| format!("Failed to query knowledge items: {}", e))?;

    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read knowledge items: {}", e))?;

    rows.into_iter()
        .map(|row| {
            let tags = parse_json_field(&row.tags_json, "knowledge_tags_json")?;
            let linked_notes =
                parse_json_field(&row.linked_notes_json, "knowledge_linked_notes_json")?;
            Ok(KnowledgeItem {
                id: row.id,
                category_id: row.category_id,
                title: row.title,
                summary: row.summary,
                content: row.content,
                source_note_id: row.source_note_id,
                source_note_title: row.source_note_title,
                source_description: row.source_description,
                updated_at: row.updated_at,
                tags,
                linked_notes,
            })
        })
        .collect()
}

fn read_state_value(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value FROM app_state WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("Failed to read notes state {}: {}", key, e))
}

fn validate_state(state: &NotesState) -> Result<(), String> {
    if state.notebooks.is_empty() {
        return Err("Notes state must contain at least one notebook".to_string());
    }
    if state.knowledge_categories.is_empty() {
        return Err("Notes state must contain at least one knowledge category".to_string());
    }

    let mut notebook_ids = HashSet::new();
    for notebook in &state.notebooks {
        if notebook.id.trim().is_empty() || notebook.name.trim().is_empty() {
            return Err("Notebook id and name are required".to_string());
        }
        if !notebook_ids.insert(notebook.id.as_str()) {
            return Err(format!("Duplicate notebook id: {}", notebook.id));
        }
    }

    if !notebook_ids.contains(state.active_notebook_id.as_str()) {
        return Err("Active notebook does not exist".to_string());
    }

    let mut note_ids = HashSet::new();
    for note in &state.notes {
        if note.id.trim().is_empty() {
            return Err("Note id is required".to_string());
        }
        if !notebook_ids.contains(note.notebook_id.as_str()) {
            return Err(format!("Note references missing notebook: {}", note.id));
        }
        if !note_ids.insert(note.id.as_str()) {
            return Err(format!("Duplicate note id: {}", note.id));
        }
    }

    if let Some(active_note_id) = &state.active_note_id {
        if !note_ids.contains(active_note_id.as_str()) {
            return Err("Active note does not exist".to_string());
        }
    }

    let mut category_ids = HashSet::new();
    for category in &state.knowledge_categories {
        if category.id.trim().is_empty() || category.name.trim().is_empty() {
            return Err("Knowledge category id and name are required".to_string());
        }
        if !category_ids.insert(category.id.as_str()) {
            return Err(format!("Duplicate knowledge category id: {}", category.id));
        }
    }

    for category in &state.knowledge_categories {
        if let Some(parent_id) = &category.parent_id {
            if parent_id.trim().is_empty() {
                return Err(format!("Knowledge category has empty parent id: {}", category.id));
            }
            if !category_ids.contains(parent_id.as_str()) {
                return Err(format!(
                    "Knowledge category references missing parent: {}",
                    category.id
                ));
            }
        }

        let mut seen_parent_ids = HashSet::new();
        let mut parent_id = category.parent_id.as_deref();
        while let Some(current_parent_id) = parent_id {
            if current_parent_id == category.id || !seen_parent_ids.insert(current_parent_id) {
                return Err(format!("Knowledge category cycle detected: {}", category.id));
            }
            parent_id = state
                .knowledge_categories
                .iter()
                .find(|item| item.id == current_parent_id)
                .and_then(|item| item.parent_id.as_deref());
        }
    }

    if !category_ids.contains(state.active_knowledge_category_id.as_str()) {
        return Err("Active knowledge category does not exist".to_string());
    }

    let mut knowledge_item_ids = HashSet::new();
    for item in &state.knowledge_items {
        if item.id.trim().is_empty()
            || item.title.trim().is_empty()
            || item.summary.trim().is_empty()
            || item.content.trim().is_empty()
        {
            return Err("Knowledge item id, title, summary and content are required".to_string());
        }
        if !category_ids.contains(item.category_id.as_str()) {
            return Err(format!(
                "Knowledge item references missing category: {}",
                item.id
            ));
        }
        if !knowledge_item_ids.insert(item.id.as_str()) {
            return Err(format!("Duplicate knowledge item id: {}", item.id));
        }
        for linked_note in &item.linked_notes {
            if linked_note.note_id.trim().is_empty() || linked_note.note_title.trim().is_empty() {
                return Err(format!(
                    "Knowledge item has invalid linked note: {}",
                    item.id
                ));
            }
        }
    }

    Ok(())
}

fn to_json_string<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("Failed to serialize notes field: {}", e))
}

fn parse_json_field<T: DeserializeOwned>(raw: &str, field: &str) -> Result<T, String> {
    serde_json::from_str(raw).map_err(|e| format!("Invalid notes field {}: {}", field, e))
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn read_workspace_path_from_config() -> PathBuf {
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
            dirs::home_dir()
                .map(|home| home.join(rest))
                .unwrap_or(self)
        } else {
            self
        }
    }
}

#[tauri::command]
pub async fn notes_export_temp(note_id: String, content: String) -> Result<String, String> {
    let workspace = read_workspace_path_from_config();
    let tmp_dir = workspace.join(".mona").join("tmp").join("notes");
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let file_path = tmp_dir.join(format!("{}.md", note_id));
    fs::write(&file_path, &content).map_err(|e| format!("Failed to write temp file: {}", e))?;

    Ok(format!(".mona/tmp/notes/{}.md", note_id))
}
