//! Contacts module: SQLite cache for address book + gateway bridge for CardDAV sync.
//!
//! 复用 email.sqlite3 数据库，新增 contacts / contact_sync_state 两张表。
//! CardDAV 同步逻辑放在 Python 侧 `mona/contacts/`，Rust 侧只做本地 CRUD 和 gateway 转发。

use crate::settings::app_data_dir;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const EMAIL_DB_FILE: &str = "email.sqlite3";

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub id: String,
    pub account_id: String,
    /// 来源：carddav / manual
    pub source: String,
    /// vCard UID（CardDAV 同步用）
    #[serde(default)]
    pub remote_uid: Option<String>,
    #[serde(default)]
    pub etag: Option<String>,
    pub display_name: String,
    /// 主邮箱
    #[serde(default)]
    pub email: Option<String>,
    /// 其他邮箱列表（JSON 数组）
    #[serde(default)]
    pub email_list: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub organization: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// 原始 vCard 内容
    #[serde(default)]
    pub raw_vcard: Option<String>,
    /// 服务器端最后修改时间（Unix 秒）
    #[serde(default)]
    pub last_modified: Option<i64>,
    /// 本地最后更新时间（Unix 秒）
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactSyncState {
    pub account_id: String,
    #[serde(default)]
    pub sync_token: Option<String>,
    #[serde(default)]
    pub last_synced_at: Option<i64>,
    #[serde(default)]
    pub last_sync_status: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

/// CardDAV 同步请求（前端 → Rust → Python gateway）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactSyncRequest {
    pub account_id: String,
    pub carddav_url: String,
    pub username: String,
    pub password: String,
}

/// CardDAV 连接测试请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDavTestRequest {
    pub carddav_url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDavTestResponse {
    pub ok: bool,
    pub contacts_count: Option<u32>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Exchange ActiveSync 同步请求（前端 → Rust → Python gateway）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EASSyncRequest {
    pub account_id: String,
    pub eas_url: String,
    pub username: String,
    pub password: String,
}

/// EAS 连接测试请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EASTestRequest {
    pub eas_url: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub account_id: Option<String>,
}

/// 单个同步联系人（Python → Rust 传递用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedContact {
    pub remote_uid: String,
    #[serde(default)]
    pub etag: Option<String>,
    /// 联系人字段（与 Contact 结构对齐的 camelCase JSON）
    pub data: serde_json::Value,
}

/// 同步结果（Python 返回给 Rust，再返回前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactSyncResult {
    pub added: u32,
    pub updated: u32,
    pub deleted: u32,
    pub total: u32,
    #[serde(default)]
    pub sync_token: Option<String>,
    #[serde(default)]
    pub contacts: Vec<SyncedContact>,
    #[serde(default)]
    pub deleted_uids: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct ContactsState {
    pub db_path: PathBuf,
}

impl ContactsState {
    pub fn new() -> Self {
        let db_path = app_data_dir().join(EMAIL_DB_FILE);
        Self { db_path }
    }

    fn conn(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.db_path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual',
                remote_uid TEXT,
                etag TEXT,
                display_name TEXT NOT NULL,
                email TEXT,
                email_list TEXT,
                phone TEXT,
                organization TEXT,
                title TEXT,
                note TEXT,
                raw_vcard TEXT,
                last_modified INTEGER,
                updated_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_uid
                ON contacts(account_id, remote_uid) WHERE remote_uid IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
            CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

            CREATE TABLE IF NOT EXISTS contact_sync_state (
                account_id TEXT PRIMARY KEY,
                sync_token TEXT,
                last_synced_at INTEGER,
                last_sync_status TEXT,
                last_error TEXT
            );
            ",
        )
        .map_err(|e| e.to_string())?;
        Ok(conn)
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令 — 联系人 CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn contact_list(
    state: tauri::State<'_, ContactsState>,
    account_id: Option<String>,
) -> Result<Vec<Contact>, String> {
    let conn = state.conn()?;
    let mut stmt = if account_id.is_some() {
        conn.prepare(
            "SELECT id, account_id, source, remote_uid, etag, display_name, email, email_list,
                    phone, organization, title, note, raw_vcard, last_modified, updated_at
             FROM contacts WHERE account_id = ?1 ORDER BY display_name",
        )
        .map_err(|e| e.to_string())?
    } else {
        conn.prepare(
            "SELECT id, account_id, source, remote_uid, etag, display_name, email, email_list,
                    phone, organization, title, note, raw_vcard, last_modified, updated_at
             FROM contacts ORDER BY display_name",
        )
        .map_err(|e| e.to_string())?
    };
    let rows = if let Some(aid) = account_id {
        stmt.query_map(params![aid], map_contact_row)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect()
    } else {
        stmt.query_map([], map_contact_row)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect()
    };
    Ok(rows)
}

#[tauri::command]
pub async fn contact_search(
    state: tauri::State<'_, ContactsState>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<Contact>, String> {
    let conn = state.conn()?;
    let pattern = format!("%{}%", query.trim());
    let lim = limit.unwrap_or(20);
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, source, remote_uid, etag, display_name, email, email_list,
                    phone, organization, title, note, raw_vcard, last_modified, updated_at
             FROM contacts
             WHERE display_name LIKE ?1 OR email LIKE ?1 OR phone LIKE ?1
                OR organization LIKE ?1
             ORDER BY display_name LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![pattern, lim], map_contact_row)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[tauri::command]
pub async fn contact_add(
    state: tauri::State<'_, ContactsState>,
    contact: Contact,
) -> Result<String, String> {
    let conn = state.conn()?;
    let id = if contact.id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        contact.id.clone()
    };
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT OR REPLACE INTO contacts
         (id, account_id, source, remote_uid, etag, display_name, email, email_list,
          phone, organization, title, note, raw_vcard, last_modified, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            id,
            contact.account_id,
            if contact.source.is_empty() { "manual".to_string() } else { contact.source },
            contact.remote_uid,
            contact.etag,
            contact.display_name,
            contact.email,
            contact.email_list,
            contact.phone,
            contact.organization,
            contact.title,
            contact.note,
            contact.raw_vcard,
            contact.last_modified,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn contact_update(
    state: tauri::State<'_, ContactsState>,
    id: String,
    fields: serde_json::Value,
) -> Result<(), String> {
    let conn = state.conn()?;
    let obj = fields.as_object().ok_or("fields 必须是 JSON 对象")?;
    // 白名单字段，避免 SQL 注入
    let allowed = [
        "display_name", "email", "email_list", "phone", "organization",
        "title", "note", "raw_vcard", "last_modified",
    ];
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    for key in allowed.iter() {
        if let Some(val) = obj.get(*key) {
            sets.push(format!("{} = ?", key));
            let v: Box<dyn rusqlite::ToSql> = match val {
                serde_json::Value::Null => Box::new(None::<String>),
                serde_json::Value::String(s) => Box::new(s.clone()),
                serde_json::Value::Number(n) => Box::new(n.as_i64().unwrap_or(0)),
                serde_json::Value::Bool(b) => Box::new(if *b { 1i64 } else { 0 }),
                _ => Box::new(val.to_string()),
            };
            values.push(v);
        }
    }
    if sets.is_empty() {
        return Ok(());
    }
    sets.push("updated_at = ?".to_string());
    let now = chrono::Utc::now().timestamp();
    values.push(Box::new(now));
    values.push(Box::new(id.clone()));

    let sql = format!("UPDATE contacts SET {} WHERE id = ?", sets.join(", "));
    let param_refs: Vec<&dyn rusqlite::ToSql> =
        values.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, param_refs.as_slice())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn contact_delete(
    state: tauri::State<'_, ContactsState>,
    id: String,
) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute("DELETE FROM contacts WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn contact_clear_account(
    state: tauri::State<'_, ContactsState>,
    account_id: String,
    source: Option<String>,
) -> Result<u32, String> {
    let conn = state.conn()?;
    let deleted = if let Some(src) = source {
        conn.execute(
            "DELETE FROM contacts WHERE account_id = ?1 AND source = ?2",
            params![account_id, src],
        )
        .map_err(|e| e.to_string())?
    } else {
        conn.execute(
            "DELETE FROM contacts WHERE account_id = ?1",
            params![account_id],
        )
        .map_err(|e| e.to_string())?
    };
    Ok(deleted as u32)
}

// ---------------------------------------------------------------------------
// Tauri 命令 — 同步状态
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn contact_get_sync_state(
    state: tauri::State<'_, ContactsState>,
    account_id: String,
) -> Result<Option<ContactSyncState>, String> {
    let conn = state.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT account_id, sync_token, last_synced_at, last_sync_status, last_error
             FROM contact_sync_state WHERE account_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let row = stmt
        .query_row(params![account_id], |row| {
            Ok(ContactSyncState {
                account_id: row.get(0)?,
                sync_token: row.get(1)?,
                last_synced_at: row.get(2)?,
                last_sync_status: row.get(3)?,
                last_error: row.get(4)?,
            })
        })
        .ok();
    Ok(row)
}

#[tauri::command]
pub async fn contact_save_sync_state(
    state: tauri::State<'_, ContactsState>,
    sync_state: ContactSyncState,
) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute(
        "INSERT OR REPLACE INTO contact_sync_state
         (account_id, sync_token, last_synced_at, last_sync_status, last_error)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            sync_state.account_id,
            sync_state.sync_token,
            sync_state.last_synced_at,
            sync_state.last_sync_status,
            sync_state.last_error,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri 命令 — gateway 转发（CardDAV 同步）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn contact_sync(
    state: tauri::State<'_, ContactsState>,
    gateway_url: String,
    req: ContactSyncRequest,
) -> Result<ContactSyncResult, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }

    // 读取上次的 sync_token（增量同步用）
    let old_token: Option<String> = {
        let conn = state.conn()?;
        conn.query_row(
            "SELECT sync_token FROM contact_sync_state WHERE account_id = ?1",
            params![req.account_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };

    // 构造发给 Python 的请求（附带 oldSyncToken）
    let python_req = serde_json::json!({
        "accountId": req.account_id,
        "carddavUrl": req.carddav_url,
        "username": req.username,
        "password": req.password,
        "oldSyncToken": old_token,
    });

    let url = format!("{}/contacts/sync", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&python_req)
        .send()
        .await
        .map_err(|e| format!("请求 gateway 失败 ({url}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("gateway 返回 {status} ({url}): {text}"));
    }
    let mut result: ContactSyncResult = resp
        .json()
        .await
        .map_err(|e| format!("解析同步结果失败: {e}"))?;

    // 同步成功后写入 SQLite
    if result.error.is_none() {
        let conn = state.conn()?;
        let now = chrono::Utc::now().timestamp();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        // 全量同步（无 old_token 或返回的 contacts 为全量）：先清空该账号的 carddav 联系人
        let is_full_sync = old_token.is_none();
        if is_full_sync {
            tx.execute(
                "DELETE FROM contacts WHERE account_id = ?1 AND source = 'carddav'",
                params![req.account_id],
            )
            .map_err(|e| e.to_string())?;
        }

        // upsert 联系人
        let mut added = 0u32;
        let mut updated = 0u32;
        for sc in &result.contacts {
            let data = &sc.data;
            let display_name = data
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or("(未命名)")
                .to_string();
            let email = data.get("email").and_then(|v| v.as_str()).map(String::from);
            let email_list = data
                .get("emailList")
                .and_then(|v| v.as_str())
                .map(String::from);
            let phone = data.get("phone").and_then(|v| v.as_str()).map(String::from);
            let organization = data
                .get("organization")
                .and_then(|v| v.as_str())
                .map(String::from);
            let title = data.get("title").and_then(|v| v.as_str()).map(String::from);
            let note = data.get("note").and_then(|v| v.as_str()).map(String::from);
            let raw_vcard = data
                .get("rawVcard")
                .and_then(|v| v.as_str())
                .map(String::from);

            // 检查是否已存在（按 account_id + remote_uid）
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM contacts WHERE account_id = ?1 AND remote_uid = ?2",
                    params![req.account_id, sc.remote_uid],
                    |row| row.get(0),
                )
                .ok();
            let is_update = existing.is_some();
            let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

            tx.execute(
                "INSERT OR REPLACE INTO contacts
                 (id, account_id, source, remote_uid, etag, display_name, email, email_list,
                  phone, organization, title, note, raw_vcard, last_modified, updated_at)
                 VALUES (?1, ?2, 'carddav', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    id,
                    req.account_id,
                    sc.remote_uid,
                    sc.etag,
                    display_name,
                    email,
                    email_list,
                    phone,
                    organization,
                    title,
                    note,
                    raw_vcard,
                    now,
                    now,
                ],
            )
            .map_err(|e| e.to_string())?;
            if is_update {
                updated += 1;
            } else {
                added += 1;
            }
        }

        // 处理删除（增量同步返回的 deleted_uids）
        let mut deleted = 0u32;
        for uid in &result.deleted_uids {
            let n = tx.execute(
                "DELETE FROM contacts WHERE account_id = ?1 AND remote_uid = ?2",
                params![req.account_id, uid],
            )
            .map_err(|e| e.to_string())?;
            deleted += n as u32;
        }

        // 更新同步状态
        tx.execute(
            "INSERT OR REPLACE INTO contact_sync_state
             (account_id, sync_token, last_synced_at, last_sync_status, last_error)
             VALUES (?1, ?2, ?3, 'success', NULL)",
            params![req.account_id, result.sync_token, now],
        )
        .map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;

        result.added = added;
        result.updated = updated;
        result.deleted = deleted;
        result.total = added + updated;
    } else {
        // 同步失败，记录错误
        let conn = state.conn()?;
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT OR REPLACE INTO contact_sync_state
             (account_id, sync_token, last_synced_at, last_sync_status, last_error)
             VALUES (?1, ?2, ?3, 'failed', ?4)",
            params![req.account_id, old_token, now, result.error],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn contact_test_carddav(
    gateway_url: String,
    req: CardDavTestRequest,
) -> Result<CardDavTestResponse, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/contacts/test_carddav", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("请求 gateway 失败 ({url}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("gateway 返回 {status} ({url}): {text}"));
    }
    let result: CardDavTestResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析测试结果失败: {e}"))?;
    Ok(result)
}

#[tauri::command]
pub async fn contact_sync_eas(
    state: tauri::State<'_, ContactsState>,
    gateway_url: String,
    req: EASSyncRequest,
) -> Result<ContactSyncResult, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }

    // 读取上次的 sync_key（增量同步用）
    let old_token: Option<String> = {
        let conn = state.conn()?;
        conn.query_row(
            "SELECT sync_token FROM contact_sync_state WHERE account_id = ?1",
            params![req.account_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };

    // 构造发给 Python 的请求
    let python_req = serde_json::json!({
        "accountId": req.account_id,
        "easUrl": req.eas_url,
        "username": req.username,
        "password": req.password,
        "oldSyncToken": old_token,
    });

    let url = format!("{}/contacts/sync_eas", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&python_req)
        .send()
        .await
        .map_err(|e| format!("请求 gateway 失败 ({url}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("gateway 返回 {status} ({url}): {text}"));
    }
    let mut result: ContactSyncResult = resp
        .json()
        .await
        .map_err(|e| format!("解析同步结果失败: {e}"))?;

    // 同步成功后写入 SQLite
    if result.error.is_none() {
        let conn = state.conn()?;
        let now = chrono::Utc::now().timestamp();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        // 全量同步（无 old_token）：先清空该账号的 eas 联系人
        let is_full_sync = old_token.is_none();
        if is_full_sync {
            tx.execute(
                "DELETE FROM contacts WHERE account_id = ?1 AND source = 'eas'",
                params![req.account_id],
            )
            .map_err(|e| e.to_string())?;
        }

        // upsert 联系人
        let mut added = 0u32;
        let mut updated = 0u32;
        for sc in &result.contacts {
            let data = &sc.data;
            let display_name = data
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or("(未命名)")
                .to_string();
            let email = data.get("email").and_then(|v| v.as_str()).map(String::from);
            let email_list = data
                .get("emailList")
                .and_then(|v| v.as_str())
                .map(String::from);
            let phone = data.get("phone").and_then(|v| v.as_str()).map(String::from);
            let organization = data
                .get("organization")
                .and_then(|v| v.as_str())
                .map(String::from);
            let title = data.get("title").and_then(|v| v.as_str()).map(String::from);
            let note = data.get("note").and_then(|v| v.as_str()).map(String::from);
            let raw_vcard = data
                .get("rawVcard")
                .and_then(|v| v.as_str())
                .map(String::from);

            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM contacts WHERE account_id = ?1 AND remote_uid = ?2",
                    params![req.account_id, sc.remote_uid],
                    |row| row.get(0),
                )
                .ok();
            let is_update = existing.is_some();
            let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

            tx.execute(
                "INSERT OR REPLACE INTO contacts
                 (id, account_id, source, remote_uid, etag, display_name, email, email_list,
                  phone, organization, title, note, raw_vcard, last_modified, updated_at)
                 VALUES (?1, ?2, 'eas', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    id,
                    req.account_id,
                    sc.remote_uid,
                    sc.etag,
                    display_name,
                    email,
                    email_list,
                    phone,
                    organization,
                    title,
                    note,
                    raw_vcard,
                    now,
                    now,
                ],
            )
            .map_err(|e| e.to_string())?;
            if is_update {
                updated += 1;
            } else {
                added += 1;
            }
        }

        // 处理删除
        let mut deleted = 0u32;
        for uid in &result.deleted_uids {
            let n = tx.execute(
                "DELETE FROM contacts WHERE account_id = ?1 AND remote_uid = ?2",
                params![req.account_id, uid],
            )
            .map_err(|e| e.to_string())?;
            deleted += n as u32;
        }

        // 更新同步状态
        tx.execute(
            "INSERT OR REPLACE INTO contact_sync_state
             (account_id, sync_token, last_synced_at, last_sync_status, last_error)
             VALUES (?1, ?2, ?3, 'success', NULL)",
            params![req.account_id, result.sync_token, now],
        )
        .map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;

        result.added = added;
        result.updated = updated;
        result.deleted = deleted;
        result.total = added + updated;
    } else {
        let conn = state.conn()?;
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT OR REPLACE INTO contact_sync_state
             (account_id, sync_token, last_synced_at, last_sync_status, last_error)
             VALUES (?1, ?2, ?3, 'failed', ?4)",
            params![req.account_id, old_token, now, result.error],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn contact_test_eas(
    gateway_url: String,
    req: EASTestRequest,
) -> Result<CardDavTestResponse, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/contacts/test_eas", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("请求 gateway 失败 ({url}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("gateway 返回 {status} ({url}): {text}"));
    }
    let result: CardDavTestResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析测试结果失败: {e}"))?;
    Ok(result)
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

fn map_contact_row(row: &rusqlite::Row) -> rusqlite::Result<Contact> {
    Ok(Contact {
        id: row.get(0)?,
        account_id: row.get(1)?,
        source: row.get(2)?,
        remote_uid: row.get(3)?,
        etag: row.get(4)?,
        display_name: row.get(5)?,
        email: row.get(6)?,
        email_list: row.get(7)?,
        phone: row.get(8)?,
        organization: row.get(9)?,
        title: row.get(10)?,
        note: row.get(11)?,
        raw_vcard: row.get(12)?,
        last_modified: row.get(13)?,
        updated_at: row.get(14)?,
    })
}
