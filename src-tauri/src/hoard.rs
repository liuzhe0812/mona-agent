// Hoard module: Agent's cross-source memory layer.
// SQLite storage for URLs/fragments with LLM summaries and tags.
// Rust side handles: table init, basic CRUD, list/delete Tauri commands.
// Python side handles: ingestion pipeline (fetch/summarize/tag), search, agent tools.

use crate::settings::app_data_dir;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const HOARD_DB_FILE: &str = "hoard.sqlite3";
const HOARD_DIR: &str = "hoard";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoardItem {
    pub id: String,
    pub url: Option<String>,
    pub title: String,
    pub content: Option<String>,
    pub summary: Option<String>,
    pub tags: Option<String>,
    pub source: String,
    pub source_ref: Option<String>,
    pub source_strength: f64,
    pub asset_path: Option<String>,
    pub created_at: i64,
    pub last_accessed_at: Option<i64>,
}

pub fn hoard_db_path() -> PathBuf {
    app_data_dir().join(HOARD_DIR).join(HOARD_DB_FILE)
}

pub fn hoard_assets_dir() -> PathBuf {
    app_data_dir().join(HOARD_DIR).join("assets")
}

fn ensure_db() -> Result<PathBuf, String> {
    let db_path = hoard_db_path();
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create hoard dir: {}", e))?;
    }
    fs::create_dir_all(hoard_assets_dir())
        .map_err(|e| format!("Failed to create assets dir: {}", e))?;

    let conn =
        Connection::open(&db_path).map_err(|e| format!("Failed to open hoard db: {}", e))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS hoards (
            id TEXT PRIMARY KEY,
            url TEXT,
            title TEXT NOT NULL,
            content TEXT,
            summary TEXT,
            tags TEXT,
            source TEXT NOT NULL,
            source_ref TEXT,
            source_strength REAL DEFAULT 1.0,
            asset_path TEXT,
            created_at INTEGER NOT NULL,
            last_accessed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_hoards_url ON hoards(url);
        CREATE INDEX IF NOT EXISTS idx_hoards_source ON hoards(source);
        CREATE INDEX IF NOT EXISTS idx_hoards_created ON hoards(created_at);
        CREATE TABLE IF NOT EXISTS hoard_relations (
            hoard_id TEXT NOT NULL,
            related_type TEXT NOT NULL,
            related_id TEXT NOT NULL,
            related_meta TEXT,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (hoard_id, related_type, related_id)
        );
        "#,
    )
    .map_err(|e| format!("Failed to init hoard tables: {}", e))?;
    Ok(db_path)
}

/// 打开 hoard 数据库连接，设置 busy_timeout 避免 Python 侧并发写入时锁冲突。
fn open_hoard_conn() -> Result<Connection, String> {
    let db_path = ensure_db()?;
    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open db: {}", e))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("Failed to set busy_timeout: {}", e))?;
    Ok(conn)
}

fn row_to_item(row: &rusqlite::Row) -> rusqlite::Result<HoardItem> {
    Ok(HoardItem {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        summary: row.get(4)?,
        tags: row.get(5)?,
        source: row.get(6)?,
        source_ref: row.get(7)?,
        source_strength: row.get(8)?,
        asset_path: row.get(9)?,
        created_at: row.get(10)?,
        last_accessed_at: row.get(11)?,
    })
}

const SELECT_COLS: &str = "id, url, title, content, summary, tags, source, source_ref, source_strength, asset_path, created_at, last_accessed_at";

#[tauri::command]
pub async fn hoard_add(
    url: Option<String>,
    title: String,
    content: Option<String>,
    summary: Option<String>,
    tags: Option<String>,
    source: String,
    source_ref: Option<String>,
    source_strength: Option<f64>,
    asset_path: Option<String>,
) -> Result<String, String> {
    let conn = open_hoard_conn()?;
    let id = format!("hoard-{}", uuid::Uuid::new_v4());
    let now = chrono::Utc::now().timestamp();
    let strength = source_strength.unwrap_or(1.0);

    conn.execute(
        "INSERT INTO hoards (id, url, title, content, summary, tags, source, source_ref, source_strength, asset_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![id, url, title, content, summary, tags, source, source_ref, strength, asset_path, now],
    )
    .map_err(|e| format!("Failed to insert hoard: {}", e))?;
    Ok(id)
}

#[tauri::command]
pub async fn hoard_update(
    id: String,
    title: Option<String>,
    content: Option<String>,
    summary: Option<String>,
    tags: Option<String>,
    asset_path: Option<String>,
) -> Result<(), String> {
    let conn = open_hoard_conn()?;

    let mut updates: Vec<&str> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if title.is_some() {
        updates.push("title = ?");
        param_values.push(Box::new(title));
    }
    if content.is_some() {
        updates.push("content = ?");
        param_values.push(Box::new(content));
    }
    if summary.is_some() {
        updates.push("summary = ?");
        param_values.push(Box::new(summary));
    }
    if tags.is_some() {
        updates.push("tags = ?");
        param_values.push(Box::new(tags));
    }
    if asset_path.is_some() {
        updates.push("asset_path = ?");
        param_values.push(Box::new(asset_path));
    }

    if updates.is_empty() {
        return Ok(());
    }

    let sql = format!("UPDATE hoards SET {} WHERE id = ?", updates.join(", "));
    param_values.push(Box::new(id));
    let param_refs: Vec<&dyn rusqlite::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, param_refs.as_slice())
        .map_err(|e| format!("Failed to update hoard: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn hoard_delete(id: String) -> Result<(), String> {
    let conn = open_hoard_conn()?;
    conn.execute("DELETE FROM hoard_relations WHERE hoard_id = ?", params![id])
        .map_err(|e| format!("Failed to delete relations: {}", e))?;
    conn.execute("DELETE FROM hoards WHERE id = ?", params![id])
        .map_err(|e| format!("Failed to delete hoard: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn hoard_get(id: String) -> Result<Option<HoardItem>, String> {
    let conn = open_hoard_conn()?;
    let item = conn
        .query_row(
            &format!("SELECT {} FROM hoards WHERE id = ?", SELECT_COLS),
            params![id],
            row_to_item,
        )
        .ok();
    Ok(item)
}

#[tauri::command]
pub async fn hoard_list(
    source: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<HoardItem>, String> {
    let conn = open_hoard_conn()?;
    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);

    let mut items = Vec::new();
    if let Some(src) = source {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM hoards WHERE source = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                SELECT_COLS
            ))
            .map_err(|e| format!("Failed to prepare stmt: {}", e))?;
        let rows = stmt
            .query_map(params![src, limit, offset], row_to_item)
            .map_err(|e| format!("Failed to query: {}", e))?;
        for row in rows {
            items.push(row.map_err(|e| format!("Row error: {}", e))?);
        }
    } else {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM hoards ORDER BY created_at DESC LIMIT ? OFFSET ?",
                SELECT_COLS
            ))
            .map_err(|e| format!("Failed to prepare stmt: {}", e))?;
        let rows = stmt
            .query_map(params![limit, offset], row_to_item)
            .map_err(|e| format!("Failed to query: {}", e))?;
        for row in rows {
            items.push(row.map_err(|e| format!("Row error: {}", e))?);
        }
    }
    Ok(items)
}

/// CJK Unified Ideographs 范围检查 (U+4E00 ..= U+9FFF)
fn is_cjk(c: char) -> bool {
    matches!(c, '\u{4e00}'..='\u{9fff}')
}

/// 将 CJK 字符序列切为 bigram（长度 1 则保留单字），追加到 tokens。
fn push_cjk_bigrams(chars: &[char], tokens: &mut Vec<String>) {
    match chars.len() {
        0 => {}
        1 => tokens.push(chars[0].to_string()),
        _ => {
            for i in 0..chars.len() - 1 {
                let mut s = String::with_capacity(4);
                s.push(chars[i]);
                s.push(chars[i + 1]);
                tokens.push(s);
            }
        }
    }
}

/// 查询分词：空白切分拉丁文，CJK 连续段切 2-gram。
/// 对齐 Python 侧 mona/kb/search.py 的 _tokenize_query。
fn tokenize_query(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for raw in query.split_whitespace() {
        if raw.is_empty() {
            continue;
        }
        if !raw.chars().any(is_cjk) {
            tokens.push(raw.to_ascii_lowercase());
            continue;
        }
        let mut cjk_run: Vec<char> = Vec::new();
        let mut other = String::new();
        for c in raw.chars() {
            if is_cjk(c) {
                if !other.is_empty() {
                    let trimmed = other.trim();
                    if !trimmed.is_empty() {
                        tokens.push(trimmed.to_ascii_lowercase());
                    }
                    other.clear();
                }
                cjk_run.push(c);
            } else {
                if !cjk_run.is_empty() {
                    push_cjk_bigrams(&cjk_run, &mut tokens);
                    cjk_run.clear();
                }
                other.push(c);
            }
        }
        push_cjk_bigrams(&cjk_run, &mut tokens);
        let trimmed = other.trim();
        if !trimmed.is_empty() {
            tokens.push(trimmed.to_ascii_lowercase());
        }
    }
    tokens
}

#[tauri::command]
pub async fn hoard_search(
    query: String,
    source: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<HoardItem>, String> {
    let conn = open_hoard_conn()?;
    let tokens = tokenize_query(&query);
    if tokens.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(20);

    // 多 token LIKE：每个 token 独立匹配 (title/summary/tags/content)，OR 连接。
    // 评分 = 各 token 得分之和 (title +3, tags +2, summary +2, content +1) × source_strength。
    let mut where_clauses: Vec<String> = Vec::new();
    let mut score_terms: Vec<String> = Vec::new();
    let mut where_params: Vec<String> = Vec::new();
    let mut score_params: Vec<String> = Vec::new();

    for tok in &tokens {
        let pat = format!("%{}%", tok);
        where_clauses.push(
            "(LOWER(title) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(COALESCE(content,'')) LIKE ?)".to_string(),
        );
        where_params.extend([pat.clone(), pat.clone(), pat.clone(), pat.clone()]);
        score_terms.push(
            "(CASE WHEN LOWER(title) LIKE ? THEN 3 ELSE 0 END".to_string()
                + " + CASE WHEN LOWER(tags) LIKE ? THEN 2 ELSE 0 END"
                + " + CASE WHEN LOWER(summary) LIKE ? THEN 2 ELSE 0 END"
                + " + CASE WHEN LOWER(COALESCE(content,'')) LIKE ? THEN 1 ELSE 0 END)",
        );
        score_params.extend([pat.clone(), pat.clone(), pat.clone(), pat.clone()]);
    }

    let where_sql = where_clauses.join(" OR ");
    let score_expr = format!("({}) * source_strength", score_terms.join(" + "));

    let sql = if source.is_some() {
        format!(
            "SELECT {} FROM hoards WHERE source = ? AND ({}) ORDER BY {} DESC LIMIT ?",
            SELECT_COLS, where_sql, score_expr
        )
    } else {
        format!(
            "SELECT {} FROM hoards WHERE {} ORDER BY {} DESC LIMIT ?",
            SELECT_COLS, where_sql, score_expr
        )
    };

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(ref src) = source {
        param_values.push(Box::new(src.clone()));
    }
    for p in &where_params {
        param_values.push(Box::new(p.clone()));
    }
    for p in &score_params {
        param_values.push(Box::new(p.clone()));
    }
    param_values.push(Box::new(limit));

    let param_refs: Vec<&dyn rusqlite::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(param_refs.as_slice(), row_to_item)
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(items)
}

#[tauri::command]
pub async fn hoard_count() -> Result<i64, String> {
    let conn = open_hoard_conn()?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM hoards", [], |row| row.get(0))
        .map_err(|e| format!("Failed to count: {}", e))?;
    Ok(count)
}

#[tauri::command]
pub async fn hoard_add_relation(
    hoard_id: String,
    related_type: String,
    related_id: String,
    related_meta: Option<String>,
) -> Result<(), String> {
    let conn = open_hoard_conn()?;
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT OR IGNORE INTO hoard_relations (hoard_id, related_type, related_id, related_meta, created_at) VALUES (?, ?, ?, ?, ?)",
        params![hoard_id, related_type, related_id, related_meta, now],
    )
    .map_err(|e| format!("Failed to add relation: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn hoard_get_relations(hoard_id: String) -> Result<Vec<serde_json::Value>, String> {
    let conn = open_hoard_conn()?;
    let mut stmt = conn
        .prepare("SELECT related_type, related_id, related_meta, created_at FROM hoard_relations WHERE hoard_id = ? ORDER BY created_at")
        .map_err(|e| format!("Failed to prepare: {}", e))?;

    let rows = stmt
        .query_map(params![hoard_id], |row| {
            let rel_type: String = row.get(0)?;
            let rel_id: String = row.get(1)?;
            let rel_meta: Option<String> = row.get(2)?;
            let created: i64 = row.get(3)?;
            Ok(serde_json::json!({
                "type": rel_type,
                "id": rel_id,
                "meta": rel_meta,
                "created_at": created,
            }))
        })
        .map_err(|e| format!("Failed to query: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|e| format!("Row error: {}", e))?);
    }
    Ok(items)
}
