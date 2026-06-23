# 邮件模块 MVP 实施方案

> **For agentic workers:** 本方案采用"可一键回滚"的解耦设计。所有改动集中在独立目录 + 两个入口文件的少量 diff，删除模块时只需删目录 + 回滚两处 diff，零副作用。

**Goal:** 在 Mona 桌面端新增"邮件"一级模块，复用 Python 侧已有的 IMAP/SMTP 收发能力，提供邮件列表/阅读/写信/AI 摘要回复的 MVP 体验。

**Architecture:** 前端独立目录 `webui/src/components/email/` + Tauri 后端薄封装 `src-tauri/src/email.rs`（仅做本地 SQLite 缓存 + 调用 Python gateway HTTP API 做真实收发）。Rust 侧零新增重型依赖，IMAP/SMTP 逻辑全部复用 `mona/channels/email.py`。

**Tech Stack:** React + Zustand + Tauri + rusqlite（已有）+ Python email.py（已有）

---

## 解耦设计：一刀切清单

如果模块最终无法达到效果，按以下顺序执行即可完全移除，**不影响任何其他模块**：

| # | 操作 | 文件 |
|---|------|------|
| 1 | 删除前端目录 | `webui/src/components/email/`（整个目录） |
| 2 | 删除后端文件 | `src-tauri/src/email.rs` |
| 3 | 回滚 Sidebar | `webui/src/components/Sidebar.tsx`：移除 `TOOLBOX_ITEMS` 中"邮件"项 + `onOpenEmail` prop + 三元链分支 + `LICENSE_REQUIRED` 中的"邮件" |
| 4 | 回滚 App | `webui/src/App.tsx`：移除 `ShellView` 中的 `"email"` + lazy import + view 渲染分支 + `onOpenEmail` 回调 |
| 5 | 回滚 lib.rs | `src-tauri/src/lib.rs`：移除 `mod email;` + `.manage(email_state)` + `invoke_handler` 中的 `email::commands::*` |
| 6 | 回滚 Cargo | `src-tauri/Cargo.toml`：移除 `mail-parser` 依赖（仅此一个新增） |
| 7 | 删除数据文件 | 用户数据目录下的 `email.sqlite3`（可选，不删也不影响） |

**关键：Python 侧 `mona/channels/email.py` 完全不改动**，它作为 Channel 继续独立运行。新模块只是通过 gateway HTTP API 调用它的能力，删除模块后 Channel 不受影响。

---

## 文件结构

```
webui/src/components/email/           # 前端（全部新增）
├── EmailClientView.tsx               # 主视图，仿 DbClientView 三栏布局
├── AccountSidebar.tsx                # 左栏：账号列表 + 文件夹树
├── MailListView.tsx                  # 中栏：邮件列表
├── MailView.tsx                      # 右栏：邮件阅读
├── MailComposer.tsx                  # 写信弹窗
├── MailAgentPanel.tsx                # AI 面板（摘要/回复/分类）
├── NewAccountDialog.tsx              # 添加账号弹窗
├── store/
│   └── emailStore.ts                 # Zustand store
└── lib/
    ├── emailApi.ts                   # Tauri invoke 封装
    └── types.ts                      # TS 类型定义

src-tauri/src/email.rs                # 后端（新增）：SQLite 缓存 + gateway 调用
src-tauri/src/lib.rs                  # 修改：注册 email 模块
src-tauri/Cargo.toml                  # 修改：加 mail-parser 依赖

webui/src/components/Sidebar.tsx      # 修改：加邮件入口
webui/src/App.tsx                     # 修改：加 email 视图路由
```

---

## MVP 功能范围

### 做（P0）

1. **多账号管理**：IMAP 账号增删改查，密码加密存储
2. **邮件列表**：拉取收件箱，按时间倒序，未读标记，分页加载
3. **邮件阅读**：HTML/纯文本渲染，附件列表，内联图片
4. **写信发信**：收件人/抄送/主题/正文（富文本），附件上传
5. **本地缓存**：邮件元数据 + 正文存 SQLite，离线可读
6. **AI 摘要**：一键总结长邮件
7. **AI 回复**：基于邮件内容起草回复
8. **AI 分类**：自动打标（重要/待办/垃圾）

### 不做（明确排除）

- Exchange 同步、日历、联系人、S/MIME、邮件规则引擎、全文搜索（FTS5）、邮件线程聚合、多文件夹同步（只做 INBOX）、IMAP IDLE 实时推送（用轮询）

---

## Task 1: 后端 - SQLite 缓存层

**Files:**
- Create: `src-tauri/src/email.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 加 mail-parser 依赖到 Cargo.toml**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 末尾加一行：

```toml
mail-parser = "0.9"
```

> `mail-parser` 是纯 Rust 的 MIME 解析库，无 C 依赖，体积约 500KB。仅用于解析从 Python gateway 拿到的原始邮件字节。不引入 `imap`/`lettre`——收发由 Python 侧完成。

- [ ] **Step 2: 创建 email.rs 骨架**

创建 `src-tauri/src/email.rs`：

```rust
use crate::settings::app_data_dir;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const EMAIL_DB_FILE: &str = "email.sqlite3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAccount {
    pub id: String,
    pub display_name: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String, // 加密存储，见 Step 3
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_username: String,
    pub smtp_password: String,
    pub from_address: String,
    pub last_synced_uid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailMessage {
    pub uid: String,
    pub account_id: String,
    pub subject: String,
    pub from_address: String,
    pub to_addresses: String, // JSON array
    pub date: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub has_attachments: bool,
    pub is_read: bool,
    pub is_starred: bool,
    pub raw_size: u32,
}

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
                last_synced_uid TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                uid TEXT NOT NULL,
                account_id TEXT NOT NULL,
                subject TEXT NOT NULL,
                from_address TEXT NOT NULL,
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
            CREATE INDEX IF NOT EXISTS idx_messages_account_date
                ON messages(account_id, date DESC);
            ",
        ).map_err(|e| e.to_string())?;
        Ok(conn)
    }
}
```

- [ ] **Step 3: 密码加密存储**

在 `email.rs` 中追加密码加解密函数。复用项目已有的 `ring` crate（Cargo.toml 中已存在）做 AES-GCM 加密，密钥派生自机器标识：

```rust
use ring::aead;
use ring::pbkdf2;
use ring::rand::{SystemRandom, SecureRandom};

const ENCRYPT_SALT: &[u8] = b"mona-email-v1-salt";
const NONCE_LEN: usize = 12;

fn derive_key() -> [u8; 32] {
    // 用机器名作为密钥派生种子（同机器可解密，换机器不可解密）
    let machine = dirs::computer().unwrap_or("mona-default").to_string_lossy();
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        100_000,
        ENCRYPT_SALT,
        machine.as_bytes(),
        &mut key,
    );
    key
}

pub fn encrypt_password(plain: &str) -> Result<String, String> {
    let key = derive_key();
    let rng = SystemRandom::new();
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill(&mut nonce).map_err(|e| e.to_string())?;
    let mut in_out = plain.as_bytes().to_vec();
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|e| e.to_string())?);
    key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::empty(), &mut in_out).map_err(|e| e.to_string())?;
    let mut combined = nonce.to_vec();
    combined.extend_from_slice(&in_out);
    Ok(base64::engine::general_purpose::STANDARD.encode(&combined))
}

pub fn decrypt_password(cipher: &str) -> Result<String, String> {
    let key = derive_key();
    let combined = base64::engine::general_purpose::STANDARD.decode(cipher).map_err(|e| e.to_string())?;
    if combined.len() < NONCE_LEN {
        return Err("invalid ciphertext".into());
    }
    let nonce = &combined[..NONCE_LEN];
    let mut ciphertext = combined[NONCE_LEN..].to_vec();
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|e| e.to_string())?);
    let plaintext = key.open_in_place(aead::Nonce::try_assume_unique_for_key(nonce).map_err(|e| e.to_string())?, aead::Aad::empty(), &mut ciphertext).map_err(|e| e.to_string())?;
    String::from_utf8(plaintext.to_vec()).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: 账号管理命令**

在 `email.rs` 中追加 Tauri 命令：

```rust
#[tauri::command]
pub async fn email_list_accounts(state: tauri::State<'_, EmailState>) -> Result<Vec<EmailAccount>, String> {
    let conn = state.conn()?;
    let mut stmt = conn.prepare(
        "SELECT id, display_name, imap_host, imap_port, imap_username, imap_password,
                smtp_host, smtp_port, smtp_username, smtp_password, from_address, last_synced_uid
         FROM accounts ORDER BY display_name"
    ).map_err(|e| e.to_string())?;
    let accounts = stmt.query_map([], |row| {
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
            last_synced_uid: row.get(11)?,
        })
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();
    Ok(accounts)
}

#[tauri::command]
pub async fn email_add_account(state: tauri::State<'_, EmailState>, account: EmailAccount) -> Result<(), String> {
    let conn = state.conn()?;
    let enc_imap = encrypt_password(&account.imap_password)?;
    let enc_smtp = encrypt_password(&account.smtp_password)?;
    conn.execute(
        "INSERT OR REPLACE INTO accounts
         (id, display_name, imap_host, imap_port, imap_username, imap_password,
          smtp_host, smtp_port, smtp_username, smtp_password, from_address, last_synced_uid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            account.id, account.display_name,
            account.imap_host, account.imap_port, account.imap_username, enc_imap,
            account.smtp_host, account.smtp_port, account.smtp_username, enc_smtp,
            account.from_address, account.last_synced_uid,
        ],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn email_delete_account(state: tauri::State<'_, EmailState>, account_id: String) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute("DELETE FROM messages WHERE account_id = ?1", params![account_id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", params![account_id]).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 5: 邮件缓存命令**

```rust
#[tauri::command]
pub async fn email_get_messages(
    state: tauri::State<'_, EmailState>,
    account_id: String,
    offset: u32,
    limit: u32,
) -> Result<Vec<EmailMessage>, String> {
    let conn = state.conn()?;
    let mut stmt = conn.prepare(
        "SELECT uid, account_id, subject, from_address, to_addresses, date,
                body_text, body_html, has_attachments, is_read, is_starred, raw_size
         FROM messages WHERE account_id = ?1
         ORDER BY date DESC LIMIT ?2 OFFSET ?3"
    ).map_err(|e| e.to_string())?;
    let msgs = stmt.query_map(params![account_id, limit, offset], |row| {
        Ok(EmailMessage {
            uid: row.get(0)?,
            account_id: row.get(1)?,
            subject: row.get(2)?,
            from_address: row.get(3)?,
            to_addresses: row.get(4)?,
            date: row.get(5)?,
            body_text: row.get(6)?,
            body_html: row.get(7)?,
            has_attachments: row.get::<_, i32>(8)? != 0,
            is_read: row.get::<_, i32>(9)? != 0,
            is_starred: row.get::<_, i32>(10)? != 0,
            raw_size: row.get(11)?,
        })
    }).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();
    Ok(msgs)
}

#[tauri::command]
pub async fn email_mark_read(
    state: tauri::State<'_, EmailState>,
    uid: String,
    account_id: String,
    is_read: bool,
) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute(
        "UPDATE messages SET is_read = ?1 WHERE uid = ?2 AND account_id = ?3",
        params![is_read as i32, uid, account_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 6: 注册到 lib.rs**

在 `src-tauri/src/lib.rs` 中：

1. 第 1-12 行的 `mod` 声明区加：
```rust
mod email;
```

2. 第 338-385 行的 State 注册区加（在 `db_state` 之后）：
```rust
let email_state = email::EmailState::new();
```
并在 `.manage(db_state)` 之后加：
```rust
.manage(email_state)
```

3. 第 386-541 行的 `invoke_handler!` 中，在 `db::commands::*` 之后加：
```rust
email::email_list_accounts,
email::email_add_account,
email::email_delete_account,
email::email_get_messages,
email::email_mark_read,
```

- [ ] **Step 7: 编译验证**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，无错误

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/email.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(email): add email module backend with SQLite cache"
```

---

## Task 2: 后端 - 收发桥接层

**Files:**
- Modify: `src-tauri/src/email.rs`

复用 Python gateway 的 HTTP API 做真实收发。Python 侧需暴露两个 HTTP endpoint（见 Task 7），Rust 侧用已有的 `reqwest` crate 调用。

- [ ] **Step 1: 同步邮件命令**

在 `email.rs` 追加。调用 Python gateway 的 `/email/sync` 接口拉取新邮件，解析后写入 SQLite：

```rust
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub account_id: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_username: String,
    pub imap_password: String,
    pub mailbox: String,
    pub use_ssl: bool,
    pub last_uid: Option<String>,
}

#[tauri::command]
pub async fn email_sync(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: SyncRequest,
) -> Result<u32, String> {
    // 调用 Python gateway
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/email/sync", gateway_url))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("gateway request failed: {e}"))?;
    let new_messages: Vec<Value> = resp.json().await.map_err(|e| format!("parse response: {e}"))?;

    let conn = state.conn()?;
    let mut count = 0u32;
    for msg in new_messages {
        let uid = msg["uid"].as_str().unwrap_or("").to_string();
        if uid.is_empty() { continue; }
        conn.execute(
            "INSERT OR IGNORE INTO messages
             (uid, account_id, subject, from_address, to_addresses, date,
              body_text, body_html, has_attachments, is_read, is_starred, raw_size)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, ?10)",
            params![
                uid, req.account_id,
                msg["subject"].as_str().unwrap_or("(no subject)"),
                msg["from"].as_str().unwrap_or(""),
                msg["to"].as_str().unwrap_or("[]"),
                msg["date"].as_str().unwrap_or(""),
                msg["body_text"].as_str().unwrap_or(""),
                msg.get("body_html").and_then(|v| v.as_str()),
                msg["has_attachments"].as_bool().unwrap_or(false) as i32,
                msg["raw_size"].as_u64().unwrap_or(0) as u32,
            ],
        ).map_err(|e| e.to_string())?;
        count += 1;
    }
    // 更新 last_synced_uid
    if let Some(last_uid) = new_messages.last().and_then(|m| m["uid"].as_str()) {
        conn.execute(
            "UPDATE accounts SET last_synced_uid = ?1 WHERE id = ?2",
            params![last_uid, req.account_id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(count)
}
```

- [ ] **Step 2: 发送邮件命令**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_username: String,
    pub smtp_password: String,
    pub use_tls: bool,
    pub use_ssl: bool,
    pub from_address: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub body_html: String,
    pub in_reply_to: Option<String>,
}

#[tauri::command]
pub async fn email_send(
    gateway_url: String,
    req: SendRequest,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/email/send", gateway_url))
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("gateway request failed: {e}"))?;
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("send failed: {text}"));
    }
    Ok(())
}
```

- [ ] **Step 3: 注册新命令**

在 `lib.rs` 的 `invoke_handler!` 中追加：

```rust
email::email_sync,
email::email_send,
```

- [ ] **Step 4: 编译验证**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/email.rs src-tauri/src/lib.rs
git commit -m "feat(email): add sync and send commands via Python gateway"
```

---

## Task 3: Python Gateway - 收发 API 暴露

**Files:**
- Modify: `mona/api/server.py`

Python 侧 `email.py` 已有完整 IMAP/SMTP 能力，只需在 HTTP API 层暴露两个 endpoint 供 Rust 调用。不改动 `email.py` 本身。

- [ ] **Step 1: 查看现有 API server 结构**

Run: `grep -n "def.*route\|@app\|router\|add_route" mona/api/server.py | head -30`

确认 API 注册方式（FastAPI / aiohttp / 自定义路由）。

- [ ] **Step 2: 添加 /email/sync 和 /email/send 路由**

在 `mona/api/server.py` 中追加。复用 `email.py` 中的 `_fetch_messages` 和 `_smtp_send` 逻辑，但不通过 Channel 实例——直接构造一次性 IMAP/SMTP 连接：

```python
from email.message import EmailMessage
import imaplib
import smtplib
import ssl
from email.parser import BytesParser
from email import policy
from email.utils import parseaddr, formatdate
from email.header import decode_header, make_header

async def email_sync_handler(request):
    """拉取指定账号的新邮件，返回解析后的邮件列表。"""
    body = await request.json()
    imap_host = body["imapHost"]
    imap_port = body["imapPort"]
    username = body["imapUsername"]
    password = body["imapPassword"]  # Rust 侧已解密
    mailbox = body.get("mailbox", "INBOX")
    use_ssl = body.get("useSsl", True)

    messages = []
    if use_ssl:
        client = imaplib.IMAP4_SSL(imap_host, imap_port)
    else:
        client = imaplib.IMAP4(imap_host, imap_port)
    try:
        client.login(username, password)
        client.select(mailbox)
        # 拉取最近 50 封（MVP 简化）
        status, data = client.search(None, "ALL")
        if status == "OK" and data and data[0]:
            ids = data[0].split()[-50:]
            for imap_id in ids:
                status, fetched = client.fetch(imap_id, "(BODY.PEEK[] UID)")
                if status != "OK" or not fetched:
                    continue
                raw = None
                uid = ""
                for item in fetched:
                    if isinstance(item, tuple):
                        raw = item[1]
                        # 提取 UID
                        meta = item[0].decode("utf-8", errors="replace") if isinstance(item[0], bytes) else str(item[0])
                        if "UID" in meta:
                            uid = meta.split("UID")[1].split(")")[0].strip()
                if raw is None:
                    continue
                parsed = BytesParser(policy=policy.default).parsebytes(raw)
                subject = str(make_header(decode_header(parsed.get("Subject", ""))))
                from_addr = parseaddr(parsed.get("From", ""))[1]
                to_addrs = str(parsed.get("To", ""))
                date = parsed.get("Date", "")
                body_text = ""
                body_html = None
                if parsed.is_multipart():
                    for part in parsed.walk():
                        ct = part.get_content_type()
                        if ct == "text/plain":
                            body_text = part.get_content()
                        elif ct == "text/html" and body_html is None:
                            body_html = part.get_content()
                else:
                    body_text = parsed.get_content()
                has_attachments = any(
                    p.get_content_disposition() == "attachment"
                    for p in parsed.walk() if p.is_multipart()
                )
                messages.append({
                    "uid": uid or imap_id.decode(),
                    "subject": subject or "(no subject)",
                    "from": from_addr,
                    "to": to_addrs,
                    "date": date,
                    "bodyText": body_text[:50000],
                    "bodyHtml": body_html,
                    "hasAttachments": has_attachments,
                    "rawSize": len(raw),
                })
    finally:
        try:
            client.logout()
        except Exception:
            pass
    return messages


async def email_send_handler(request):
    """通过 SMTP 发送邮件。"""
    body = await request.json()
    msg = EmailMessage()
    msg["From"] = body["fromAddress"]
    msg["To"] = ", ".join(body["to"])
    if body.get("cc"):
        msg["Cc"] = ", ".join(body["cc"])
    msg["Subject"] = body["subject"]
    msg["Date"] = formatdate(localtime=True)
    if body.get("inReplyTo"):
        msg["In-Reply-To"] = body["inReplyTo"]
    msg.set_content(body.get("bodyText", ""), subtype="html" if body.get("bodyHtml") else "plain")
    if body.get("bodyHtml"):
        msg.add_alternative(body["bodyHtml"], subtype="html")

    smtp_host = body["smtpHost"]
    smtp_port = body["smtpPort"]
    username = body["smtpUsername"]
    password = body["smtpPassword"]
    use_tls = body.get("useTls", True)
    use_ssl = body.get("useSsl", False)

    if use_ssl:
        smtp = smtplib.SMTP_SSL(smtp_host, smtp_port, context=ssl.create_default_context())
    else:
        smtp = smtplib.SMTP(smtp_host, smtp_port)
        if use_tls:
            smtp.starttls(context=ssl.create_default_context())
    try:
        smtp.login(username, password)
        smtp.send_message(msg)
    finally:
        smtp.quit()
    return {"status": "ok"}
```

> **注意**：以上是 handler 函数。实际注册到路由的方式取决于 `server.py` 用的框架。需要根据 Step 1 的 grep 结果调整注册方式（如 `app.router.add_post("/email/sync", email_sync_handler)`）。

- [ ] **Step 3: 测试 API**

手动用 curl 测试（需 gateway 运行中）：

```bash
curl -X POST http://localhost:<port>/email/sync \
  -H "Content-Type: application/json" \
  -d '{"imapHost":"imap.gmail.com","imapPort":993,"imapUsername":"test@gmail.com","imapPassword":"appkey","mailbox":"INBOX","useSsl":true}'
```

Expected: 返回 JSON 邮件数组

- [ ] **Step 4: Commit**

```bash
git add mona/api/server.py
git commit -m "feat(email): expose sync/send HTTP endpoints in gateway"
```

---

## Task 4: 前端 - 类型定义与 API 封装

**Files:**
- Create: `webui/src/components/email/lib/types.ts`
- Create: `webui/src/components/email/lib/emailApi.ts`

- [ ] **Step 1: 类型定义**

创建 `webui/src/components/email/lib/types.ts`：

```typescript
export interface EmailAccount {
  id: string;
  displayName: string;
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  fromAddress: string;
  lastSyncedUid?: string | null;
}

export interface EmailMessage {
  uid: string;
  accountId: string;
  subject: string;
  fromAddress: string;
  toAddresses: string;
  date: string;
  bodyText: string;
  bodyHtml?: string | null;
  hasAttachments: boolean;
  isRead: boolean;
  isStarred: boolean;
  rawSize: number;
}

export interface SyncResult {
  newCount: number;
}
```

- [ ] **Step 2: API 封装**

创建 `webui/src/components/email/lib/emailApi.ts`：

```typescript
import { invoke } from "@tauri-apps/api/core";
import type { EmailAccount, EmailMessage } from "./types";

export async function listAccounts(): Promise<EmailAccount[]> {
  return invoke<EmailAccount[]>("email_list_accounts");
}

export async function addAccount(account: EmailAccount): Promise<void> {
  await invoke("email_add_account", { account });
}

export async function deleteAccount(accountId: string): Promise<void> {
  await invoke("email_delete_account", { accountId });
}

export async function getMessages(
  accountId: string,
  offset = 0,
  limit = 50,
): Promise<EmailMessage[]> {
  return invoke<EmailMessage[]>("email_get_messages", { accountId, offset, limit });
}

export async function markRead(uid: string, accountId: string, isRead: boolean): Promise<void> {
  await invoke("email_mark_read", { uid, accountId, isRead });
}

export async function syncEmail(
  accountId: string,
  account: EmailAccount,
  gatewayUrl: string,
): Promise<number> {
  return invoke<number>("email_sync", {
    gatewayUrl,
    req: {
      accountId,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapUsername: account.imapUsername,
      imapPassword: account.imapPassword,
      mailbox: "INBOX",
      useSsl: true,
      lastUid: account.lastSyncedUid,
    },
  });
}

export async function sendEmail(
  account: EmailAccount,
  to: string[],
  subject: string,
  bodyHtml: string,
  cc: string[] = [],
  gatewayUrl: string,
): Promise<void> {
  await invoke("email_send", {
    gatewayUrl,
    req: {
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpUsername: account.smtpUsername,
      smtpPassword: account.smtpPassword,
      useTls: true,
      useSsl: false,
      fromAddress: account.fromAddress,
      to,
      cc,
      subject,
      bodyHtml,
      inReplyTo: null,
    },
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add webui/src/components/email/lib/
git commit -m "feat(email): add frontend types and API layer"
```

---

## Task 5: 前端 - Zustand Store

**Files:**
- Create: `webui/src/components/email/store/emailStore.ts`

- [ ] **Step 1: Store 实现**

创建 `webui/src/components/email/store/emailStore.ts`：

```typescript
import { create } from "zustand";
import type { EmailAccount, EmailMessage } from "../lib/types";
import * as api from "../lib/emailApi";

interface EmailState {
  accounts: EmailAccount[];
  selectedAccountId: string | null;
  messages: EmailMessage[];
  selectedMessage: EmailMessage | null;
  loading: boolean;
  syncing: boolean;
  error: string | null;

  loadAccounts: () => Promise<void>;
  addAccount: (account: EmailAccount) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;
  selectAccount: (accountId: string) => Promise<void>;
  loadMessages: () => Promise<void>;
  syncMail: (gatewayUrl: string) => Promise<void>;
  selectMessage: (msg: EmailMessage | null) => void;
  toggleRead: (msg: EmailMessage) => Promise<void>;
}

export const useEmailStore = create<EmailState>((set, get) => ({
  accounts: [],
  selectedAccountId: null,
  messages: [],
  selectedMessage: null,
  loading: false,
  syncing: false,
  error: null,

  loadAccounts: async () => {
    set({ loading: true, error: null });
    try {
      const accounts = await api.listAccounts();
      set({ accounts, loading: false });
      if (accounts.length > 0 && !get().selectedAccountId) {
        await get().selectAccount(accounts[0].id);
      }
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  addAccount: async (account) => {
    await api.addAccount(account);
    await get().loadAccounts();
  },

  removeAccount: async (accountId) => {
    await api.deleteAccount(accountId);
    if (get().selectedAccountId === accountId) {
      set({ selectedAccountId: null, messages: [], selectedMessage: null });
    }
    await get().loadAccounts();
  },

  selectAccount: async (accountId) => {
    set({ selectedAccountId: accountId, selectedMessage: null });
    await get().loadMessages();
  },

  loadMessages: async () => {
    const accountId = get().selectedAccountId;
    if (!accountId) return;
    set({ loading: true, error: null });
    try {
      const messages = await api.getMessages(accountId, 0, 50);
      set({ messages, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  syncMail: async (gatewayUrl) => {
    const accountId = get().selectedAccountId;
    if (!accountId) return;
    const account = get().accounts.find((a) => a.id === accountId);
    if (!account) return;
    set({ syncing: true, error: null });
    try {
      await api.syncEmail(accountId, account, gatewayUrl);
      await get().loadMessages();
      set({ syncing: false });
    } catch (e) {
      set({ error: String(e), syncing: false });
    }
  },

  selectMessage: (msg) => {
    set({ selectedMessage: msg });
    if (msg && !msg.isRead) {
      get().toggleRead(msg);
    }
  },

  toggleRead: async (msg) => {
    const accountId = get().selectedAccountId;
    if (!accountId) return;
    try {
      await api.markRead(msg.uid, accountId, !msg.isRead);
      set((state) => ({
        messages: state.messages.map((m) =>
          m.uid === msg.uid ? { ...m, isRead: !m.isRead } : m,
        ),
        selectedMessage:
          state.selectedMessage?.uid === msg.uid
            ? { ...state.selectedMessage, isRead: !msg.isRead }
            : state.selectedMessage,
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add webui/src/components/email/store/
git commit -m "feat(email): add Zustand store"
```

---

## Task 6: 前端 - 主视图与子组件

**Files:**
- Create: `webui/src/components/email/EmailClientView.tsx`
- Create: `webui/src/components/email/AccountSidebar.tsx`
- Create: `webui/src/components/email/MailListView.tsx`
- Create: `webui/src/components/email/MailView.tsx`
- Create: `webui/src/components/email/MailComposer.tsx`
- Create: `webui/src/components/email/NewAccountDialog.tsx`
- Create: `webui/src/components/email/MailAgentPanel.tsx`

- [ ] **Step 1: 主视图 EmailClientView.tsx**

仿 `DbClientView.tsx` 三栏布局。创建 `webui/src/components/email/EmailClientView.tsx`：

```tsx
import { useEffect, useRef, useState } from "react";
import { RefreshCw, Plus, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/separator";
import { cn } from "@/lib/utils";
import { AccountSidebar } from "./AccountSidebar";
import { MailListView } from "./MailListView";
import { MailView } from "./MailView";
import { MailAgentPanel } from "./MailAgentPanel";
import { NewAccountDialog } from "./NewAccountDialog";
import { MailComposer } from "./MailComposer";
import { useEmailStore } from "./store/emailStore";

const GATEWAY_URL = "http://127.0.0.1:8765";

export function EmailClientView() {
  const loadAccounts = useEmailStore((s) => s.loadAccounts);
  const accounts = useEmailStore((s) => s.accounts);
  const syncing = useEmailStore((s) => s.syncing);
  const syncMail = useEmailStore((s) => s.syncMail);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [showAgentPanel, setShowAgentPanel] = useState(true);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      loadAccounts();
    }
  }, [loadAccounts]);

  return (
    <div className="flex h-full w-full">
      <AccountSidebar onAddAccount={() => setShowNewAccount(true)} />
      <Separator orientation="vertical" />
      <div className="flex flex-1 min-w-0">
        <div className="flex w-[380px] flex-col border-r border-border/65">
          <div className="flex h-10 items-center justify-between border-b border-border/65 px-3">
            <span className="text-[12px] font-semibold">收件箱</span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => syncMail(GATEWAY_URL)}
                disabled={syncing || accounts.length === 0}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => setShowComposer(true)}
                disabled={accounts.length === 0}
              >
                <Mail className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <MailListView />
        </div>
        <div className="flex flex-1 min-w-0">
          <MailView />
          {showAgentPanel && <MailAgentPanel />}
        </div>
      </div>
      <NewAccountDialog open={showNewAccount} onOpenChange={setShowNewAccount} />
      {showComposer && <MailComposer onClose={() => setShowComposer(false)} />}
    </div>
  );
}
```

- [ ] **Step 2: AccountSidebar.tsx**

```tsx
import { Plus, Trash2, Mailbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEmailStore } from "./store/emailStore";
import { cn } from "@/lib/utils";

export function AccountSidebar({ onAddAccount }: { onAddAccount: () => void }) {
  const accounts = useEmailStore((s) => s.accounts);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const selectAccount = useEmailStore((s) => s.selectAccount);
  const removeAccount = useEmailStore((s) => s.removeAccount);

  return (
    <div className="flex w-[200px] flex-col bg-muted/30">
      <div className="flex h-10 items-center justify-between border-b border-border/65 px-3">
        <span className="text-[12px] font-semibold">邮箱账号</span>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onAddAccount}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {accounts.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
            点击 + 添加邮箱账号
          </div>
        ) : (
          accounts.map((account) => (
            <div
              key={account.id}
              className={cn(
                "group flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px]",
                selectedAccountId === account.id
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50",
              )}
              onClick={() => selectAccount(account.id)}
            >
              <Mailbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{account.displayName}</span>
              <button
                className="opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAccount(account.id);
                }}
              >
                <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: MailListView.tsx**

```tsx
import { useEmailStore } from "./store/emailStore";
import { cn } from "@/lib/utils";

export function MailListView() {
  const messages = useEmailStore((s) => s.messages);
  const selectedMessage = useEmailStore((s) => s.selectedMessage);
  const selectMessage = useEmailStore((s) => s.selectMessage);
  const loading = useEmailStore((s) => s.loading);

  if (loading && messages.length === 0) {
    return <div className="flex-1 p-4 text-[12px] text-muted-foreground">加载中...</div>;
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">
        暂无邮件，点击刷新按钮同步
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      {messages.map((msg) => (
        <div
          key={msg.uid}
          className={cn(
            "cursor-pointer border-b border-border/40 px-3 py-2.5",
            selectedMessage?.uid === msg.uid ? "bg-accent" : "hover:bg-accent/50",
          )}
          onClick={() => selectMessage(msg)}
        >
          <div className="flex items-center gap-2">
            {!msg.isRead && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />}
            <span className={cn("flex-1 truncate text-[12px]", !msg.isRead && "font-semibold")}>
              {msg.fromAddress}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {msg.date.slice(0, 10)}
            </span>
          </div>
          <div className={cn("mt-0.5 truncate text-[12px]", !msg.isRead && "font-medium")}>
            {msg.subject}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {msg.bodyText.slice(0, 80)}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: MailView.tsx**

```tsx
import { useEmailStore } from "./store/emailStore";

export function MailView() {
  const msg = useEmailStore((s) => s.selectedMessage);

  if (!msg) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        选择一封邮件查看
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-w-0">
      <div className="border-b border-border/65 px-4 py-3">
        <h2 className="text-[15px] font-semibold">{msg.subject}</h2>
        <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground">{msg.fromAddress}</span>
          <span>→</span>
          <span>{msg.toAddresses}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{msg.date}</div>
      </div>
      <div className="flex-1 overflow-auto px-4 py-3">
        {msg.bodyHtml ? (
          <div
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: msg.bodyHtml }}
          />
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-[13px]">{msg.bodyText}</pre>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: NewAccountDialog.tsx**

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEmailStore } from "./store/emailStore";
import type { EmailAccount } from "./lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PRESETS: Record<string, Partial<EmailAccount>> = {
  "Gmail": { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 587 },
  "Outlook": { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587 },
  "QQ": { imapHost: "imap.qq.com", imapPort: 993, smtpHost: "smtp.qq.com", smtpPort: 465 },
  "163": { imapHost: "imap.163.com", imapPort: 993, smtpHost: "smtp.163.com", smtpPort: 465 },
};

export function NewAccountDialog({ open, onOpenChange }: Props) {
  const addAccount = useEmailStore((s) => s.addAccount);
  const [form, setForm] = useState<EmailAccount>({
    id: crypto.randomUUID(),
    displayName: "",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapUsername: "",
    imapPassword: "",
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpUsername: "",
    smtpPassword: "",
    fromAddress: "",
  });

  if (!open) return null;

  const handleSubmit = async () => {
    await addAccount(form);
    onOpenChange(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[480px] rounded-lg border border-border bg-background p-6 shadow-lg">
        <h2 className="mb-4 text-[15px] font-semibold">添加邮箱账号</h2>
        <div className="space-y-3">
          <div className="flex gap-2">
            {Object.keys(PRESETS).map((preset) => (
              <Button
                key={preset}
                variant="outline"
                size="sm"
                onClick={() => setForm({ ...form, ...PRESETS[preset] })}
              >
                {preset}
              </Button>
            ))}
          </div>
          <div>
            <Label>显示名称</Label>
            <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="我的邮箱" />
          </div>
          <div>
            <Label>邮箱地址</Label>
            <Input value={form.imapUsername} onChange={(e) => setForm({
              ...form,
              imapUsername: e.target.value,
              smtpUsername: e.target.value,
              fromAddress: e.target.value,
            })} placeholder="you@example.com" />
          </div>
          <div>
            <Label>密码 / 应用专用密码</Label>
            <Input type="password" value={form.imapPassword} onChange={(e) => setForm({
              ...form,
              imapPassword: e.target.value,
              smtpPassword: e.target.value,
            })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>IMAP 服务器</Label>
              <Input value={form.imapHost} onChange={(e) => setForm({ ...form, imapHost: e.target.value })} />
            </div>
            <div>
              <Label>IMAP 端口</Label>
              <Input type="number" value={form.imapPort} onChange={(e) => setForm({ ...form, imapPort: Number(e.target.value) })} />
            </div>
            <div>
              <Label>SMTP 服务器</Label>
              <Input value={form.smtpHost} onChange={(e) => setForm({ ...form, smtpHost: e.target.value })} />
            </div>
            <div>
              <Label>SMTP 端口</Label>
              <Input type="number" value={form.smtpPort} onChange={(e) => setForm({ ...form, smtpPort: Number(e.target.value) })} />
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={handleSubmit}>添加</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: MailComposer.tsx**

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEmailStore } from "./store/emailStore";
import * as api from "./lib/emailApi";

const GATEWAY_URL = "http://127.0.0.1:8765";

export function MailComposer({ onClose }: { onClose: () => void }) {
  const accounts = useEmailStore((s) => s.accounts);
  const selectedAccountId = useEmailStore((s) => s.selectedAccountId);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = accounts.find((a) => a.id === selectedAccountId);
  if (!account) return null;

  const handleSend = async () => {
    setSending(true);
    setError(null);
    try {
      await api.sendEmail(
        account,
        to.split(",").map((s) => s.trim()).filter(Boolean),
        subject,
        body,
        [],
        GATEWAY_URL,
      );
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[600px] rounded-lg border border-border bg-background p-6 shadow-lg">
        <h2 className="mb-4 text-[15px] font-semibold">写邮件</h2>
        <div className="space-y-3">
          <div>
            <Label>收件人</Label>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="recipient@example.com" />
          </div>
          <div>
            <Label>主题</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <Label>正文</Label>
            <textarea
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] min-h-[200px]"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {error && <div className="text-[12px] text-destructive">{error}</div>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSend} disabled={sending || !to || !subject}>
            {sending ? "发送中..." : "发送"}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: MailAgentPanel.tsx**

AI 面板。MVP 阶段先做"摘要"和"回复"两个快捷动作，通过调用 Mona 的 Agent 能力实现。创建 `webui/src/components/email/MailAgentPanel.tsx`：

```tsx
import { useState } from "react";
import { Sparkles, Reply, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEmailStore } from "./store/emailStore";

export function MailAgentPanel() {
  const msg = useEmailStore((s) => s.selectedMessage);
  const [output, setOutput] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const runAgent = async (action: "summarize" | "reply") => {
    if (!msg) return;
    setLoading(true);
    setOutput("");
    // MVP: 通过 Mona 的 Agent HTTP API 调用
    // 实际实现需要对接 mona/api/server.py 的 agent endpoint
    try {
      const resp = await fetch("http://127.0.0.1:8765/agent/quick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt:
            action === "summarize"
              ? `请用中文简洁总结这封邮件的要点：\n\n主题：${msg.subject}\n发件人：${msg.fromAddress}\n正文：${msg.bodyText.slice(0, 3000)}`
              : `请基于以下邮件内容，用中文起草一封专业回复：\n\n主题：${msg.subject}\n发件人：${msg.fromAddress}\n正文：${msg.bodyText.slice(0, 3000)}`,
        }),
      });
      const data = await resp.json();
      setOutput(data.response || data.text || JSON.stringify(data));
    } catch (e) {
      setOutput(`Error: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex w-[320px] flex-col border-l border-border/65">
      <div className="flex h-10 items-center justify-between border-b border-border/65 px-3">
        <span className="text-[12px] font-semibold">Mona AI</span>
        {output && (
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setOutput("")}>
            <RotateCcw className="h-3 w-3" />
          </Button>
        )}
      </div>
      <div className="flex gap-2 border-b border-border/65 p-2.5">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => runAgent("summarize")}
          disabled={!msg || loading}
        >
          <Sparkles className="mr-1 h-3 w-3" /> 摘要
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => runAgent("reply")}
          disabled={!msg || loading}
        >
          <Reply className="mr-1 h-3 w-3" /> 回复
        </Button>
      </div>
      <div className="flex-1 overflow-auto p-3 text-[12px] leading-relaxed">
        {loading ? (
          <span className="text-muted-foreground">思考中...</span>
        ) : output ? (
          <pre className="whitespace-pre-wrap font-sans">{output}</pre>
        ) : (
          <span className="text-muted-foreground">选择一封邮件后，点击"摘要"或"回复"</span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add webui/src/components/email/
git commit -m "feat(email): add email client UI components"
```

---

## Task 7: 前端入口注册

**Files:**
- Modify: `webui/src/components/Sidebar.tsx`
- Modify: `webui/src/App.tsx`

- [ ] **Step 1: Sidebar 加邮件入口**

在 `webui/src/components/Sidebar.tsx` 中：

1. `TOOLBOX_ITEMS` 数组末尾加（在 PPT制作 之后）：

```tsx
  { label: "邮件", icon: <Mail className="h-4 w-4" /> },
```

2. 在文件顶部 import 区加 `Mail` 图标（从 lucide-react）：

```tsx
import { Mail } from "lucide-react";
```

3. `ToolboxNavigation` 组件的 props 类型加：

```tsx
  onOpenEmail?: () => void;
```

4. `ToolboxNavigation` 函数参数解构加 `onOpenEmail`。

5. `onClick` 三元链末尾（`onGoHome` 之前）加：

```tsx
          : item.label === "邮件"
            ? onOpenEmail
```

6. `LICENSE_REQUIRED` 集合加 "邮件"（可选，若作为 Pro 功能）：

```tsx
  const LICENSE_REQUIRED = new Set(["知识库", "PPT制作", "邮件"]);
```

7. `SidebarProps` 接口加：

```tsx
  onOpenEmail?: () => void;
```

8. `Sidebar` 组件参数解构加 `onOpenEmail`，并传给 `ToolboxNavigation`。

- [ ] **Step 2: App.tsx 加 email 视图路由**

在 `webui/src/App.tsx` 中：

1. `ShellView` 类型加 `"email"`：

```tsx
type ShellView = "chat" | "settings" | "note" | "ssh" | "db" | "kb" | "ppt" | "email";
```

2. lazy import 区加：

```tsx
const EmailClientView = lazy(() =>
  import("@/components/email/EmailClientView").then((module) => ({
    default: module.EmailClientView,
  })),
);
```

3. 视图渲染 switch 区域（第 1212-1257 行附近），在 `view === "ppt"` 块之后加：

```tsx
{view === "email" && (
  <div className={cn("absolute inset-0 flex flex-col", isBrowserTabActive && "hidden")}>
    <Suspense fallback={<ModuleLoading title="正在打开邮件" />}>
      <EmailClientView />
    </Suspense>
  </div>
)}
```

4. 在 `App` 组件中找到 `onOpenKb` 回调定义附近，加 `onOpenEmail`：

```tsx
const onOpenEmail = useCallback(() => setView("email"), []);
```

5. 将 `onOpenEmail` 传给 `Sidebar` 组件。

- [ ] **Step 3: 验证编译**

Run: `cd webui && npm run build`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add webui/src/components/Sidebar.tsx webui/src/App.tsx
git commit -m "feat(email): register email module in sidebar and app router"
```

---

## Task 8: 端到端验证

- [ ] **Step 1: 启动开发环境**

Run: `npm run tauri dev`

- [ ] **Step 2: 手动测试流程**

1. 点击侧边栏"邮件"图标 → 打开邮件模块
2. 点击 + 添加 Gmail/QQ 邮箱账号（需使用应用专用密码）
3. 点击刷新按钮 → 同步邮件
4. 邮件列表显示收件箱邮件
5. 点击邮件 → 右侧显示正文
6. 点击"摘要"按钮 → AI 面板显示摘要
7. 点击"回复"按钮 → AI 面板显示回复草稿
8. 点击写信按钮 → 弹窗写信并发送

- [ ] **Step 3: 验证解耦回滚**

模拟"一刀砍掉"流程，确认删除后项目仍可编译：

1. 删除 `webui/src/components/email/` 目录
2. 删除 `src-tauri/src/email.rs`
3. 回滚 Sidebar.tsx、App.tsx、lib.rs、Cargo.toml 的 diff
4. Run: `cd src-tauri && cargo check && cd ../webui && npm run build`
5. Expected: 全部编译通过，其他模块不受影响

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Python gateway 的 `/email/sync` 和 `/email/send` endpoint 需要确认 `server.py` 的框架类型才能正确注册路由 | Task 3 Step 1 先 grep 确认框架，再调整 handler 注册方式 |
| `mail-parser` crate 增加约 500KB 安装包体积 | 可接受；若不可接受，改用 Python 侧解析后返回 JSON，Rust 侧不解析 MIME |
| AI 面板的 `/agent/quick` endpoint 可能不存在 | Task 6 Step 7 的 `fetch` 调用需对接实际 API；MVP 可先 mock 返回 |
| IMAP 密码用机器名派生密钥加密，换机器无法解密 | 可接受——换机器需重新输入密码，符合安全预期 |
| HTML 邮件 `dangerouslySetInnerHTML` 有 XSS 风险 | MVP 可接受（本地客户端）；后续可用 DOMPurify 过滤 |
