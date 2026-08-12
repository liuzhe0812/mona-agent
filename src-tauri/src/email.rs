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
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// MIME encoded-word 解码：=?charset?B?encoded?= 或 =?charset?Q?encoded?=
// gb2312/gbk 统一用 gb18030（超集）解码，避免"喆"等扩展字符丢失
use data_encoding::BASE64;

const EMAIL_DB_FILE: &str = "email.sqlite3";
const MAIL_DIR: &str = "mail";
const ENCRYPT_SALT: &[u8] = b"mona-email-v1-salt";
const NONCE_LEN: usize = 12;

// ---------------------------------------------------------------------------
// 文件存储层（Foxmail 风格：一邮件一 .eml 文件）
// ---------------------------------------------------------------------------

/// 返回邮件文件根目录：<app_data>/mona/mail
fn mail_root() -> PathBuf {
    app_data_dir().join(MAIL_DIR)
}

/// 清理路径段：替换文件系统非法字符（/ \ : * ? " < > |）为下划线，避免破坏目录结构。
/// 保留中文、空格等合法字符。
fn sanitize_path_segment(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// 计算 .eml 文件相对路径：<account_id>/<folder>/<uid>.eml
/// 返回的路径使用正斜杠分隔，跨平台一致。
fn eml_relative_path(account_id: &str, folder: &str, uid: &str) -> String {
    format!(
        "{}/{}/{}.eml",
        sanitize_path_segment(account_id),
        sanitize_path_segment(folder),
        sanitize_path_segment(uid)
    )
}

/// 将相对路径转为绝对路径
/// skill 第二节：路径解析必须限制在邮件数据目录内，阻止 `..` 穿越
fn eml_absolute_path(relative_path: &str) -> PathBuf {
    let root = mail_root();
    let joined = root.join(relative_path);
    // 校验结果仍在 mail_root 之下，阻止路径穿越
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.clone());
    if let Ok(canonical_joined) = joined.canonicalize() {
        if !canonical_joined.starts_with(&canonical_root) {
            log::warn!(
                "[email] 路径穿越被拒绝: relative_path={} resolved={:?}",
                relative_path,
                canonical_joined
            );
            return root.join("invalid_path_blocked");
        }
    }
    joined
}

/// 原子写入文件：先写入同目录的临时文件，再 rename 替换目标文件
/// skill 第二节：.eml 和 .meta.json 使用临时文件写入并原子 rename
/// 写入中途崩溃会留下临时文件而不是半截损坏的目标文件
fn atomic_write_file(abs_path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = abs_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    // 临时文件：同目录下，加 .tmp 后缀（同目录 rename 是原子的）
    let tmp_path = abs_path.with_extension("eml.tmp");
    std::fs::write(&tmp_path, bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    // rename 替换目标文件（同目录下是原子的）
    std::fs::rename(&tmp_path, abs_path).map_err(|e| {
        // rename 失败时清理临时文件
        let _ = std::fs::remove_file(&tmp_path);
        format!("原子替换文件失败: {e}")
    })
}

/// 写入 .eml 文件，自动创建父目录。返回相对路径（存入 SQLite）。
fn write_eml_file(
    account_id: &str,
    folder: &str,
    uid: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let rel = eml_relative_path(account_id, folder, uid);
    let abs = eml_absolute_path(&rel);
    atomic_write_file(&abs, bytes).map_err(|e| format!("写入 .eml 文件失败: {e}"))?;
    Ok(rel)
}

/// 读取 .eml 文件字节。文件不存在返回 None，存在返回 Ok(Some(bytes))。
fn read_eml_file(relative_path: &str) -> Option<Vec<u8>> {
    if relative_path.is_empty() {
        return None;
    }
    let abs = eml_absolute_path(relative_path);
    if !abs.exists() {
        return None;
    }
    std::fs::read(&abs).ok()
}

/// 删除 .eml 文件。文件不存在视为成功。
fn delete_eml_file(relative_path: &str) -> Result<(), String> {
    if relative_path.is_empty() {
        return Ok(());
    }
    let abs = eml_absolute_path(relative_path);
    if abs.exists() {
        std::fs::remove_file(&abs).map_err(|e| format!("删除 .eml 文件失败: {e}"))?;
    }
    Ok(())
}

/// 移动 .eml 文件到新位置（跨文件夹移动）。返回新的相对路径。
fn move_eml_file(
    old_relative: &str,
    new_account: &str,
    new_folder: &str,
    uid: &str,
) -> Result<String, String> {
    let new_relative = eml_relative_path(new_account, new_folder, uid);
    if old_relative.is_empty() {
        return Ok(new_relative);
    }
    let old_abs = eml_absolute_path(old_relative);
    let new_abs = eml_absolute_path(&new_relative);
    if !old_abs.exists() {
        // 旧文件不存在，直接返回新路径（调用方应负责重新拉取）
        return Ok(new_relative);
    }
    if let Some(parent) = new_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目标目录失败: {e}"))?;
    }
    // 如果目标已存在（同名 uid），覆盖
    if new_abs.exists() {
        std::fs::remove_file(&new_abs).map_err(|e| format!("清理目标文件失败: {e}"))?;
    }
    std::fs::rename(&old_abs, &new_abs)
        .map_err(|e| format!("移动 .eml 文件失败: {e}"))?;
    Ok(new_relative)
}

// ---------------------------------------------------------------------------
// .meta.json sidecar 状态文件（存已读/星标/bodyFetched 等 RFC822 不含的状态）
// ---------------------------------------------------------------------------

/// .meta.json 结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmlMeta {
    uid: String,
    account_id: String,
    folder: String,
    #[serde(default)]
    is_read: bool,
    #[serde(default)]
    is_starred: bool,
    #[serde(default)]
    has_attachments: bool,
    #[serde(default)]
    body_fetched: bool,
    #[serde(default)]
    message_id: String,
    #[serde(default)]
    eml_mtime: i64,
}

/// 计算 .meta.json 相对路径：<account_id>/<folder>/<uid>.eml.meta.json
fn meta_relative_path(account_id: &str, folder: &str, uid: &str) -> String {
    format!(
        "{}/{}/{}.eml.meta.json",
        sanitize_path_segment(account_id),
        sanitize_path_segment(folder),
        sanitize_path_segment(uid)
    )
}

/// 写入 .meta.json sidecar 文件
fn write_meta_json(meta: &EmlMeta) -> Result<(), String> {
    let rel = meta_relative_path(&meta.account_id, &meta.folder, &meta.uid);
    let abs = eml_absolute_path(&rel);
    let json = serde_json::to_string_pretty(meta).map_err(|e| format!("序列化 meta 失败: {e}"))?;
    atomic_write_file(&abs, json.as_bytes()).map_err(|e| format!("写入 .meta.json 失败: {e}"))?;
    Ok(())
}

/// 读取 .meta.json。文件不存在返回 None。
fn read_meta_json(account_id: &str, folder: &str, uid: &str) -> Option<EmlMeta> {
    let rel = meta_relative_path(account_id, folder, uid);
    let abs = eml_absolute_path(&rel);
    if !abs.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&abs).ok()?;
    serde_json::from_str(&content).ok()
}

/// 删除 .meta.json 文件
fn delete_meta_json(account_id: &str, folder: &str, uid: &str) -> Result<(), String> {
    let rel = meta_relative_path(account_id, folder, uid);
    let abs = eml_absolute_path(&rel);
    if abs.exists() {
        std::fs::remove_file(&abs).map_err(|e| format!("删除 .meta.json 失败: {e}"))?;
    }
    Ok(())
}

/// 移动 .meta.json 文件到新文件夹
fn move_meta_json(
    old_account: &str,
    old_folder: &str,
    uid: &str,
    new_account: &str,
    new_folder: &str,
) -> Result<(), String> {
    let old_rel = meta_relative_path(old_account, old_folder, uid);
    let new_rel = meta_relative_path(new_account, new_folder, uid);
    let old_abs = eml_absolute_path(&old_rel);
    let new_abs = eml_absolute_path(&new_rel);
    if !old_abs.exists() {
        return Ok(());
    }
    if let Some(parent) = new_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 meta 目标目录失败: {e}"))?;
    }
    if new_abs.exists() {
        std::fs::remove_file(&new_abs).map_err(|e| format!("清理目标 meta 失败: {e}"))?;
    }
    std::fs::rename(&old_abs, &new_abs).map_err(|e| format!("移动 .meta.json 失败: {e}"))?;
    Ok(())
}

/// 解析 RFC822 header，提取关键字段
/// 返回 (subject, from_address, from_name, to_addresses, cc_addresses, date, message_id, has_attachments)
fn parse_eml_header(eml_bytes: &[u8]) -> (String, String, String, String, String, String, String, bool) {
    // RFC822 header 与 body 用空行分隔，header 内每行 "Key: Value"
    // 这里只解析 header 部分（第一个空行之前的内容）
    let header_end = eml_bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .or_else(|| eml_bytes.windows(2).position(|w| w == b"\n\n"))
        .unwrap_or(eml_bytes.len());

    // 在字节层面按行解析，保留每个 value 的原始字节
    // 避免 from_utf8_lossy 把非 UTF-8 字节（如 GBK 编码的"喆"字）替换成 U+FFFD 导致信息丢失
    let mut headers: std::collections::HashMap<String, Vec<u8>> = std::collections::HashMap::new();
    let mut current_key: Option<String> = None;
    for line_bytes in eml_bytes[..header_end].split(|&b| b == b'\n') {
        let line_bytes = line_bytes.strip_suffix(b"\r").unwrap_or(line_bytes);
        if line_bytes.is_empty() {
            break;
        }
        // 折行：以空格或 tab 开头，附加到上一个值
        if line_bytes.first().map(|&b| b == b' ' || b == b'\t').unwrap_or(false) {
            if let Some(k) = &current_key {
                if let Some(v) = headers.get_mut(k) {
                    v.push(b' ');
                    let trimmed = line_bytes.iter().skip_while(|&&b| b == b' ' || b == b'\t').copied().collect::<Vec<_>>();
                    v.extend(trimmed);
                }
            }
            continue;
        }
        if let Some(colon) = line_bytes.iter().position(|&b| b == b':') {
            let key = String::from_utf8_lossy(&line_bytes[..colon]).trim().to_lowercase();
            // 去除 value 前导空格
            let value_start = line_bytes[colon + 1..].iter().position(|&b| b != b' ' && b != b'\t').unwrap_or(line_bytes.len() - colon - 1);
            let value = line_bytes[colon + 1 + value_start..].to_vec();
            headers.insert(key.clone(), value);
            current_key = Some(key);
        }
    }

    let subject = decode_header_field(headers.get("subject").map(|v| v.as_slice()).unwrap_or_default());
    let from_decoded = decode_header_field(headers.get("from").map(|v| v.as_slice()).unwrap_or_default());
    let (from_name, from_address) = parse_address_field(&from_decoded);
    let to_addresses = decode_header_field(headers.get("to").map(|v| v.as_slice()).unwrap_or_default());
    let cc_addresses = decode_header_field(headers.get("cc").map(|v| v.as_slice()).unwrap_or_default());
    let date = decode_header_field(headers.get("date").map(|v| v.as_slice()).unwrap_or_default());
    let message_id = decode_header_field(headers.get("message-id").map(|v| v.as_slice()).unwrap_or_default());

    // 检测附件：Content-Type: multipart/mixed 通常表示有附件
    let content_type = decode_header_field(headers.get("content-type").map(|v| v.as_slice()).unwrap_or_default());
    let has_attachments = content_type.to_lowercase().contains("multipart/mixed");

    (
        subject,
        from_address,
        from_name,
        to_addresses,
        cc_addresses,
        date,
        message_id,
        has_attachments,
    )
}

/// 重新解析 .eml header 并修复 SQLite 中含 U+FFFD 替换字符的乱码字段。
///
/// 背景：早期版本 Rust 用 `String::from_utf8_lossy` 解码邮件头，GBK 编码的
/// 扩展字符（如"喆"）会被替换为 U+FFFD，写入 SQLite 后永久乱码。
/// 修复为 gb18030 解码后只对新 sync 的邮件生效，旧数据仍是乱码。
///
/// 此函数在 fetchBody 时用最新解码逻辑重新解析 header，若 SQLite 当前值
/// 含 U+FFFD 则更新。同时返回 header JSON 供前端立即更新 selectedMessage，
/// 无需刷新列表。
fn reparse_header_and_fix_db(
    state: &EmailState,
    eml_bytes: &[u8],
    uid: &str,
    account_id: &str,
    mailbox: &str,
) -> serde_json::Value {
    let (hdr_subject, hdr_from_addr, hdr_from_name, hdr_to, hdr_cc, _hdr_date, _hdr_msg_id, _hdr_has_att) =
        parse_eml_header(eml_bytes);

    // 只在 SQLite 当前值含 U+FFFD（乱码标志）时才更新，避免无意义 FTS 重建
    if let Ok(conn) = state.conn() {
        let current: (String, String) = conn
            .query_row(
                "SELECT to_addresses, COALESCE(cc_addresses, '') \
                 FROM messages WHERE uid=?1 AND account_id=?2 AND folder=?3",
                params![uid, account_id, mailbox],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or_default();
        if current.0.contains('\u{FFFD}') || current.1.contains('\u{FFFD}') {
            let _ = conn.execute(
                "UPDATE messages SET subject=?1, from_address=?2, from_name=?3, \
                 to_addresses=?4, cc_addresses=?5 \
                 WHERE uid=?6 AND account_id=?7 AND folder=?8",
                params![
                    &hdr_subject, &hdr_from_addr, &hdr_from_name, &hdr_to, &hdr_cc,
                    uid, account_id, mailbox,
                ],
            );
            log::debug!(
                "[email-header-fix] 修复乱码 header uid={} account={} folder={} to={:?}",
                uid, account_id, mailbox, &hdr_to
            );
        }
    }

    serde_json::json!({
        "subject": hdr_subject,
        "fromAddress": hdr_from_addr,
        "fromName": hdr_from_name,
        "toAddresses": hdr_to,
        "ccAddresses": hdr_cc,
    })
}

/// 解码邮件头字段（原始字节）：
/// 1. 若包含 =? 标记，走 MIME encoded-word 解码（=?charset?B/Q?encoded?=）
/// 2. 否则尝试 UTF-8 严格解码
/// 3. UTF-8 失败则用 GB18030（GBK/GB2312 超集，含"喆"等扩展字符）解码
/// 这样能同时处理 MIME 编码和非 MIME 编码的中文邮件头
fn decode_header_field(raw: &[u8]) -> String {
    // MIME encoded-word 标记检测
    if raw.windows(2).any(|w| w == b"=?") {
        let lossy = String::from_utf8_lossy(raw);
        return decode_mime_header(&lossy);
    }
    // 先尝试 UTF-8 严格解码
    if let Ok(s) = String::from_utf8(raw.to_vec()) {
        return s;
    }
    // UTF-8 失败：用 GB18030 解码（兼容 GBK/GB2312，覆盖"喆"等扩展字符）
    let (decoded, _, had_errors) = encoding_rs::GB18030.decode(raw);
    if had_errors {
        // GB18030 也失败，回退到 lossy
        return String::from_utf8_lossy(raw).into_owned();
    }
    decoded.into_owned()
}

/// 解析 From 字段，提取显示名和邮箱地址
/// 手写 quoted-printable 解码（MIME Q 编码用）
/// 输入已将下划线替换为空格，解析 =XX 十六进制转义
fn decode_quoted_printable(input: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'=' {
            if i + 2 >= input.len() {
                return None;
            }
            // 软换行：= 后面是 \r\n 或 \n，跳过
            if input[i + 1] == b'\r' && input[i + 2] == b'\n' {
                i += 3;
                continue;
            }
            if input[i + 1] == b'\n' {
                i += 2;
                continue;
            }
            // =XX 十六进制
            let h = hex_digit(input[i + 1])?;
            let l = hex_digit(input[i + 2])?;
            out.push((h << 4) | l);
            i += 3;
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    Some(out)
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// 解码 MIME encoded-word：=?charset?encoding?encoded_text?=
/// 支持 B (Base64) 和 Q (Quoted-Printable) 两种编码
/// gb2312/gbk 统一用 gb18030（超集）解码，避免"喆"等扩展字符丢失
fn decode_mime_word(encoded: &str) -> Option<String> {
    // 格式：=?charset?B?encoded?= 或 =?charset?Q?encoded?=
    let s = encoded.strip_prefix("=?")?;
    let end = s.strip_suffix("?=")?;
    let parts: Vec<&str> = end.splitn(3, '?').collect();
    if parts.len() != 3 {
        return None;
    }
    let charset = parts[0].to_lowercase();
    let encoding = parts[1].to_uppercase();
    let encoded_text = parts[2];

    // 先解码 transfer encoding 得到 raw bytes
    let raw_bytes: Vec<u8> = match encoding.as_str() {
        "B" => match BASE64.decode(encoded_text.as_bytes()) {
            Ok(b) => b,
            Err(_) => return None,
        },
        "Q" => {
            // MIME QP 使用下划线表示空格，需替换后再解码
            let normalized: Vec<u8> = encoded_text.bytes().map(|b| if b == b'_' { b' ' } else { b }).collect();
            decode_quoted_printable(&normalized)?
        }
        _ => return None,
    };

    // 根据 charset 解码为 String
    // gb2312/gbk 统一归一化为 gb18030（超集），避免"喆"等扩展字符丢失
    let normalized_charset = match charset.as_str() {
        "gb2312" | "gbk" | "gb_2312" | "csiso58gb231280" => "gb18030",
        c => c,
    };
    if matches!(normalized_charset, "utf-8" | "utf8" | "us-ascii" | "ascii") {
        return String::from_utf8(raw_bytes).ok();
    }
    // 用 encoding_rs 的 for_label 动态查找编码器，避免硬编码常量名
    let encoder = encoding_rs::Encoding::for_label(normalized_charset.as_bytes());
    let encoder = match encoder {
        Some(e) => e,
        None => return String::from_utf8(raw_bytes).ok(),
    };
    let (decoded, _, _) = encoder.decode(&raw_bytes);
    Some(decoded.into_owned())
}

/// 解码邮件头字段：扫描其中的 =?charset?B/Q?encoded?= 片段，逐个解码后拼接。
/// 非编码部分原样保留。连续多个 encoded-word 之间的空白会被移除（RFC 2047）。
fn decode_mime_header(value: &str) -> String {
    if !value.contains("=?") || !value.contains("?=") {
        return value.to_string();
    }
    let mut result = String::with_capacity(value.len());
    let mut remaining = value;
    let mut last_was_encoded = false;

    while let Some(start) = remaining.find("=?") {
        // 先把 start 之前的纯文本部分加入结果
        let prefix = &remaining[..start];
        if !prefix.is_empty() {
            // 连续 encoded-word 之间的空白分隔符需移除
            let prefix_trimmed = if last_was_encoded {
                prefix.trim_start()
            } else {
                prefix
            };
            if !prefix_trimmed.is_empty() {
                result.push_str(prefix_trimmed);
            }
        }

        // 查找对应的 ?= 结束标记
        let after_start = &remaining[start..];
        let end = match after_start.find("?=") {
            Some(e) => e,
            None => {
                // 没有结束标记，剩余部分原样加入
                result.push_str(after_start);
                return result;
            }
        };
        let encoded_word = &after_start[..end + 2]; // 含 ?=

        // 尝试解码
        match decode_mime_word(encoded_word) {
            Some(decoded) => {
                result.push_str(&decoded);
                last_was_encoded = true;
            }
            None => {
                // 解码失败，原样保留
                result.push_str(encoded_word);
                last_was_encoded = false;
            }
        }
        remaining = &after_start[end + 2..];
    }

    // 尾部剩余纯文本
    if !remaining.is_empty() {
        result.push_str(remaining);
    }
    result
}

fn parse_address_field(raw: &str) -> (String, String) {
    // 格式："Display Name" <email@example.com> 或 email@example.com
    let raw = raw.trim();
    if let Some(lt) = raw.rfind('<') {
        if let Some(gt) = raw.rfind('>') {
            let email = raw[lt + 1..gt].trim().to_string();
            let name_part = raw[..lt].trim();
            let name = name_part.trim_matches('"').trim().to_string();
            return (name, email);
        }
    }
    (String::new(), raw.to_string())
}

impl Default for EmlMeta {
    fn default() -> Self {
        Self {
            uid: String::new(),
            account_id: String::new(),
            folder: String::new(),
            is_read: false,
            is_starred: false,
            has_attachments: false,
            body_fetched: false,
            message_id: String::new(),
            eml_mtime: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// 索引重建 / 一致性校验（SQLite 作为可重建缓存的核心能力）
// ---------------------------------------------------------------------------

/// 扫描指定文件夹目录下所有 .eml 文件，全量重建该文件夹的 SQLite 索引。
/// 用于手动重建或全量重建（先 DELETE 再 INSERT），不适合启动校验（用 verify_consistency_on_startup）。
fn rebuild_folder_index(state: &EmailState, account_id: &str, folder: &str) -> Result<usize, String> {
    let folder_dir = mail_root()
        .join(sanitize_path_segment(account_id))
        .join(sanitize_path_segment(folder));
    if !folder_dir.exists() {
        // 文件夹目录不存在：清空该文件夹索引（可能用户已手动删除所有邮件）
        let conn = state.conn()?;
        conn.execute(
            "DELETE FROM messages WHERE account_id = ?1 AND folder = ?2",
            params![account_id, folder],
        )
        .map_err(|e| e.to_string())?;
        return Ok(0);
    }

    let conn = state.conn()?;
    // 先删除该文件夹所有索引（保留其他文件夹）
    conn.execute(
        "DELETE FROM messages WHERE account_id = ?1 AND folder = ?2",
        params![account_id, folder],
    )
    .map_err(|e| e.to_string())?;

    let mut count = 0usize;
    let entries = std::fs::read_dir(&folder_dir).map_err(|e| format!("读取文件夹失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(s) => s,
            None => continue,
        };
        // 只处理 .eml 文件（跳过 .eml.meta.json）
        if !name.ends_with(".eml") {
            continue;
        }
        let uid = name.trim_end_matches(".eml").to_string();
        let eml_bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                log::warn!("[rebuild] 读取 .eml 失败 {}: {}", path.display(), e);
                continue;
            }
        };
        let (subject, from_address, from_name, to_addresses, cc_addresses, date, message_id, has_attachments) =
            parse_eml_header(&eml_bytes);
        // 读 .meta.json（如有）
        let meta = read_meta_json(account_id, folder, &uid);
        let is_read = meta.as_ref().map(|m| m.is_read).unwrap_or(false);
        let is_starred = meta.as_ref().map(|m| m.is_starred).unwrap_or(false);
        let body_fetched = meta.as_ref().map(|m| m.body_fetched).unwrap_or(false);
        let has_attach = meta.as_ref().map(|m| m.has_attachments).unwrap_or(has_attachments);
        let mid = meta.as_ref().map(|m| m.message_id.clone()).unwrap_or(message_id);
        let eml_rel = eml_relative_path(account_id, folder, &uid);
        let raw_size = eml_bytes.len() as u32;

        // 若 .meta.json 不存在，从 .eml header 重建一份
        if meta.is_none() {
            let m = EmlMeta {
                uid: uid.clone(),
                account_id: account_id.to_string(),
                folder: folder.to_string(),
                is_read: false,
                is_starred: false,
                has_attachments: has_attach,
                body_fetched: false,
                message_id: mid.clone(),
                eml_mtime: chrono::Utc::now().timestamp(),
            };
            let _ = write_meta_json(&m);
        }

        conn.execute(
            "INSERT INTO messages
             (uid, uid_int, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
              date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path)
             VALUES (?1, CASE WHEN ?1 LIKE 'L%' THEN 0 ELSE CAST(?1 AS INTEGER) END,
                     ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                uid,
                account_id,
                folder,
                if subject.is_empty() { "(no subject)" } else { &subject },
                from_address,
                from_name,
                to_addresses,
                cc_addresses,
                date,
                has_attach as i32,
                is_read as i32,
                is_starred as i32,
                raw_size,
                mid,
                body_fetched as i32,
                eml_rel,
            ],
        )
        .map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
}

/// 全量重建所有账号所有文件夹的 SQLite 索引。返回总记录数。
/// 用于手动触发（email_rebuild_index 命令）或 SQLite 损坏后的恢复。
pub fn rebuild_all_indexes(state: &EmailState) -> Result<usize, String> {
    let conn = state.conn()?;
    // 取所有账号 ID
    let account_ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM accounts").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    drop(conn);

    let mail_root = mail_root();
    let mut total = 0usize;
    for account_id in &account_ids {
        let account_dir = mail_root.join(sanitize_path_segment(account_id));
        if !account_dir.exists() {
            continue;
        }
        // 扫描每个文件夹子目录
        let entries = match std::fs::read_dir(&account_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let folder = match path.file_name().and_then(|n| n.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            match rebuild_folder_index(state, account_id, &folder) {
                Ok(n) => total += n,
                Err(e) => log::warn!(
                    "[rebuild-all] account={} folder={} 失败: {}",
                    account_id,
                    folder,
                    e
                ),
            }
        }
    }
    Ok(total)
}

/// 启动时一致性校验：扫描每个文件夹目录，对比 SQLite 索引，只修复差异（不批量 DELETE）。
/// 此函数应在后台异步调用，不阻塞 UI。
pub fn verify_consistency_on_startup(state: &EmailState) {
    log::info!("[email-verify] 开始启动时一致性校验");
    let start = std::time::Instant::now();

    // 取所有账号 ID（账号实际存在）
    let account_ids: Vec<String> = {
        let conn = match state.conn() {
            Ok(c) => c,
            Err(e) => {
                log::error!("[email-verify] 打开数据库失败: {e}");
                return;
            }
        };
        let mut stmt = match conn.prepare("SELECT id FROM accounts") {
            Ok(s) => s,
            Err(e) => {
                log::error!("[email-verify] 查询 accounts 失败: {e}");
                return;
            }
        };
        let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
            Ok(r) => r,
            Err(e) => {
                log::error!("[email-verify] 查询 accounts rows 失败: {e}");
                return;
            }
        };
        rows.filter_map(|r| r.ok()).collect()
    };

    let mail_root = mail_root();
    let mut total_rebuilt = 0usize;
    let mut total_orphans = 0usize;
    let mut total_folders_checked = 0usize;

    for account_id in &account_ids {
        let account_dir = mail_root.join(sanitize_path_segment(account_id));
        if !account_dir.exists() {
            continue;
        }
        // 扫描每个文件夹子目录（不依赖 folders 表，因为 folders 表可能未同步过）
        let entries = match std::fs::read_dir(&account_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let folder = match path.file_name().and_then(|n| n.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            total_folders_checked += 1;

            // 集合 A：.eml 文件的 uid 集合
            let mut eml_uids: std::collections::HashSet<String> = std::collections::HashSet::new();
            let folder_entries = match std::fs::read_dir(&path) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for fe in folder_entries.flatten() {
                if let Some(name) = fe.file_name().to_str() {
                    if name.ends_with(".eml") && !name.ends_with(".meta.json") {
                        eml_uids.insert(name.trim_end_matches(".eml").to_string());
                    }
                }
            }

            // 集合 B：SQLite 索引的 uid 集合
            let db_uids: std::collections::HashSet<String> = {
                let conn = match state.conn() {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let mut stmt = match conn.prepare(
                    "SELECT uid FROM messages WHERE account_id = ?1 AND folder = ?2",
                ) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                stmt.query_map(params![account_id, &folder], |row| row.get::<_, String>(0))
                    .ok()
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
                    .unwrap_or_default()
            };

            let only_eml: Vec<_> = eml_uids.difference(&db_uids).cloned().collect();
            let only_db: Vec<_> = db_uids.difference(&eml_uids).cloned().collect();

            if only_eml.is_empty() && only_db.is_empty() {
                continue;
            }

            log::debug!(
                "[email-verify] account={} folder={} 不一致: .eml缺索引={}, 索引缺.eml={}",
                account_id,
                folder,
                only_eml.len(),
                only_db.len()
            );

            // 索引缺 .eml：删除孤儿索引记录
            if !only_db.is_empty() {
                let conn = match state.conn() {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                for uid in &only_db {
                    let _ = conn.execute(
                        "DELETE FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                        params![uid, account_id, &folder],
                    );
                }
                total_orphans += only_db.len();
            }

            // .eml 缺索引：解析 .eml header + .meta.json 重建索引
            if !only_eml.is_empty() {
                let conn = match state.conn() {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                for uid in &only_eml {
                    let eml_rel = eml_relative_path(account_id, &folder, uid);
                    let eml_abs = eml_absolute_path(&eml_rel);
                    let eml_bytes = match std::fs::read(&eml_abs) {
                        Ok(b) => b,
                        Err(_) => continue,
                    };
                    let (subject, from_address, from_name, to_addresses, cc_addresses, date, message_id, has_attachments) =
                        parse_eml_header(&eml_bytes);
                    let meta = read_meta_json(account_id, &folder, uid);
                    let is_read = meta.as_ref().map(|m| m.is_read).unwrap_or(false);
                    let is_starred = meta.as_ref().map(|m| m.is_starred).unwrap_or(false);
                    let body_fetched = meta.as_ref().map(|m| m.body_fetched).unwrap_or(false);
                    let has_attach = meta.as_ref().map(|m| m.has_attachments).unwrap_or(has_attachments);
                    let mid = meta.as_ref().map(|m| m.message_id.clone()).unwrap_or(message_id);
                    let raw_size = eml_bytes.len() as u32;

                    // 若 .meta.json 不存在，重建一份
                    if meta.is_none() {
                        let m = EmlMeta {
                            uid: uid.clone(),
                            account_id: account_id.clone(),
                            folder: folder.clone(),
                            is_read: false,
                            is_starred: false,
                            has_attachments: has_attach,
                            body_fetched: false,
                            message_id: mid.clone(),
                            eml_mtime: chrono::Utc::now().timestamp(),
                        };
                        let _ = write_meta_json(&m);
                    }

                    if let Err(e) = conn.execute(
                        "INSERT OR REPLACE INTO messages
                         (uid, uid_int, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                          date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path)
                         VALUES (?1, CASE WHEN ?1 LIKE 'L%' THEN 0 ELSE CAST(?1 AS INTEGER) END,
                                 ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                        params![
                            uid,
                            account_id,
                            &folder,
                            if subject.is_empty() { "(no subject)" } else { &subject },
                            from_address,
                            from_name,
                            to_addresses,
                            cc_addresses,
                            date,
                            has_attach as i32,
                            is_read as i32,
                            is_starred as i32,
                            raw_size,
                            mid,
                            body_fetched as i32,
                            eml_rel,
                        ],
                    ) {
                        log::warn!("[email-verify] 重建索引失败 uid={}: {}", uid, e);
                    } else {
                        total_rebuilt += 1;
                    }
                }
            }
        }
    }

    log::info!(
        "[email-verify] 校验完成 in {:.1}s: 检查文件夹 {} 个, 重建索引 {} 条, 删除孤儿 {} 条",
        start.elapsed().as_secs_f32(),
        total_folders_checked,
        total_rebuilt,
        total_orphans
    );
}

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
    /// IMAP 是否使用 SSL（993 端口默认 true，143 默认 false）
    #[serde(default = "default_true")]
    pub imap_use_ssl: bool,
    /// SMTP 是否使用 SSL（465 端口默认 true，587/25 默认 false，587 用 STARTTLS）
    #[serde(default)]
    pub smtp_use_ssl: bool,
    /// 签名列表（JSON 序列化存储，每账号可有多条签名）
    #[serde(default)]
    pub signatures: Vec<EmailSignature>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailSignature {
    pub id: String,
    pub name: String,
    /// 签名内容（HTML）
    pub content: String,
    #[serde(default)]
    pub is_default: bool,
}

/// 邮件规则/过滤器
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailRule {
    pub id: String,
    pub account_id: String,
    pub name: String,
    /// 条件类型：from_contains / subject_contains / to_contains
    pub condition_field: String,
    /// 条件值
    pub condition_value: String,
    /// 动作类型：move / mark_read / star / delete
    pub action: String,
    /// 动作目标（move 时为目标文件夹）
    #[serde(default)]
    pub action_target: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub priority: i32,
}

/// 延迟发送的邮件（outbox）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEmail {
    pub id: String,
    pub account_id: String,
    pub to_addresses: String,
    #[serde(default)]
    pub cc_addresses: Option<String>,
    #[serde(default)]
    pub bcc_addresses: Option<String>,
    pub subject: String,
    pub body_text: String,
    #[serde(default)]
    pub body_html: Option<String>,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    /// 附件 JSON（与 EmailAttachment 一致）
    #[serde(default)]
    pub attachments_json: Option<String>,
    /// 计划发送时间（ISO 8601）
    pub scheduled_at: String,
    /// 状态：pending / sent / failed
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: String,
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
    /// 正文不再存入 SQLite，前端通过 email_fetch_body 按需从 .eml 文件解析。
    /// 此字段保留为空字符串，仅用于兼容旧前端接口形状。
    #[serde(default)]
    pub body_text: String,
    #[serde(default)]
    pub body_html: Option<String>,
    pub has_attachments: bool,
    pub is_read: bool,
    pub is_starred: bool,
    pub raw_size: u32,
    #[serde(default)]
    pub message_id: Option<String>,
    /// 附件元信息不再存入 SQLite，前端通过 email_fetch_attachment 按需从 .eml 解析。
    /// 此字段保留为空数组，仅用于兼容旧前端接口形状。
    #[serde(default)]
    pub attachments: Vec<EmailAttachment>,
    /// 正文是否已拉取（.eml 文件是否已落盘到本地）
    #[serde(default)]
    pub body_fetched: bool,
    /// .eml 文件相对路径（<account_id>/<folder>/<uid>.eml），空表示未落盘
    #[serde(default)]
    pub eml_path: String,
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

/// email_sync 返回值：新增邮件数 + 新邮件列表（规则应用后仍在当前文件夹的）
/// 前端可直接 prepend 到列表，无需全量 reload
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub new_count: u32,
    pub new_messages: Vec<EmailMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    #[serde(default)]
    pub account_id: String,
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

// EmailState 持久化 db_path，schema 初始化只执行一次。
// 之前的实现每次 conn() 都执行 PRAGMA WAL + 全部 CREATE TABLE + 迁移检查，
// 每次都获取写锁，是邮件列表加载慢的根因（每次 50-200ms 的 schema 检查开销）。
// 现在用 AtomicBool 保证 schema 初始化只执行一次，后续 conn() 只 open + busy_timeout，
// 查询开销降至 <5ms。WAL 是持久化属性，设置一次即可。
#[derive(Clone)]
pub struct EmailState {
    db_path: PathBuf,
    schema_initialized: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// 用户主动 fetch_body 进行中标志：prefetch 检测到时让出 IMAP 锁，避免阻塞用户请求
    user_fetch_in_progress: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// RAII guard：用户主动 fetch_body 期间持有，drop 时自动清除标志。
/// 确保无论函数如何返回（成功/失败/early return），标志都会被清除。
struct UserFetchGuard(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl UserFetchGuard {
    fn new(flag: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Self {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
        Self(flag)
    }
}

impl Drop for UserFetchGuard {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

impl EmailState {
    pub fn new() -> Self {
        let db_path = app_data_dir().join(EMAIL_DB_FILE);
        Self {
            db_path,
            schema_initialized: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            user_fetch_in_progress: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// 返回数据库路径（用于需要创建独立连接的 async 场景）
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// 打开连接。首次调用会执行 schema 初始化 + WAL 设置（写操作），后续只 open + busy_timeout。
    /// WAL 是持久化属性，设置一次后后续连接不需要再设置。
    pub fn conn(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.db_path).map_err(|e| e.to_string())?;
        // 首次调用时设置 WAL + 执行 schema 初始化
        if !self.schema_initialized.load(std::sync::atomic::Ordering::SeqCst) {
            conn.pragma_update(None, "journal_mode", "WAL")
                .map_err(|e| e.to_string())?;
            Self::init_schema(&conn)?;
            self.schema_initialized.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        Ok(conn)
    }

    fn init_schema(conn: &Connection) -> Result<(), String> {
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
                folder TEXT NOT NULL DEFAULT 'INBOX',
                subject TEXT NOT NULL,
                from_address TEXT NOT NULL,
                from_name TEXT,
                to_addresses TEXT NOT NULL,
                cc_addresses TEXT,
                date TEXT NOT NULL,
                has_attachments INTEGER NOT NULL DEFAULT 0,
                is_read INTEGER NOT NULL DEFAULT 0,
                is_starred INTEGER NOT NULL DEFAULT 0,
                raw_size INTEGER NOT NULL DEFAULT 0,
                message_id TEXT,
                body_fetched INTEGER NOT NULL DEFAULT 0,
                eml_path TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (uid, account_id, folder)
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
        // attachments_json 列已弃用：eml_path 迁移会重建表丢弃此列，新安装不再创建
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
        // 迁移：accounts 表添加 imap_use_ssl 列
        let has_imap_use_ssl: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('accounts') WHERE name='imap_use_ssl'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_imap_use_ssl {
            conn.execute(
                "ALTER TABLE accounts ADD COLUMN imap_use_ssl INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：accounts 表添加 smtp_use_ssl 列
        let has_smtp_use_ssl: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('accounts') WHERE name='smtp_use_ssl'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_smtp_use_ssl {
            conn.execute(
                "ALTER TABLE accounts ADD COLUMN smtp_use_ssl INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：accounts 表添加 signatures 列（JSON 数组，存储每账号的多条签名）
        let has_signatures: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('accounts') WHERE name='signatures'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_signatures {
            conn.execute(
                "ALTER TABLE accounts ADD COLUMN signatures TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：messages 表添加 body_fetched 列
        // 默认值 1 表示旧数据已认为正文已拉取（兼容已同步的邮件）
        let has_body_fetched: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('messages') WHERE name='body_fetched'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_body_fetched {
            conn.execute(
                "ALTER TABLE messages ADD COLUMN body_fetched INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：Foxmail 风格文件存储改造
        // 重建 messages 表：移除 body_text/body_html/attachments_json，新增 eml_path
        // 邮件正文和附件改为存入 .eml 文件（<app_data>/mona/mail/<account>/<folder>/<uid>.eml）
        // FTS5 重建为只索引头字段（body_text 不再存于 SQLite）
        let has_eml_path: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('messages') WHERE name='eml_path'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_eml_path {
            log::info!("[email-migration] 开始 Foxmail 风格文件存储改造：重建 messages 表");
            // 1. 删除旧 FTS5 触发器和表（依赖 body_text 列，必须先删）
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS messages_ai;
                DROP TRIGGER IF EXISTS messages_ad;
                DROP TRIGGER IF EXISTS messages_au;
                DROP TABLE IF EXISTS messages_fts;",
            )
            .map_err(|e| e.to_string())?;
            // 2. 创建新表（不含 body_text/body_html/attachments_json，含 eml_path）
            conn.execute_batch(
                "CREATE TABLE messages_new (
                    uid TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    folder TEXT NOT NULL DEFAULT 'INBOX',
                    subject TEXT NOT NULL,
                    from_address TEXT NOT NULL,
                    from_name TEXT,
                    to_addresses TEXT NOT NULL,
                    cc_addresses TEXT,
                    date TEXT NOT NULL,
                    has_attachments INTEGER NOT NULL DEFAULT 0,
                    is_read INTEGER NOT NULL DEFAULT 0,
                    is_starred INTEGER NOT NULL DEFAULT 0,
                    raw_size INTEGER NOT NULL DEFAULT 0,
                    message_id TEXT,
                    body_fetched INTEGER NOT NULL DEFAULT 0,
                    eml_path TEXT NOT NULL DEFAULT '',
                    PRIMARY KEY (uid, account_id, folder)
                );",
            )
            .map_err(|e| e.to_string())?;
            // 3. 复制数据（不复制 body_text/body_html/attachments_json）
            // body_fetched 重置为 0：.eml 文件尚未落盘，待迁移脚本或下次 fetch_body 时落盘
            // 使用 PRAGMA 检查旧表是否有 cc_addresses/message_id 列（极旧版本可能没有）
            let has_cc_col: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('messages') WHERE name='cc_addresses'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            let has_msgid_col: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM pragma_table_info('messages') WHERE name='message_id'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            let select_sql = if has_cc_col && has_msgid_col {
                "INSERT OR IGNORE INTO messages_new
                    (uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                     date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path)
                SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                       date, has_attachments, is_read, is_starred, raw_size, message_id, 0, ''
                FROM messages"
            } else if has_msgid_col {
                "INSERT OR IGNORE INTO messages_new
                    (uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                     date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path)
                SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses, NULL,
                       date, has_attachments, is_read, is_starred, raw_size, message_id, 0, ''
                FROM messages"
            } else {
                "INSERT OR IGNORE INTO messages_new
                    (uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                     date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path)
                SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses, NULL,
                       date, has_attachments, is_read, is_starred, raw_size, NULL, 0, ''
                FROM messages"
            };
            conn.execute(select_sql, []).map_err(|e| e.to_string())?;
            let migrated_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM messages_new", [], |row| row.get(0))
                .unwrap_or(0);
            log::info!("[email-migration] 已迁移 {} 条邮件记录到新 schema", migrated_count);
            // 4. 替换旧表
            conn.execute("DROP TABLE messages", [])
                .map_err(|e| e.to_string())?;
            conn.execute("ALTER TABLE messages_new RENAME TO messages", [])
                .map_err(|e| e.to_string())?;
            // 5. 重建索引
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_messages_account_folder_date
                    ON messages(account_id, folder, date DESC);",
            )
            .map_err(|e| e.to_string())?;
            // 6. 重建 FTS5（只索引头字段，body_text 不再参与全文搜索）
            conn.execute_batch(
                "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                    subject, from_name, from_address, to_addresses,
                    content='messages', content_rowid='rowid',
                    tokenize='unicode61'
                );",
            )
            .map_err(|e| e.to_string())?;
            // 7. 重建触发器（不再引用 body_text）
            conn.execute_batch(
                "CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                    INSERT INTO messages_fts(rowid, subject, from_name, from_address, to_addresses)
                    VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.to_addresses);
                END;
                CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, to_addresses)
                    VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.to_addresses);
                END;
                CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, to_addresses)
                    VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.to_addresses);
                    INSERT INTO messages_fts(rowid, subject, from_name, from_address, to_addresses)
                    VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.to_addresses);
                END;",
            )
            .map_err(|e| e.to_string())?;
            // 8. 重建 FTS 索引
            conn.execute_batch("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');")
                .map_err(|e| e.to_string())?;
            log::info!("[email-migration] Foxmail 风格文件存储改造完成");
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
        // 迁移：新增 uid_int 列（INTEGER 类型），消除 CAST(uid AS INTEGER) 导致的索引失效
        // uid 是 TEXT（本地发送用 "L" 前缀），但排序/分页需要整数语义
        let has_uid_int: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('messages') WHERE name='uid_int'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_uid_int {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN uid_int INTEGER NOT NULL DEFAULT 0;
                 UPDATE messages SET uid_int = CAST(uid AS INTEGER) WHERE uid NOT LIKE 'L%';
                 UPDATE messages SET uid_int = 0 WHERE uid LIKE 'L%';",
            )
            .map_err(|e| e.to_string())?;
        }
        // uid_int 索引：用于列表查询的 ORDER BY uid_int DESC 和游标分页
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_messages_account_folder_uid_int
                ON messages(account_id, folder, uid_int DESC);
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
                uid_validity TEXT,
                PRIMARY KEY (account_id, name)
            );
            CREATE INDEX IF NOT EXISTS idx_folders_account ON folders(account_id);
            ",
        )
        .map_err(|e| e.to_string())?;
        // 迁移：给旧 folders 表加 uid_validity 列（用于 UIDVALIDITY 检测）
        let has_uid_validity: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('folders') WHERE name='uid_validity'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_uid_validity {
            conn.execute(
                "ALTER TABLE folders ADD COLUMN uid_validity TEXT",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // 迁移：给 folders 表加 last_synced_uid 列（按 folder 存储同步水位线，
        // 替代从 messages 表查 MAX(uid_int)，避免本地残留过期高 UID 导致 IMAP 同步死循环）
        let has_last_synced_uid: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('folders') WHERE name='last_synced_uid'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_last_synced_uid {
            conn.execute(
                "ALTER TABLE folders ADD COLUMN last_synced_uid INTEGER",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        // FTS5 全文搜索索引（外部内容表，关联 messages）
        // 注意：body_text 已移除，FTS5 只索引头字段
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                subject, from_name, from_address, to_addresses,
                content='messages', content_rowid='rowid',
                tokenize='unicode61'
            );",
        )
        .map_err(|e| e.to_string())?;
        // 触发器：messages 表变更时同步到 FTS 表（不再引用 body_text）
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, subject, from_name, from_address, to_addresses)
                VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.to_addresses);
            END;
            CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, to_addresses)
                VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.to_addresses);
            END;
            CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_address, to_addresses)
                VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.to_addresses);
                INSERT INTO messages_fts(rowid, subject, from_name, from_address, to_addresses)
                VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.to_addresses);
            END;",
        )
        .map_err(|e| e.to_string())?;
        // 首次创建 FTS 表时，重建索引灌入现有数据
        let fts_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages_fts", [], |row| row.get(0))
            .unwrap_or(0);
        let msg_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap_or(0);
        if fts_count == 0 && msg_count > 0 {
            conn.execute_batch("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');")
                .map_err(|e| e.to_string())?;
        }
        // 邮件规则/过滤器表
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS email_rules (
                id TEXT NOT NULL PRIMARY KEY,
                account_id TEXT NOT NULL,
                name TEXT NOT NULL,
                condition_field TEXT NOT NULL,
                condition_value TEXT NOT NULL,
                action TEXT NOT NULL,
                action_target TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                priority INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_email_rules_account ON email_rules(account_id);
            ",
        )
        .map_err(|e| e.to_string())?;
        // 延迟发送 outbox 表
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS email_outbox (
                id TEXT NOT NULL PRIMARY KEY,
                account_id TEXT NOT NULL,
                to_addresses TEXT NOT NULL,
                cc_addresses TEXT,
                bcc_addresses TEXT,
                subject TEXT NOT NULL,
                body_text TEXT NOT NULL,
                body_html TEXT,
                in_reply_to TEXT,
                attachments_json TEXT,
                scheduled_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox(status, scheduled_at);
            ",
        )
        .map_err(|e| e.to_string())?;
        // 账号冷却表：记录 IMAP/SMTP 认证失败时间，避免重启后立即重试加剧风控
        // PRIMARY KEY 必须是 (account_id, service) 复合键，否则 IMAP/SMTP 冷却会互相覆盖
        // 幂等迁移：检查现有表的主键，如果不正确则 DROP 重建（冷却期数据可丢失）
        let cooldown_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='account_cooldowns'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_default();
        if !cooldown_sql.is_empty() && !cooldown_sql.contains("account_id, service") {
            // 旧表主键不对（只有 account_id），DROP 重建
            conn.execute("DROP TABLE account_cooldowns", [])
                .map_err(|e| e.to_string())?;
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS account_cooldowns (
                account_id TEXT NOT NULL,
                service TEXT NOT NULL,
                failed_until TEXT NOT NULL,
                reason TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (account_id, service)
            );
            ",
        )
        .map_err(|e| e.to_string())?;
        Ok(())
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
                    from_name, last_synced_uid, carddav_url, eas_url, imap_use_ssl, smtp_use_ssl,
                    signatures
             FROM accounts ORDER BY display_name",
        )
        .map_err(|e| e.to_string())?;
    let accounts = stmt
        .query_map([], |row| {
            let sigs_str: String = row.get(17).unwrap_or_else(|_| "[]".to_string());
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
                imap_use_ssl: row.get::<_, i32>(15)? != 0,
                smtp_use_ssl: row.get::<_, i32>(16)? != 0,
                signatures: serde_json::from_str(&sigs_str).unwrap_or_default(),
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
          last_synced_uid, carddav_url, eas_url, imap_use_ssl, smtp_use_ssl, signatures)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
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
            account.imap_use_ssl as i32,
            account.smtp_use_ssl as i32,
            serde_json::to_string(&account.signatures).unwrap_or_else(|_| "[]".to_string()),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn email_update_account_settings(
    state: tauri::State<'_, EmailState>,
    account: EmailAccount,
    new_password: Option<String>,
) -> Result<(), String> {
    let conn = state.conn()?;
    // 密码：仅在显式传入非空新密码时才更新（避免双重加密 / 误清空）
    let (imap_pwd, smtp_pwd) = match new_password.as_deref() {
        Some(p) if !p.is_empty() => {
            let enc = encrypt_password(p)?;
            (enc.clone(), enc)
        }
        _ => {
            // 保留数据库原密码
            let row: (String, String) = conn
                .query_row(
                    "SELECT imap_password, smtp_password FROM accounts WHERE id = ?1",
                    params![&account.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(|e| e.to_string())?;
            row
        }
    };
    conn.execute(
        "UPDATE accounts SET
            display_name = ?2, imap_host = ?3, imap_port = ?4, imap_username = ?5,
            imap_password = ?6, smtp_host = ?7, smtp_port = ?8, smtp_username = ?9,
            smtp_password = ?10, from_address = ?11, from_name = ?12,
            last_synced_uid = ?13, carddav_url = ?14, eas_url = ?15,
            imap_use_ssl = ?16, smtp_use_ssl = ?17, signatures = ?18
         WHERE id = ?1",
        params![
            account.id,
            account.display_name,
            account.imap_host,
            account.imap_port,
            account.imap_username,
            imap_pwd,
            account.smtp_host,
            account.smtp_port,
            account.smtp_username,
            smtp_pwd,
            account.from_address,
            account.from_name,
            account.last_synced_uid,
            account.carddav_url,
            account.eas_url,
            account.imap_use_ssl as i32,
            account.smtp_use_ssl as i32,
            serde_json::to_string(&account.signatures).unwrap_or_else(|_| "[]".to_string()),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn email_delete_account(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    account_id: String,
) -> Result<(), String> {
    // 先获取账号信息，用于通知 gateway 清理 IDLE 和连接池
    let (imap_host, imap_username) = {
        let conn = state.conn()?;
        conn.query_row(
            "SELECT imap_host, imap_username FROM accounts WHERE id = ?1",
            params![&account_id],
            |row| {
                let host: String = row.get(0)?;
                let user: String = row.get(1)?;
                Ok((host, user))
            },
        )
        .map_err(|e| format!("获取账号信息失败: {e}"))?
    };

    // 通知 gateway 停止该账号的 IDLE 监听并移除 IMAP 连接池
    // 必须在删除 SQLite 记录前调用，否则无法拿到 imap_host/username
    if !gateway_url.is_empty() && !imap_host.is_empty() && !imap_username.is_empty() {
        let url = format!("{}/email/account_removed", gateway_url.trim_end_matches('/'));
        let client = reqwest::Client::builder()
        .no_proxy()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let payload = serde_json::json!({
            "accountId": &account_id,
            "imapHost": &imap_host,
            "imapUsername": &imap_username,
        });
        let _ = client.post(&url).json(&payload).send().await;
        // 清理失败不应阻断账号删除，仅记录（无法在这里 eprintln，忽略即可）
    }

    let conn = state.conn()?;
    // 删除该账号的所有 .eml 文件（整个账号目录）
    let account_dir = mail_root().join(sanitize_path_segment(&account_id));
    if account_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&account_dir) {
            log::warn!(
                "[email-delete-account] account={} remove eml dir failed: {}",
                account_id,
                e
            );
        }
    }
    conn.execute("DELETE FROM messages WHERE account_id = ?1", params![&account_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders WHERE account_id = ?1", params![&account_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM email_rules WHERE account_id = ?1", params![&account_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", params![&account_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri 命令 — 邮件规则/过滤器
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn email_list_rules(
    state: tauri::State<'_, EmailState>,
    account_id: String,
) -> Result<Vec<EmailRule>, String> {
    let conn = state.conn()?;
    let mut stmt = conn
        .prepare("SELECT id, account_id, name, condition_field, condition_value, action, action_target, enabled, priority FROM email_rules WHERE account_id = ?1 ORDER BY priority DESC, name")
        .map_err(|e| e.to_string())?;
    let rules = stmt
        .query_map(params![account_id], |row| {
            Ok(EmailRule {
                id: row.get(0)?,
                account_id: row.get(1)?,
                name: row.get(2)?,
                condition_field: row.get(3)?,
                condition_value: row.get(4)?,
                action: row.get(5)?,
                action_target: row.get(6)?,
                enabled: row.get::<_, i32>(7)? != 0,
                priority: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rules)
}

#[tauri::command]
pub async fn email_save_rule(
    state: tauri::State<'_, EmailState>,
    rule: EmailRule,
) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute(
        "INSERT OR REPLACE INTO email_rules
         (id, account_id, name, condition_field, condition_value, action, action_target, enabled, priority)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            rule.id,
            rule.account_id,
            rule.name,
            rule.condition_field,
            rule.condition_value,
            rule.action,
            rule.action_target,
            rule.enabled as i32,
            rule.priority,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn email_delete_rule(
    state: tauri::State<'_, EmailState>,
    rule_id: String,
) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute("DELETE FROM email_rules WHERE id = ?1", params![rule_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取账号下所有启用的规则（供同步时应用）
pub fn get_enabled_rules(conn: &Connection, account_id: &str) -> Result<Vec<EmailRule>, String> {
    let mut stmt = conn
        .prepare("SELECT id, account_id, name, condition_field, condition_value, action, action_target, enabled, priority FROM email_rules WHERE account_id = ?1 AND enabled = 1 ORDER BY priority DESC")
        .map_err(|e| e.to_string())?;
    let rules = stmt
        .query_map(params![account_id], |row| {
            Ok(EmailRule {
                id: row.get(0)?,
                account_id: row.get(1)?,
                name: row.get(2)?,
                condition_field: row.get(3)?,
                condition_value: row.get(4)?,
                action: row.get(5)?,
                action_target: row.get(6)?,
                enabled: row.get::<_, i32>(7)? != 0,
                priority: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rules)
}

/// 从邮件的 from/to/cc 字段解析 (display_name, email) 列表。
/// 支持的格式：
///   - `"Name" <email@example.com>`
///   - `Name <email@example.com>`
///   - `email@example.com`
///   - JSON 数组字符串（to/cc 字段用）
fn parse_addresses_from_field(raw: &str) -> Vec<(String, String)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    // JSON 数组格式（to/cc 字段）
    if raw.starts_with('[') {
        if let Ok(arr) = serde_json::from_str::<Vec<Value>>(raw) {
            return arr
                .iter()
                .filter_map(|v| {
                    let email = v["email"].as_str()?.to_string();
                    if email.is_empty() {
                        return None;
                    }
                    let name = v["name"].as_str().unwrap_or("").to_string();
                    Some((name, email))
                })
                .collect();
        }
        return Vec::new();
    }
    // 逗号分隔的地址列表
    let mut result = Vec::new();
    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        // 提取 <email>
        if let Some(lt) = part.find('<') {
            if let Some(gt) = part.find('>') {
                let email = part[lt + 1..gt].trim().to_string();
                let name = part[..lt].trim().trim_matches('"').to_string();
                if !email.is_empty() {
                    result.push((name, email));
                }
                continue;
            }
        }
        // 纯邮箱
        if part.contains('@') {
            result.push((String::new(), part.to_string()));
        }
    }
    result
}

/// 自动从新邮件收集联系人：提取 From/To/Cc，按 email 全局去重后插入 contacts 表。
/// source 固定为 "auto"。失败仅记录日志，不影响邮件同步主流程。
fn auto_collect_contacts(conn: &Connection, account_id: &str, messages: &[Value]) {
    let now = chrono::Utc::now().timestamp();
    for msg in messages {
        let from_addr = msg["from"].as_str().unwrap_or("");
        let from_name = msg.get("fromName").and_then(|v| v.as_str()).unwrap_or("");
        let to_addrs = msg["to"].as_str().unwrap_or("");
        let cc_addrs = msg.get("cc").and_then(|v| v.as_str()).unwrap_or("");

        let mut candidates: Vec<(String, String)> = Vec::new();
        // From：优先用 fromName
        candidates.push((from_name.to_string(), from_addr.to_string()));
        // To / Cc
        for raw in [to_addrs, cc_addrs] {
            candidates.extend(parse_addresses_from_field(raw));
        }

        for (name, email) in candidates {
            let email_clean = email.trim().to_lowercase();
            if email_clean.is_empty() || !email_clean.contains('@') {
                continue;
            }
            // 全局按 email 去重
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM contacts WHERE lower(email) = ?1 LIMIT 1",
                    params![&email_clean],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if exists {
                continue;
            }
            let display = if name.trim().is_empty() {
                email_clean.clone()
            } else {
                name.trim().to_string()
            };
            let id = uuid::Uuid::new_v4().to_string();
            if let Err(e) = conn.execute(
                "INSERT INTO contacts
                 (id, account_id, source, display_name, email, updated_at)
                 VALUES (?1, ?2, 'auto', ?3, ?4, ?5)",
                params![id, account_id, display, email_clean, now],
            ) {
                log::warn!("[auto-collect] insert contact failed: {e}");
            }
        }
    }
}

/// 判断邮件是否匹配规则条件
pub fn rule_matches(rule: &EmailRule, subject: &str, from_address: &str, from_name: &str, to_addresses: &str) -> bool {
    let value = rule.condition_value.to_lowercase();
    if value.is_empty() {
        return false;
    }
    let field_value = match rule.condition_field.as_str() {
        "from_contains" => format!("{} {}", from_address, from_name).to_lowercase(),
        "subject_contains" => subject.to_lowercase(),
        "to_contains" => to_addresses.to_lowercase(),
        _ => return false,
    };
    field_value.contains(&value)
}

// ---------------------------------------------------------------------------
// Tauri 命令 — 延迟发送（outbox）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn email_outbox_add(
    state: tauri::State<'_, EmailState>,
    email: OutboxEmail,
) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute(
        "INSERT INTO email_outbox
         (id, account_id, to_addresses, cc_addresses, bcc_addresses, subject, body_text,
          body_html, in_reply_to, attachments_json, scheduled_at, status, error, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            email.id,
            email.account_id,
            email.to_addresses,
            email.cc_addresses,
            email.bcc_addresses,
            email.subject,
            email.body_text,
            email.body_html,
            email.in_reply_to,
            email.attachments_json,
            email.scheduled_at,
            email.status,
            email.error,
            email.created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn email_outbox_list(
    state: tauri::State<'_, EmailState>,
    account_id: String,
) -> Result<Vec<OutboxEmail>, String> {
    let conn = state.conn()?;
    let mut stmt = conn
        .prepare("SELECT id, account_id, to_addresses, cc_addresses, bcc_addresses, subject, body_text, body_html, in_reply_to, attachments_json, scheduled_at, status, error, created_at FROM email_outbox WHERE account_id = ?1 ORDER BY scheduled_at DESC")
        .map_err(|e| e.to_string())?;
    let emails = stmt
        .query_map(params![account_id], |row| {
            Ok(OutboxEmail {
                id: row.get(0)?,
                account_id: row.get(1)?,
                to_addresses: row.get(2)?,
                cc_addresses: row.get(3)?,
                bcc_addresses: row.get(4)?,
                subject: row.get(5)?,
                body_text: row.get(6)?,
                body_html: row.get(7)?,
                in_reply_to: row.get(8)?,
                attachments_json: row.get(9)?,
                scheduled_at: row.get(10)?,
                status: row.get(11)?,
                error: row.get(12)?,
                created_at: row.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(emails)
}

#[tauri::command]
pub async fn email_outbox_delete(
    state: tauri::State<'_, EmailState>,
    id: String,
) -> Result<(), String> {
    let conn = state.conn()?;
    conn.execute("DELETE FROM email_outbox WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 处理到期的 outbox 邮件：调用 gateway 发送，成功后更新状态
#[tauri::command]
pub async fn email_outbox_process(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
) -> Result<u32, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空".into());
    }
    let db_path = state.db_path().to_path_buf();

    // Phase 1: 同步读取 — 查询到期邮件 + 获取凭据 + 构建请求体（不跨 await）
    struct PendingSend {
        id: String,
        req_body: Value,
    }
    let pending: Vec<PendingSend> = {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut stmt = conn
            .prepare("SELECT id, account_id, to_addresses, cc_addresses, bcc_addresses, subject, body_text, body_html, in_reply_to, attachments_json FROM email_outbox WHERE status = 'pending' AND scheduled_at <= ?1")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, String, Option<String>, Option<String>, String, String, Option<String>, Option<String>, Option<String>)> = stmt
            .query_map(params![now], |row| {
                Ok((
                    row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                    row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        let mut result = Vec::new();
        for (id, account_id, to, cc, bcc, subject, body_text, body_html, in_reply_to, attachments_json) in rows {
            let account = match get_imap_credentials(&conn, &account_id) {
                Ok(a) => a,
                Err(e) => {
                    let _ = conn.execute(
                        "UPDATE email_outbox SET status = 'failed', error = ?1 WHERE id = ?2",
                        params![format!("账号不存在: {e}"), id],
                    );
                    continue;
                }
            };
            let smtp_password = match decrypt_password(&account.smtp_password) {
                Ok(p) => p,
                Err(e) => {
                    let _ = conn.execute(
                        "UPDATE email_outbox SET status = 'failed', error = ?1 WHERE id = ?2",
                        params![format!("密码解密失败: {e}"), id],
                    );
                    continue;
                }
            };
            let attachments: Value = attachments_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Array(vec![]));
            let req_body = serde_json::json!({
                "smtpHost": account.smtp_host,
                "smtpPort": account.smtp_port,
                "smtpUsername": account.smtp_username,
                "smtpPassword": smtp_password,
                "useSsl": account.smtp_use_ssl,
                "fromAddress": account.from_address,
                "fromName": account.from_name,
                "to": to.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>(),
                "cc": cc.as_deref().unwrap_or("").split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>(),
                "bcc": bcc.as_deref().unwrap_or("").split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>(),
                "subject": subject,
                "bodyHtml": body_html.as_deref().unwrap_or(""),
                "bodyText": body_text,
                "inReplyTo": in_reply_to,
                "attachments": attachments,
            });
            result.push(PendingSend { id, req_body });
        }
        result
    }; // conn dropped

    // Phase 2: 异步发送 — 不持有 Connection
    let url = format!("{}/email/send", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let mut sent_count = 0u32;
    let mut updates: Vec<(String, &'static str, Option<String>)> = Vec::new();

    for item in pending {
        match client.post(&url).json(&item.req_body).send().await {
            Ok(resp) if resp.status().is_success() => {
                updates.push((item.id, "sent", None));
                sent_count += 1;
            }
            Ok(resp) => {
                let text = resp.text().await.unwrap_or_default();
                updates.push((item.id, "failed", Some(text)));
            }
            Err(e) => {
                updates.push((item.id, "failed", Some(format!("网络错误: {e}"))));
            }
        }
    }

    // Phase 3: 同步写入 — 更新状态
    if !updates.is_empty() {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        for (id, status, error) in updates {
            let _ = conn.execute(
                "UPDATE email_outbox SET status = ?1, error = ?2 WHERE id = ?3",
                params![status, error, id],
            );
        }
    }

    Ok(sent_count)
}

// ---------------------------------------------------------------------------
// Tauri 命令 — 邮件缓存
// ---------------------------------------------------------------------------

/// 递归提取 text/plain 和 text/html 正文。
/// 同时收集内联图片（Content-ID 或 inline image），把 HTML 中的 cid: 引用替换为 data URI。
fn extract_bodies(
    msg: &mailparse::ParsedMail<'_>,
    body_text: &mut String,
    body_html: &mut Option<String>,
) {
    // 先收集所有内联图片，建立 cid -> data URI 映射
    let mut inline_images: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    collect_inline_images(msg, &mut inline_images);

    // 递归提取 text/plain 和 text/html
    extract_bodies_inner(msg, body_text, body_html);

    // 替换 HTML 中的 cid: 引用为 data URI
    if let Some(html) = body_html.as_mut() {
        if !inline_images.is_empty() {
            replace_cid_refs(html, &inline_images);
        }
    }
}

/// 递归提取附件元信息（Content-Disposition: attachment 的 part）
/// 返回 { filename, contentType, size, partId } 列表，前端用于展示和按需下载
fn extract_attachments(msg: &mailparse::ParsedMail<'_>, attachments: &mut Vec<serde_json::Value>) {
    let disposition = msg.get_content_disposition();
    if disposition.disposition == mailparse::DispositionType::Attachment {
        let filename = disposition
            .params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("filename"))
            .map(|(_, v)| v.clone())
            .or_else(|| {
                msg.ctype
                    .params
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("name"))
                    .map(|(_, v)| v.clone())
            })
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "未命名附件".to_string());
        let content_type = msg.ctype.mimetype.clone();
        let size = msg.get_body_raw().map(|b| b.len()).unwrap_or(0) as u64;
        attachments.push(serde_json::json!({
            "filename": filename,
            "contentType": content_type,
            "size": size,
            "partId": String::new(),
        }));
    }
    // 递归子 part，包括 message/* 嵌套邮件（转发邮件内的附件）
    for part in &msg.subparts {
        extract_attachments(part, attachments);
    }
}

/// 递归查找指定文件名的附件 part，返回其解码后的原始字节
/// skill 第五节：完整 .eml 中的附件已经在本地，用户点击下载时从 .eml 解码并导出，不再请求网络
fn find_attachment_bytes<'a>(msg: &'a mailparse::ParsedMail<'_>, filename: &str) -> Option<(&'a mailparse::ParsedMail<'a>, String)> {
    let disposition = msg.get_content_disposition();
    if disposition.disposition == mailparse::DispositionType::Attachment {
        let fname = disposition
            .params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("filename"))
            .map(|(_, v)| v.clone())
            .or_else(|| {
                msg.ctype
                    .params
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("name"))
                    .map(|(_, v)| v.clone())
            })
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "未命名附件".to_string());
        if fname == filename {
            return Some((msg, fname));
        }
    }
    for part in &msg.subparts {
        if let Some(found) = find_attachment_bytes(part, filename) {
            return Some(found);
        }
    }
    None
}

/// 递归收集内联图片（Content-ID 或 inline disposition 的 image/*），转成 data URI
fn collect_inline_images(
    msg: &mailparse::ParsedMail<'_>,
    map: &mut std::collections::HashMap<String, String>,
) {
    let content_type = msg.ctype.mimetype.as_str();
    let disposition = msg.get_content_disposition();
    let cid = msg
        .headers
        .iter()
        .find(|h| h.get_key().eq_ignore_ascii_case("content-id"))
        .map(|h| h.get_value())
        .unwrap_or_default();
    let is_inline_image = !cid.is_empty()
        || (disposition.disposition == mailparse::DispositionType::Inline
            && content_type.starts_with("image/"));

    if is_inline_image {
        let cid_key = cid
            .trim()
            .trim_matches(|c| c == '<' || c == '>')
            .trim()
            .to_lowercase();
        if !cid_key.is_empty() {
            if let Ok(raw) = msg.get_body_raw() {
                // 大小保护：单张超 5MB 不转换
                if raw.len() < 5 * 1024 * 1024 {
                    let data_uri = format!(
                        "data:{};base64,{}",
                        content_type,
                        base64::engine::general_purpose::STANDARD.encode(&raw)
                    );
                    map.insert(cid_key, data_uri);
                }
            }
        }
    }

    for part in &msg.subparts {
        collect_inline_images(part, map);
    }
}

/// 替换 HTML 中的 src="cid:xxx" 和 src='cid:xxx' 为 data URI
fn replace_cid_refs(html: &mut String, map: &std::collections::HashMap<String, String>) {
    if map.is_empty() {
        return;
    }
    let lower = html.to_lowercase();
    let mut result = String::with_capacity(html.len());
    let mut last_end = 0;
    let mut search_from = 0;
    let needle = "cid:";
    // cid: 前面必须是紧邻的 src=" 或 src='（共 5 字节）
    let prefix_len = 5;

    while search_from < lower.len() {
        let idx = match lower[search_from..].find(needle) {
            Some(i) => search_from + i,
            None => break,
        };
        // 检查 cid: 前面紧邻的 5 字节是否是 src=" 或 src='
        if idx >= prefix_len {
            let prefix = &lower[idx - prefix_len..idx];
            if prefix == "src=\"" || prefix == "src='" {
                let quote_char = prefix.as_bytes()[prefix_len - 1];
                // 提取 cid: 后面的 key（到对应的引号结束）
                let after = &html[idx + needle.len()..];
                if let Some(end) = after.find(quote_char as char) {
                    let cid_ref = after[..end].trim().to_lowercase();
                    if let Some(data_uri) = map.get(&cid_ref) {
                        // 保留 src=" 部分，替换 cid:xxx 为 data URI
                        result.push_str(&html[last_end..idx]);
                        result.push_str(data_uri);
                        last_end = idx + needle.len() + end;
                        search_from = last_end;
                        continue;
                    }
                }
            }
        }
        search_from = idx + needle.len();
    }
    if last_end < html.len() {
        result.push_str(&html[last_end..]);
    }
    *html = result;
}

/// 递归提取 text/plain 和 text/html 正文（内部函数）
fn extract_bodies_inner(
    msg: &mailparse::ParsedMail<'_>,
    body_text: &mut String,
    body_html: &mut Option<String>,
) {
    let mimetype = &msg.ctype.mimetype;
    if mimetype == "text/plain" && body_text.is_empty() {
        if let Some(text) = decode_body_part(msg) {
            *body_text = text;
        }
    } else if mimetype == "text/html" && body_html.is_none() {
        if let Some(text) = decode_body_part(msg) {
            *body_html = Some(text);
        }
    } else if mimetype.starts_with("multipart/") {
        for part in &msg.subparts {
            extract_bodies_inner(part, body_text, body_html);
        }
    } else if mimetype.starts_with("message/") {
        // 嵌套邮件（message/rfc822、message/global、message/disposition-notification 等）
        // 嵌套邮件的子 part 是真正的邮件内容，递归解析提取正文
        // 例如转发邮件：multipart/mixed → message/rfc822 → multipart/alternative → text/plain|html
        // 不递归的话整个转发邮件正文都会丢失（Foxmail 能递归，Mona 之前跳过）
        for part in &msg.subparts {
            extract_bodies_inner(part, body_text, body_html);
        }
    }
}

/// 解码邮件正文 part：用 get_body_raw 获取已去除 transfer encoding 的原始字节，手动按 charset 解码。
/// gb2312/gbk 归一化为 gb18030（超集，含"喆"等扩展字符），
/// 避免 mailparse::get_body() 按 gb2312 解码时扩展字符变 U+FFFD。
/// 先尝试 UTF-8 严格解码（兼容声明 gb2312 但实际 UTF-8 的邮件），失败再用声明的 charset。
fn decode_body_part(msg: &mailparse::ParsedMail<'_>) -> Option<String> {
    let raw = msg.get_body_raw().ok()?;
    if raw.is_empty() {
        return None;
    }
    // 先尝试 UTF-8 严格解码（兼容声明 gb2312 但实际 UTF-8 的错误邮件）
    if let Ok(s) = String::from_utf8(raw.clone()) {
        return Some(s);
    }
    // UTF-8 失败：读取 Content-Type 的 charset 参数
    let charset = msg
        .ctype
        .params
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("charset"))
        .map(|(_, v)| v.to_lowercase())
        .unwrap_or_else(|| "gb18030".to_string());
    // gb2312/gbk 归一化为 gb18030（超集，含"喆"等扩展字符）
    let normalized = match charset.as_str() {
        "gb2312" | "gbk" | "gb_2312" | "csiso58gb231280" => "gb18030",
        c => c,
    };
    let encoder = encoding_rs::Encoding::for_label(normalized.as_bytes());
    match encoder {
        Some(e) => {
            let (decoded, _, _) = e.decode(&raw);
            Some(decoded.into_owned())
        }
        None => Some(String::from_utf8_lossy(&raw).into_owned()),
    }
}

#[tauri::command]
pub async fn email_get_messages(
    state: tauri::State<'_, EmailState>,
    account_id: String,
    folder: String,
    before_uid: Option<String>,
    limit: u32,
) -> Result<Vec<EmailMessage>, String> {
    let conn = state.conn()?;
    // 游标分页：before_uid 为空时拉取最新一页；非空时拉取 uid < before_uid 的下一页
    // 替代 OFFSET，避免大表越往后翻越慢
    let (sql, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = match &before_uid {
        Some(b) if !b.is_empty() => {
            let parsed = b.parse::<i64>().unwrap_or(0);
            (
                "SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                        date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path
                 FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid_int < ?3
                 ORDER BY uid_int DESC LIMIT ?4"
                    .to_string(),
                vec![
                    Box::new(account_id) as Box<dyn rusqlite::ToSql>,
                    Box::new(folder),
                    Box::new(parsed),
                    Box::new(limit),
                ],
            )
        }
        _ => (
            "SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                    date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path
             FROM messages WHERE account_id = ?1 AND folder = ?2
             ORDER BY uid_int DESC LIMIT ?3"
                .to_string(),
            vec![
                Box::new(account_id) as Box<dyn rusqlite::ToSql>,
                Box::new(folder),
                Box::new(limit),
            ],
        ),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let msgs = stmt
        .query_map(param_refs.as_slice(), |row| {
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
                body_text: String::new(),
                body_html: None,
                has_attachments: row.get::<_, i32>(9)? != 0,
                is_read: row.get::<_, i32>(10)? != 0,
                is_starred: row.get::<_, i32>(11)? != 0,
                raw_size: row.get(12)?,
                message_id: row.get(13)?,
                attachments: Vec::new(),
                body_fetched: row.get::<_, i32>(14)? != 0,
                eml_path: row.get(15)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(msgs)
}

/// 统一收件箱：聚合所有账号 INBOX，按日期降序，使用 date 作为游标（uid 跨账号会冲突）
/// 用于 P5-2 统一收件箱视图
#[tauri::command]
pub async fn email_get_unified_inbox(
    state: tauri::State<'_, EmailState>,
    before_date: Option<String>,
    limit: u32,
) -> Result<Vec<EmailMessage>, String> {
    let conn = state.conn()?;
    let (sql, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = match &before_date {
        Some(b) if !b.is_empty() => (
            "SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                    date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path
             FROM messages
             WHERE folder = 'INBOX' AND date < ?1
             ORDER BY date DESC LIMIT ?2"
                .to_string(),
            vec![
                Box::new(b.clone()) as Box<dyn rusqlite::ToSql>,
                Box::new(limit),
            ],
        ),
        _ => (
            "SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                    date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path
             FROM messages
             WHERE folder = 'INBOX'
             ORDER BY date DESC LIMIT ?1"
                .to_string(),
            vec![Box::new(limit) as Box<dyn rusqlite::ToSql>],
        ),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let msgs = stmt
        .query_map(param_refs.as_slice(), |row| {
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
                body_text: String::new(),
                body_html: None,
                has_attachments: row.get::<_, i32>(9)? != 0,
                is_read: row.get::<_, i32>(10)? != 0,
                is_starred: row.get::<_, i32>(11)? != 0,
                raw_size: row.get(12)?,
                message_id: row.get(13)?,
                attachments: Vec::new(),
                body_fetched: row.get::<_, i32>(14)? != 0,
                eml_path: row.get(15)?,
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
    // 本地优先：先更新 SQLite，确保 UI 立即响应且状态持久化
    // 即使 IMAP 同步失败（如企业邮箱限制非 INBOX 文件夹），本地已读状态也不会丢失
    {
        let conn = state.conn()?;
        let value: i32 = if req.add { 1 } else { 0 };
        conn.execute(
            "UPDATE messages SET is_read = ?1 WHERE uid = ?2 AND account_id = ?3 AND folder = ?4",
            params![value, req.uid, req.account_id, req.mailbox],
        )
        .map_err(|e| e.to_string())?;
        // 同步更新 .meta.json
        if let Some(mut meta) = read_meta_json(&req.account_id, &req.mailbox, &req.uid) {
            meta.is_read = req.add;
            let _ = write_meta_json(&meta);
        }
    }

    // 后台同步到 IMAP 服务器（fire-and-forget，不阻塞前端）
    // Foxmail 风格：本地已读状态秒级生效，IMAP 同步在后台进行，失败不影响本地
    if !gateway_url.is_empty() {
        let url = format!("{}/email/set_flag", gateway_url.trim_end_matches('/'));
        let req_clone = req.clone();
        tokio::spawn(async move {
            let client = reqwest::Client::builder()
        .no_proxy()
                .timeout(Duration::from_secs(10))
                .build();
            if let Ok(client) = client {
                match client.post(&url).json(&req_clone).send().await {
                    Ok(resp) if resp.status().is_success() => {}
                    Ok(resp) => {
                        let status = resp.status();
                        let text = resp.text().await.unwrap_or_default();
                        log::warn!(
                            "[email-mark-read] IMAP set_flag 失败（本地已更新）: {} {}",
                            status,
                            text
                        );
                    }
                    Err(e) => {
                        log::warn!(
                            "[email-mark-read] 请求 gateway 失败（本地已更新）: {}",
                            e
                        );
                    }
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn email_toggle_starred(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: SetFlagRequest,
) -> Result<(), String> {
    // 本地优先：先更新 SQLite
    {
        let conn = state.conn()?;
        let value: i32 = if req.add { 1 } else { 0 };
        conn.execute(
            "UPDATE messages SET is_starred = ?1 WHERE uid = ?2 AND account_id = ?3 AND folder = ?4",
            params![value, req.uid, req.account_id, req.mailbox],
        )
        .map_err(|e| e.to_string())?;
        if let Some(mut meta) = read_meta_json(&req.account_id, &req.mailbox, &req.uid) {
            meta.is_starred = req.add;
            let _ = write_meta_json(&meta);
        }
    }

    // 后台同步到 IMAP（fire-and-forget，失败不影响本地）
    if !gateway_url.is_empty() {
        let url = format!("{}/email/set_flag", gateway_url.trim_end_matches('/'));
        let req_clone = req.clone();
        tokio::spawn(async move {
            let client = reqwest::Client::builder()
        .no_proxy()
                .timeout(Duration::from_secs(10))
                .build();
            if let Ok(client) = client {
                match client.post(&url).json(&req_clone).send().await {
                    Ok(resp) if resp.status().is_success() => {}
                    Ok(resp) => {
                        let status = resp.status();
                        let text = resp.text().await.unwrap_or_default();
                        log::warn!(
                            "[email-toggle-starred] IMAP set_flag 失败（本地已更新）: {} {}",
                            status,
                            text
                        );
                    }
                    Err(e) => {
                        log::warn!(
                            "[email-toggle-starred] 请求 gateway 失败（本地已更新）: {}",
                            e
                        );
                    }
                }
            }
        });
    }
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
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {e}"))?;
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
    // skill 第八章：优先使用 COPYUID/MOVEUID 关联源 UID 与目标 UID
    // 服务器返回 destUid 时直接 UPDATE 本地 uid，避免依赖 message_id 去重
    let resp_value: Value = resp.json().await.map_err(|e| format!("解析响应失败: {e}"))?;
    let dest_uid: Option<String> = resp_value
        .get("destUid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());

    // Foxmail 风格：移动 .eml + .meta.json + UPDATE SQLite，邮件在目标文件夹立即可见
    // IMAP MOVE 会改变 uid：
    //   - 服务器返回 destUid（COPYUID/MOVEUID）：直接用新 uid 落盘和 UPDATE
    //   - 服务器未返回：保留旧 uid，下次同步靠 message_id 去重替换为新 uid
    let effective_uid = dest_uid.as_ref().unwrap_or(&req.uid);
    let conn = state.conn()?;
    let eml_path: String = conn
        .query_row(
            "SELECT eml_path FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
            params![req.uid, req.account_id, req.mailbox],
            |row| Ok(row.get::<_, String>(0).unwrap_or_default()),
        )
        .unwrap_or_default();
    // 移动 .eml 文件到目标文件夹（用 effective_uid 命名）
    let new_eml_path = if !eml_path.is_empty() {
        match move_eml_file(&eml_path, &req.account_id, &req.dest_mailbox, effective_uid) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[email-move] 移动 .eml 文件失败: {}", e);
                String::new()
            }
        }
    } else {
        String::new()
    };
    // 移动 .meta.json 文件
    if let Err(e) = move_meta_json(
        &req.account_id,
        &req.mailbox,
        &req.uid,
        &req.account_id,
        &req.dest_mailbox,
    ) {
        log::warn!("[email-move] 移动 .meta.json 失败: {}", e);
    }
    // 若服务器返回了新 uid，重命名 .meta.json 到新 uid
    if let Some(new_uid) = &dest_uid {
        let old_meta_rel = meta_relative_path(&req.account_id, &req.dest_mailbox, &req.uid);
        let new_meta_rel = meta_relative_path(&req.account_id, &req.dest_mailbox, new_uid);
        let old_abs = eml_absolute_path(&old_meta_rel);
        let new_abs = eml_absolute_path(&new_meta_rel);
        if old_abs.exists() {
            if let Err(e) = std::fs::rename(&old_abs, &new_abs) {
                log::warn!("[email-move] 重命名 .meta.json 到新 uid 失败: {}", e);
            }
        }
    }
    // 更新 .meta.json 的 folder 字段（用 effective_uid 读取）
    if let Some(mut meta) = read_meta_json(&req.account_id, &req.dest_mailbox, effective_uid) {
        meta.folder = req.dest_mailbox.clone();
        if let Some(new_uid) = &dest_uid {
            meta.uid = new_uid.clone();
        }
        let _ = write_meta_json(&meta);
    }
    // UPDATE SQLite: folder = dest, eml_path = new_path, uid = effective_uid
    if dest_uid.is_some() {
        // 服务器返回新 uid：UPDATE folder/eml_path/uid（uid 改变）
        conn.execute(
            "UPDATE messages SET folder = ?1, eml_path = ?2, uid = ?3, uid_int = ?4
             WHERE uid = ?5 AND account_id = ?6 AND folder = ?7",
            params![
                req.dest_mailbox,
                &new_eml_path,
                effective_uid,
                effective_uid.parse::<i64>().unwrap_or(0),
                req.uid,
                req.account_id,
                req.mailbox
            ],
        )
        .map_err(|e| e.to_string())?;
    } else {
        // 服务器未返回新 uid：保留旧 uid，依赖 message_id 去重
        conn.execute(
            "UPDATE messages SET folder = ?1, eml_path = ?2
             WHERE uid = ?3 AND account_id = ?4 AND folder = ?5",
            params![req.dest_mailbox, &new_eml_path, req.uid, req.account_id, req.mailbox],
        )
        .map_err(|e| e.to_string())?;
    }
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
    /// 内联图片的 Content-ID（不含尖括号）。设置后附件会以 inline 方式嵌入，
    /// HTML 中可通过 cid:xxx 引用，避免被 Gmail/Outlook 等客户端剥离 data URI 图片。
    #[serde(default)]
    pub content_id: Option<String>,
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
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: FetchAttachmentRequest,
) -> Result<FetchAttachmentResponse, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }

    // Foxmail 风格：优先从本地 .eml 文件解析附件
    let eml_path: String = {
        let conn = state.conn()?;
        conn.query_row(
            "SELECT eml_path FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
            params![&req.uid, &req.account_id, &req.mailbox],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default()
    };
    if !eml_path.is_empty() {
        if let Some(eml_bytes) = read_eml_file(&eml_path) {
            if let Ok(parsed) = mailparse::parse_mail(&eml_bytes) {
                if let Some((part, _fname)) = find_attachment_bytes(&parsed, &req.filename) {
                    if let Ok(raw_bytes) = part.get_body_raw() {
                        let content_type = part.ctype.mimetype.clone();
                        let data_b64 =
                            base64::engine::general_purpose::STANDARD.encode(&raw_bytes);
                        return Ok(FetchAttachmentResponse {
                            filename: req.filename.clone(),
                            content_type,
                            size: raw_bytes.len() as u64,
                            data: data_b64,
                        });
                    }
                    log::warn!(
                        "[email-fetch-attachment] 找到附件 part 但 get_body_raw 失败: {}",
                        req.filename
                    );
                } else {
                    log::warn!(
                        "[email-fetch-attachment] 在 .eml 中未找到附件: {}",
                        req.filename
                    );
                }
            } else {
                log::warn!("[email-fetch-attachment] mailparse 解析失败");
            }
        } else {
            log::warn!("[email-fetch-attachment] eml_path 非空但文件不存在");
        }
    }

    // 本地无 .eml 或解析失败：调 gateway /email/fetch_attachment 从 IMAP 拉取
    let url = format!("{}/email/fetch_attachment", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
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

/// 直接下载附件到用户指定路径，避免前端处理大 base64 字符串。
///
/// 与 email_fetch_attachment 相比：
/// - 不返回 base64 数据到前端，节省内存
/// - Rust 侧解码后直接写入文件，适合大附件
/// - 前端调用 save() 选择路径后调用此命令
#[tauri::command]
pub async fn email_download_attachment_to_file(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: FetchAttachmentRequest,
    save_path: String,
) -> Result<u64, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空".into());
    }
    if save_path.is_empty() {
        return Err("save_path 不能为空".into());
    }
    let resp = email_fetch_attachment(state, gateway_url, req).await?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&resp.data)
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    let path = std::path::Path::new(&save_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(path, &bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(bytes.len() as u64)
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
    let mut folders: Vec<EmailFolder> = stmt
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
    // 兜底：folders 表为空时，从 messages 表 DISTINCT folder 恢复文件夹列表
    // 即使 folders 表未缓存（如首次打开未同步），只要有本地 .eml 邮件就能显示文件夹
    if folders.is_empty() {
        let mut stmt2 = conn
            .prepare(
                "SELECT DISTINCT folder FROM messages WHERE account_id = ?1 ORDER BY folder",
            )
            .map_err(|e| e.to_string())?;
        let fallback: Vec<String> = stmt2
            .query_map(params![account_id], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        folders = fallback
            .into_iter()
            .map(|name| EmailFolder {
                name,
                delimiter: "/".to_string(),
                flags: "".to_string(),
                has_children: false,
                unread_count: 0,
            })
            .collect();
    }
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
        // 用 ON CONFLICT 而非 INSERT OR REPLACE：REPLACE 会先 DELETE 再 INSERT，
        // 清空 last_synced_uid 和 uid_validity 列，导致同步水位线丢失、死循环复发。
        tx.execute(
            "INSERT INTO folders (account_id, name, delimiter, flags, has_children, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(account_id, name) DO UPDATE SET
               delimiter = ?3, flags = ?4, has_children = ?5, updated_at = ?6",
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
) -> Result<SyncResult, String> {
    sync_folder_internal(&state, &gateway_url, req, true).await
}

/// 邮件同步核心逻辑：调用 gateway /email/sync，UPSERT 到 SQLite，应用规则。
///
/// 此函数与 #[tauri::command] 解耦，可被命令和后台同步任务复用。
/// `apply_rules=false` 时跳过规则应用，用于规则 MOVE 后同步目标文件夹（避免递归触发规则）。
async fn sync_folder_internal(
    state: &EmailState,
    gateway_url: &str,
    req: SyncRequest,
    apply_rules: bool,
) -> Result<SyncResult, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }
    let url = format!("{}/email/sync", gateway_url.trim_end_matches('/'));
    // gateway 同步只拉信头和标志；正文由按需读取和后台预取负责。
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {e}"))?;
    // 同步水位线必须按 folder 读取，不能使用账号级 last_synced_uid。
    let mut req_json = serde_json::to_value(&req).map_err(|e| e.to_string())?;
    if let Some(obj) = req_json.as_object_mut() {
        let (local_last_uid, local_uid_validity): (Option<i64>, String) = {
            let conn = state.conn()?;
            let (folder_last_uid, uid_validity) = conn
                .query_row(
                    "SELECT last_synced_uid, uid_validity FROM folders
                     WHERE account_id = ?1 AND name = ?2",
                    params![&req.account_id, &req.mailbox],
                    |row| {
                        Ok((
                            row.get::<_, Option<i64>>(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        ))
                    },
                )
                .unwrap_or((None, String::new()));
            let last_uid = folder_last_uid.or_else(|| {
                conn.query_row(
                    "SELECT MAX(uid_int) FROM messages
                     WHERE account_id = ?1 AND folder = ?2",
                    params![&req.account_id, &req.mailbox],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .ok()
                .flatten()
            });
            (last_uid, uid_validity)
        };
        obj.insert(
            "lastUid".to_string(),
            local_last_uid
                .map(Value::from)
                .unwrap_or(Value::Null),
        );
        obj.insert("uidValidity".to_string(), Value::String(local_uid_validity));
    }
    let resp = match client.post(&url).json(&req_json).send().await {
        Ok(resp) => resp,
        Err(first_error) if first_error.is_connect() => {
            // Services 与界面并行启动时可能尚未监听端口，短暂等待后只重试一次。
            tokio::time::sleep(Duration::from_millis(500)).await;
            client
                .post(&url)
                .json(&req_json)
                .send()
                .await
                .map_err(|e| format!("请求 gateway 连接失败 ({url}): {e}"))?
        }
        Err(e) if e.is_timeout() => {
            return Err(format!("邮件同步超时 ({url})，Services 未在 90 秒内返回"));
        }
        Err(e) => return Err(format!("请求 gateway 失败 ({url}): {e}")),
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    let resp_value: Value = resp.json().await.map_err(|e| format!("解析响应失败: {e}"))?;
    // 兼容两种返回格式：新版 dict（含 uidValidity/messages）或旧版 list
    let (new_messages, uid_validity, uid_validity_changed): (Vec<Value>, String, bool) =
        match &resp_value {
            Value::Array(arr) => (arr.clone(), String::new(), false),
            Value::Object(obj) => {
                let msgs = obj
                    .get("messages")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let uv = obj
                    .get("uidValidity")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let changed = obj
                    .get("uidValidityChanged")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                (msgs, uv, changed)
            }
            _ => (Vec::new(), String::new(), false),
        };

    let conn = state.conn()?;
    log::debug!(
        "[email-sync] account={} mailbox={} last_uid={:?} gateway_returned={} uid_validity={} changed={}",
        req.account_id,
        req.mailbox,
        req.last_uid,
        new_messages.len(),
        uid_validity,
        uid_validity_changed
    );

    // UIDVALIDITY 变化：废弃该文件夹所有旧 UID 映射，让本地从头重建索引
    // 旧 UID 已失效，保留会导致新邮件永远拉不到（UID > last_uid 永远不命中）
    if uid_validity_changed {
        log::warn!(
            "[email-sync] UIDVALIDITY changed for account={} mailbox={}: 废弃旧 UID 映射并重建文件夹索引",
            req.account_id,
            req.mailbox
        );
        // 删除该文件夹所有 messages 和对应的 .eml/.meta.json
        let stale_records: Vec<(String, String)> = conn
            .prepare(
                "SELECT uid, eml_path FROM messages WHERE account_id = ?1 AND folder = ?2",
            )
            .map(|mut stmt| {
                stmt.query_map(params![&req.account_id, &req.mailbox], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
            })
            .unwrap_or_else(|_| Ok(Vec::new()))
            .unwrap_or_default();
        for (stale_uid, stale_eml_path) in &stale_records {
            if !stale_eml_path.is_empty() {
                let _ = delete_eml_file(stale_eml_path);
            }
            let _ = delete_meta_json(&req.account_id, &req.mailbox, stale_uid);
        }
        conn.execute(
            "DELETE FROM messages WHERE account_id = ?1 AND folder = ?2",
            params![&req.account_id, &req.mailbox],
        )
        .map_err(|e| e.to_string())?;
        // 重置 last_synced_uid，让本次同步拉取最近 20 封重建
        conn.execute(
            "UPDATE folders SET last_synced_uid = NULL WHERE account_id = ?1 AND name = ?2",
            params![&req.account_id, &req.mailbox],
        )
        .map_err(|e| e.to_string())?;
    }
    // 更新 folders.uid_validity（无论是否变化，都同步到最新值）
    if !uid_validity.is_empty() {
        conn.execute(
            "INSERT INTO folders (account_id, name, delimiter, flags, has_children, updated_at, uid_validity)
             VALUES (?1, ?2, '/', '', 0, ?3, ?4)
             ON CONFLICT(account_id, name) DO UPDATE SET uid_validity = ?4",
            params![
                &req.account_id,
                &req.mailbox,
                chrono::Utc::now().to_rfc3339(),
                &uid_validity
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    let mut new_count = 0u32;
    // 记录真正新增的 UID（规则应用前在当前文件夹中的新邮件）
    let mut new_uids: Vec<String> = Vec::new();
    // 收集重新解析的正确 header，供 auto_collect_contacts 使用
    // gateway 返回的 fromName/to/cc 可能含乱码（Python 侧解码问题），
    // Rust 侧用 parse_eml_header 重新解析后才是正确的
    let mut corrected_messages: Vec<Value> = Vec::new();
    for msg in &new_messages {
        let uid = msg["uid"].as_str().unwrap_or("").to_string();
        if uid.is_empty() {
            continue;
        }
        let message_id_str = msg.get("messageId").and_then(|v| v.as_str()).unwrap_or("");

        // 去重：如果本地存在相同 message_id 的记录，分三种情况处理：
        // 1. 同文件夹内不同 uid（本地发送版本 "L" 或 MOVE 后的旧 uid）：删除旧版本，INSERT 新 uid 版本
        //    场景a: email_send 已落盘 "L" uid 版本，IMAP 同步拉到 IMAP uid 版本
        //    场景b: MOVE 邮件后本地保留旧 uid，IMAP 同步拉到新 uid 版本（IMAP MOVE 会改变 uid）
        // 2. 跨文件夹相同 message_id（uid 可能相同也可能不同）：规则 move 后 IMAP 服务器未真正删除
        //    源文件夹邮件（某些企业邮箱 MOVE 行为异常），下次同步源文件夹又拉到同一封邮件。
        //    此时邮件已在目标文件夹，源文件夹的副本是 stale 的，跳过 INSERT 避免重复显示。
        // 3. 同文件夹同 uid：已存在的记录，跳过去重逻辑，交给后面的 UPSERT 处理
        // 继承旧记录的 is_read/is_starred：MOVE 后 IMAP 服务器可能丢失 \Seen 标志，
        // 不能让新 UID 记录的 is_read 回退为 IMAP 返回值（可能 false），否则已读邮件变未读
        let mut inherited_is_read: Option<bool> = None;
        let mut inherited_is_starred: Option<bool> = None;
        let mut skip_insert_cross_folder = false;
        if !message_id_str.is_empty() {
            // 查询所有文件夹中相同 message_id 的记录（不限 folder，不限 uid）
            let local_records: Vec<(String, String, String, i32, i32)> = match conn.prepare(
                "SELECT uid, folder, eml_path, is_read, is_starred FROM messages
                 WHERE account_id = ?1 AND message_id = ?2",
            ) {
                Ok(mut stmt) => match stmt.query_map(
                    params![&req.account_id, message_id_str],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i32>(3)?, row.get::<_, i32>(4)?)),
                ) {
                    Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
                    Err(_) => Vec::new(),
                },
                Err(_) => Vec::new(),
            };
            for (local_uid, local_folder, local_eml_path, local_is_read, local_is_starred) in &local_records {
                if local_folder != &req.mailbox {
                    // 跨文件夹重复：邮件已被规则移动到其他文件夹，当前文件夹的副本是 stale 的
                    // 跳过 INSERT，避免同一封邮件在多个文件夹显示
                    log::debug!(
                        "[email-sync] 跨文件夹去重: 跳过 uid={} message_id={} (已存在于文件夹 {}，当前同步 {})",
                        uid,
                        message_id_str,
                        local_folder,
                        req.mailbox
                    );
                    skip_insert_cross_folder = true;
                    break;
                }
                // 同文件夹内：只有 uid 不同时才删除旧记录（同 uid 是已存在记录，交给 UPSERT）
                if local_uid == &uid {
                    continue;
                }
                // 同文件夹内不同 uid：删除旧记录，继承 is_read/is_starred（IMAP 新 uid 替换旧 uid）
                if *local_is_read == 1 {
                    inherited_is_read = Some(true);
                }
                if *local_is_starred == 1 {
                    inherited_is_starred = Some(true);
                }
                if !local_eml_path.is_empty() {
                    let _ = delete_eml_file(local_eml_path);
                }
                let _ = delete_meta_json(&req.account_id, &req.mailbox, local_uid);
                let _ = conn.execute(
                    "DELETE FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                    params![local_uid, &req.account_id, &req.mailbox],
                );
                log::debug!(
                    "[email-sync] 去重: 删除旧版本 uid={} (IMAP uid={} 替换, message_id={}, is_read={}, is_starred={})",
                    local_uid,
                    uid,
                    message_id_str,
                    local_is_read,
                    local_is_starred
                );
            }
        }
        // 跨文件夹重复：跳过本封邮件的 INSERT，处理下一条
        if skip_insert_cross_folder {
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
        // Offline-First: 同步时直接拉完整 RFC822（gateway 已切换为 BODY.PEEK[]），
        // body_fetched 跟随 gateway 返回值（普通邮件 true，大邮件降级为 false 待后台补拉）。
        // 用户点击时优先读本地 .eml，毫秒级返回，无需再走 gateway。
        let raw_bytes_b64 = msg.get("rawBytes").and_then(|v| v.as_str()).unwrap_or("");
        // gateway 返回的 bodyFetched：true=完整 RFC822，false=HEADER-only（大邮件降级）
        let gw_body_fetched = msg.get("bodyFetched").and_then(|v| v.as_bool()).unwrap_or(false);
        // 保存解码后的 eml 字节，用于落盘后用 Rust parse_eml_header 重新解析 header
        // 确保 subject/from/to/cc 解码质量不依赖 gateway Python 代码（gb2312→gb18030 归一化在 Rust 侧保证）
        let mut eml_bytes_opt: Option<Vec<u8>> = None;
        let eml_path_value: String = if !raw_bytes_b64.is_empty() {
            match base64::engine::general_purpose::STANDARD.decode(raw_bytes_b64) {
                Ok(bytes) => {
                    eml_bytes_opt = Some(bytes.clone());
                    match write_eml_file(&req.account_id, &req.mailbox, &uid, &bytes) {
                        Ok(rel_path) => {
                            // 写 .meta.json sidecar（存 isRead/isStarred/bodyFetched 等 RFC822 不含的状态）
                            // 继承旧记录（MOVE 去重）的 is_read/is_starred，避免 MOVE 后 \Seen 丢失导致已读变未读
                            let is_read = inherited_is_read.unwrap_or(msg["isRead"].as_bool().unwrap_or(false));
                            let is_starred = inherited_is_starred.unwrap_or(msg["isStarred"].as_bool().unwrap_or(false));
                            let has_attachments = msg["hasAttachments"].as_bool().unwrap_or(false);
                            let meta = EmlMeta {
                                uid: uid.clone(),
                                account_id: req.account_id.clone(),
                                folder: req.mailbox.clone(),
                                is_read,
                                is_starred,
                                has_attachments,
                                body_fetched: gw_body_fetched,
                                message_id: message_id_str.to_string(),
                                eml_mtime: chrono::Utc::now().timestamp(),
                            };
                            let _ = write_meta_json(&meta);
                            rel_path
                        }
                        Err(e) => {
                            log::warn!("[email-sync] 写入 .eml 失败 uid={}: {}", uid, e);
                            String::new()
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[email-sync] base64 解码 rawBytes 失败 uid={}: {}", uid, e);
                    String::new()
                }
            }
        } else {
            String::new()
        };
        // 用 Rust 的 parse_eml_header 从 .eml 字节重新解析 header（subject/from/to/cc/date/message_id/has_attachments）
        // 不直接用 gateway 返回的 JSON 字段，确保 gb2312/gbk 编码的中文（含"喆"等扩展字符）正确解码
        let (hdr_subject, hdr_from_addr, hdr_from_name, hdr_to, hdr_cc, hdr_date, hdr_msg_id, hdr_has_att) =
            if let Some(ref eml_bytes) = eml_bytes_opt {
                parse_eml_header(eml_bytes)
            } else {
                // .eml 无字节时回退到 gateway 字段
                (
                    msg["subject"].as_str().unwrap_or("(no subject)").to_string(),
                    msg["from"].as_str().unwrap_or("").to_string(),
                    msg.get("fromName").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    msg["to"].as_str().unwrap_or("[]").to_string(),
                    msg.get("cc").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    msg["date"].as_str().unwrap_or("").to_string(),
                    msg.get("messageId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    msg["hasAttachments"].as_bool().unwrap_or(false),
                )
            };
        // 收集正确的 header（用重新解析的值，而非 gateway 返回的可能含乱码的 JSON 字段）
        corrected_messages.push(serde_json::json!({
            "uid": uid,
            "from": hdr_from_addr,
            "fromName": hdr_from_name,
            "to": hdr_to,
            "cc": hdr_cc,
        }));
        // sync 时 body_fetched 跟随 gateway 返回值：普通邮件=1（完整 RFC822 已落盘），大邮件=0（HEADER-only，待后台补拉）
        let body_fetched_value: i32 = if gw_body_fetched { 1 } else { 0 };
        // UPSERT：更新邮件内容但保留用户已设置的 is_read/is_starred 和 body_fetched
        // 不再存储 body_text/body_html/attachments_json（已移除字段），改为存 eml_path
        // Foxmail 风格：正文完全存 .eml 文件，SQLite 仅做索引
        conn.execute(
            "INSERT INTO messages
             (uid, uid_int, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
              date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path)
             VALUES (?1, CASE WHEN ?1 LIKE 'L%' THEN 0 ELSE CAST(?1 AS INTEGER) END,
                     ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(uid, account_id, folder) DO UPDATE SET
              uid_int=CASE WHEN excluded.uid LIKE 'L%' THEN 0 ELSE CAST(excluded.uid AS INTEGER) END,
              subject=excluded.subject,
              from_address=excluded.from_address,
              from_name=excluded.from_name,
              to_addresses=excluded.to_addresses,
              cc_addresses=excluded.cc_addresses,
              date=excluded.date,
              has_attachments=excluded.has_attachments,
              raw_size=excluded.raw_size,
              message_id=excluded.message_id,
              eml_path=CASE WHEN excluded.eml_path != '' THEN excluded.eml_path ELSE messages.eml_path END,
              body_fetched=CASE WHEN excluded.eml_path != '' THEN excluded.body_fetched ELSE messages.body_fetched END,
              is_read=CASE WHEN messages.is_read=1 THEN 1 ELSE excluded.is_read END,
              is_starred=CASE WHEN messages.is_starred=1 THEN 1 ELSE excluded.is_starred END",
            params![
                uid,
                req.account_id,
                req.mailbox,
                &hdr_subject,
                &hdr_from_addr,
                &hdr_from_name,
                &hdr_to,
                &hdr_cc,
                &hdr_date,
                hdr_has_att as i32,
                // is_read：继承旧记录（MOVE 去重）的 is_read=1 优先，否则取 IMAP 返回值
                inherited_is_read.unwrap_or(msg["isRead"].as_bool().unwrap_or(false)) as i32,
                // is_starred：同上，继承旧记录的星标状态
                inherited_is_starred.unwrap_or(msg["isStarred"].as_bool().unwrap_or(false)) as i32,
                msg["rawSize"].as_u64().unwrap_or(0) as u32,
                &hdr_msg_id,
                body_fetched_value,
                eml_path_value,
            ],
        )
        .map_err(|e| e.to_string())?;
        if !existed {
            new_count += 1;
            new_uids.push(uid);
        }
    }

    // 自动从新邮件收集联系人（发件人 + 收件人 + 抄送）
    // 使用重新解析的正确 header，避免 gateway 返回的乱码字段污染通讯录
    auto_collect_contacts(&conn, &req.account_id, &corrected_messages);
    // 更新同步水位线（取本次同步中最大的 UID）
    // folders.last_synced_uid 是按 folder 存储的水位线，下次同步以此为基准，
    // 避免从 messages 表查 MAX(uid_int) 时因本地残留过期高 UID 而陷入死循环。
    // gateway 在 server max uid < last_uid 时会重置并返回最近 20 封，
    // 这里用返回邮件的 max uid 更新水位线，下次同步就不会再传过期的 last_uid。
    if let Some(max_uid) = new_messages
        .iter()
        .filter_map(|m| m["uid"].as_str())
        .filter_map(|s| s.parse::<i64>().ok())
        .max()
    {
        conn.execute(
            "UPDATE accounts SET last_synced_uid = ?1 WHERE id = ?2",
            params![max_uid.to_string(), req.account_id],
        )
        .map_err(|e| e.to_string())?;
        // UPSERT folders.last_synced_uid（folder 行可能在 list_folders 之前不存在）
        conn.execute(
            "INSERT INTO folders (account_id, name, delimiter, flags, has_children, updated_at, last_synced_uid)
             VALUES (?1, ?2, '/', '', 0, ?3, ?4)
             ON CONFLICT(account_id, name) DO UPDATE SET last_synced_uid = ?4",
            params![&req.account_id, &req.mailbox, chrono::Utc::now().to_rfc3339(), max_uid],
        )
        .map_err(|e| e.to_string())?;
    }

    // 应用邮件规则（仅对本次同步的新邮件）
    // apply_rules=false 时跳过（用于规则 MOVE 后同步目标文件夹，避免递归触发规则）
    // 注意：规则应用是 async，MutexGuard 不能跨 await，需在 await 前 drop conn
    let rules = if apply_rules {
        get_enabled_rules(&conn, &req.account_id).unwrap_or_default()
    } else {
        Vec::new()
    };
    // conn 在此处不再需要，drop 释放锁，让后续 await 不会持有 MutexGuard
    drop(conn);
    if !rules.is_empty() {
        // 收集匹配规则的新邮件（owned EmailRule，避免跨越 await 持有引用）
        let mut matched: Vec<(String, String, EmailRule)> = Vec::new();
        for msg in &new_messages {
            let uid = match msg["uid"].as_str() {
                Some(s) if !s.is_empty() => s.to_string(),
                _ => continue,
            };
            let subject = msg["subject"].as_str().unwrap_or("");
            let from_address = msg["from"].as_str().unwrap_or("");
            let from_name = msg.get("fromName").and_then(|v| v.as_str()).unwrap_or("");
            let to_addresses = msg["to"].as_str().unwrap_or("");
            for rule in &rules {
                // 跳过"移动到当前文件夹"的规则：邮件已在目标文件夹，再次 MOVE 会导致
                // update_local_cache 删除刚插入的记录（规则循环应用 bug）
                if rule.action == "move" && rule.action_target.as_deref() == Some(req.mailbox.as_str()) {
                    continue;
                }
                if rule_matches(rule, subject, from_address, from_name, to_addresses) {
                    matched.push((uid.clone(), req.mailbox.clone(), rule.clone()));
                    break; // 一个邮件只应用第一条匹配的规则
                }
            }
        }
        // 执行规则动作（mark_read/star 本地+IMAP；move/delete 调用 gateway）
        if !matched.is_empty() {
            let (account, plain_password) = {
                let conn = state.conn()?;
                let account = get_imap_credentials(&conn, &req.account_id)?;
                let plain = decrypt_password(&account.imap_password)?;
                (account, plain)
            };
            let matched_refs: Vec<(String, String, &EmailRule)> = matched
                .iter()
                .map(|(uid, folder, rule)| (uid.clone(), folder.clone(), rule))
                .collect();
            apply_rule_actions(
                state,
                gateway_url,
                &matched_refs,
                &account,
                &plain_password,
            )
            .await;
        }
    }

    // 规则应用后，从本地 SQLite 查询仍在当前文件夹的新邮件（规则可能 move/delete 了部分）
    let conn = state.conn()?;
    let new_messages_in_folder: Vec<EmailMessage> = if new_uids.is_empty() {
        Vec::new()
    } else {
        // 构造 IN 占位符
        let placeholders: Vec<&str> = new_uids.iter().map(|_| "?").collect();
        let in_clause = placeholders.join(",");
        let sql = format!(
            "SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                    date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path
             FROM messages WHERE account_id = ? AND folder = ? AND uid IN ({})
             ORDER BY uid_int DESC",
            in_clause
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = vec![&req.account_id, &req.mailbox];
        for uid in &new_uids {
            params_vec.push(uid);
        }
        let msgs = stmt
            .query_map(params_vec.as_slice(), |row| {
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
                    body_text: String::new(),
                    body_html: None,
                    has_attachments: row.get::<_, i32>(9)? != 0,
                    is_read: row.get::<_, i32>(10)? != 0,
                    is_starred: row.get::<_, i32>(11)? != 0,
                    raw_size: row.get(12)?,
                    message_id: row.get(13)?,
                    attachments: Vec::new(),
                    body_fetched: row.get::<_, i32>(14)? != 0,
                    eml_path: row.get(15)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        msgs
    };

    log::debug!(
        "[email-sync] account={} done new_count={} returned_to_frontend={}",
        req.account_id,
        new_count,
        new_messages_in_folder.len()
    );

    // 异步触发 AI 日程提取或预取正文（不阻塞 sync 返回）
    if !new_uids.is_empty() && !gateway_url.is_empty() {
        // 判断当前账号+文件夹是否启用 AI 日程提取。
        // 启用时：在同一个后台任务中先调用 fetch_raw_and_cache 拉完整正文，再触发 AI 提取，
        //         避免 AI 与正文下载并行导致 AI 读到空正文。
        // 未启用时：保留原行为——异步触发 AI（gateway 侧再次检查配置）+ INBOX 未读正文预取。
        let schedule_config = crate::settings::read_email_schedule_config();
        let schedule_enabled = schedule_config
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let folder_key = format!("{}:{}", req.account_id, req.mailbox);
        let folder_configured = schedule_config
            .get("folders")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().any(|v| v.as_str() == Some(&folder_key)))
            .unwrap_or(false);

        if schedule_enabled && folder_configured {
            // 合并流程：先拉完整正文，再触发 AI 日程提取
            let state_clone = state.clone();
            let gw = gateway_url.to_string();
            let account_id = req.account_id.clone();
            let mailbox = req.mailbox.clone();
            let uids = new_uids.clone();
            tokio::spawn(async move {
                let mut ready_uids: Vec<String> = Vec::new();
                for uid in &uids {
                    match fetch_raw_and_cache(&state_clone, &gw, &account_id, uid, &mailbox).await {
                        Ok(()) => ready_uids.push(uid.clone()),
                        Err(e) => {
                            // 正文首次拉取失败，重试一次
                            log::debug!(
                                "[schedule-extract] body fetch first failed: account={} folder={} uid={} err={}",
                                account_id, mailbox, uid, e
                            );
                            match fetch_raw_and_cache(
                                &state_clone,
                                &gw,
                                &account_id,
                                uid,
                                &mailbox,
                            )
                            .await
                            {
                                Ok(()) => ready_uids.push(uid.clone()),
                                Err(e2) => {
                                    // 仍失败则记录账号、文件夹和 UID，不调用 AI
                                    log::warn!(
                                        "[schedule-extract] body fetch retry failed: account={} folder={} uid={} err={}",
                                        account_id, mailbox, uid, e2
                                    );
                                }
                            }
                        }
                    }
                }
                if !ready_uids.is_empty() {
                    trigger_schedule_extract(&gw, &account_id, &mailbox, &ready_uids).await;
                }
            });
        } else {
            // AI 日程未启用：保留原行为
            // 1. 异步触发 AI 日程提取（gateway 侧会再次检查配置，未配置则立即返回）
            let account_id = req.account_id.clone();
            let mailbox = req.mailbox.clone();
            let uids = new_uids.clone();
            let gw = gateway_url.to_string();
            tokio::spawn(async move {
                trigger_schedule_extract(&gw, &account_id, &mailbox, &uids).await;
            });

            // 2. 异步预取未读邮件正文（仅 INBOX，不阻塞 sync 返回）
            //    同步只拉了 HEADER，这里后台拉完整 RFC822 落盘，
            //    确保用户/AI 打开邮件时走本地 .eml，毫秒级无等待。
            if req.mailbox == "INBOX" {
                let state_clone = state.clone();
                let gw = gateway_url.to_string();
                let account_id = req.account_id.clone();
                let mailbox = req.mailbox.clone();
                tokio::spawn(async move {
                    let (account, plain_password) = {
                        match state_clone.conn() {
                            Ok(conn) => match get_imap_credentials(&conn, &account_id) {
                                Ok(a) => match decrypt_password(&a.imap_password) {
                                    Ok(p) => (a, p),
                                    Err(e) => {
                                        log::warn!(
                                            "[email-sync] prefetch: decrypt password failed: {}",
                                            e
                                        );
                                        return;
                                    }
                                },
                                Err(e) => {
                                    log::warn!(
                                        "[email-sync] prefetch: get credentials failed: {}",
                                        e
                                    );
                                    return;
                                }
                            },
                            Err(e) => {
                                log::warn!("[email-sync] prefetch: get conn failed: {}", e);
                                return;
                            }
                        }
                    };
                    if let Err(e) =
                        prefetch_unread_bodies(&state_clone, &gw, &account, &plain_password, &mailbox)
                            .await
                    {
                        log::debug!("[email-sync] prefetch unread bodies failed: {}", e);
                    }
                });
            }
        }
    }

    Ok(SyncResult {
        new_count,
        new_messages: new_messages_in_folder,
    })
}

/// 异步调用 gateway /email/schedule/extract，触发 AI 日程提取。
/// 失败静默记录日志，不影响 sync 流程。
async fn trigger_schedule_extract(gateway_url: &str, account_id: &str, folder: &str, uids: &[String]) {
    let url = format!("{}/email/schedule/extract", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let body = serde_json::json!({
        "accountId": account_id,
        "folder": folder,
        "uids": uids,
    });
    match client.post(&url).json(&body).send().await {
        Ok(resp) => {
            if resp.status().is_success() {
                log::debug!(
                    "[schedule-extract] triggered: account={} folder={} uids={}",
                    account_id, folder, uids.len()
                );
            } else {
                log::warn!(
                    "[schedule-extract] gateway returned {}: account={} folder={}",
                    resp.status(), account_id, folder
                );
            }
        }
        Err(e) => {
            log::warn!("[schedule-extract] request failed: {}", e);
        }
    }
}

// ---------------------------------------------------------------------------
// 后台静默同步引擎
// ---------------------------------------------------------------------------
// 启动后等待 30s 执行首次全量同步（让前端首屏先完成），之后每 15 分钟轮询一次（对齐 Foxmail 默认）。
// 遍历 SQLite 中所有账号 + 文件夹，调用 gateway /email/sync 进行增量同步。
// 单个账号/文件夹失败不影响其他，全部错误静默记录日志。

const BG_SYNC_INITIAL_DELAY_SECS: u64 = 30;
const BG_SYNC_INTERVAL_SECS: u64 = 900;

/// 判断是否为系统文件夹（INBOX/Sent/Drafts/Trash/Junk 等）。
/// bg sync 只对系统文件夹 + 本地已有邮件的文件夹做同步，跳过空的自定义文件夹
/// 避免 N 次 IMAP SELECT 占用连接锁导致 UI 卡顿。
fn is_system_folder(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == "inbox"
        || lower.contains("sent")
        || lower.contains("outbox")
        || lower.contains("draft")
        || lower.contains("trash")
        || lower.contains("junk")
        || lower.contains("spam")
        || lower.contains("deleted")
        || lower.contains("star")
        || lower.contains("flag")
        || name.contains("收件箱")
        || name.contains("已发送")
        || name.contains("已发邮件")
        || name.contains("发件箱")
        || name.contains("草稿")
        || name.contains("垃圾")
        || name.contains("删除")
}

/// 检查账号是否在冷却期内（IMAP 认证失败后 1 小时不再尝试）
/// 返回 Some(剩余秒数) 表示在冷却期内，None 表示可以尝试
fn check_account_cooldown(state: &EmailState, account_id: &str, service: &str) -> Option<i64> {
    let conn = state.conn().ok()?;
    let failed_until: String = conn
        .query_row(
            "SELECT failed_until FROM account_cooldowns WHERE account_id = ?1 AND service = ?2",
            params![account_id, service],
            |row| row.get(0),
        )
        .ok()?;
    let failed_until_ts = chrono::DateTime::parse_from_rfc3339(&failed_until).ok()?;
    let now = chrono::Local::now();
    let remaining = (failed_until_ts.with_timezone(&now.timezone()) - now).num_seconds();
    if remaining > 0 {
        Some(remaining)
    } else {
        None
    }
}

/// 标记账号认证失败，设置冷却期（1 小时）
fn mark_account_cooldown(
    state: &EmailState,
    account_id: &str,
    service: &str,
    reason: &str,
) {
    let Ok(conn) = state.conn() else { return };
    let now = chrono::Local::now();
    let failed_until = now + chrono::Duration::hours(1);
    let _ = conn.execute(
        "INSERT OR REPLACE INTO account_cooldowns (account_id, service, failed_until, reason, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            account_id,
            service,
            failed_until.to_rfc3339(),
            reason,
            now.to_rfc3339(),
        ],
    );
}

/// 清除账号冷却期（认证成功后调用）
fn clear_account_cooldown(state: &EmailState, account_id: &str, service: &str) {
    let Ok(conn) = state.conn() else { return };
    let _ = conn.execute(
        "DELETE FROM account_cooldowns WHERE account_id = ?1 AND service = ?2",
        params![account_id, service],
    );
}

/// 判断错误是否为永久性认证失败（IMAP/SMTP 密码错误/账号异常）
/// 用于触发账号冷却期，避免反复尝试加剧服务器限流
fn is_permanent_auth_error(error_text: &str) -> bool {
    let lower = error_text.to_lowercase();
    // 认证失败类（密码错误、授权码错误、账号异常）
    lower.contains("authentication failed")
        || lower.contains("认证失败")
        || lower.contains("login fail")
        || lower.contains("登录失败")
        || lower.contains("account is abnormal")
        || lower.contains("账号异常")
        || lower.contains("不允许尝试登录")
        || lower.contains("service is not open")
        || lower.contains("服务未开通")
        // 频率限制类（真正的风控）
        || lower.contains("login frequency limited")
        || lower.contains("频率限制")
}

/// 启动后台静默同步引擎。应在 services 启动成功后调用。
pub fn start_background_sync(app_handle: AppHandle, services_port: u16) {
    let gateway_url = format!("http://127.0.0.1:{}", services_port);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(BG_SYNC_INITIAL_DELAY_SECS)).await;

        loop {
            let started = std::time::Instant::now();
            let mut total_new: u32 = 0;

            // 1. 处理到期的 outbox 邮件（延迟发送）
            let email_state = app_handle.state::<EmailState>();
            match email_outbox_process(email_state, gateway_url.clone()).await {
                Ok(n) => {
                    if n > 0 {
                        log::debug!("[email-bg] outbox processed: {} sent", n);
                        let _ = app_handle.emit("email-outbox-updated", ());
                    }
                }
                Err(e) => log::warn!("[email-bg] outbox process failed: {}", e),
            }

            // 2. 邮件同步 + 删除对账 + 预下载
            match run_bg_sync_cycle(&app_handle, &gateway_url, &mut total_new).await {
                Ok(()) => {
                    log::debug!(
                        "[email-bg] sync cycle done in {:.1}s, new={}",
                        started.elapsed().as_secs_f32(),
                        total_new
                    );
                }
                Err(e) => {
                    log::warn!("[email-bg] sync cycle error: {}", e);
                }
            }
            tokio::time::sleep(Duration::from_secs(BG_SYNC_INTERVAL_SECS)).await;
        }
    });
}

/// 执行一次后台同步：遍历所有账号 + 所有文件夹，调用 sync_folder_internal。
async fn run_bg_sync_cycle(
    app_handle: &AppHandle,
    gateway_url: &str,
    total_new: &mut u32,
) -> Result<(), String> {
    let email_state = app_handle.state::<EmailState>();

    // P0-2: 每 N 次同步周期对账一次（约 60 分钟，BG_SYNC_INTERVAL_SECS=900s）
    // skill 第三节：不支持 CONDSTORE/QRESYNC 时定期全量对账，同步删除/移动状态
    let cycle = RECONCILE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let need_reconcile = cycle % RECONCILE_EVERY_N_CYCLES == 0;
    if need_reconcile {
        log::info!("[email-bg] reconcile cycle started (cycle={})", cycle);
    }

    // 读取所有账号
    let accounts: Vec<EmailAccount> = {
        let conn = email_state.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, display_name, imap_host, imap_port, imap_username, imap_password,
                        smtp_host, smtp_port, smtp_username, smtp_password, from_address,
                        from_name, last_synced_uid, carddav_url, eas_url, imap_use_ssl,
                        smtp_use_ssl, signatures
                 FROM accounts ORDER BY display_name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let sigs_str: String = row.get(17).unwrap_or_else(|_| "[]".to_string());
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
                    imap_use_ssl: row.get::<_, i32>(15)? != 0,
                    smtp_use_ssl: row.get::<_, i32>(16)? != 0,
                    signatures: serde_json::from_str(&sigs_str).unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut accs: Vec<EmailAccount> = Vec::new();
        for r in rows {
            if let Ok(a) = r {
                accs.push(a);
            }
        }
        accs
    };

    if accounts.is_empty() {
        return Ok(());
    }

    for account in accounts {
        // 检查 IMAP 冷却期：如果账号最近认证失败，跳过避免加剧风控
        if let Some(remaining) = check_account_cooldown(&email_state, &account.id, "imap") {
            log::debug!(
                "[email-bg] account={} in IMAP cooldown, skip ({}s remaining)",
                account.id,
                remaining
            );
            continue;
        }

        let plain_password = match decrypt_password(&account.imap_password) {
            Ok(p) => p,
            Err(e) => {
                log::warn!(
                    "[email-bg] account={} password decrypt failed: {}",
                    account.id,
                    e
                );
                continue;
            }
        };

        // 该账号的所有文件夹（folders 表，由前端首次展开时同步）
        let mut folders: Vec<String> = {
            let conn = match email_state.conn() {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[email-bg] account={} open conn failed: {}", account.id, e);
                    continue;
                }
            };
            let mut stmt = match conn.prepare(
                "SELECT name FROM folders WHERE account_id = ?1 ORDER BY name",
            ) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("[email-bg] account={} prepare failed: {}", account.id, e);
                    continue;
                }
            };
            let rows = stmt
                .query_map(params![&account.id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string());
            let mut fs: Vec<String> = Vec::new();
            if let Ok(rows) = rows {
                for r in rows.flatten() {
                    fs.push(r);
                }
            }
            fs
        };

        // folders 为空：可能是新账号还没在前端展开过。先调用 gateway 拉取文件夹列表，
        // 写入 SQLite 缓存后再进行邮件同步，确保新账号也能被后台同步覆盖。
        if folders.is_empty() {
            log::debug!(
                "[email-bg] account={} folders empty, syncing folder list from IMAP",
                account.id
            );
            let folder_req = FolderRequest {
                imap_host: account.imap_host.clone(),
                imap_port: account.imap_port,
                imap_username: account.imap_username.clone(),
                imap_password: plain_password.clone(),
                use_ssl: account.imap_use_ssl,
            };
            match email_list_folders(gateway_url.to_string(), folder_req).await {
                Ok(remote_folders) => {
                    if let Ok(conn) = email_state.conn() {
                        let now = chrono::Local::now().to_rfc3339();
                        for folder in &remote_folders {
                            let _ = conn.execute(
                                "INSERT OR REPLACE INTO folders
                                 (account_id, name, delimiter, flags, has_children, updated_at)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                                params![
                                    &account.id,
                                    folder.name,
                                    folder.delimiter.clone(),
                                    folder.flags.clone(),
                                    if folder.has_children { 1 } else { 0 },
                                    now.clone(),
                                ],
                            );
                        }
                    }
                    folders = remote_folders.iter().map(|f| f.name.clone()).collect();
                    log::debug!(
                        "[email-bg] account={} synced {} folders from IMAP",
                        account.id,
                        folders.len()
                    );
                }
                Err(e) => {
                    log::warn!(
                        "[email-bg] account={} sync folders failed: {}",
                        account.id,
                        e
                    );
                    continue;
                }
            }
        }

        if folders.is_empty() {
            log::debug!("[email-bg] account={} still no folders after sync, skip", account.id);
            continue;
        }

        // 文件夹过滤：避免对一堆空文件夹逐个跑 IMAP SELECT（每文件夹约 1-2 秒）
        // 只同步：INBOX / 系统文件夹（Sent/Drafts/Trash/Junk 等）/ 本地已有邮件的文件夹
        // 自定义空文件夹靠 IDLE 或用户手动"收取"触发
        let filtered_folders: Vec<String> = match email_state.conn() {
            Ok(conn) => {
                let mut result: Vec<String> = Vec::new();
                for f in &folders {
                    let is_system = is_system_folder(f);
                    let has_local: bool = conn
                        .query_row(
                            "SELECT COUNT(*) > 0 FROM messages WHERE account_id = ?1 AND folder = ?2",
                            params![&account.id, f],
                            |row| row.get::<_, bool>(0),
                        )
                        .unwrap_or(false);
                    if is_system || has_local || f == "INBOX" {
                        result.push(f.clone());
                    }
                }
                result
            }
            Err(_) => folders.clone(),
        };
        if filtered_folders.len() != folders.len() {
            log::debug!(
                "[email-bg] account={} folder filter: {} -> {} (skip empty custom folders)",
                account.id,
                folders.len(),
                filtered_folders.len()
            );
        }

        for folder in &filtered_folders {
            // 优先用 folders 表的 last_synced_uid 作为同步水位线，
            // 避免从 messages 表查 MAX(uid_int) 时因本地残留过期高 UID 而死循环。
            // folders.last_synced_uid 为空时（首次同步或旧库迁移），回退到 messages 表。
            let last_uid: Option<String> = email_state
                .conn()
                .ok()
                .and_then(|conn| {
                    conn.query_row(
                        "SELECT last_synced_uid FROM folders
                         WHERE account_id = ?1 AND name = ?2",
                        params![&account.id, &folder],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                    .ok()
                    .flatten()
                })
                .filter(|n| *n > 0)
                .map(|n| n.to_string())
                .or_else(|| {
                    // 回退：folders 表无记录（首次同步），从 messages 表取 MAX(uid_int)
                    email_state.conn().ok().and_then(|conn| {
                        conn.query_row(
                            "SELECT MAX(uid_int) FROM messages
                             WHERE account_id = ?1 AND folder = ?2",
                            params![&account.id, &folder],
                            |row| row.get::<_, Option<i64>>(0),
                        )
                        .ok()
                        .flatten()
                        .map(|n| n.to_string())
                    })
                });

            let req = SyncRequest {
                account_id: account.id.clone(),
                imap_host: account.imap_host.clone(),
                imap_port: account.imap_port,
                imap_username: account.imap_username.clone(),
                imap_password: plain_password.clone(),
                mailbox: folder.clone(),
                use_ssl: account.imap_use_ssl,
                last_uid,
            };

            match sync_folder_internal(&email_state, gateway_url, req, true).await {
                Ok(result) => {
                    // 同步成功，清除 IMAP 冷却期（如果之前有）
                    clear_account_cooldown(&email_state, &account.id, "imap");
                    if result.new_count > 0 {
                        log::debug!(
                            "[email-bg] account={} folder={} new={}",
                            account.id,
                            folder,
                            result.new_count
                        );
                        *total_new += result.new_count;
                        // 通知前端有新邮件，由前端决定是否刷新当前列表
                        let _ = app_handle.emit(
                            "email-bg-sync",
                            serde_json::json!({
                                "accountId": account.id,
                                "folder": folder,
                                "newCount": result.new_count,
                                "newMessages": result.new_messages,
                            }),
                        );
                    }
                }
                Err(e) => {
                    // 检测到永久性认证错误：标记账号冷却 1 小时，跳过后续文件夹
                    if is_permanent_auth_error(&e) {
                        log::warn!(
                            "[email-bg] account={} permanent auth error, marking cooldown 1h: {}",
                            account.id,
                            e
                        );
                        mark_account_cooldown(&email_state, &account.id, "imap", &e);
                        break; // 跳过该账号剩余文件夹
                    }
                    log::warn!(
                        "[email-bg] account={} folder={} sync failed: {}",
                        account.id,
                        folder,
                        e
                    );
                    // 同步失败则跳过该文件夹的删除对账（避免误删）
                    continue;
                }
            }

            // 不做删除对账：增量同步只拉新增（UID > lastUid），不会拉到已删除的邮件。
            // 本地邮件删除仅由用户主动操作触发（点删除按钮 → IMAP MOVE/STORE + 删本地）。
            // 之前对非 INBOX 文件夹做对账会误清空刚同步的数据（UIDVALIDITY 不稳定）。

            // P1-1: 正文预下载（仅 INBOX，最近 N 封未读且未拉取正文的邮件）
            // 用户大概率会查看未读邮件，提前下载避免点击时的等待
            if folder == "INBOX" {
                if let Err(e) = prefetch_unread_bodies(&email_state, gateway_url, &account, &plain_password, folder).await {
                    log::warn!(
                        "[email-bg] account={} folder={} prefetch unread bodies failed: {}",
                        account.id,
                        folder,
                        e
                    );
                }
            }

            // P0-2: 定期全量对账（每 N 次同步周期对账一次）
            // skill 第三节：服务器不支持 CONDSTORE/QRESYNC 时定期校准
            // 增量同步只拉新增，无法发现服务器端已删除/已移动的邮件
            if need_reconcile {
                if let Err(e) = reconcile_folder(
                    &email_state,
                    gateway_url,
                    &account,
                    &plain_password,
                    folder,
                )
                .await
                {
                    log::warn!(
                        "[email-bg] account={} folder={} reconcile failed: {}",
                        account.id,
                        folder,
                        e
                    );
                }
            }

            // 每个文件夹同步完成后短暂释放锁间隔，让用户操作（点击文件夹、查看正文）插队
            // 避免后台同步长时间占用 IMAP 连接锁导致 UI 卡顿
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    Ok(())
}

/// 后台对账计数器：每 N 次同步周期触发一次全量对账
/// 静态计数器，进程重启后重新计数（影响很小，下次对账最多推迟 N 个周期）
static RECONCILE_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
/// 每 4 次后台同步周期对账一次（约 60 分钟，BG_SYNC_INTERVAL_SECS=900s）
const RECONCILE_EVERY_N_CYCLES: u32 = 4;

/// 全量对账：调用 gateway /email/list_uids 获取服务器 UID 集合，
/// 删除本地有但服务器没有的邮件（.eml + .meta.json + SQLite 索引）。
///
/// skill 第三节：服务器不支持 CONDSTORE/QRESYNC 时必须定期全量对账。
/// 增量同步（UID > last_uid）只能发现新邮件，无法发现服务器端已删除/已移动的邮件，
/// 本对账用 list_uids 拉服务器全量 UID，对比本地，清理孤立邮件。
async fn reconcile_folder(
    state: &EmailState,
    gateway_url: &str,
    account: &EmailAccount,
    plain_password: &str,
    folder: &str,
) -> Result<u32, String> {
    if gateway_url.is_empty() {
        return Ok(0);
    }
    let url = format!("{}/email/list_uids", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {e}"))?;
    let req_body = serde_json::json!({
        "accountId": account.id,
        "imapHost": account.imap_host,
        "imapPort": account.imap_port,
        "imapUsername": account.imap_username,
        "imapPassword": plain_password,
        "mailbox": folder,
        "useSsl": account.imap_use_ssl,
    });
    let resp = client
        .post(&url)
        .json(&req_body)
        .send()
        .await
        .map_err(|e| format!("请求 list_uids 失败 ({url}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("list_uids 返回 {status}: {text}"));
    }
    let resp_value: Value =
        resp.json().await.map_err(|e| format!("解析 list_uids 响应失败: {e}"))?;
    let server_uids: std::collections::HashSet<String> = resp_value
        .get("uids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|u| u.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    // 服务器返回空 UID 列表视为临时故障，跳过对账避免误删全部本地邮件
    if server_uids.is_empty() {
        log::warn!(
            "[email-reconcile] account={} folder={} server returned empty uids, skip",
            account.id,
            folder
        );
        return Ok(0);
    }

    // 查询本地所有 UID 和对应的 eml_path
    let local_uids: Vec<(String, String)> = {
        let conn = state.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT uid, eml_path FROM messages WHERE account_id = ?1 AND folder = ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![&account.id, &folder], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1).unwrap_or_default(),
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // 删除本地有但服务器没有的邮件（.eml + .meta.json + SQLite 索引）
    let mut deleted_count = 0u32;
    for (uid, eml_path) in &local_uids {
        if !server_uids.contains(uid) {
            if !eml_path.is_empty() {
                let _ = delete_eml_file(eml_path);
            }
            let _ = delete_meta_json(&account.id, folder, uid);
            if let Ok(conn) = state.conn() {
                let _ = conn.execute(
                    "DELETE FROM messages WHERE account_id = ?1 AND folder = ?2 AND uid = ?3",
                    params![&account.id, &folder, uid],
                );
            }
            deleted_count += 1;
        }
    }

    if deleted_count > 0 {
        log::info!(
            "[email-reconcile] account={} folder={} deleted {} stale messages",
            account.id,
            folder,
            deleted_count
        );
    }
    Ok(deleted_count)
}

/// skill 第九节：Services 请求失败时先检查进程状态，必要时恢复。
/// 通过 app_handle 获取 ServicesState，检查 is_running，若未运行则调用 start 重启。
async fn try_recover_services(app_handle: &tauri::AppHandle) {
    let services_state = app_handle.state::<crate::ServicesState>();
    if services_state.is_running() {
        // 进程在但请求失败，可能是刚启动还没 ready，等待一下
        log::info!("[email-fetch-body] services 进程在运行，等待就绪");
        if let Some(port) = services_state.port() {
            let _ = crate::services::wait_for_services(
                port,
                30,
                || services_state.exit_message(),
            )
            .await;
        }
        return;
    }
    // 进程未运行，尝试重启
    log::info!("[email-fetch-body] services 进程未运行，尝试重启");
    let settings = crate::settings::load_settings();
    if let Err(e) = crate::settings::ensure_desktop_config(
        settings.gateway_port,
        settings.services_port,
    ) {
        log::warn!("[email-fetch-body] ensure_desktop_config 失败: {}", e);
        return;
    }
    match services_state.start(&settings, app_handle) {
        Ok(port) => {
            let _ = crate::services::wait_for_services(
                port,
                90,
                || services_state.exit_message(),
            )
            .await;
        }
        Err(e) => {
            log::warn!("[email-fetch-body] 重启 services 失败: {}", e);
        }
    }
}

const PREFETCH_UNREAD_LIMIT: u32 = 20;

/// 预下载未读邮件的正文（仅 INBOX，最近 20 封未读且 body_fetched=0）。
///
/// 同步时只拉取 HEADER + FLAGS，正文按需拉取。但未读邮件用户大概率会查看，
/// 后台静默预下载可让用户点击时秒开，提升体验。
/// 单封失败不影响其他，整体不阻塞同步主流程。
///
/// 抢占机制：检测到用户主动 fetch_body 进行中时，sleep 让出 IMAP 锁窗口，
/// 避免预下载串行占用账号级锁阻塞用户请求。
async fn prefetch_unread_bodies(
    state: &EmailState,
    gateway_url: &str,
    account: &EmailAccount,
    plain_password: &str,
    folder: &str,
) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Ok(());
    }
    // 查询未读且未拉取正文的邮件，按 UID 倒序取最近 N 封
    let uids_to_prefetch: Vec<String> = {
        let conn = state.conn()?;
        let mut stmt = conn.prepare(
            "SELECT uid FROM messages
             WHERE account_id = ?1 AND folder = ?2 AND is_read = 0 AND body_fetched = 0
             ORDER BY uid_int DESC
             LIMIT ?3",
        ).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![&account.id, folder, PREFETCH_UNREAD_LIMIT], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        let mut uids: Vec<String> = Vec::new();
        for r in rows {
            if let Ok(u) = r {
                uids.push(u);
            }
        }
        uids
    };

    if uids_to_prefetch.is_empty() {
        return Ok(());
    }

    log::debug!(
        "[email-bg] account={} folder={} prefetching {} unread bodies",
        account.id,
        folder,
        uids_to_prefetch.len()
    );

    let url = format!("{}/email/fetch_body", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
    let base_req = serde_json::json!({
        "imapHost": account.imap_host,
        "imapPort": account.imap_port,
        "imapUsername": account.imap_username,
        "imapPassword": plain_password,
        "mailbox": folder,
        "useSsl": account.imap_use_ssl,
    });

    let mut success = 0u32;
    let mut failed = 0u32;
    for uid in &uids_to_prefetch {
        // 抢占检测：用户正在主动 fetch_body 时，sleep 让出 IMAP 锁窗口，跳过本轮预下载
        // prefetch 是尽力而为的优化，绝不应阻塞用户主动操作
        if state
            .user_fetch_in_progress
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        let mut req = base_req.clone();
        req["uid"] = serde_json::Value::String(uid.clone());
        match client.post(&url).json(&req).send().await {
            Ok(resp) if resp.status().is_success() => {
                let body: Value = match resp.json().await {
                    Ok(v) => v,
                    Err(e) => {
                        log::warn!(
                            "[email-bg] account={} uid={} parse body failed: {}",
                            account.id,
                            uid,
                            e
                        );
                        failed += 1;
                        continue;
                    }
                };
                // Foxmail 风格：如果 gateway 返回 rawBytes，落盘为 .eml 文件
                let raw_b64 = body.get("rawBytes").and_then(|v| v.as_str()).unwrap_or("");
                let eml_path = if !raw_b64.is_empty() {
                    match base64::engine::general_purpose::STANDARD.decode(raw_b64) {
                        Ok(bytes) => match write_eml_file(&account.id, folder, uid, &bytes) {
                            Ok(rel) => rel,
                            Err(e) => {
                                log::warn!(
                                    "[email-bg] account={} uid={} write eml failed: {}",
                                    account.id,
                                    uid,
                                    e
                                );
                                String::new()
                            }
                        },
                        Err(e) => {
                            log::warn!(
                                "[email-bg] account={} uid={} decode rawBytes failed: {}",
                                account.id,
                                uid,
                                e
                            );
                            String::new()
                        }
                    }
                } else {
                    String::new()
                };
                // 更新 SQLite：eml_path + body_fetched=1（不再写 body_text）
                if let Ok(conn) = state.conn() {
                    if eml_path.is_empty() {
                        let _ = conn.execute(
                            "UPDATE messages SET body_fetched = 1
                             WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                            params![uid, &account.id, folder],
                        );
                    } else {
                        let _ = conn.execute(
                            "UPDATE messages SET body_fetched = 1, eml_path = ?1
                             WHERE uid = ?2 AND account_id = ?3 AND folder = ?4",
                            params![eml_path, uid, &account.id, folder],
                        );
                    }
                }
                success += 1;
            }
            Ok(resp) => {
                log::warn!(
                    "[email-bg] account={} uid={} fetch_body status={}",
                    account.id,
                    uid,
                    resp.status()
                );
                failed += 1;
            }
            Err(e) => {
                log::warn!(
                    "[email-bg] account={} uid={} fetch_body error: {}",
                    account.id,
                    uid,
                    e
                );
                failed += 1;
            }
        }
    }

    log::debug!(
        "[email-bg] account={} folder={} prefetch done success={} failed={}",
        account.id,
        folder,
        success,
        failed
    );
    Ok(())
}

/// 对一批邮件应用规则动作。
/// - mark_read/star: 本地更新 + 调用 gateway /email/set_flag 同步 IMAP 服务器
/// - move: 调用 gateway /email/move + 删除本地缓存（目标文件夹下次同步拉取）
/// - delete: 调用 gateway /email/delete + 删除本地缓存
///
/// 返回 (success_count, failed_count, errors)。错误不向上抛出（规则失败不应阻塞 sync）。
async fn apply_rule_actions(
    state: &EmailState,
    gateway_url: &str,
    matched: &[(String, String, &EmailRule)],
    account: &EmailAccount,
    plain_password: &str,
) -> (u32, u32, Vec<String>) {
    if gateway_url.is_empty() || matched.is_empty() {
        return (0, 0, Vec::new());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let base = gateway_url.trim_end_matches('/');

    let mut success: u32 = 0;
    let mut failed: u32 = 0;
    let mut errors: Vec<String> = Vec::new();

    for (uid, folder, rule) in matched {
        let target = BatchActionTarget {
            uid: uid.clone(),
            account_id: account.id.clone(),
            folder: folder.clone(),
        };
        let result = execute_single_action(
            &client,
            base,
            &rule.action,
            &target,
            account,
            plain_password,
            rule.action_target.as_deref(),
        )
        .await;

        match result {
            Ok(()) => {
                // 同步本地缓存
                if let Err(e) = update_local_cache(state, gateway_url, &rule.action, &target, rule.action_target.as_deref(), account, plain_password).await {
                    failed += 1;
                    let msg = format!("uid={uid} 本地缓存更新失败: {e}");
                    log::warn!("[rule] {msg}");
                    errors.push(msg);
                } else {
                    success += 1;
                }
            }
            Err(e) => {
                failed += 1;
                let msg = format!("uid={uid} action={}: {e}", rule.action);
                log::warn!("[rule] 规则动作失败 {msg}");
                errors.push(msg);
            }
        }
    }
    (success, failed, errors)
}

/// 对历史邮件批量应用收件规则。
/// 扫描指定账号 INBOX 中所有已缓存的邮件，匹配启用规则并执行动作。
/// 用于用户创建规则后对已有邮件进行归类。
#[tauri::command]
pub async fn email_apply_rules(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    account_id: String,
) -> Result<serde_json::Value, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空".into());
    }

    // 收集匹配规则（持有 owned EmailRule，避免跨越 await 持有引用）
    let mut matched: Vec<(String, String, EmailRule)> = Vec::new();
    let mut inbox_total: u32 = 0;
    // 诊断信息（matched=0 时返回给前端，帮助定位匹配失败原因）
    let mut diag_rules: Vec<serde_json::Value> = Vec::new();
    let mut diag_froms: Vec<String> = Vec::new();
    {
        let conn = state.conn()?;
        let rules = get_enabled_rules(&conn, &account_id)?;
        if rules.is_empty() {
            return Ok(serde_json::json!({ "matched": 0, "success": 0, "failed": 0 }));
        }

        let mut stmt = conn
            .prepare(
                // COALESCE 把可空字段（from_name）的 NULL 转成空串，
                // 避免 row.get::<_, String>() 遇到 NULL 报错导致整行被 filter_map 丢弃
                "SELECT uid, folder, subject, from_address, COALESCE(from_name, '') AS from_name, to_addresses
                 FROM messages
                 WHERE account_id = ?1 AND folder = 'INBOX'
                 ORDER BY uid_int DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, String, String, String, String)> = stmt
            .query_map(params![&account_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        inbox_total = rows.len() as u32;

        for (uid, folder, subject, from_address, from_name, to_addresses) in &rows {
            for rule in &rules {
                if rule_matches(rule, subject, from_address, from_name, to_addresses) {
                    matched.push((uid.clone(), folder.clone(), rule.clone()));
                    break;
                }
            }
        }

        // 收集诊断信息（在 block 内，rules/rows 仍可用）
        diag_rules = rules
            .iter()
            .map(|r| {
                serde_json::json!({
                    "name": r.name,
                    "conditionField": r.condition_field,
                    "conditionValue": r.condition_value,
                    "action": r.action,
                    "actionTarget": r.action_target,
                })
            })
            .collect();
        diag_froms = rows.iter().take(5).map(|(_, _, _, from_addr, _, _)| from_addr.clone()).collect();
    }

    let total_matched = matched.len() as u32;
    if total_matched == 0 {
        return Ok(serde_json::json!({
            "matched": 0,
            "success": 0,
            "failed": 0,
            "inboxTotal": inbox_total,
            "diagRules": diag_rules,
            "diagFroms": diag_froms,
        }));
    }

    // 获取账号凭据
    let (account, plain_password) = {
        let conn2 = state.conn()?;
        let account = get_imap_credentials(&conn2, &account_id)?;
        let plain = decrypt_password(&account.imap_password)?;
        (account, plain)
    };

    // 执行规则动作
    let matched_refs: Vec<(String, String, &EmailRule)> = matched
        .iter()
        .map(|(uid, folder, rule)| (uid.clone(), folder.clone(), rule))
        .collect();
    let (success, failed, errors) =
        apply_rule_actions(&state, &gateway_url, &matched_refs, &account, &plain_password).await;

    Ok(serde_json::json!({
        "matched": total_matched,
        "success": success,
        "failed": failed,
        "errors": errors,
        "inboxTotal": inbox_total,
    }))
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
pub async fn email_send(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    req: SendRequest,
) -> Result<(), String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空，请确认 Mona 运行时已启动".into());
    }

    // 注意：用户手动发信不检查冷却期。
    // 冷却期仅用于后台同步引擎避免反复触发风控。
    // 如果用户改对了密码，应能立即尝试发信，发信成功后自动清除冷却。
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
        // 检测永久性认证错误，标记 SMTP 冷却期（仅影响后台同步，不影响用户手动发信）
        if is_permanent_auth_error(&text) {
            mark_account_cooldown(&state, &req.account_id, "smtp", &text);
        }
        return Err(format!(
            "gateway 返回 {status} ({url}): {text}\n若刚更新代码，请重启 Mona 使新路由生效"
        ));
    }
    // 发送成功，清除 SMTP 冷却期
    clear_account_cooldown(&state, &req.account_id, "smtp");

    // 解析 gateway 响应：rawBytes（完整 RFC822）+ messageId + date
    // gateway 已同步完成 SMTP + IMAP APPEND，rawBytes 是发送邮件的完整字节
    let response_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 gateway 响应失败: {e}"))?;
    let raw_b64 = response_json
        .get("rawBytes")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let gw_message_id = response_json
        .get("messageId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let gw_date = response_json
        .get("date")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // 自动收集收件人/抄送人到联系人库
    if let Ok(conn) = state.conn() {
        let now = chrono::Utc::now().timestamp();
        for raw in req.to.iter().chain(req.cc.iter()) {
            for (name, email) in parse_addresses_from_field(raw) {
                let email_clean = email.trim().to_lowercase();
                if email_clean.is_empty() || !email_clean.contains('@') {
                    continue;
                }
                let exists: bool = conn
                    .query_row(
                        "SELECT 1 FROM contacts WHERE lower(email) = ?1 LIMIT 1",
                        params![&email_clean],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);
                if exists {
                    continue;
                }
                let display = if name.trim().is_empty() {
                    email_clean.clone()
                } else {
                    name.trim().to_string()
                };
                let id = uuid::Uuid::new_v4().to_string();
                if let Err(e) = conn.execute(
                    "INSERT INTO contacts
                     (id, account_id, source, display_name, email, updated_at)
                     VALUES (?1, ?2, 'auto', ?3, ?4, ?5)",
                    params![id, &req.account_id, display, email_clean, now],
                ) {
                    log::warn!("[auto-collect] insert contact on send failed: {e}");
                }
            }
        }
    }

    // 本地落盘 + 写索引（Foxmail 风格：发送即可见）
    // 生成 uid = "L" + timestamp_ms，标记为本地生成；后续 IMAP 同步会按 message_id 去重替换
    let mut local_write_ok = false;
    if !raw_b64.is_empty() {
        match base64::engine::general_purpose::STANDARD.decode(&raw_b64) {
            Ok(raw_bytes) => {
                let uid = format!("L{}", chrono::Utc::now().timestamp_millis());
                // 探测"已发送"文件夹实际名称（从 folders 表查，兜底 "Sent"）
                let sent_folder: String = match state.conn() {
                    Ok(conn) => conn
                        .query_row(
                            "SELECT name FROM folders
                             WHERE account_id = ?1 AND (
                               lower(name) = 'sent' OR lower(name) = 'sent items'
                               OR lower(name) = 'sent messages' OR name = '已发送'
                               OR lower(name) LIKE 'sent%' OR name LIKE '%已发送%'
                             ) LIMIT 1",
                            params![&req.account_id],
                            |row| row.get::<_, String>(0),
                        )
                        .unwrap_or_else(|_| "Sent".to_string()),
                    Err(_) => "Sent".to_string(),
                };

                // 写 .eml 文件
                match write_eml_file(&req.account_id, &sent_folder, &uid, &raw_bytes) {
                    Ok(eml_rel) => {
                        // 解析 RFC822 header
                        let (subject, from_addr, from_name, to_addrs, cc_addrs, date_field, msg_id, has_attach) =
                            parse_eml_header(&raw_bytes);
                        // 写 .meta.json（已发送邮件：isRead=true, bodyFetched=true）
                        let meta = EmlMeta {
                            uid: uid.clone(),
                            account_id: req.account_id.clone(),
                            folder: sent_folder.clone(),
                            is_read: true,
                            is_starred: false,
                            has_attachments: has_attach,
                            body_fetched: true,
                            message_id: if msg_id.is_empty() { gw_message_id.clone() } else { msg_id.clone() },
                            eml_mtime: chrono::Utc::now().timestamp(),
                        };
                        let _ = write_meta_json(&meta);
                        // 写 SQLite 索引
                        if let Ok(conn) = state.conn() {
                            let subject_value = if subject.is_empty() {
                                req.subject.clone()
                            } else {
                                subject
                            };
                            let from_addr_value = if from_addr.is_empty() {
                                req.from_address.clone()
                            } else {
                                from_addr
                            };
                            let date_value = if date_field.is_empty() {
                                gw_date.clone()
                            } else {
                                date_field
                            };
                            let msg_id_value = if msg_id.is_empty() {
                                gw_message_id.clone()
                            } else {
                                msg_id
                            };
                            let from_name_value = if from_name.is_empty() {
                                req.from_name.clone().unwrap_or_default()
                            } else {
                                from_name
                            };
                            let to_addrs_value = if to_addrs.is_empty() {
                                req.to.join(", ")
                            } else {
                                to_addrs
                            };
                            let cc_addrs_value = if cc_addrs.is_empty() {
                                req.cc.join(", ")
                            } else {
                                cc_addrs
                            };
                            match conn.execute(
                                "INSERT OR REPLACE INTO messages
                                 (uid, uid_int, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
                                  date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path)
                                 VALUES (?1, CASE WHEN ?1 LIKE 'L%' THEN 0 ELSE CAST(?1 AS INTEGER) END,
                                         ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                                params![
                                    &uid,
                                    &req.account_id,
                                    &sent_folder,
                                    &subject_value,
                                    &from_addr_value,
                                    &from_name_value,
                                    &to_addrs_value,
                                    &cc_addrs_value,
                                    &date_value,
                                    has_attach as i32,
                                    1, // is_read: 已发送默认已读
                                    0, // is_starred
                                    raw_bytes.len() as u32,
                                    &msg_id_value,
                                    1, // body_fetched: 本地有完整 .eml
                                    &eml_rel,
                                ],
                            ) {
                                Ok(_) => {
                                    log::debug!(
                                    "[email-send] 本地落盘成功: uid={}, folder={}, size={}",
                                    uid,
                                    sent_folder,
                                    raw_bytes.len()
                                );
                                    local_write_ok = true;
                                }
                                Err(e) => {
                                    log::warn!("[email-send] 写 SQLite 索引失败 uid={}: {}", uid, e);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[email-send] 写 .eml 文件失败: {}", e);
                    }
                }
            }
            Err(e) => {
                log::warn!("[email-send] base64 解码 rawBytes 失败: {}", e);
            }
        }
    }

    // 发送成功后，同步"已发送"文件夹索引（同步执行，不依赖后台任务）。
    // 必要性：gateway 已同步完成 IMAP APPEND，本地 SQLite 索引不会有这条记录，
    //   IDLE 默认只监听 INBOX 不会推送"已发送"变更，用户切到"已发送"会看到空列表。
    // 实现：用 folders 表中的实际文件夹名（Sent Messages/Sent/已发送等），
    //   全量同步（last_uid=None 拉取最近 20 封），确保新邮件被写入索引。
    //   失败只记日志，不影响发送结果（用户下次手动收取时也会拉回）。
    // 备注：本地落盘成功时，此同步作为补充（拉取 IMAP 版本替换 "L" uid 本地版本，由 sync_folder_internal 去重处理）；
    //   本地落盘失败时，此同步作为兜底（确保邮件至少能通过 IMAP 同步进入索引）。
    log::debug!("[email-send] 开始同步已发送文件夹索引: account={} local_write_ok={}", req.account_id, local_write_ok);
    let account_id = req.account_id.clone();
    let gw = gateway_url.clone();
    let db_path = state.db_path().to_path_buf();
    let schema_initialized = state.schema_initialized.clone();
    let user_fetch_in_progress = state.user_fetch_in_progress.clone();
    let sync_result: Result<SyncResult, String> = async {
        let state_inner = EmailState {
            db_path: db_path.clone(),
            schema_initialized,
            user_fetch_in_progress,
        };
        let conn = state_inner.conn()?;
        let account = get_imap_credentials(&conn, &account_id)?;
        let plain = decrypt_password(&account.imap_password)?;
        // 从 folders 表探测"已发送"文件夹的实际名称
        let sent_folder: String = conn
            .query_row(
                "SELECT name FROM folders
                 WHERE account_id = ?1 AND (
                   lower(name) = 'sent' OR lower(name) = 'sent items'
                   OR lower(name) = 'sent messages' OR name = '已发送'
                   OR lower(name) LIKE 'sent%' OR name LIKE '%已发送%'
                 ) LIMIT 1",
                params![&account_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "Sent".to_string());
        // 优先用 folders 表的 last_synced_uid 作为同步水位线，回退到 messages 表
        let last_uid: Option<String> = conn
            .query_row(
                "SELECT last_synced_uid FROM folders
                 WHERE account_id = ?1 AND name = ?2",
                params![&account_id, &sent_folder],
                |row| row.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten()
            .filter(|n| *n > 0)
            .map(|n| n.to_string())
            .or_else(|| {
                conn.query_row(
                    "SELECT MAX(uid_int) FROM messages
                     WHERE account_id = ?1 AND folder = ?2",
                    params![&account_id, &sent_folder],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .ok()
                .flatten()
                .filter(|n| *n > 0)
                .map(|n| n.to_string())
            });
        drop(conn);
        log::debug!("[email-send] 同步已发送文件夹: name={}, last_uid={:?}", sent_folder, last_uid);
        let sync_req = SyncRequest {
            account_id: account.id.clone(),
            imap_host: account.imap_host.clone(),
            imap_port: account.imap_port,
            imap_username: account.imap_username.clone(),
            imap_password: plain,
            mailbox: sent_folder.clone(),
            use_ssl: account.imap_use_ssl,
            last_uid,
        };
        sync_folder_internal(&state_inner, &gw, sync_req, false).await
    }
    .await;
    match sync_result {
        Ok(r) => log::debug!(
            "[email-send] 已发送文件夹同步完成: new={}, msgs={}",
            r.new_count,
            r.new_messages.len()
        ),
        Err(e) => log::warn!("[email-send] 已发送文件夹同步失败: {e}"),
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
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
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
    // 解析返回值：{"status":"ok","action":"moved"|"deleted","target":"<folder>"|null}
    let result: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let action = result
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("deleted");
    let target = result.get("target").and_then(|v| v.as_str());

    let conn = state.conn()?;

    // 查询本地 .eml 文件路径（用于同步文件操作）
    let eml_path: String = conn
        .query_row(
            "SELECT eml_path FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
            params![req.uid, req.account_id, req.mailbox],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();

    if action == "moved" {
        // MOVE 到回收站：IMAP MOVE 会改变 UID，本地旧 UID 记录已失效。
        // 删除本地记录 + .eml + .meta.json，下次同步时从 IMAP 拉取正确新 UID 的记录。
        // 保留旧 UID 会导致用户在回收站删除时用旧 UID 调 IMAP，操作静默失败，邮件复活。
        conn.execute(
            "DELETE FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
            params![req.uid, req.account_id, req.mailbox],
        )
        .map_err(|e| e.to_string())?;
        if !eml_path.is_empty() {
            if let Err(e) = delete_eml_file(&eml_path) {
                log::warn!("[email-delete] 删除 .eml 文件失败: {}", e);
            }
        }
        let _ = delete_meta_json(&req.account_id, &req.mailbox, &req.uid);
        // 不立即同步回收站文件夹：后台同步（15分钟）会自动拉取新 UID 的记录。
        // 立即同步可能与 IMAP MOVE 尚未完全提交产生竞态。
    } else {
        // 永久删除：删除本地缓存 + .eml + .meta.json
        conn.execute(
            "DELETE FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
            params![req.uid, req.account_id, req.mailbox],
        )
        .map_err(|e| e.to_string())?;
        if !eml_path.is_empty() {
            if let Err(e) = delete_eml_file(&eml_path) {
                log::warn!("[email-delete] 删除 .eml 文件失败: {}", e);
            }
        }
        let _ = delete_meta_json(&req.account_id, &req.mailbox, &req.uid);
    }
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

    // 同步 .meta.json：查询该文件夹所有 uid，在后台线程批量更新 is_read=true。
    // 邮件列表以 SQLite 为准，此处不阻塞 API 返回。
    let account_id = req.account_id.clone();
    let mailbox = req.mailbox.clone();
    let db_path = state.db_path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        let Ok(conn) = Connection::open(db_path) else { return };
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        let mut stmt = match conn.prepare("SELECT uid FROM messages WHERE account_id = ?1 AND folder = ?2") {
            Ok(s) => s,
            Err(_) => return,
        };
        let uids: Vec<String> = stmt
            .query_map(params![account_id, mailbox], |row| row.get::<_, String>(0))
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        for uid in &uids {
            if let Some(mut meta) = read_meta_json(&account_id, &mailbox, uid) {
                meta.is_read = true;
                let _ = write_meta_json(&meta);
            }
        }
    });
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
    // 本地缓存同步：删除该文件夹所有邮件 + 清空 .eml 目录
    let conn = state.conn()?;
    // 删除整个文件夹的 .eml 目录
    let folder_dir = mail_root()
        .join(sanitize_path_segment(&req.account_id))
        .join(sanitize_path_segment(&req.mailbox));
    if folder_dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&folder_dir) {
            log::warn!(
                "[email-empty] account={} folder={} remove eml dir failed: {}",
                req.account_id,
                req.mailbox,
                e
            );
        }
    }
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
    /// 预设收件人（点击发件人名称写邮件时使用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_to: Option<String>,
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
    crate::attach_permission_allower(&window);
    let _ = window.show();
    let _ = window.set_focus();

    Ok(label)
}

/// 关闭当前邮件撰写窗口
#[tauri::command]
pub async fn email_close_compose_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenMailViewWindowPayload {
    pub account_id: String,
    pub uid: String,
    pub folder: String,
    /// 窗口标题（通常是邮件主题），可选
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
}

/// 打开独立的邮件预览窗口（只读，Agent 回复中的 mona:email 链接点击后触发）
#[tauri::command]
pub async fn email_open_view_window(
    app: AppHandle,
    payload: OpenMailViewWindowPayload,
) -> Result<String, String> {
    let label = format!("mailview-{}", uuid::Uuid::new_v4());
    let title = payload.subject.clone().unwrap_or_else(|| "邮件预览".into());
    // 用 query string 传参（不敏感，无需 base64）
    let url = format!(
        "#/mailview?accountId={}&uid={}&folder={}",
        urlencoding::encode(&payload.account_id),
        urlencoding::encode(&payload.uid),
        urlencoding::encode(&payload.folder),
    );

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(900.0, 680.0)
        .min_inner_size(640.0, 480.0)
        .decorations(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    crate::attach_permission_allower(&window);
    let _ = window.show();
    let _ = window.set_focus();

    Ok(label)
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

/// 跨文件夹/跨账号搜索邮件（FTS5 全文搜索，只读本地缓存）
#[tauri::command]
pub async fn email_search_messages(
    state: tauri::State<'_, EmailState>,
    req: EmailSearchRequest,
) -> Result<Vec<EmailSearchResult>, String> {
    let conn = state.conn()?;
    // 有关键词时用 FTS5 MATCH，否则用普通查询
    let use_fts = req.keyword.as_ref().map_or(false, |k| !k.is_empty());

    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    // FTS 模式下 MATCH 参数放在第一位
    if use_fts {
        let keyword = req.keyword.as_ref().unwrap();
        // 用双引号包裹作为短语查询，避免 FTS5 特殊字符问题
        let fts_query = format!("\"{}\"", keyword.replace('"', " "));
        params.push(Box::new(fts_query));
    }

    // FTS 模式下字段需要 m. 前缀（JOIN 了 messages_fts）
    let col_prefix = if use_fts { "m." } else { "" };

    if let Some(ref v) = req.account_id {
        conditions.push(format!("{col_prefix}account_id = ?{}", params.len() + 1));
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = req.folder {
        conditions.push(format!("{col_prefix}folder = ?{}", params.len() + 1));
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = req.from_address {
        conditions.push(format!("{col_prefix}from_address LIKE ?{}", params.len() + 1));
        params.push(Box::new(format!("%{v}%")));
    }
    if let Some(ref v) = req.from_name {
        conditions.push(format!("{col_prefix}from_name LIKE ?{}", params.len() + 1));
        params.push(Box::new(format!("%{v}%")));
    }
    if let Some(ref v) = req.date_from {
        conditions.push(format!("{col_prefix}date >= ?{}", params.len() + 1));
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = req.date_to {
        conditions.push(format!("{col_prefix}date <= ?{}", params.len() + 1));
        params.push(Box::new(v.clone()));
    }
    if let Some(v) = req.is_read {
        conditions.push(format!("{col_prefix}is_read = ?{}", params.len() + 1));
        params.push(Box::new(if v { 1i32 } else { 0i32 }));
    }
    if let Some(v) = req.is_starred {
        conditions.push(format!("{col_prefix}is_starred = ?{}", params.len() + 1));
        params.push(Box::new(if v { 1i32 } else { 0i32 }));
    }
    if let Some(v) = req.has_attachments {
        conditions.push(format!("{col_prefix}has_attachments = ?{}", params.len() + 1));
        params.push(Box::new(if v { 1i32 } else { 0i32 }));
    }

    let limit = req.limit.clamp(1, 200);
    let offset = req.offset;

    let sql = if use_fts {
        let extra = if conditions.is_empty() {
            String::new()
        } else {
            format!("AND {}", conditions.join(" AND "))
        };
        format!(
            "SELECT m.uid, m.account_id, m.folder, m.subject, m.from_address, m.from_name,
                    m.to_addresses, m.date, m.has_attachments, m.is_read, m.is_starred, m.raw_size
             FROM messages m
             JOIN messages_fts ON m.rowid = messages_fts.rowid
             WHERE messages_fts MATCH ?1
             {extra}
             ORDER BY CAST(m.uid AS INTEGER) DESC LIMIT ?{} OFFSET ?{}",
            params.len() + 1,
            params.len() + 2
        )
    } else {
        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        format!(
            "SELECT uid, account_id, folder, subject, from_address, from_name, to_addresses,
                    date, has_attachments, is_read, is_starred, raw_size
             FROM messages {where_clause}
             ORDER BY uid_int DESC LIMIT ?{} OFFSET ?{}",
            params.len() + 1,
            params.len() + 2
        )
    };

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
                from_name, last_synced_uid, carddav_url, eas_url, imap_use_ssl, smtp_use_ssl,
                signatures
         FROM accounts WHERE id = ?1",
        params![account_id],
        |row| {
            let sigs_str: String = row.get(17).unwrap_or_else(|_| "[]".to_string());
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
                imap_use_ssl: row.get::<_, i32>(15)? != 0,
                smtp_use_ssl: row.get::<_, i32>(16)? != 0,
                signatures: serde_json::from_str(&sigs_str).unwrap_or_default(),
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
                    if let Err(e) = update_local_cache(&state, &gateway_url, &req.action, target, req.dest_folder.as_deref(), &account, &plain_password).await {
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
/// 把字符串中的 \\uXXXX 转义解码为可读中文字符，用于 gateway 返回的错误提示。
fn decode_unicode_escapes(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    if let Ok(code) = u32::from_str_radix(&hex, 16) {
                        if let Some(decoded) = char::from_u32(code) {
                            output.push(decoded);
                        } else {
                            output.push('\\');
                            output.push('u');
                            output.push_str(&hex);
                        }
                    } else {
                        output.push('\\');
                        output.push('u');
                        output.push_str(&hex);
                    }
                }
                Some(next) => {
                    output.push('\\');
                    output.push(next);
                }
                None => output.push('\\'),
            }
        } else {
            output.push(c);
        }
    }
    output
}

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
                use_ssl: account.imap_use_ssl,
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
                return Err(format!("gateway 返回错误: {}", decode_unicode_escapes(&text)));
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
                use_ssl: account.imap_use_ssl,
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
                return Err(format!("gateway 返回错误: {}", decode_unicode_escapes(&text)));
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
                use_ssl: account.imap_use_ssl,
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
                return Err(format!("gateway 返回错误: {}", decode_unicode_escapes(&text)));
            }
            Ok(())
        }
        _ => Err(format!("未知操作: {action}")),
    }
}

/// 批量操作后同步本地缓存
async fn update_local_cache(
    state: &EmailState,
    gateway_url: &str,
    action: &str,
    target: &BatchActionTarget,
    dest_folder: Option<&str>,
    account: &EmailAccount,
    plain_password: &str,
) -> Result<(), String> {
    let conn = state.conn()?;
    match action {
        "mark_read" => {
            conn.execute(
                "UPDATE messages SET is_read = 1 WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
            if let Some(mut meta) = read_meta_json(&target.account_id, &target.folder, &target.uid) {
                meta.is_read = true;
                let _ = write_meta_json(&meta);
            }
        }
        "mark_unread" => {
            conn.execute(
                "UPDATE messages SET is_read = 0 WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
            if let Some(mut meta) = read_meta_json(&target.account_id, &target.folder, &target.uid) {
                meta.is_read = false;
                let _ = write_meta_json(&meta);
            }
        }
        "star" => {
            conn.execute(
                "UPDATE messages SET is_starred = 1 WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
            if let Some(mut meta) = read_meta_json(&target.account_id, &target.folder, &target.uid) {
                meta.is_starred = true;
                let _ = write_meta_json(&meta);
            }
        }
        "unstar" => {
            conn.execute(
                "UPDATE messages SET is_starred = 0 WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
            if let Some(mut meta) = read_meta_json(&target.account_id, &target.folder, &target.uid) {
                meta.is_starred = false;
                let _ = write_meta_json(&meta);
            }
        }
        "move" => {
            // Foxmail 风格：移动 .eml + .meta.json + UPDATE SQLite，邮件在目标文件夹立即可见
            // IMAP MOVE 会改变 uid，但本地保留旧 uid；下次常规同步拉到新 uid 时，
            // sync_folder_internal 的 message_id 去重会删除旧 uid 版本、INSERT 新 uid 版本
            let eml_path: String = conn
                .query_row(
                    "SELECT eml_path FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                    params![target.uid, target.account_id, target.folder],
                    |row| row.get::<_, String>(0),
                )
                .unwrap_or_default();
            if let Some(dest) = dest_folder {
                // 移动 .eml 文件到目标文件夹（保留 uid）
                let new_eml_path = if !eml_path.is_empty() {
                    match move_eml_file(&eml_path, &target.account_id, dest, &target.uid) {
                        Ok(p) => p,
                        Err(e) => {
                            log::warn!("[rule-move] move .eml failed: {}", e);
                            String::new()
                        }
                    }
                } else {
                    String::new()
                };
                // 移动 .meta.json 文件
                if let Err(e) = move_meta_json(
                    &target.account_id,
                    &target.folder,
                    &target.uid,
                    &target.account_id,
                    dest,
                ) {
                    log::warn!("[rule-move] move .meta.json failed: {}", e);
                }
                // 更新 .meta.json 的 folder 字段
                if let Some(mut meta) = read_meta_json(&target.account_id, dest, &target.uid) {
                    meta.folder = dest.to_string();
                    let _ = write_meta_json(&meta);
                }
                // UPDATE SQLite: folder = dest, eml_path = new_path
                conn.execute(
                    "UPDATE messages SET folder = ?1, eml_path = ?2
                     WHERE uid = ?3 AND account_id = ?4 AND folder = ?5",
                    params![dest, &new_eml_path, &target.uid, &target.account_id, &target.folder],
                )
                .map_err(|e| e.to_string())?;
                log::debug!(
                    "[rule-move] uid={} {} -> {} 本地移动完成",
                    target.uid,
                    target.folder,
                    dest
                );
                // P0-3: 立即同步目标文件夹，校准 UID（在 match 块之后执行，避免与当前持有的 conn 冲突）。
                // 本地保留旧 uid，但 IMAP MOVE 会为目标文件夹分配新 uid，
                // 需立即触发 sync_folder_internal(message_id 去重逻辑) 删除旧 uid 版本、INSERT 新 uid 版本，
                // 否则用户点击该邮件时本地用旧 uid 请求目标文件夹会得到 SELECT/FETCH NO，陷入加载循环。
            } else {
                // 无目标文件夹，兜底删除
                if !eml_path.is_empty() {
                    let _ = delete_eml_file(&eml_path);
                }
                let _ = delete_meta_json(&target.account_id, &target.folder, &target.uid);
                conn.execute(
                    "DELETE FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                    params![target.uid, target.account_id, target.folder],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        "delete" => {
            // 查询并删除 .eml 文件，然后删除索引
            let eml_path: String = conn
                .query_row(
                    "SELECT eml_path FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                    params![target.uid, target.account_id, target.folder],
                    |row| row.get::<_, String>(0),
                )
                .unwrap_or_default();
            if !eml_path.is_empty() {
                if let Err(e) = delete_eml_file(&eml_path) {
                    log::warn!("[rule-delete] delete eml failed: {}", e);
                }
            }
            conn.execute(
                "DELETE FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![target.uid, target.account_id, target.folder],
            )
            .map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    // P0-3: move 操作完成后立即同步目标文件夹，校准 UID。
    // 本地保留旧 uid，但 IMAP MOVE 会为目标文件夹分配新 uid，
    // 需立即触发 sync_folder_internal(message_id 去重逻辑) 删除旧 uid 版本、INSERT 新 uid 版本，
    // 否则用户点击该邮件时本地用旧 uid 请求目标文件夹会得到 SELECT/FETCH NO，陷入加载循环。
    // 放在 match 块之后是为了让上面的 conn 自然 drop，避免与 sync_folder_internal 内部新连接冲突。
    if action == "move" {
        if let Some(dest) = dest_folder {
            if gateway_url.is_empty() {
                log::warn!(
                    "[rule-move] gateway_url 为空，跳过目标文件夹 {} 的 UID 校准",
                    dest
                );
            } else {
                let last_uid: Option<String> = match state.conn() {
                    Ok(c) => c
                        .query_row(
                            "SELECT MAX(CAST(uid AS INTEGER)) FROM messages
                             WHERE account_id = ?1 AND folder = ?2",
                            params![&target.account_id, dest],
                            |row| {
                                let v: Option<i64> = row.get(0)?;
                                Ok(v.filter(|n| *n > 0).map(|n| n.to_string()))
                            },
                        )
                        .ok()
                        .flatten(),
                    Err(e) => {
                        log::warn!("[rule-move] 查询目标文件夹 last_uid 失败: {}", e);
                        None
                    }
                };
                let sync_req = SyncRequest {
                    account_id: account.id.clone(),
                    imap_host: account.imap_host.clone(),
                    imap_port: account.imap_port,
                    imap_username: account.imap_username.clone(),
                    imap_password: plain_password.to_string(),
                    mailbox: dest.to_string(),
                    use_ssl: account.imap_use_ssl,
                    last_uid,
                };
                // Box::pin 打破 async fn 静态递归：sync_folder_internal 内部会调用
                // update_local_cache（应用规则时），不 pin 会报 E0733。
                // apply_rules=false 运行时不会真正递归，仅满足编译器静态调用图要求。
                let sync_fut = sync_folder_internal(state, gateway_url, sync_req, false);
                let sync_result = Box::pin(sync_fut).await;
                match sync_result {
                    Ok(r) => log::debug!(
                        "[rule-move] 目标文件夹 {} 同步完成: new={}, msgs={}",
                        dest,
                        r.new_count,
                        r.new_messages.len()
                    ),
                    Err(e) => log::warn!(
                        "[rule-move] 目标文件夹 {} 同步失败（不影响本地移动结果）: {}",
                        dest,
                        e
                    ),
                }
            }
        }
    }
    Ok(())
}

/// 按需读取单封邮件正文（Offline-First：本地 .eml 优先，缺失时才调 gateway）。
///
/// 三段式逻辑：
/// 1. 本地命中：SQLite body_fetched=true 且 .eml 可读 → mailparse 解析返回（毫秒级）
/// 2. 本地失败：HEADER-only .eml 或 .eml 缺失 → 调 gateway fetch_body（includeRawBytes=true）
/// 3. 落盘：用响应中的 rawBytes 直接写 .eml（一次 IMAP 传输），
///    仅在 rawBytes 缺失/写盘失败时回退 fetch_raw_and_cache 二次拉取
#[tauri::command]
pub async fn email_fetch_body(
    state: tauri::State<'_, EmailState>,
    app_handle: tauri::AppHandle,
    account_id: String,
    uid: String,
    mailbox: String,
    gateway_url: Option<String>,
) -> Result<serde_json::Value, String> {
    // 1. 查 SQLite 拿 eml_path、body_fetched 和 header（已解码，避免重复解析）
    let conn = state.conn()?;
    let (eml_path, body_fetched, db_header): (String, bool, Option<serde_json::Value>) = conn
        .query_row(
            "SELECT eml_path, body_fetched, subject, from_address, from_name, to_addresses, cc_addresses
             FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
            params![&uid, &account_id, &mailbox],
            |row| {
                let eml_path: String = row.get(0).unwrap_or_default();
                let body_fetched: bool = row.get::<_, i32>(1).unwrap_or(0) == 1;
                let subject: String = row.get(2).unwrap_or_default();
                let from_address: String = row.get(3).unwrap_or_default();
                let from_name: String = row.get(4).unwrap_or_default();
                let to_addresses: String = row.get(5).unwrap_or_default();
                let cc_addresses: String = row.get(6).unwrap_or_default();
                // 检测是否有乱码标志（旧数据 gb2312→gb18030 修复前），有则返回 None 触发重新解析
                let has_fffd = subject.contains('\u{FFFD}')
                    || from_name.contains('\u{FFFD}')
                    || to_addresses.contains('\u{FFFD}')
                    || cc_addresses.contains('\u{FFFD}');
                let header = if has_fffd {
                    None
                } else {
                    Some(serde_json::json!({
                        "subject": subject,
                        "fromAddress": from_address,
                        "fromName": from_name,
                        "toAddresses": to_addresses,
                        "ccAddresses": cc_addresses,
                    }))
                };
                Ok((eml_path, body_fetched, header))
            },
        )
        .unwrap_or_default();
    drop(conn);

    // 2. 本地优先：.eml 存在且 body_fetched=true 时，直接 mailparse 解析返回（毫秒级，不走 gateway）
    //    命中条件：.eml 完整（body_fetched=true）且 mailparse 解析成功
    //    合法空正文（纯附件、日历邀请、加密内容）解析成功但没有可显示正文时也返回本地结果，
    //    不反复请求网络（skill 第四节：合法空正文不得反复请求网络）
    //    HEADER-only .eml（body_fetched=false）视为不完整，走网络回退
    if !eml_path.is_empty() && body_fetched {
        let eml_abs = eml_absolute_path(&eml_path);
        if let Ok(eml_bytes) = std::fs::read(&eml_abs) {
            if let Ok(parsed) = mailparse::parse_mail(&eml_bytes) {
                let mut body_text = String::new();
                let mut body_html: Option<String> = None;
                extract_bodies(&parsed, &mut body_text, &mut body_html);
                if body_text.len() > 50000 {
                    body_text.truncate(50000);
                }
                let mut attachments: Vec<serde_json::Value> = Vec::new();
                extract_attachments(&parsed, &mut attachments);
                let header = match db_header {
                    Some(h) => h,
                    None => reparse_header_and_fix_db(
                        state.inner(),
                        &eml_bytes,
                        &uid,
                        &account_id,
                        &mailbox,
                    ),
                };
                return Ok(serde_json::json!({
                    "bodyText": body_text,
                    "bodyHtml": body_html,
                    "attachments": attachments,
                    "header": header,
                }));
            } else {
                log::warn!("[email-fetch-body] mailparse 解析失败，回退 gateway");
            }
        } else {
            log::warn!("[email-fetch-body] 读取 .eml 失败，回退 gateway");
        }
    }

    // 3. 本地未命中，需要调邮件服务 HTTP 拉取（serviceUrl 由前端传入，变量名历史遗留叫 gatewayUrl）
    //    emit 事件通知前端切换提示文案：从"正在加载正文"切为"正在请求邮件"
    let _ = app_handle.emit(
        "email-body-stage",
        serde_json::json!({
            "accountId": &account_id,
            "uid": &uid,
            "mailbox": &mailbox,
            "stage": "network",
        }),
    );
    let gateway_url = match gateway_url.as_deref().filter(|s| !s.is_empty()) {
        Some(u) => u,
        None => return Err("本地无 .eml 缓存且邮件服务未就绪，无法拉取正文".into()),
    };

    // 抢占标志：prefetch 检测到此标志时让出 IMAP 锁，避免阻塞用户请求
    let _guard = UserFetchGuard::new(state.user_fetch_in_progress.clone());

    let (account, plain_password) = {
        let conn = state.conn()?;
        let account = get_imap_credentials(&conn, &account_id)?;
        let plain = decrypt_password(&account.imap_password)?;
        (account, plain)
    };

    let url = format!("{}/email/fetch_body", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;

    // 调 gateway，含 UID 失效自动修复重试一次
    // skill 第九节：Services 请求失败时先检查进程状态，必要时恢复并重试一次
    let (body, resolved_uid) = match fetch_body_via_gateway(
        &client,
        &url,
        &account_id,
        &account,
        &plain_password,
        &mailbox,
        &uid,
        state.inner(),
        &gateway_url,
    )
    .await
    {
        Ok(result) => result,
        Err(e) => {
            // 连接错误：services 可能未启动或已崩溃，尝试恢复后重试一次
            if e.contains("error sending request") || e.contains("连接") {
                log::warn!(
                    "[email-fetch-body] services 连接失败，尝试恢复: {}",
                    e
                );
                try_recover_services(&app_handle).await;
                // 重试一次
                fetch_body_via_gateway(
                    &client,
                    &url,
                    &account_id,
                    &account,
                    &plain_password,
                    &mailbox,
                    &uid,
                    state.inner(),
                    &gateway_url,
                )
                .await?
            } else {
                return Err(e);
            }
        }
    };

    // 正文拉取完成，提前释放抢占标志：
    // 1) 落盘阶段不再与 prefetch 竞争（prefetch 会让路即可，无需继续置位）
    // 2) 关键：避免下方 fetch_raw_and_cache 回退路径被自己持有的标志锁住 30s
    drop(_guard);

    // 4. 同步落盘完整 RFC822（Offline-First：确保下次点击本地命中）
    //    fetch_body 已随响应带回 rawBytes（一次 IMAP 传输），直接解码写盘；
    //    仅在 rawBytes 缺失或写盘失败时回退到 fetch_raw_and_cache 二次拉取。
    //    用 resolved_uid（自动修复后可能变化）作为落盘 key
    let mut body = body;
    let raw_b64 = body
        .get("rawBytes")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // rawBytes 是完整 RFC822 的 base64，体积大且前端不需要，从响应中移除
    if let Some(obj) = body.as_object_mut() {
        obj.remove("rawBytes");
    }
    let mut cached = false;
    if !raw_b64.is_empty() {
        match base64::engine::general_purpose::STANDARD.decode(&raw_b64) {
            Ok(bytes) => match write_eml_file(&account_id, &mailbox, &resolved_uid, &bytes) {
                Ok(rel) => {
                    match state.conn() {
                        Ok(conn) => {
                            if let Err(e) = conn.execute(
                                "UPDATE messages SET body_fetched = 1, eml_path = ?1
                                 WHERE uid = ?2 AND account_id = ?3 AND folder = ?4",
                                params![rel, &resolved_uid, &account_id, &mailbox],
                            ) {
                                log::warn!(
                                    "[email-fetch-body] 更新 body_fetched 失败 account={} uid={}: {}",
                                    account_id,
                                    resolved_uid,
                                    e
                                );
                            } else {
                                cached = true;
                            }
                        }
                        Err(e) => {
                            log::warn!("[email-fetch-body] 打开数据库失败: {}", e);
                        }
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[email-fetch-body] 落盘 .eml 失败 account={} uid={}: {}",
                        account_id,
                        resolved_uid,
                        e
                    );
                }
            },
            Err(e) => {
                log::warn!(
                    "[email-fetch-body] 解码 rawBytes 失败 account={} uid={}: {}",
                    account_id,
                    resolved_uid,
                    e
                );
            }
        }
    }
    if !cached {
        // 回退路径：rawBytes 缺失/写盘失败时二次拉取落盘（此时 guard 已释放，不会自锁）
        if let Err(e) = fetch_raw_and_cache(
            state.inner(),
            &gateway_url,
            &account_id,
            &resolved_uid,
            &mailbox,
        )
        .await
        {
            log::warn!(
                "[email-fetch-body] 回退落盘 .eml 失败 account={} uid={}: {}",
                account_id,
                resolved_uid,
                e
            );
        }
    }

    // 5. 如果自动修复换了 uid，在响应中返回新 uid，让前端 store 更新本地记录的 uid
    if resolved_uid != uid {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("_resolvedUid".to_string(), serde_json::Value::String(resolved_uid));
        }
    }

    Ok(body)
}

/// 调 gateway /email/fetch_body 拉取正文，含 UID 失效自动修复重试。
///
/// 返回 (body, resolved_uid)：
/// - body: gateway 返回的 JSON（bodyText/bodyHtml/attachments/header）
/// - resolved_uid: 实际使用的 uid（自动修复后可能不同于原始 uid）
async fn fetch_body_via_gateway(
    client: &reqwest::Client,
    url: &str,
    account_id: &str,
    account: &EmailAccount,
    plain_password: &str,
    mailbox: &str,
    original_uid: &str,
    state: &EmailState,
    gateway_url: &str,
) -> Result<(serde_json::Value, String), String> {
    let mut req_uid = original_uid.to_string();
    let mut retried = false;

    loop {
        let req = serde_json::json!({
            "accountId": account_id,
            "imapHost": account.imap_host,
            "imapPort": account.imap_port,
            "imapUsername": account.imap_username,
            "imapPassword": plain_password,
            "mailbox": mailbox,
            "uid": req_uid,
            "useSsl": account.imap_use_ssl,
            // 返回 rawBytes（base64 RFC822），Rust 侧直接落盘，
            // 避免原来 fetch_body + fetch_raw 两次完整 IMAP 下载
            "includeRawBytes": true,
        });
        let resp = client
            .post(url)
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("请求 gateway 失败: {e}"))?;

        if resp.status().is_success() {
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("解析响应失败: {e}"))?;
            return Ok((body, req_uid));
        }

        let text = resp.text().await.unwrap_or_default();

        // 仅在第一次失败且错误是"UID not found"时尝试自动修复
        if !retried && text.contains("UID not found in mailbox") {
            retried = true;
            log::warn!(
                "[email-fetch-body] 检测到 UID 不在文件夹 {} 中（uid={}），触发自动修复",
                mailbox,
                req_uid
            );

            // 拉旧 uid 对应的 message_id（用于同步后查新 uid）
            let message_id: String = match state.conn() {
                Ok(c) => c
                    .query_row(
                        "SELECT message_id FROM messages
                         WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                        params![&req_uid, &account_id, &mailbox],
                        |row| {
                            let mid: String = row.get(0).unwrap_or_default();
                            Ok(mid)
                        },
                    )
                    .unwrap_or_default(),
                Err(_) => String::new(),
            };
            if message_id.is_empty() {
                return Err(format!("gateway 返回错误: {text}"));
            }

            // 同步当前文件夹，让 message_id 去重逻辑用新 uid 替换旧 uid 记录
            let sync_req = SyncRequest {
                account_id: account.id.clone(),
                imap_host: account.imap_host.clone(),
                imap_port: account.imap_port,
                imap_username: account.imap_username.clone(),
                imap_password: plain_password.to_string(),
                mailbox: mailbox.to_string(),
                use_ssl: account.imap_use_ssl,
                last_uid: None,
            };
            let sync_fut = sync_folder_internal(state, gateway_url, sync_req, false);
            if let Err(e) = Box::pin(sync_fut).await {
                log::warn!(
                    "[email-fetch-body] 自动修复：同步文件夹 {} 失败: {}",
                    mailbox,
                    e
                );
                return Err(format!("gateway 返回错误: {text}"));
            }

            // 用 message_id 查询本地新 uid
            let new_uid: String = match state.conn() {
                Ok(c) => c
                    .query_row(
                        "SELECT uid FROM messages
                         WHERE account_id = ?1 AND folder = ?2 AND message_id = ?3
                         ORDER BY uid DESC LIMIT 1",
                        params![&account_id, &mailbox, &message_id],
                        |row| {
                            let u: String = row.get(0).unwrap_or_default();
                            Ok(u)
                        },
                    )
                    .unwrap_or_default(),
                Err(_) => String::new(),
            };
            if new_uid.is_empty() || new_uid == req_uid {
                log::warn!(
                    "[email-fetch-body] 自动修复：同步后未在文件夹 {} 找到 message_id={} 的新 uid 版本",
                    mailbox,
                    message_id
                );
                return Err(format!("gateway 返回错误: {text}"));
            }
            log::info!(
                "[email-fetch-body] 自动修复：uid {} -> {} (message_id={})",
                req_uid,
                new_uid,
                message_id
            );
            req_uid = new_uid;
            continue;
        }
        return Err(format!("gateway 返回错误: {text}"));
    }
}

/// 拉取 RFC822 并落盘 .eml + 更新 eml_path（后台异步调用，不阻塞用户）。
/// 复用 email_fetch_raw 的核心逻辑，但不返回 rawBase64。
async fn fetch_raw_and_cache(
    state: &EmailState,
    gateway_url: &str,
    account_id: &str,
    uid: &str,
    mailbox: &str,
) -> Result<(), String> {
    // 优先检查本地是否已有完整 .eml（body_fetched=1 表示已拉取完整 RFC822）
    // 注意：仅检查 eml_path 非空不够，同步时可能已落盘 HEADER-only 的 .eml
    {
        let conn = state.conn()?;
        let (eml_path, body_fetched): (String, bool) = conn
            .query_row(
                "SELECT eml_path, body_fetched FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
                params![uid, account_id, mailbox],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
            )
            .unwrap_or_default();
        if !eml_path.is_empty() && body_fetched {
            return Ok(());
        }
    }

    // 让出用户请求：如果用户正在主动 fetch_body，等待其完成后再拉取（最多等 30s）
    // 避免后台落盘任务与用户请求抢占账号级 IMAP 锁
    for _ in 0..60 {
        if !state
            .user_fetch_in_progress
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let (account, plain_password) = {
        let conn = state.conn()?;
        let account = get_imap_credentials(&conn, account_id)?;
        let plain = decrypt_password(&account.imap_password)?;
        (account, plain)
    };

    let req = serde_json::json!({
        "accountId": account_id,
        "imapHost": account.imap_host,
        "imapPort": account.imap_port,
        "imapUsername": account.imap_username,
        "imapPassword": plain_password,
        "mailbox": mailbox,
        "uid": uid,
        "useSsl": account.imap_use_ssl,
    });

    let url = format!("{}/email/fetch_raw", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
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
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))?;

    if let Some(raw_b64) = body.get("rawBase64").and_then(|v| v.as_str()) {
        if !raw_b64.is_empty() {
            match base64::engine::general_purpose::STANDARD.decode(raw_b64) {
                Ok(bytes) => match write_eml_file(account_id, mailbox, uid, &bytes) {
                    Ok(rel) => {
                        let conn = state.conn()?;
                        // P1: 完整 RFC822 已落盘成功，原子更新 eml_path 和 body_fetched
                        // 写入或数据库失败时保持 body_fetched=false，下次仍可恢复
                        let _ = conn.execute(
                            "UPDATE messages SET eml_path = ?1, body_fetched = 1
                             WHERE uid = ?2 AND account_id = ?3 AND folder = ?4",
                            params![rel, uid, account_id, mailbox],
                        );
                        // 同步 .meta.json：body_fetched=true（仅在落盘成功后写入）
                        if let Some(mut meta) = read_meta_json(account_id, mailbox, uid) {
                            meta.body_fetched = true;
                            let _ = write_meta_json(&meta);
                        }
                    }
                    Err(e) => log::warn!("[email-fetch-body] 后台落盘 .eml 失败: {}", e),
                },
                Err(e) => log::warn!("[email-fetch-body] 后台 base64 解码失败: {}", e),
            }
        }
    }
    Ok(())
}

/// 拉取邮件原始 RFC822 字节（用于 .eml 导出）
/// Foxmail 风格：优先读本地 .eml 文件，未落盘时调 gateway 拉取并落盘。
#[tauri::command]
pub async fn email_fetch_raw(
    state: tauri::State<'_, EmailState>,
    gateway_url: String,
    account_id: String,
    uid: String,
    mailbox: String,
) -> Result<serde_json::Value, String> {
    if gateway_url.is_empty() {
        return Err("gateway URL 为空".into());
    }

    // 1. 优先读本地 .eml 文件
    let conn = state.conn()?;
    let eml_path: String = conn
        .query_row(
            "SELECT eml_path FROM messages WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
            params![&uid, &account_id, &mailbox],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    drop(conn);

    if !eml_path.is_empty() {
        if let Some(eml_bytes) = read_eml_file(&eml_path) {
            let size = eml_bytes.len();
            let raw_b64 = base64::engine::general_purpose::STANDARD.encode(&eml_bytes);
            return Ok(serde_json::json!({
                "rawBase64": raw_b64,
                "size": size,
            }));
        }
    }

    // 2. 本地无 .eml，调 gateway 拉取 RFC822
    let (account, plain_password) = {
        let conn = state.conn()?;
        let account = get_imap_credentials(&conn, &account_id)?;
        let plain = decrypt_password(&account.imap_password)?;
        (account, plain)
    };

    let req = serde_json::json!({
        "accountId": account_id,
        "imapHost": account.imap_host,
        "imapPort": account.imap_port,
        "imapUsername": account.imap_username,
        "imapPassword": plain_password,
        "mailbox": mailbox,
        "uid": uid,
        "useSsl": account.imap_use_ssl,
    });

    let url = format!("{}/email/fetch_raw", gateway_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
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
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {e}"))?;

    // 3. 落盘 .eml 文件供下次使用
    if let Some(raw_b64) = body.get("rawBase64").and_then(|v| v.as_str()) {
        if !raw_b64.is_empty() {
            match base64::engine::general_purpose::STANDARD.decode(raw_b64) {
                Ok(bytes) => {
                    match write_eml_file(&account_id, &mailbox, &uid, &bytes) {
                        Ok(rel) => {
                            let conn = state.conn()?;
                            let _ = conn.execute(
                                "UPDATE messages SET body_fetched = 1, eml_path = ?1
                                 WHERE uid = ?2 AND account_id = ?3 AND folder = ?4",
                                params![rel, uid, account_id, mailbox],
                            );
                        }
                        Err(e) => log::warn!("[email-fetch-raw] 落盘 .eml 失败: {}", e),
                    }
                }
                Err(e) => log::warn!("[email-fetch-raw] base64 解码失败: {}", e),
            }
        }
    }

    Ok(body)
}

/// 手动触发全量重建邮件索引（从 .eml + .meta.json 重建 SQLite 索引）
/// 用于 SQLite 损坏后的恢复，或用户怀疑索引与文件不一致时的兜底工具。
#[tauri::command]
pub async fn email_rebuild_index(
    state: tauri::State<'_, EmailState>,
) -> Result<serde_json::Value, String> {
    let state_clone = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let count = rebuild_all_indexes(&state_clone)?;
        log::info!("[email-rebuild] 全量重建完成，共 {} 条记录", count);
        Ok(serde_json::json!({ "count": count }))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}
