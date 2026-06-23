use crate::settings::app_data_dir;
use base64::Engine;
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
}

fn default_context_level() -> String {
    "full".to_string()
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

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            id,
            notebook_id,
            title,
            content_markdown,
            tags_json,
            content='notes',
            content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, id, notebook_id, title, content_markdown, tags_json)
            VALUES (new.rowid, new.id, new.notebook_id, new.title, new.content_markdown, new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
            DELETE FROM notes_fts WHERE rowid = old.rowid;
            INSERT INTO notes_fts(rowid, id, notebook_id, title, content_markdown, tags_json)
            VALUES (new.rowid, new.id, new.notebook_id, new.title, new.content_markdown, new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, id, notebook_id, title, content_markdown, tags_json)
            VALUES ('delete', old.rowid, old.id, old.notebook_id, old.title, old.content_markdown, old.tags_json);
        END;
        "#,
    )
    .map_err(|e| format!("Failed to initialize notes schema: {}", e))?;

    ensure_column(conn, "knowledge_categories", "parent_id", "TEXT")?;
    ensure_column(
        conn,
        "knowledge_items",
        "linked_notes_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        conn,
        "notebooks",
        "knowledge_base_enabled",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "notes", "agent_chat_id", "TEXT")?;
    ensure_column(
        conn,
        "notes",
        "applied_agent_message_ids_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(conn, "notes", "plain_text", "TEXT")?;
    ensure_column(
        conn,
        "notes",
        "context_level",
        "TEXT NOT NULL DEFAULT 'full'",
    )?;

    // Migrate FTS5 table: if old notes_fts has column "note_id", rebuild it
    migrate_fts_if_needed(conn)
}

fn migrate_fts_if_needed(conn: &Connection) -> Result<(), String> {
    // Check if notes_fts has the old "note_id" column (should be "id" now)
    let has_old_schema: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('notes_fts') WHERE name = 'note_id'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;

    if !has_old_schema {
        return Ok(());
    }

    // Drop old FTS table and triggers, they will be recreated by initialize_schema
    // on next app launch. But since CREATE VIRTUAL TABLE IF NOT EXISTS won't recreate,
    // we need to drop them now.
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS notes_fts_insert;
         DROP TRIGGER IF EXISTS notes_fts_update;
         DROP TRIGGER IF EXISTS notes_fts_delete;
         DROP TABLE IF EXISTS notes_fts;",
    )
    .map_err(|e| format!("Failed to drop old FTS table: {}", e))?;

    // Recreate with correct column names
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            id,
            notebook_id,
            title,
            content_markdown,
            tags_json,
            content='notes',
            content_rowid='rowid'
        );
        CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, id, notebook_id, title, content_markdown, tags_json)
            VALUES (new.rowid, new.id, new.notebook_id, new.title, new.content_markdown, new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
            DELETE FROM notes_fts WHERE rowid = old.rowid;
            INSERT INTO notes_fts(rowid, id, notebook_id, title, content_markdown, tags_json)
            VALUES (new.rowid, new.id, new.notebook_id, new.title, new.content_markdown, new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, id, notebook_id, title, content_markdown, tags_json)
            VALUES ('delete', old.rowid, old.id, old.notebook_id, old.title, old.content_markdown, old.tags_json);
        END;
        INSERT INTO notes_fts(notes_fts) VALUES('rebuild');",
    )
    .map_err(|e| format!("Failed to recreate FTS table: {}", e))?;

    Ok(())
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
            "默认分类",
            "",
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

    let transformations = load_transformations(&conn)?;

    Ok(NotesState {
        notebooks,
        notes,
        knowledge_categories,
        knowledge_items,
        active_notebook_id,
        active_note_id,
        active_knowledge_category_id,
        transformations,
    })
}

fn load_transformations(conn: &Connection) -> Result<Vec<NoteTransformation>, String> {
    let raw = match read_state_value(conn, "transformations")? {
        Some(value) if !value.is_empty() => value,
        _ => return Ok(Vec::new()),
    };
    serde_json::from_str::<Vec<NoteTransformation>>(&raw)
        .map_err(|e| format!("Failed to parse transformations JSON: {}", e))
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
        let context_level = if note.context_level.is_empty() {
            "full".to_string()
        } else {
            note.context_level.clone()
        };
        tx.execute(
            "INSERT INTO notes (
                id, notebook_id, title, preview, updated_at_label, source_kind, source_label,
                tags_json, content_markdown, content_json, plain_text, agent_chat_id,
                applied_agent_message_ids_json, context_level, created_at, modified_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
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
                &context_level,
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

    let transformations_json = serde_json::to_string(&state.transformations)
        .map_err(|e| format!("Failed to serialize transformations: {}", e))?;
    tx.execute(
        "INSERT INTO app_state (key, value) VALUES ('transformations', ?1)",
        params![&transformations_json],
    )
    .map_err(|e| format!("Failed to save transformations: {}", e))?;

    tx.execute("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')", [])
        .map_err(|e| format!("Failed to rebuild FTS index: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit notes transaction: {}", e))?;

    // Clean up orphaned image files no longer referenced by any note
    cleanup_orphaned_assets(&state.notes)?;

    Ok(())
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
        context_level: String,
    }

    let mut stmt = conn
        .prepare(
            "SELECT
                id, notebook_id, title, preview, updated_at_label, source_kind, source_label,
                tags_json, content_markdown, content_json, plain_text, agent_chat_id,
                applied_agent_message_ids_json, context_level
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
                context_level: row.get::<_, Option<String>>(13)?.unwrap_or_else(|| "full".to_string()),
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
                context_level: row.context_level,
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
            dirs::home_dir()
                .map(|home| home.join(rest))
                .unwrap_or(self)
        } else {
            self
        }
    }
}

#[tauri::command]
pub async fn notes_create_from_chat(
    title: String,
    content_markdown: String,
    notebook_id: Option<String>,
) -> Result<String, String> {
    let conn = open_notes_db()?;

    let target_notebook_id = match notebook_id {
        Some(id) => {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM notebooks WHERE id = ?1",
                    params![&id],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Failed to check notebook: {}", e))?;
            if !exists {
                return Err(format!("Notebook not found: {}", id));
            }
            id
        }
        None => "default".to_string(),
    };

    let note_id = format!("note-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().to_rfc3339();
    let preview: String = content_markdown
        .chars()
        .take(120)
        .collect::<String>()
        .lines()
        .next()
        .unwrap_or("")
        .to_string();

    conn.execute(
        "INSERT INTO notes (
            id, notebook_id, title, preview, updated_at_label, source_kind, source_label,
            tags_json, content_markdown, content_json, plain_text, agent_chat_id,
            applied_agent_message_ids_json, created_at, modified_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, '[]', ?10, ?10)",
        params![
            &note_id,
            &target_notebook_id,
            &title,
            &preview,
            "刚刚",
            "agent",
            "聊天保存",
            "[]",
            &content_markdown,
            &now,
        ],
    )
    .map_err(|e| format!("Failed to create note from chat: {}", e))?;

    Ok(note_id)
}

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

#[tauri::command]
pub async fn notes_search(
    notebook_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<NoteSearchResult>, String> {
    let conn = open_notes_db()?;
    let limit = limit.unwrap_or(5);

    // Try FTS5 search first
    let fts_results = search_fts(&conn, Some(&notebook_id), &query, limit)?;

    let results = if !fts_results.is_empty() {
        fts_results
    } else {
        // Fallback to LIKE search for better Chinese support
        search_like(&conn, Some(&notebook_id), &query, limit)?
    };

    apply_context_levels(&conn, results)
}

#[tauri::command]
pub async fn notes_search_all(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<NoteSearchResult>, String> {
    let conn = open_notes_db()?;
    let limit = limit.unwrap_or(20);

    // Try FTS5 search first across all notebooks
    let fts_results = search_fts(&conn, None, &query, limit)?;

    let results = if !fts_results.is_empty() {
        fts_results
    } else {
        // Fallback to LIKE search
        search_like(&conn, None, &query, limit)?
    };

    apply_context_levels(&conn, results)
}

fn search_fts(
    conn: &Connection,
    notebook_id: Option<&str>,
    query: &str,
    limit: usize,
) -> Result<Vec<NoteSearchResult>, String> {
    // Build FTS query: split into words, filter short ones, join with OR
    let fts_query = query
        .split_whitespace()
        .filter(|w| w.len() >= 2)
        .map(|w| format!("\"{}\"", w))
        .collect::<Vec<_>>()
        .join(" OR ");

    if fts_query.is_empty() {
        return Ok(vec![]);
    }

    // FTS5 virtual tables cannot be joined directly; query FTS first, then
    // resolve notebook names from the notebooks table.
    let fts_sql = match notebook_id {
        Some(_) => format!(
            "SELECT id, title, snippet(notes_fts, 3, '⟨', '⟩', '...', 64) as snippet, rank, notebook_id \
             FROM notes_fts \
             WHERE notes_fts MATCH ?1 AND notebook_id = ?2 \
             ORDER BY rank \
             LIMIT {}",
            limit
        ),
        None => format!(
            "SELECT id, title, snippet(notes_fts, 3, '⟨', '⟩', '...', 64) as snippet, rank, notebook_id \
             FROM notes_fts \
             WHERE notes_fts MATCH ?1 \
             ORDER BY rank \
             LIMIT {}",
            limit
        ),
    };

    let mut stmt = conn.prepare(&fts_sql).map_err(|e| format!("Search prepare failed: {}", e))?;
    let raw_rows: Vec<(String, String, String, f64, Option<String>)> = match notebook_id {
        Some(nid) => stmt
            .query_map(params![&fts_query, nid], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| format!("Search query failed: {}", e))?
            .filter_map(|r| r.ok())
            .collect(),
        None => stmt
            .query_map(params![&fts_query], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| format!("Search query failed: {}", e))?
            .filter_map(|r| r.ok())
            .collect(),
    };

    if raw_rows.is_empty() {
        return Ok(vec![]);
    }

    // Batch-resolve notebook names
    let mut notebook_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let unique_ids: Vec<&str> = raw_rows
        .iter()
        .filter_map(|r| r.4.as_deref())
        .filter(|id| !notebook_names.contains_key(*id))
        .collect();
    if !unique_ids.is_empty() {
        let placeholders = unique_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("SELECT id, name FROM notebooks WHERE id IN ({})", placeholders);
        let mut nb_stmt = conn.prepare(&sql).map_err(|e| format!("Notebook lookup failed: {}", e))?;
        let nb_rows = nb_stmt
            .query_map(rusqlite::params_from_iter(unique_ids.iter()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Notebook lookup query failed: {}", e))?;
        for nb_row in nb_rows.flatten() {
            notebook_names.insert(nb_row.0, nb_row.1);
        }
    }

    Ok(raw_rows
        .into_iter()
        .map(|(note_id, title, snippet, rank, nb_id)| NoteSearchResult {
            note_id,
            title,
            snippet,
            rank,
            notebook_id: nb_id.clone(),
            notebook_name: nb_id.and_then(|id| notebook_names.get(&id).cloned()),
        })
        .collect())
}

/// Look up `context_level` and `preview` for a batch of note IDs from the notes
/// table. Returns a map keyed by note_id.
fn load_note_context_levels(
    conn: &Connection,
    note_ids: &[String],
) -> Result<std::collections::HashMap<String, (String, String)>, String> {
    let mut map = std::collections::HashMap::new();
    if note_ids.is_empty() {
        return Ok(map);
    }
    let placeholders = note_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, context_level, preview FROM notes WHERE id IN ({})",
        placeholders
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Context level lookup failed: {}", e))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(note_ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_else(|| "full".to_string()),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            ))
        })
        .map_err(|e| format!("Context level query failed: {}", e))?;
    for row in rows.flatten() {
        map.insert(row.0, (row.1, row.2));
    }
    Ok(map)
}

/// Apply context-level filtering and truncation to search results.
/// - `none`: drop the result entirely
/// - `summary`: replace snippet with the note's preview (short summary)
/// - `full`: keep as-is
fn apply_context_levels(
    conn: &Connection,
    results: Vec<NoteSearchResult>,
) -> Result<Vec<NoteSearchResult>, String> {
    if results.is_empty() {
        return Ok(results);
    }
    let note_ids: Vec<String> = results.iter().map(|r| r.note_id.clone()).collect();
    let context_map = load_note_context_levels(conn, &note_ids)?;

    Ok(results
        .into_iter()
        .filter_map(|result| {
            let (context_level, preview) = context_map.get(&result.note_id).cloned().unwrap_or_else(|| {
                ("full".to_string(), String::new())
            });
            match context_level.as_str() {
                "none" => None,
                "summary" => Some(NoteSearchResult {
                    snippet: if preview.is_empty() { result.snippet } else { preview.clone() },
                    ..result
                }),
                _ => Some(result),
            }
        })
        .collect())
}

fn search_like(
    conn: &Connection,
    notebook_id: Option<&str>,
    query: &str,
    limit: usize,
) -> Result<Vec<NoteSearchResult>, String> {
    let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));
    let (sql, params): (String, Vec<Box<dyn rusqlite::ToSql>>) = match notebook_id {
        Some(nid) => (
            format!(
                "SELECT n.id, n.title, substr(n.content_markdown, 1, 200) as snippet, n.notebook_id, nb.name as notebook_name \
                 FROM notes n LEFT JOIN notebooks nb ON nb.id = n.notebook_id \
                 WHERE n.notebook_id = ?1 AND (n.title LIKE ?2 ESCAPE '\\' OR n.content_markdown LIKE ?2 ESCAPE '\\') \
                 ORDER BY n.modified_at DESC \
                 LIMIT {}",
                limit
            ),
            vec![Box::new(nid.to_string()), Box::new(pattern)],
        ),
        None => (
            format!(
                "SELECT n.id, n.title, substr(n.content_markdown, 1, 200) as snippet, n.notebook_id, nb.name as notebook_name \
                 FROM notes n LEFT JOIN notebooks nb ON nb.id = n.notebook_id \
                 WHERE n.title LIKE ?1 ESCAPE '\\' OR n.content_markdown LIKE ?1 ESCAPE '\\' \
                 ORDER BY n.modified_at DESC \
                 LIMIT {}",
                limit
            ),
            vec![Box::new(pattern)],
        ),
    };

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("LIKE search prepare failed: {}", e))?;
    let results = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |row| {
            Ok(NoteSearchResult {
                note_id: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
                rank: 0.0,
                notebook_id: row.get::<_, Option<String>>(3)?,
                notebook_name: row.get::<_, Option<String>>(4)?,
            })
        })
        .map_err(|e| format!("LIKE search query failed: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
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

/// Scan all notes' Markdown for `assets/xxx.png` references and delete
/// files in the assets directory that are no longer referenced by any note.
fn cleanup_orphaned_assets(notes: &[OperationNote]) -> Result<(), String> {
    let assets_dir = app_data_dir().join("notes").join("assets");
    if !assets_dir.exists() {
        return Ok(());
    }

    // Collect all referenced file names from note Markdown
    let mut referenced = std::collections::HashSet::new();
    for note in notes {
        let md = &note.content_markdown;
        let mut start = 0;
        while let Some(pos) = md[start..].find("assets/") {
            let abs_pos = start + pos;
            let rest = &md[abs_pos + "assets/".len()..];
            // Extract file name: alphanumeric + dots + extension
            let end = rest
                .char_indices()
                .take_while(|(i, c)| {
                    *i == 0 && c.is_alphanumeric()
                        || *i > 0 && (c.is_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
                })
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            let name = &rest[..end];
            if !name.is_empty() && name.contains('.') {
                referenced.insert(name.to_string());
            }
            start = abs_pos + "assets/".len();
        }
    }

    // Delete files not in the referenced set
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
    file_name: String,
    image_data: Vec<u8>,
) -> Result<String, String> {
    let assets_dir = app_data_dir().join("notes").join("assets");
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create notes assets dir: {}", e))?;

    let file_path = assets_dir.join(&file_name);
    fs::write(&file_path, &image_data)
        .map_err(|e| format!("Failed to save note image: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn notes_get_assets_dir() -> Result<String, String> {
    let assets_dir = app_data_dir().join("notes").join("assets");
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to ensure notes assets dir: {}", e))?;
    Ok(assets_dir.to_string_lossy().to_string())
}

/// Read a note image file and return it as a data URL for rendering.
/// Only used for in-browser display; the database still stores relative paths like `assets/xxx.png`.
#[tauri::command]
pub async fn notes_read_image(file_name: String) -> Result<String, String> {
    let assets_dir = app_data_dir().join("notes").join("assets");
    let file_path = assets_dir.join(&file_name);

    if !file_path.exists() {
        return Err(format!("Image file not found: {}", file_name));
    }

    let data = fs::read(&file_path)
        .map_err(|e| format!("Failed to read image: {}", e))?;

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "image/png",
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:{};base64,{}", mime, b64))
}
