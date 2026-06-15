use crate::settings::app_data_dir;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const DB_FILE: &str = "browser.sqlite3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub folder: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportBookmarkItem {
    pub url: String,
    pub title: String,
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitRecord {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub visit_count: i64,
    pub last_visited_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressBarSuggestion {
    pub url: String,
    pub title: String,
    pub is_bookmark: bool,
    pub visit_count: i64,
    pub last_visited_at: String,
}

fn db_path() -> PathBuf {
    app_data_dir().join("browser").join(DB_FILE)
}

fn open_db() -> Result<Connection, String> {
    let path = db_path();
    let parent = path.parent().ok_or("Invalid browser database path")?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create browser dir: {}", e))?;

    let conn =
        Connection::open(&path).map_err(|e| format!("Failed to open browser database: {}", e))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to set WAL mode: {}", e))?;
    initialize_schema(&conn)?;
    Ok(conn)
}

fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL DEFAULT '',
            folder TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS visit_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL DEFAULT '',
            visit_count INTEGER NOT NULL DEFAULT 1,
            last_visited_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url);
        CREATE INDEX IF NOT EXISTS idx_visit_history_url ON visit_history(url);
        CREATE INDEX IF NOT EXISTS idx_visit_history_last_visited ON visit_history(last_visited_at DESC);
        "#,
    )
    .map_err(|e| format!("Failed to initialize browser schema: {}", e))?;

    // Migrate: add folder column if missing (existing databases)
    let has_folder: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('bookmarks') WHERE name = 'folder'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if !has_folder {
        conn.execute(
            "ALTER TABLE bookmarks ADD COLUMN folder TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(|e| format!("Failed to migrate bookmarks table: {}", e))?;
    }

    // Create folder index after ensuring the column exists
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder)",
        [],
    )
    .map_err(|e| format!("Failed to create folder index: {}", e))?;

    Ok(())
}

// ── Bookmark commands ──

#[tauri::command]
pub async fn browser_add_bookmark(url: String, title: String, folder: Option<String>) -> Result<Bookmark, String> {
    let folder = folder.unwrap_or_default();
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        conn.execute(
            "INSERT INTO bookmarks (url, title, folder) VALUES (?1, ?2, ?3) ON CONFLICT(url) DO UPDATE SET title = ?2, folder = ?3",
            params![url, title, folder],
        )
        .map_err(|e| format!("Failed to add bookmark: {}", e))?;
        let bookmark = conn
            .query_row(
                "SELECT id, url, title, folder, created_at FROM bookmarks WHERE url = ?1",
                params![url],
                |row| {
                    Ok(Bookmark {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        title: row.get(2)?,
                        folder: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .map_err(|e| format!("Failed to query bookmark: {}", e))?;
        Ok(bookmark)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
pub async fn browser_remove_bookmark(url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        conn.execute("DELETE FROM bookmarks WHERE url = ?1", params![url])
            .map_err(|e| format!("Failed to remove bookmark: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
pub async fn browser_update_bookmark(url: String, title: Option<String>, folder: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        if let Some(title) = title {
            conn.execute("UPDATE bookmarks SET title = ?1 WHERE url = ?2", params![title, url])
                .map_err(|e| format!("Failed to update bookmark title: {}", e))?;
        }
        if let Some(folder) = folder {
            conn.execute("UPDATE bookmarks SET folder = ?1 WHERE url = ?2", params![folder, url])
                .map_err(|e| format!("Failed to update bookmark folder: {}", e))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
pub async fn browser_is_bookmarked(url: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM bookmarks WHERE url = ?1)",
                params![url],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to check bookmark: {}", e))?;
        Ok(exists)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
pub async fn browser_import_bookmarks(items: Vec<ImportBookmarkItem>) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to start import transaction: {}", e))?;
        let mut imported = 0usize;
        for item in items {
            let url = item.url.trim();
            if url.is_empty() {
                continue;
            }
            tx.execute(
                "INSERT INTO bookmarks (url, title, folder) VALUES (?1, ?2, ?3)
                 ON CONFLICT(url) DO UPDATE SET title = ?2, folder = ?3",
                params![url, item.title.trim(), item.folder.trim()],
            )
            .map_err(|e| format!("Failed to import bookmark: {}", e))?;
            imported += 1;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit import: {}", e))?;
        Ok(imported)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
pub async fn browser_list_bookmarks() -> Result<Vec<Bookmark>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let mut stmt = conn
            .prepare("SELECT id, url, title, folder, created_at FROM bookmarks ORDER BY folder, created_at DESC")
            .map_err(|e| format!("Failed to prepare query: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Bookmark {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    title: row.get(2)?,
                    folder: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| format!("Failed to query bookmarks: {}", e))?;
        let bookmarks: Vec<Bookmark> = rows.filter_map(|r| r.ok()).collect();
        Ok(bookmarks)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

// ── Visit history commands ──

#[tauri::command]
pub async fn browser_record_visit(url: String, title: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        conn.execute(
            r#"INSERT INTO visit_history (url, title, visit_count, last_visited_at)
               VALUES (?1, ?2, 1, datetime('now'))
               ON CONFLICT(url) DO UPDATE SET
                 title = CASE WHEN ?2 != '' THEN ?2 ELSE title END,
                 visit_count = visit_count + 1,
                 last_visited_at = datetime('now')"#,
            params![url, title],
        )
        .map_err(|e| format!("Failed to record visit: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
pub async fn browser_clear_history() -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        conn.execute("DELETE FROM visit_history", [])
            .map_err(|e| format!("Failed to clear history: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// 清理浏览器缓存（通过 WebView2 CDP 协议）
#[tauri::command]
pub async fn browser_clear_cache(
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;

    let state = app.state::<crate::browser::BrowserState>();
    let tabs = state.list_tabs();

    if tabs.is_empty() {
        return Ok(());
    }

    let first_label = format!("browser-{}", tabs[0].id);
    let webview = app
        .get_webview(&first_label)
        .ok_or_else(|| "No browser webview found".to_string())?;

    webview
        .with_webview(|wv| {
            #[cfg(target_os = "windows")]
            {
                use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
                use windows::core::HSTRING;

                let controller = wv.controller();
                let core_webview = unsafe { controller.CoreWebView2().unwrap() };

                let handler = CallDevToolsProtocolMethodCompletedHandler::create(
                    Box::new(|_result: windows::core::Result<()>, _json: String| Ok(())),
                );

                let method_name = HSTRING::from("Network.clearBrowserCache");
                let params = HSTRING::from("{}");

                unsafe {
                    let _ = core_webview
                        .CallDevToolsProtocolMethod(&method_name, &params, &handler);
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = wv;
            }
        })
        .map_err(|e| format!("Failed to clear cache: {}", e))?;

    Ok(())
}

// ── Address bar suggestions ──

#[tauri::command]
pub async fn browser_search_suggestions(
    query: String,
    limit: Option<i64>,
) -> Result<Vec<AddressBarSuggestion>, String> {
    let limit = limit.unwrap_or(10).min(20);
    tokio::task::spawn_blocking(move || {
        let conn = open_db()?;
        let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));

        // 收藏夹匹配
        let mut stmt = conn
            .prepare(
                "SELECT url, title FROM bookmarks WHERE url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\' ORDER BY created_at DESC LIMIT ?2",
            )
            .map_err(|e| format!("Failed to prepare bookmark query: {}", e))?;
        let bookmark_rows = stmt
            .query_map(params![pattern, limit], |row| {
                Ok(AddressBarSuggestion {
                    url: row.get(0)?,
                    title: row.get(1)?,
                    is_bookmark: true,
                    visit_count: 0,
                    last_visited_at: String::new(),
                })
            })
            .map_err(|e| format!("Failed to query bookmarks: {}", e))?;
        let mut suggestions: Vec<AddressBarSuggestion> =
            bookmark_rows.filter_map(|r| r.ok()).collect();

        // 历史记录匹配（排除已作为收藏出现的 URL）
        let bookmark_urls: Vec<String> = suggestions.iter().map(|s| s.url.clone()).collect();
        let remaining = limit - suggestions.len() as i64;
        if remaining > 0 {
            let mut stmt = conn
                .prepare(
                    "SELECT url, title, visit_count, last_visited_at FROM visit_history WHERE (url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\') AND url NOT IN (SELECT url FROM bookmarks) ORDER BY visit_count DESC, last_visited_at DESC LIMIT ?2",
                )
                .map_err(|e| format!("Failed to prepare history query: {}", e))?;
            let history_rows = stmt
                .query_map(params![pattern, remaining], |row| {
                    Ok(AddressBarSuggestion {
                        url: row.get(0)?,
                        title: row.get(1)?,
                        is_bookmark: false,
                        visit_count: row.get(2)?,
                        last_visited_at: row.get(3)?,
                    })
                })
                .map_err(|e| format!("Failed to query history: {}", e))?;
            suggestions.extend(history_rows.filter_map(|r| r.ok()));
        }

        Ok(suggestions)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}
