//! Email module: SQLite cache for accounts/messages + gateway bridge for IMAP/SMTP.
//!
//! 收发逻辑复用 Python 侧 `mona/channels/email.py`，Rust 侧只做本地缓存和
//! gateway HTTP 转发，避免引入 imap/lettre 等重型依赖。

use crate::settings::app_data_dir;
use base64::Engine;
use ring::aead;
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const EMAIL_DB_FILE: &str = "email.sqlite3";
const ENCRYPT_SALT: &[u8] = b"mona-email-v1-salt";
const NONCE_LEN: usize = 12;

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAccount {
    pub id: String,
    pub display_name: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_username: String,
    pub smtp_password: String,
    pub from_address: String,
    /// 发信名称（发邮件时 From 头的显示名），为空时使用 from_address
    #[serde(default)]
    pub from_name: Option<String>,
    #[serde(default)]
    pub last_synced_uid: Option<String>,
    /// CardDAV 地址簿服务地址（为空表示不同步通讯录）
    #[serde(default)]
    pub carddav_url: Option<String>,
    /// Exchange ActiveSync 服务地址（企业邮通讯录同步，为空表示不使用）
    #[serde(default)]
    pub eas_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailMessage {
    pub uid: String,
    pub account_id: String,
    #[serde(default = "default_mailbox")]
    pub folder: String,
    pub subject: String,
    pub from_address: String,
    #[serde(default)]
    pub from_name: Option<String>,
    pub to_addresses: String,
    #[serde(default)]
    pub cc_addresses: Option<String>,
    pub date: String,
    pub body_text: String,
    #[serde(default)]
    pub body_html: Option<String>,
    pub has_attachments: bool,
    pub is_read: bool,
    pub is_starred: bool,
    pub raw_size: u32,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub attachments: Vec<EmailAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAttachment {
    pub filename: String,
    pub content_type: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub account_id: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    #[serde(default = "default_mailbox")]
    pub mailbox: String,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
    #[serde(default)]
    pub last_uid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_username: String,
    pub smtp_password: String,
    #[serde(default = "default_true")]
    pub use_tls: bool,
    #[serde(default)]
    pub use_ssl: bool,
    pub from_address: String,
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub body_html: String,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub attachments: Vec<EmailAttachmentInput>,
    // IMAP 配置：用于发送成功后通过 IMAP APPEND 保存副本到"已发送"文件夹。
    // 全部带 default，旧前端不传这些字段时自动跳过保存副本。
    #[serde(default)]
    pub imap_host: String,
    #[serde(default = "default_imap_port")]
    pub imap_port: u16,
    #[serde(default)]
    pub imap_username: String,
    #[serde(default)]
    pub imap_password: String,
    #[serde(default = "default_true")]
    pub imap_use_ssl: bool,
    #[serde(default)]
    pub from_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRequest {
    pub account_id: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    pub mailbox: String,
    pub uid: String,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFlagRequest {
    pub account_id: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    pub mailbox: String,
    pub uid: String,
    pub flag: String,
    pub add: bool,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
}

/// 文件夹级操作请求（全部标为已读、清空文件夹等）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderActionRequest {
    pub account_id: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    pub mailbox: String,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveRequest {
    pub account_id: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    pub mailbox: String,
    pub dest_mailbox: String,
    pub uid: String,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFolderRequest {
    pub account_id: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    pub mailbox: String,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
}

fn default_mailbox() -> String {
    "INBOX".to_string()
}
fn default_true() -> bool {
    true
}

fn default_imap_port() -> u16 {
    993
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

pub struct EmailState {
    pub db_path: PathBuf,
}

impl EmailState {
    pub fn new() -> Self {
        let db_path = app_data_dir().join(EMAIL_DB_FILE);
        Self { db_path }
    }

    fn conn(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.db_path).map_err(|e| e.to_string())?;
        // 设置锁等待超时：并发写时等待最多 5 秒，避免 "database is locked" 立即失败
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                imap_host TEXT NOT NULL,
                imap_port INTEGER NOT NULL,
                imap_username TEXT NOT NULL,
                imap_password TEXT NOT NULL,
                smtp_host TEXT NOT NULL,
                smtp_port INTEGER NOT NULL,
                smtp_username TEXT NOT NULL,
                smtp_password TEXT NOT NULL,
                from_address TEXT NOT NULL,
                last_synced_uid TEXT,
                from_name TEXT,
                carddav_url TEXT,
                eas_url TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                uid TEXT NOT NULL,
                account_id TEXT NOT NULL,
                subject TEXT NOT NULL,
                from_address TEXT NOT NULL,
                from_name TEXT,
                to_addresses TEXT NOT NULL,
                date TEXT NOT NULL,
                body_text TEXT NOT NULL,
                body_html TEXT,
                has_attachments INTEGER NOT NULL DEFAULT 0,
                is_read INTEGER NOT NULL DEFAULT 0,
                is_starred INTEGER NOT NULL DEFAULT 0,
                raw_size INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (uid, account_id)
            );
            ",
        )
        .map_err(|e| e.to_string())?;
        // 迁移：给旧表加 folder 列（必须在 CREATE INDEX 之前完成）
        let has_folder: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('messages') WHERE name='folder'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_folder {
            conn.execute(
                "ALTER TABLE messages ADD COLUMN folder TEXT NOT NULL DEFAULT 'INBOX'",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：主键从 (uid, account_id) 升级为 (uid, account_id, folder)
        // SQLite 不支持 ALTER PRIMARY KEY，通过重建表实现
        let pk_has_folder: bool = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|sql| sql.contains("uid, account_id, folder"))
            .unwrap_or(false);
        if has_folder && !pk_has_folder {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS messages_new (
                    uid TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    folder TEXT NOT NULL DEFAULT 'INBOX',
                    subject TEXT NOT NULL,
                    from_address TEXT NOT NULL,
                    from_name TEXT,
                    to_addresses TEXT NOT NULL,
                    date TEXT NOT NULL,
                    body_text TEXT NOT NULL,
                    body_html TEXT,
                    has_attachments INTEGER NOT NULL DEFAULT 0,
                    is_read INTEGER NOT NULL DEFAULT 0,
                    is_starred INTEGER NOT NULL DEFAULT 0,
                    raw_size INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (uid, account_id, folder)
                );
                INSERT OR IGNORE INTO messages_new
                    (uid, account_id, folder, subject, from_address, from_name, to_addresses, date,
                     body_text, body_html, has_attachments, is_read, is_starred, raw_size)
                SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses, date,
                       body_text, body_html, has_attachments, is_read, is_starred, raw_size
                FROM messages;
                DROP TABLE messages;
                ALTER TABLE messages_new RENAME TO messages;
                ",
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：添加 cc_addresses 列
        let has_cc: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('messages') WHERE name='cc_addresses'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_cc {
            conn.execute(
                "ALTER TABLE messages ADD COLUMN cc_addresses TEXT",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：添加 message_id 列
        let has_msgid: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('messages') WHERE name='message_id'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_msgid {
            conn.execute(
                "ALTER TABLE messages ADD COLUMN message_id TEXT",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：添加 attachments_json 列
        let has_att: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('messages') WHERE name='attachments_json'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_att {
            conn.execute(
                "ALTER TABLE messages ADD COLUMN attachments_json TEXT",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：添加 from_name 列
        let has_from_name: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('messages') WHERE name='from_name'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_from_name {
            conn.execute(
                "ALTER TABLE messages ADD COLUMN from_name TEXT",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：accounts 表添加 from_name 列（发信名称）
        let has_account_from_name: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('accounts') WHERE name='from_name'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_account_from_name {
            conn.execute(
                "ALTER TABLE accounts ADD COLUMN from_name TEXT",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：accounts 表添加 carddav_url 列（通讯录同步地址）
        let has_carddav_url: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('accounts') WHERE name='carddav_url'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_carddav_url {
            conn.execute(
                "ALTER TABLE accounts ADD COLUMN carddav_url TEXT",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：accounts 表添加 eas_url 列（Exchange ActiveSync 通讯录同步地址）
        let has_eas_url: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('accounts') WHERE name='eas_url'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_eas_url {
            conn.execute(
                "ALTER TABLE accounts ADD COLUMN eas_url TEXT",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // AI 分析结果表（人工单次触发后存储）
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS email_ai_analysis (
                uid TEXT NOT NULL,
                account_id TEXT NOT NULL,
                folder TEXT NOT NULL,
                summary TEXT NOT NULL,
                category TEXT NOT NULL,
                intent TEXT NOT NULL,
                urgency TEXT NOT NULL,
                sentiment TEXT NOT NULL,
                key_info TEXT NOT NULL DEFAULT '{}',
                analyzed_at TEXT NOT NULL,
                PRIMARY KEY (uid, account_id, folder)
            );",
        )
        .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_messages_account_folder_date
                ON messages(account_id, folder, date DESC);
            ",
        )
        .map_err(|e| e.to_string())?;
        // 文件夹结构本地缓存表
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS folders (
                account_id TEXT NOT NULL,
                name TEXT NOT NULL,
                delimiter TEXT NOT NULL DEFAULT '/',
                flags TEXT NOT NULL DEFAULT '',
                has_children INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (account_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id);
            ",
        )
        .map_err(|e| e.to_string())?;
        Ok(conn)
    }
}

// ---------------------------------------------------------------------------
// 密码加密（AES-256-GCM，密钥派生自机器标识）
// ---------------------------------------------------------------------------

fn machine_id() -> String {
    // 用 UUID v4 作为机器标识，持久化到 app_data_dir
    let id_file = app_data_dir().join("machine.id");
    if let Ok(id) = std::fs::read_to_string(&id_file) {
        if !id.trim().is_empty() {
            return id.trim().to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(app_data_dir());
    let _ = std::fs::write(&id_file, &id);
    id
}

fn derive_key() -> [u8; 32] {
    let machine = machine_id();
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        std::num::NonZeroU32::new(100_000).unwrap(),
        ENCRYPT_SALT,
        machine.as_bytes(),
        &mut key,
    );
    key
}

pub fn encrypt_password(plain: &str) -> Result<String, String> {
    let key_bytes = derive_key();
    let rng = SystemRandom::new();
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut nonce)
        .map_err(|e| format!("rng error: {e}"))?;
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes).map_err(|e| format!("{e:?}"))?,
    );
    let mut in_out = plain.as_bytes().to_vec();
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::empty(),
        &mut in_out,
    )
    .map_err(|e| format!("{e:?}"))?;
    let mut combined = nonce.to_vec();
    combined.extend_from_slice(&in_out);
    Ok(base64::engine::general_purpose::STANDARD.encode(&combined))
}

pub fn decrypt_password(cipher: &str) -> Result<String, String> {
    let key_bytes = derive_key();
    let combined = base64::engine::general_purpose::STANDARD
        .decode(cipher)
        .map_err(|e| e.to_string())?;
    if combined.len() < NONCE_LEN {
        return Err("invalid ciphertext".into());
    }
    let nonce: [u8; NONCE_LEN] = combined[..NONCE_LEN]
        .try_into()
        .map_err(|_| "nonce length mismatch")?;
    let mut ciphertext = combined[NONCE_LEN..].to_vec();
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes).map_err(|e| format!("{e:?}"))?,
    );
    let plaintext = key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::empty(),
            &mut ciphertext,
        )
        .map_err(|e| format!("decrypt failed: {e:?}"))?;
    String::from_utf8(plaintext.to_vec()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tauri 命令 — 账号管理
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn email_list_accounts(
    state: tauri::State<'_, EmailState>,
) -> Result<Vec<EmailAccount>, String> {
    let conn = state.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, display_name, imap_host, imap_port, imap_username, imap_password,
                    smtp_host, smtp_port, smtp_username, smtp_password, from_address,
                    from_name, last_synced_uid, carddav_url, eas_url
             FROM accounts ORDER BY display_name",
        )
        .map_err(|e| e.to_string())?;
    let accounts = stmt
        .query_map([], |row| {
            Ok(EmailAccount {
                id: row.get(0)?,
                display_name: row.get(1)?,
                imap_host: row.get(2)?,
                imap_port: row.get(3)?,
                imap_username: row.get(4)?,
                imap_password: row.get(5)?,
                smtp_host: row.get(6)?,
                smtp_port: row.get(7)?,
                smtp_username: row.get(8)?,
                smtp_password: row.get(9)?,
                from_address: row.get(10)?,
                from_name: row.get(11)?,
                last_synced_uid: row.get(12)?,
                carddav_url: row.get(13)?,
                eas_url: row.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(accounts)
}

#[tauri::command]
pub async fn email_add_account(
    state: tauri::State<'_, EmailState>,
    account: EmailAccount,
) -> Result<(), String> {
    let conn = state.conn()?;
    let enc_imap = encrypt_password(&account.imap_password)?;
    let enc_smtp = encrypt_password(&account.smtp_password)?;
    conn.execute(
        "INSERT OR REPLACE INTO accounts
         (id, display_name, imap_host, imap_port, imap_username, imap_password,
          smtp_host, smtp_port, smtp_username, smtp_password, from_address, from_name,
          last_synced_uid, carddav_url, eas_url)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            account.id,
            account.display_name,
            account.imap_host,
            account.imap_port,
            account.imap_username,
            enc_imap,
            account.smtp_host,
            account.smtp_port,
            account.smtp_username,
            enc_smtp,
            account.from_address,
            account.from_name,
            account.last_synced_uid,
            account.carddav_url,
            account.eas_url,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn email_delete_account(
    state: tauri::State<'_, EmailState>,
    account_id: String,
) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute("DELETE FROM messages WHERE account_id = ?1", params![account_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders WHERE account_id = ?1", params![account_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", params![account_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri 命令 — 邮件缓存
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn email_get_messages(
    state: tauri::State<'_, EmailState>,
    account_id: String,
    folder: String,
    offset: u32,
    limit: u32,
) -> Result<Vec<EmailMessage>, String> {
    let conn = state.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                    date, body_text, body_html, has_attachments, is_read, is_starred, raw_size,
                    message_id, attachments_json
             FROM messages WHERE account_id = ?1 AND folder = ?2
             ORDER BY date DESC LIMIT ?3 OFFSET ?4",
        )
        .map_err(|e| e.to_string())?;
    let msgs = stmt
        .query_map(params![account_id, folder, limit, offset], |row| {
            let attachments_json: Option<String> = row.get(16)?;
            let attachments: Vec<EmailAttachment> = attachments_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();
            Ok(EmailMessage {
                uid: row.get(0)?,
                account_id: row.get(1)?,
                folder: row.get(2)?,
                subject: row.get(3)?,
                from_address: row.get(4)?,
                from_name: row.get(5)?,
                to_addresses: row.get(6)?,
                cc_addresses: row.get(7)?,
                date: row.get(8)?,
                body_text: row.get(9)?,
                body_html: row.get(10)?,
                has_attachments: row.get::<_, i32>(11)? != 0,
                is_read: row.get::<_, i32>(12)? != 0,
                is_starred: row.get::<_, i32>(13)? != 0,
                raw_size: row.get(14)?,
                message_id: row.get(15)?,
                attachments,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(msgs)
}

#[tauri::command]
pub async fn email_mark_read(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: SetFlagRequest,
) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/set_flag", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    // 本地缓存同步更新
    let conn = state.conn()?;
    let value: i32 = if req.add { 1 } else { 0 };
    conn.execute(
        "UPDATE messages SET is_read = ?1 WHERE uid = ?2 AND account_id = ?3 AND folder = ?4",
        params![value, req.uid, req.account_id, req.mailbox],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn email_toggle_starred(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: SetFlagRequest,
) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/set_flag", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    // 本地缓存同步更新
    let conn = state.conn()?;
    let value: i32 = if req.add { 1 } else { 0 };
    conn.execute(
        "UPDATE messages SET is_starred = ?1 WHERE uid = ?2 AND account_id = ?3 AND folder = ?4",
        params![value, req.uid, req.account_id, req.mailbox],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn email_move_message(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: MoveRequest,
) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/move", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    // 本地缓存：从原文件夹删除（目标文件夹会在下次同步时拉取）
    let conn = state.conn()?;
    conn.execute(
        "DELETE FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
        params![req.uid, req.account_id, req.mailbox],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchAttachmentRequest {
    pub account_id: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    pub mailbox: String,
    pub uid: String,
    pub filename: String,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchAttachmentResponse {
    pub filename: String,
    pub content_type: String,
    pub size: u64,
    pub data: String, // base64 编码
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAttachmentInput {
    pub filename: String,
    pub content_type: String,
    pub data: String, // base64 编码（无 data: 前缀）
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraftRequest {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
    pub from_address: String,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    pub subject: String,
    pub body_html: String,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub attachments: Vec<EmailAttachmentInput>,
}

#[tauri::command]
pub async fn email_save_draft(
    gateway_url: String,
    req: SaveDraftRequest,
) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/save_draft", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionRequest {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResponse {
    pub ok: bool,
    #[serde(default)]
    pub folders: u32,
}

#[tauri::command]
pub async fn email_test_connection(
    gateway_url: String,
    req: TestConnectionRequest,
) -> Result<TestConnectionResponse, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/test_connection", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    resp.json::<TestConnectionResponse>()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))
}

#[tauri::command]
pub async fn email_fetch_attachment(
    gateway_url: String,
    req: FetchAttachmentRequest,
) -> Result<FetchAttachmentResponse, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/fetch_attachment", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    resp.json::<FetchAttachmentResponse>()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))
}

// ---------------------------------------------------------------------------
// Tauri 命令 — 收发桥接（调用 Python gateway）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderRequest {
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailFolder {
    pub name: String,
    pub delimiter: String,
    pub has_children: bool,
    pub flags: String,
    #[serde(default)]
    pub unread_count: u32,
}

#[tauri::command]
pub async fn email_list_folders(
    gateway_url: String,
    req: FolderRequest,
) -> Result<Vec<EmailFolder>, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/folders", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    resp.json::<Vec<EmailFolder>>()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))
}

/// 从本地数据库读取账号的文件夹缓存，立即返回，不访问 IMAP。
#[tauri::command]
pub async fn email_get_folders(
    state: tauri::State<'_, EmailState>,
    account_id: String,
) -> Result<Vec<EmailFolder>, String> {
    let conn = state.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT name, delimiter, flags, has_children
             FROM folders WHERE account_id = ?1 ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let folders = stmt
        .query_map(params![account_id], |row| {
            Ok(EmailFolder {
                name: row.get(0)?,
                delimiter: row.get(1)?,
                flags: row.get(2)?,
                has_children: row.get::<_, i32>(3)? != 0,
                unread_count: 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(folders)
}

/// 连接 IMAP 拉取最新文件夹列表并写入本地缓存，返回同步后的列表。
#[tauri::command]
pub async fn email_sync_folders(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    account_id: String,
    req: FolderRequest,
) -> Result<Vec<EmailFolder>, String> {
    let folders = email_list_folders(gateway_url, req).await?;
    let conn = state.conn()?;
    let now = chrono::Local::now();
    let updated_at = now.to_rfc3339();
    // 60 秒前的时间戳：刚创建的文件夹（updated_at 晚于此时间）即使 IMAP LIST
    // 瞬态未返回也保留，避免新建后立即被后台同步清掉
    let recent_threshold = (now - chrono::Duration::seconds(60)).to_rfc3339();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // 只删除"旧"文件夹，保留 60 秒内创建的（IMAP 可能尚未同步）
    tx.execute(
        "DELETE FROM folders WHERE account_id = ?1 AND updated_at <= ?2",
        params![account_id, recent_threshold],
    )
    .map_err(|e| e.to_string())?;
    for folder in &folders {
        tx.execute(
            "INSERT OR REPLACE INTO folders (account_id, name, delimiter, flags, has_children, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                account_id,
                folder.name,
                folder.delimiter.clone(),
                folder.flags.clone(),
                if folder.has_children { 1 } else { 0 },
                updated_at.clone(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    // 返回本地数据库合并后的完整列表（含被保留的新文件夹），
    // 而非 IMAP 原始列表，确保前端拿到包含新文件夹的完整列表
    let mut stmt = conn
        .prepare(
            "SELECT name, delimiter, flags, has_children
             FROM folders WHERE account_id = ?1 ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let local_folders: Vec<EmailFolder> = stmt
        .query_map(params![account_id], |row| {
            Ok(EmailFolder {
                name: row.get(0)?,
                delimiter: row.get(1)?,
                flags: row.get(2)?,
                has_children: row.get::<_, i32>(3)? != 0,
                unread_count: 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(local_folders)
}

/// 从本地数据库统计各文件夹的未读邮件数，比 IMAP STATUS UNSEEN 更准确
#[tauri::command]
pub async fn email_unread_counts(
    state: tauri::State<'_, EmailState>,
    account_id: String,
) -> Result<std::collections::HashMap<String, u32>, String> {
    let conn = state.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT folder, COUNT(*) as cnt FROM messages
             WHERE account_id = ?1 AND is_read = 0
             GROUP BY folder",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for row in rows.flatten() {
        map.insert(row.0, row.1);
    }
    Ok(map)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStats {
    pub folder: String,
    pub count: u32,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailStatistics {
    pub account_id: String,
    pub total_count: u32,
    pub total_size: u64,
    pub folders: Vec<FolderStats>,
}

/// 从本地数据库统计账号下各文件夹的邮件数量和占用空间
#[tauri::command]
pub async fn email_statistics(
    state: tauri::State<'_, EmailState>,
    account_id: String,
) -> Result<EmailStatistics, String> {
    let conn = state.conn()?;
    let mut stmt = conn
        .prepare(
            "SELECT folder, COUNT(*) as cnt, COALESCE(SUM(raw_size), 0) as total_size
             FROM messages
             WHERE account_id = ?1
             GROUP BY folder
             ORDER BY total_size DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id], |row| {
            Ok(FolderStats {
                folder: row.get::<_, String>(0)?,
                count: row.get::<_, u32>(1)?,
                size: row.get::<_, u64>(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut folders: Vec<FolderStats> = rows.filter_map(|r| r.ok()).collect();
    if folders.is_empty() {
        // 没有任何邮件时至少返回一个空统计，避免前端空状态
        folders = vec![];
    }
    let total_count = folders.iter().map(|f| f.count).sum();
    let total_size = folders.iter().map(|f| f.size).sum();
    Ok(EmailStatistics {
        account_id,
        total_count,
        total_size,
        folders,
    })
}

#[tauri::command]
pub async fn email_create_folder(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: CreateFolderRequest,
) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/create_folder", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    // 创建成功后立即写入本地缓存，避免 IMAP LIST 延迟导致文件夹树短暂空白
    let conn = state.conn()?;
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT OR REPLACE INTO folders (account_id, name, delimiter, flags, has_children, updated_at)
         VALUES (?1, ?2, '/', '', 0, ?3)",
        params![&req.account_id, &req.mailbox, now],
    )
    .map_err(|e| format!("写入本地文件夹缓存失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn email_sync(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: SyncRequest,
) -> Result<u32, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/sync", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    let new_messages: Vec<Value> = resp.json().await.map_err(|e| format!("解析响应失败: {e}"))?;

    let conn = state.conn()?;
    let mut new_count = 0u32;
    for msg in &new_messages {
        let uid = msg["uid"].as_str().unwrap_or("").to_string();
        if uid.is_empty() {
            continue;
        }
        // 检查该邮件是否已存在（用于统计真正的新增数）
        let existed: bool = conn
            .query_row(
                "SELECT 1 FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![&uid, &req.account_id, &req.mailbox],
                |_| Ok(true),
            )
            .unwrap_or(false);
        // UPSERT：更新邮件内容但保留用户已设置的 is_read/is_starred
        let attachments_json = if msg.get("attachments").is_some() {
            serde_json::to_string(&msg["attachments"]).unwrap_or_default()
        } else {
            String::new()
        };
        conn.execute(
            "INSERT INTO messages
             (uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
              date, body_text, body_html, has_attachments, is_read, is_starred, raw_size,
              message_id, attachments_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15, ?16)
             ON CONFLICT(uid, account_id, folder) DO UPDATE SET
              subject=excluded.subject,
              from_address=excluded.from_address,
              from_name=excluded.from_name,
              to_addresses=excluded.to_addresses,
              cc_addresses=excluded.cc_addresses,
              date=excluded.date,
              body_text=excluded.body_text,
              body_html=excluded.body_html,
              has_attachments=excluded.has_attachments,
              raw_size=excluded.raw_size,
              message_id=excluded.message_id,
              attachments_json=excluded.attachments_json,
              is_read=CASE WHEN messages.is_read=1 THEN 1 ELSE excluded.is_read END",
            params![
                uid,
                req.account_id,
                req.mailbox,
                msg["subject"].as_str().unwrap_or("(no subject)"),
                msg["from"].as_str().unwrap_or(""),
                msg.get("fromName").and_then(|v| v.as_str()),
                msg["to"].as_str().unwrap_or("[]"),
                msg.get("cc").and_then(|v| v.as_str()),
                msg["date"].as_str().unwrap_or(""),
                msg["bodyText"].as_str().unwrap_or(""),
                msg.get("bodyHtml").and_then(|v| v.as_str()),
                msg["hasAttachments"].as_bool().unwrap_or(false) as i32,
                msg["isRead"].as_bool().unwrap_or(false) as i32,
                msg["rawSize"].as_u64().unwrap_or(0) as u32,
                msg.get("messageId").and_then(|v| v.as_str()),
                if attachments_json.is_empty() { None } else { Some(&attachments_json) },
            ],
        )
        .map_err(|e| e.to_string())?;
        if !existed {
            new_count += 1;
        }
    }
    // 更新 last_synced_uid（取本次同步中最大的 UID）
    if let Some(max_uid) = new_messages
        .iter()
        .filter_map(|m| m["uid"].as_str())
        .filter_map(|s| s.parse::<u64>().ok())
        .max()
    {
        conn.execute(
            "UPDATE accounts SET last_synced_uid = ?1 WHERE id = ?2",
            params![max_uid.to_string(), req.account_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(new_count)
}

// ---------------------------------------------------------------------------
// IMAP IDLE 实时推送：启动/停止指定账号的 IDLE 监听
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleStartRequest {
    pub account_id: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    #[serde(default = "default_mailbox")]
    pub mailbox: String,
    #[serde(default = "default_true")]
    pub use_ssl: bool,
}

/// 启动指定账号的 IMAP IDLE 监听。gateway 会保持长连接，新邮件到达时通过 WebSocket 推送。
#[tauri::command]
pub async fn email_start_idle(
    gateway_url: String,
    req: IdleStartRequest,
) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/idle/start", gateway_url.trim_end_matches('/'));
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
    Ok(())
}

/// 停止指定账号的 IMAP IDLE 监听。
#[tauri::command]
pub async fn email_stop_idle(gateway_url: String, account_id: String) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/idle/stop", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "accountId": account_id }))
        .send()
        .await
        .map_err(|e| format!("请求 gateway 失败 ({url}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("gateway 返回 {status} ({url}): {text}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn email_send(gateway_url: String, req: SendRequest) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/send", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn email_delete_message(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: DeleteRequest,
) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/delete", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    // 本地缓存也删除
    let conn = state.conn()?;
    conn.execute(
        "DELETE FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
        params![req.uid, req.account_id, req.mailbox],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 将指定文件夹所有邮件标记为已读
#[tauri::command]
pub async fn email_mark_all_read(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: FolderActionRequest,
) -> Result<u32, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/mark_all_read", gateway_url.trim_end_matches('/'));
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
    let result: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let count = result
        .get("count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    // 本地缓存同步：将该文件夹所有邮件标记为已读
    let conn = state.conn()?;
    conn.execute(
        "UPDATE messages SET is_read = 1 WHERE account_id = ?1 AND folder = ?2",
        params![req.account_id, req.mailbox],
    )
    .map_err(|e| e.to_string())?;
    Ok(count)
}

/// 清空指定文件夹中的所有邮件
#[tauri::command]
pub async fn email_empty_folder(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: FolderActionRequest,
) -> Result<u32, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/empty_folder", gateway_url.trim_end_matches('/'));
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
    let result: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let count = result
        .get("count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    // 本地缓存同步：删除该文件夹所有邮件
    let conn = state.conn()?;
    conn.execute(
        "DELETE FROM messages WHERE account_id = ?1 AND folder = ?2",
        params![req.account_id, req.mailbox],
    )
    .map_err(|e| e.to_string())?;
    Ok(count)
}

// ---------------------------------------------------------------------------
// Tauri 命令 — 解密账号密码（供前端 sync/send 时使用）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn email_get_decrypted_password(
    state: tauri::State<'_, EmailState>,
    account_id: String,
    field: String, // "imap" or "smtp"
) -> Result<String, String> {
    let conn = state.conn()?;
    let column = match field.as_str() {
        "imap" => "imap_password",
        "smtp" => "smtp_password",
        _ => return Err("field must be 'imap' or 'smtp'".into()),
    };
    let sql = format!("SELECT {column} FROM accounts WHERE id = ?1");
    let cipher: Option<String> = conn
        .query_row(&sql, params![account_id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    match cipher {
        Some(c) => decrypt_password(&c),
        None => Err("account not found".into()),
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenComposeWindowPayload {
    pub mode: String, // "compose" | "reply" | "replyAll" | "forward"
    pub account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_message: Option<serde_json::Value>,
}

/// 打开独立的邮件撰写窗口（Foxmail 风格新窗口）
#[tauri::command]
pub async fn email_open_compose_window(
    app: AppHandle,
    payload: OpenComposeWindowPayload,
) -> Result<String, String> {
    let label = format!("compose-{}", uuid::Uuid::new_v4());
    let title = match payload.mode.as_str() {
        "reply" => "回复邮件",
        "replyAll" => "回复全部",
        "forward" => "转发邮件",
        _ => "写邮件",
    };
    let json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.as_bytes());
    let url = format!("#/compose?data={}", encoded);

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(900.0, 680.0)
        .min_inner_size(640.0, 480.0)
        .decorations(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();

    Ok(label)
}

/// 关闭当前邮件撰写窗口
#[tauri::command]
pub async fn email_close_compose_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// AI 邮件分析结果存储（人工单次触发后持久化）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAnalysis {
    pub uid: String,
    pub account_id: String,
    pub folder: String,
    pub summary: String,
    pub category: String,
    pub intent: String,
    pub urgency: String,
    pub sentiment: String,
    /// keyInfo 原始 JSON 字符串，前端解析
    pub key_info: String,
    pub analyzed_at: String,
}

/// 读取本地缓存的 AI 分析结果（无则返回 None）
#[tauri::command]
pub async fn email_get_analysis(
    state: tauri::State<'_, EmailState>,
    uid: String,
    account_id: String,
    folder: String,
) -> Result<Option<EmailAnalysis>, String> {
    let conn = state.conn()?;
    let row = conn
        .query_row(
            "SELECT uid, account_id, folder, summary, category, intent, urgency, sentiment,
                    key_info, analyzed_at
             FROM email_ai_analysis
             WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
            params![uid, account_id, folder],
            |row| {
                Ok(EmailAnalysis {
                    uid: row.get(0)?,
                    account_id: row.get(1)?,
                    folder: row.get(2)?,
                    summary: row.get(3)?,
                    category: row.get(4)?,
                    intent: row.get(5)?,
                    urgency: row.get(6)?,
                    sentiment: row.get(7)?,
                    key_info: row.get(8)?,
                    analyzed_at: row.get(9)?,
                })
            },
        );
    match row {
        Ok(analysis) => Ok(Some(analysis)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 保存 AI 分析结果（INSERT OR REPLACE）
#[tauri::command]
pub async fn email_save_analysis(
    state: tauri::State<'_, EmailState>,
    analysis: EmailAnalysis,
) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute(
        "INSERT OR REPLACE INTO email_ai_analysis
            (uid, account_id, folder, summary, category, intent, urgency, sentiment,
             key_info, analyzed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            analysis.uid,
            analysis.account_id,
            analysis.folder,
            analysis.summary,
            analysis.category,
            analysis.intent,
            analysis.urgency,
            analysis.sentiment,
            analysis.key_info,
            analysis.analyzed_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// AI 邮件分析：Rust 转发到 Python /email/analyze（避免前端跨域）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeImage {
    /// base64 编码（无 data: 前缀）
    pub data: String,
    /// MIME 类型，如 "image/png"
    pub mime: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeRequest {
    pub subject: String,
    pub from_address: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    pub date: String,
    pub body_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_html: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<AnalyzeImage>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResponse {
    pub summary: String,
    pub category: String,
    pub intent: String,
    pub urgency: String,
    pub sentiment: String,
    pub key_info: String,
}

/// 调用 Python 后端分析邮件（人工单次触发）
#[tauri::command]
pub async fn email_analyze(
    gateway_url: String,
    req: AnalyzeRequest,
) -> Result<AnalyzeResponse, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/analyze", gateway_url.trim_end_matches('/'));
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
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    resp.json::<AnalyzeResponse>()
        .await
        .map_err(|e| format!("解析 gateway 响应失败: {e}"))
}

// ==================== 邮件搜索（跨文件夹/跨账号） ====================

fn default_search_limit() -> u32 {
    50
}

/// 搜索结果（不含正文，节省内存）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSearchResult {
    pub uid: String,
    pub account_id: String,
    pub folder: String,
    pub subject: String,
    pub from_address: String,
    pub from_name: Option<String>,
    pub to_addresses: String,
    pub date: String,
    pub has_attachments: bool,
    pub is_read: bool,
    pub is_starred: bool,
    pub raw_size: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSearchRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyword: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_read: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_starred: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_attachments: Option<bool>,
    #[serde(default = "default_search_limit")]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

/// 跨文件夹/跨账号搜索邮件（SQL LIKE，只读本地缓存）
#[tauri::command]
pub async fn email_search_messages(
    state: tauri::State<'_, EmailState>,
    req: EmailSearchRequest,
) -> Result<Vec<EmailSearchResult>, String> {
    let conn = state.conn()?;
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(ref v) = req.account_id {
        conditions.push(format!("account_id = ?{}", params.len() + 1));
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = req.folder {
        conditions.push(format!("folder = ?{}", params.len() + 1));
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = req.keyword {
        conditions.push(format!(
            "(subject LIKE ?{} OR body_text LIKE ?{})",
            params.len() + 1,
            params.len() + 2
        ));
        let kw = format!("%{v}%");
        params.push(Box::new(kw.clone()));
        params.push(Box::new(kw));
    }
    if let Some(ref v) = req.from_address {
        conditions.push(format!("from_address LIKE ?{}", params.len() + 1));
        params.push(Box::new(format!("%{v}%")));
    }
    if let Some(ref v) = req.from_name {
        conditions.push(format!("from_name LIKE ?{}", params.len() + 1));
        params.push(Box::new(format!("%{v}%")));
    }
    if let Some(ref v) = req.date_from {
        conditions.push(format!("date >= ?{}", params.len() + 1));
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = req.date_to {
        conditions.push(format!("date <= ?{}", params.len() + 1));
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = req.is_read {
        conditions.push(format!("is_read = ?{}", params.len() + 1));
        params.push(Box::new(if v { 1i32 } else { 0i32 }));
    }
    if let Some(v) = req.is_starred {
        conditions.push(format!("is_starred = ?{}", params.len() + 1));
        params.push(Box::new(if v { 1i32 } else { 0i32 }));
    }
    if let Some(v) = req.has_attachments {
        conditions.push(format!("has_attachments = ?{}", params.len() + 1));
        params.push(Box::new(if v { 1i32 } else { 0i32 }));
    }

    let limit = req.limit.clamp(1, 200);
    let offset = req.offset;

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses,
                date, has_attachments, is_read, is_starred, raw_size
         FROM messages {where_clause}
         ORDER BY date DESC LIMIT ?{} OFFSET ?{}",
        params.len() + 1,
        params.len() + 2
    );

    params.push(Box::new(limit));
    params.push(Box::new(offset));

    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let msgs = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(EmailSearchResult {
                uid: row.get(0)?,
                account_id: row.get(1)?,
                folder: row.get(2)?,
                subject: row.get(3)?,
                from_address: row.get(4)?,
                from_name: row.get(5)?,
                to_addresses: row.get(6)?,
                date: row.get(7)?,
                has_attachments: row.get::<_, i32>(8)? != 0,
                is_read: row.get::<_, i32>(9)? != 0,
                is_starred: row.get::<_, i32>(10)? != 0,
                raw_size: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(msgs)
}

// ==================== 批量操作 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchActionTarget {
    pub uid: String,
    pub account_id: String,
    pub folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchActionRequest {
    pub action: String, // mark_read | mark_unread | star | unstar | move | delete
    pub messages: Vec<BatchActionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dest_folder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchActionResponse {
    pub success: u32,
    pub failed: u32,
    pub errors: Vec<String>,
}

/// 获取账号 IMAP 凭据（解密密码）
fn get_imap_credentials(conn: &Connection, account_id: &str) -> Result<EmailAccount, String> {
    conn.query_row(
        "SELECT id, display_name, imap_host, imap_port, imap_username, imap_password,
                smtp_host, smtp_port, smtp_username, smtp_password, from_address,
                from_name, last_synced_uid, carddav_url, eas_url
         FROM accounts WHERE id = ?1",
        params![account_id],
        |row| {
            Ok(EmailAccount {
                id: row.get(0)?,
                display_name: row.get(1)?,
                imap_host: row.get(2)?,
                imap_port: row.get(3)?,
                imap_username: row.get(4)?,
                imap_password: row.get(5)?,
                smtp_host: row.get(6)?,
                smtp_port: row.get(7)?,
                smtp_username: row.get(8)?,
                smtp_password: row.get(9)?,
                from_address: row.get(10)?,
                from_name: row.get(11)?,
                last_synced_uid: row.get(12)?,
                carddav_url: row.get(13)?,
                eas_url: row.get(14)?,
            })
        },
    )
    .map_err(|e| format!("账号 {account_id} 不存在: {e}"))
}

/// 批量操作邮件：标记已读/未读、加/取消星标、移动、删除。
///
/// 用户在前端确认 AI 的操作建议后调用此命令实际执行。
/// 按 account_id 分组，复用 gateway 的 /email/set_flag、/email/move、/email/delete 路由。
#[tauri::command]
pub async fn email_batch_action(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: BatchActionRequest,
) -> Result<BatchActionResponse, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }

    let valid_actions = ["mark_read", "mark_unread", "star", "unstar", "move", "delete"];
    if !valid_actions.contains(&req.action.as_str()) {
        return Err(format!(
            "无效操作 '{}'，支持: {}",
            req.action,
            valid_actions.join(", ")
        ));
    }
    if req.messages.is_empty() {
        return Err("邮件列表为空".into());
    }
    if req.action == "move" && req.dest_folder.as_deref().unwrap_or("").is_empty() {
        return Err("move 操作需要指定 dest_folder".into());
    }

    let client = reqwest::Client::new();
    let mut success: u32 = 0;
    let mut failed: u32 = 0;
    let mut errors: Vec<String> = Vec::new();

    // 按 account_id 分组，避免重复查凭据
    let mut groups: std::collections::HashMap<String, Vec<&BatchActionTarget>> =
        std::collections::HashMap::new();
    for m in &req.messages {
        groups.entry(m.account_id.clone()).or_default().push(m);
    }

    for (account_id, targets) in &groups {
        // 获取账号凭据
        let (account, plain_password) = {
            let conn = state.conn()?;
            let account = get_imap_credentials(&conn, account_id)?;
            let plain = decrypt_password(&account.imap_password)?;
            (account, plain)
        };

        for target in targets {
            let result = execute_single_action(
                &client,
                &gateway_url,
                &req.action,
                target,
                &account,
                &plain_password,
                req.dest_folder.as_deref(),
            )
            .await;

            match result {
                Ok(()) => {
                    // 同步本地缓存
                    if let Err(e) = update_local_cache(&state, &req.action, target, req.dest_folder.as_deref()) {
                        // 本地缓存更新失败不影响整体结果，但记录错误
                        errors.push(format!(
                            "uid={} 本地缓存更新失败: {e}",
                            target.uid
                        ));
                    }
                    success += 1;
                }
                Err(e) => {
                    failed += 1;
                    errors.push(format!("uid={} ({}): {e}", target.uid, target.folder));
                }
            }
        }
    }

    Ok(BatchActionResponse {
        success,
        failed,
        errors,
    })
}

/// 执行单个邮件操作（调用 gateway）
async fn execute_single_action(
    client: &reqwest::Client,
    gateway_url: &str,
    action: &str,
    target: &BatchActionTarget,
    account: &EmailAccount,
    plain_password: &str,
    dest_folder: Option<&str>,
) -> Result<(), String> {
    let base = gateway_url.trim_end_matches('/');

    match action {
        "mark_read" | "mark_unread" | "star" | "unstar" => {
            let (flag, add) = match action {
                "mark_read" => ("\\Seen", true),
                "mark_unread" => ("\\Seen", false),
                "star" => ("\\Flagged", true),
                "unstar" => ("\\Flagged", false),
                _ => unreachable!(),
            };
            let req = SetFlagRequest {
                account_id: account.id.clone(),
                imap_host: account.imap_host.clone(),
                imap_port: account.imap_port,
                imap_username: account.imap_username.clone(),
                imap_password: plain_password.to_string(),
                mailbox: target.folder.clone(),
                uid: target.uid.clone(),
                flag: flag.to_string(),
                add,
                use_ssl: true,
            };
            let url = format!("{base}/email/set_flag");
            let resp = client
                .post(&url)
                .json(&req)
                .send()
                .await
                .map_err(|e| format!("请求 gateway 失败: {e}"))?;
            if !resp.status().is_success() {
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("gateway 返回错误: {text}"));
            }
            Ok(())
        }
        "move" => {
            let dest = dest_folder.ok_or("move 操作缺少 dest_folder")?;
            let req = MoveRequest {
                account_id: account.id.clone(),
                imap_host: account.imap_host.clone(),
                imap_port: account.imap_port,
                imap_username: account.imap_username.clone(),
                imap_password: plain_password.to_string(),
                mailbox: target.folder.clone(),
                dest_mailbox: dest.to_string(),
                uid: target.uid.clone(),
                use_ssl: true,
            };
            let url = format!("{base}/email/move");
            let resp = client
                .post(&url)
                .json(&req)
                .send()
                .await
                .map_err(|e| format!("请求 gateway 失败: {e}"))?;
            if !resp.status().is_success() {
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("gateway 返回错误: {text}"));
            }
            Ok(())
        }
        "delete" => {
            let req = DeleteRequest {
                account_id: account.id.clone(),
                imap_host: account.imap_host.clone(),
                imap_port: account.imap_port,
                imap_username: account.imap_username.clone(),
                imap_password: plain_password.to_string(),
                mailbox: target.folder.clone(),
                uid: target.uid.clone(),
                use_ssl: true,
            };
            let url = format!("{base}/email/delete");
            let resp = client
                .post(&url)
                .json(&req)
                .send()
                .await
                .map_err(|e| format!("请求 gateway 失败: {e}"))?;
            if !resp.status().is_success() {
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("gateway 返回错误: {text}"));
            }
            Ok(())
        }
        _ => Err(format!("未知操作: {action}")),
    }
}

/// 批量操作后同步本地缓存
fn update_local_cache(
    state: &tauri::State<'_, EmailState>,
    action: &str,
    target: &BatchActionTarget,
    _dest_folder: Option<&str>,
) -> Result<(), String> {
    let conn = state.conn()?;
    match action {
        "mark_read" => {
            conn.execute(
                "UPDATE messages SET is_read = 1 WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
        }
        "mark_unread" => {
            conn.execute(
                "UPDATE messages SET is_read = 0 WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
        }
        "star" => {
            conn.execute(
                "UPDATE messages SET is_starred = 1 WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
        }
        "unstar" => {
            conn.execute(
                "UPDATE messages SET is_starred = 0 WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
        }
        "move" => {
            // 移动：从原文件夹删除（目标文件夹会在下次同步时拉取）
            conn.execute(
                "DELETE FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
        }
        "delete" => {
            conn.execute(
                "DELETE FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    Ok(())
}
