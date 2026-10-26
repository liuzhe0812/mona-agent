use super::{EmailSearchRequest, EmailSearchResult};
use rusqlite::{params, Connection, OptionalExtension, ToSql};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub(super) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS email_search_fts USING fts5(
            body, tokenize='trigram'
        );
        CREATE TABLE IF NOT EXISTS email_search_index_state (
            message_rowid INTEGER PRIMARY KEY,
            eml_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_mtime_ns INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS email_search_message_delete
        AFTER DELETE ON messages BEGIN
            DELETE FROM email_search_fts WHERE rowid = old.rowid;
            DELETE FROM email_search_index_state WHERE message_rowid = old.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS email_search_eml_invalidate
        AFTER UPDATE OF body_fetched, eml_path ON messages
        WHEN old.body_fetched != new.body_fetched OR old.eml_path != new.eml_path BEGIN
            DELETE FROM email_search_fts WHERE rowid = old.rowid;
            DELETE FROM email_search_index_state WHERE message_rowid = old.rowid;
        END;",
    )
    .map_err(|e| e.to_string())
}

#[derive(Clone)]
struct IndexedFile {
    eml_path: String,
    file_size: i64,
    file_mtime_ns: i64,
}

fn search_root(root: &Path) -> Option<PathBuf> {
    root.canonicalize().ok()
}

fn resolve_eml_path(root: &Path, canonical_root: &Path, relative_path: &str) -> Option<PathBuf> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }

    // Reuse the email module's resolved-path guard, then verify the final target as well.
    let resolved = super::eml_absolute_path_under(root, relative_path)
        .canonicalize()
        .ok()?;
    resolved.starts_with(canonical_root).then_some(resolved)
}

fn file_state(path: &Path) -> Option<(i64, i64)> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let file_size = i64::try_from(metadata.len()).ok()?;
    let file_mtime_ns = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos()
        .min(i64::MAX as u128) as i64;
    Some((file_size, file_mtime_ns))
}

fn clear_index(conn: &mut Connection, rowid: i64) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM email_search_fts WHERE rowid = ?1", [rowid])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM email_search_index_state WHERE message_rowid = ?1",
        [rowid],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn store_index(
    conn: &mut Connection,
    rowid: i64,
    indexed_file: &IndexedFile,
    body: &str,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM email_search_fts WHERE rowid = ?1", [rowid])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO email_search_fts(rowid, body) VALUES (?1, ?2)",
        params![rowid, body],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO email_search_index_state
         (message_rowid, eml_path, file_size, file_mtime_ns)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(message_rowid) DO UPDATE SET
            eml_path = excluded.eml_path,
            file_size = excluded.file_size,
            file_mtime_ns = excluded.file_mtime_ns",
        params![
            rowid,
            indexed_file.eml_path,
            indexed_file.file_size,
            indexed_file.file_mtime_ns
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn extract_search_body(bytes: &[u8], rowid: i64) -> Option<String> {
    let parsed = match mailparse::parse_mail(bytes) {
        Ok(parsed) => parsed,
        Err(error) => {
            log::debug!(
                "[email-search] 跳过无法解析的本地邮件 rowid={}: {}",
                rowid,
                error
            );
            return None;
        }
    };
    let mut plain = String::new();
    let mut html = None;
    super::extract_bodies_inner(&parsed, &mut plain, &mut html);
    if let Some(html) = html {
        if !plain.is_empty() {
            plain.push('\n');
        }
        plain.push_str(&html);
    }
    Some(plain)
}

/// Refresh one body's derived index after its complete `.eml` has been committed.
pub(super) fn refresh_body_index_for_message(
    conn: &mut Connection,
    root: &Path,
    account_id: &str,
    folder: &str,
    uid: &str,
) -> Result<(), String> {
    let record = conn
        .query_row(
            "SELECT rowid, body_fetched, eml_path FROM messages
             WHERE uid = ?1 AND account_id = ?2 AND folder = ?3",
            params![uid, account_id, folder],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i32>(1)? != 0,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((rowid, body_fetched, relative_path)) = record else {
        return Ok(());
    };
    if !body_fetched || relative_path.is_empty() {
        return clear_index(conn, rowid);
    }
    let Some(canonical_root) = search_root(root) else {
        return clear_index(conn, rowid);
    };
    let Some(path) = resolve_eml_path(root, &canonical_root, &relative_path) else {
        return clear_index(conn, rowid);
    };
    let Some((file_size, file_mtime_ns)) = file_state(&path) else {
        return clear_index(conn, rowid);
    };
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return clear_index(conn, rowid),
    };
    let Some(body) = extract_search_body(&bytes, rowid) else {
        return clear_index(conn, rowid);
    };
    store_index(
        conn,
        rowid,
        &IndexedFile {
            eml_path: relative_path,
            file_size,
            file_mtime_ns,
        },
        &body,
    )
}

fn ensure_body_indexed(conn: &mut Connection, root: &Path) -> Result<(), String> {
    let candidates = {
        let mut statement = conn
            .prepare(
                "SELECT rowid, eml_path FROM messages
                 WHERE body_fetched = 1 AND eml_path != ''",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    let candidate_ids: HashSet<i64> = candidates.iter().map(|(rowid, _)| *rowid).collect();

    // Repair an interrupted rebuild where one side of the derived index was lost.
    conn.execute(
        "DELETE FROM email_search_index_state
         WHERE message_rowid NOT IN (SELECT rowid FROM email_search_fts)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM email_search_fts
         WHERE rowid NOT IN (SELECT message_rowid FROM email_search_index_state)",
        [],
    )
    .map_err(|e| e.to_string())?;

    let mut states = {
        let mut statement = conn
            .prepare(
                "SELECT message_rowid, eml_path, file_size, file_mtime_ns
                 FROM email_search_index_state",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    IndexedFile {
                        eml_path: row.get(1)?,
                        file_size: row.get(2)?,
                        file_mtime_ns: row.get(3)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };

    let canonical_root = search_root(root);
    for rowid in states.keys().copied().collect::<Vec<_>>() {
        if !candidate_ids.contains(&rowid) {
            clear_index(conn, rowid)?;
            states.remove(&rowid);
        }
    }

    let Some(canonical_root) = canonical_root else {
        for rowid in states.keys().copied().collect::<Vec<_>>() {
            clear_index(conn, rowid)?;
        }
        return Ok(());
    };

    for (rowid, relative_path) in candidates {
        let Some(abs_path) = resolve_eml_path(root, &canonical_root, &relative_path) else {
            clear_index(conn, rowid)?;
            states.remove(&rowid);
            continue;
        };
        let Some((file_size, file_mtime_ns)) = file_state(&abs_path) else {
            clear_index(conn, rowid)?;
            states.remove(&rowid);
            continue;
        };
        let current = IndexedFile {
            eml_path: relative_path,
            file_size,
            file_mtime_ns,
        };
        if states.get(&rowid).is_some_and(|indexed| {
            indexed.eml_path == current.eml_path
                && indexed.file_size == current.file_size
                && indexed.file_mtime_ns == current.file_mtime_ns
        }) {
            continue;
        }

        let bytes = match fs::read(&abs_path) {
            Ok(bytes) => bytes,
            Err(_) => {
                clear_index(conn, rowid)?;
                states.remove(&rowid);
                continue;
            }
        };
        let Some(body) = extract_search_body(&bytes, rowid) else {
            clear_index(conn, rowid)?;
            states.remove(&rowid);
            continue;
        };
        store_index(conn, rowid, &current, &body)?;
        states.insert(rowid, current);
    }
    Ok(())
}

pub(super) fn parse_timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(value)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(value))
        .ok()
        .map(|date| date.timestamp())
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|date| date.and_utc().timestamp())
        })
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
                .map(|date| date.and_utc().timestamp())
        })
}

pub(super) fn search_messages(
    conn: &mut Connection,
    root: &Path,
    req: &EmailSearchRequest,
) -> Result<Vec<EmailSearchResult>, String> {
    ensure_body_indexed(conn, root)?;

    let mut conditions = Vec::<String>::new();
    let mut params = Vec::<Box<dyn ToSql>>::new();
    if let Some(keyword) = req
        .keyword
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let placeholder = format!("?{}", params.len() + 1);
        let contains_wildcard = keyword.chars().any(|c| matches!(c, '%' | '_' | '\\'));
        let searchable_fields = [
            "m.uid",
            "m.account_id",
            "m.folder",
            "m.subject",
            "m.from_address",
            "coalesce(m.from_name, '')",
            "m.to_addresses",
            "coalesce(m.cc_addresses, '')",
            "coalesce(m.message_id, '')",
            "m.date",
        ];
        let header_matches = searchable_fields
            .iter()
            .map(|field| {
                if contains_wildcard {
                    format!("instr(lower({field}), lower({placeholder})) > 0")
                } else {
                    format!("{field} LIKE {placeholder} COLLATE NOCASE")
                }
            })
            .collect::<Vec<_>>()
            .join(" OR ");
        let body_matches = if contains_wildcard {
            format!("instr(lower(body_fts.body), lower({placeholder})) > 0")
        } else {
            format!("body_fts.body LIKE {placeholder} COLLATE NOCASE")
        };
        conditions.push(format!("({header_matches} OR {body_matches})"));
        let value = if contains_wildcard {
            keyword.to_string()
        } else {
            format!("%{keyword}%")
        };
        params.push(Box::new(value));
    }
    if let Some(value) = &req.account_id {
        conditions.push(format!("m.account_id = ?{}", params.len() + 1));
        params.push(Box::new(value.clone()));
    }
    if let Some(value) = &req.folder {
        conditions.push(format!("m.folder = ?{}", params.len() + 1));
        params.push(Box::new(value.clone()));
    }
    if let Some(value) = &req.from_address {
        conditions.push(format!("m.from_address LIKE ?{}", params.len() + 1));
        params.push(Box::new(format!("%{value}%")));
    }
    if let Some(value) = &req.from_name {
        conditions.push(format!("m.from_name LIKE ?{}", params.len() + 1));
        params.push(Box::new(format!("%{value}%")));
    }
    if let Some(value) = &req.date_from {
        conditions.push(format!("m.date >= ?{}", params.len() + 1));
        params.push(Box::new(value.clone()));
    }
    if let Some(value) = &req.date_to {
        conditions.push(format!("m.date <= ?{}", params.len() + 1));
        params.push(Box::new(value.clone()));
    }
    if let Some(value) = req.is_read {
        conditions.push(format!("m.is_read = ?{}", params.len() + 1));
        params.push(Box::new(if value { 1i32 } else { 0i32 }));
    }
    if let Some(value) = req.is_starred {
        conditions.push(format!("m.is_starred = ?{}", params.len() + 1));
        params.push(Box::new(if value { 1i32 } else { 0i32 }));
    }
    if let Some(value) = req.has_attachments {
        conditions.push(format!("m.has_attachments = ?{}", params.len() + 1));
        params.push(Box::new(if value { 1i32 } else { 0i32 }));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT m.uid, m.account_id, m.folder, m.subject, m.from_address, m.from_name,
                m.to_addresses, m.date, m.has_attachments, m.is_read, m.is_starred, m.raw_size
         FROM messages AS m
         LEFT JOIN email_search_fts AS body_fts ON body_fts.rowid = m.rowid
         {where_clause}"
    );
    let param_refs = params
        .iter()
        .map(|value| value.as_ref())
        .collect::<Vec<_>>();
    let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut messages = statement
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
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    messages.sort_by(|left, right| {
        let left_time = parse_timestamp(&left.date).unwrap_or(i64::MIN);
        let right_time = parse_timestamp(&right.date).unwrap_or(i64::MIN);
        right_time
            .cmp(&left_time)
            .then_with(|| left.account_id.cmp(&right.account_id))
            .then_with(|| left.folder.cmp(&right.folder))
            .then_with(|| left.uid.cmp(&right.uid))
    });
    let start = (req.offset as usize).min(messages.len());
    let end = start
        .saturating_add(req.limit.clamp(1, 200) as usize)
        .min(messages.len());
    Ok(messages.drain(start..end).collect())
}

#[cfg(test)]
mod tests {
    use super::search_messages;
    use crate::email::search::init_schema;
    use crate::email::EmailSearchRequest;
    use rusqlite::{params, Connection};
    use std::path::Path;
    use tempfile::TempDir;

    fn database(temp: &TempDir) -> Connection {
        let conn = Connection::open(temp.path().join("email.sqlite3")).unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (
                uid TEXT NOT NULL,
                account_id TEXT NOT NULL,
                folder TEXT NOT NULL,
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
                eml_path TEXT NOT NULL DEFAULT ''
            );",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn request(keyword: &str, offset: u32, limit: u32) -> EmailSearchRequest {
        EmailSearchRequest {
            account_id: None,
            folder: None,
            keyword: Some(keyword.to_string()),
            from_address: None,
            from_name: None,
            date_from: None,
            date_to: None,
            is_read: None,
            is_starred: None,
            has_attachments: None,
            limit,
            offset,
        }
    }

    fn add_message(
        conn: &Connection,
        root: &Path,
        uid: &str,
        account: &str,
        folder: &str,
        date: &str,
        body_fetched: bool,
        flags: (bool, bool, bool),
        body: &str,
    ) {
        let eml_path = format!("{account}/{folder}/{uid}.eml");
        let abs_path = root.join(&eml_path);
        std::fs::create_dir_all(abs_path.parent().unwrap()).unwrap();
        let eml = format!(
            "From: Sender <sender@example.com>\r\nSubject: Header for {uid}\r\nDate: {date}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{body}"
        );
        std::fs::write(&abs_path, eml.as_bytes()).unwrap();
        conn.execute(
            "INSERT INTO messages
             (uid, account_id, folder, subject, from_address, from_name, to_addresses, cc_addresses,
              date, has_attachments, is_read, is_starred, raw_size, message_id, body_fetched, eml_path)
             VALUES (?1, ?2, ?3, ?4, 'sender@example.com', 'Sender', 'reader@example.com', NULL,
                     ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                uid,
                account,
                folder,
                format!("Header for {uid}"),
                date,
                if flags.2 { 1i32 } else { 0i32 },
                if flags.0 { 1i32 } else { 0i32 },
                if flags.1 { 1i32 } else { 0i32 },
                eml.len() as i64,
                format!("<{uid}@example.com>"),
                if body_fetched { 1i32 } else { 0i32 },
                eml_path,
            ],
        )
        .unwrap();
    }

    fn rfc_date(days: i64) -> String {
        chrono::DateTime::<chrono::Utc>::from_timestamp(days * 86_400, 0)
            .unwrap()
            .to_rfc2822()
    }

    #[test]
    fn indexes_full_bodies_and_pages_by_actual_date_after_fifty() {
        let temp = tempfile::tempdir().unwrap();
        let mut conn = database(&temp);
        for uid in 1..=55 {
            // UID order intentionally differs from the real message date order.
            add_message(
                &conn,
                temp.path(),
                &uid.to_string(),
                "account-a",
                "INBOX",
                &rfc_date(56 - uid),
                true,
                (false, true, true),
                &format!("共同中文词语 EnglishSubstring 第{uid}封邮件"),
            );
        }

        let page = search_messages(&mut conn, temp.path(), &request("中文", 50, 5)).unwrap();
        assert_eq!(page.len(), 5);
        assert_eq!(page[0].uid, "51");
        assert_eq!(page[0].date, rfc_date(5));
        assert_eq!(
            search_messages(&mut conn, temp.path(), &request("lishSub", 0, 10))
                .unwrap()
                .len(),
            10
        );
    }

    #[test]
    fn reindexes_changed_eml_and_ignores_incomplete_messages() {
        let temp = tempfile::tempdir().unwrap();
        let mut conn = database(&temp);
        let date = rfc_date(20_000);
        add_message(
            &conn,
            temp.path(),
            "1",
            "account-a",
            "INBOX",
            &date,
            true,
            (false, true, false),
            "旧正文搜索词",
        );
        add_message(
            &conn,
            temp.path(),
            "2",
            "account-a",
            "INBOX",
            &date,
            false,
            (false, false, false),
            "未缓存正文搜索词",
        );

        assert_eq!(
            search_messages(&mut conn, temp.path(), &request("旧正文", 0, 10))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            search_messages(&mut conn, temp.path(), &request("未缓存", 0, 10))
                .unwrap()
                .len(),
            0
        );

        std::fs::write(
            temp.path().join("account-a/INBOX/1.eml"),
            format!("From: sender@example.com\r\nSubject: Header\r\nDate: {date}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n替换后的新内容"),
        )
        .unwrap();
        assert_eq!(
            search_messages(&mut conn, temp.path(), &request("旧正文", 0, 10))
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            search_messages(&mut conn, temp.path(), &request("新内容", 0, 10))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn filters_apply_across_account_folder_and_message_flags() {
        let temp = tempfile::tempdir().unwrap();
        let mut conn = database(&temp);
        let date = rfc_date(20_000);
        add_message(
            &conn,
            temp.path(),
            "1",
            "account-a",
            "INBOX",
            &date,
            true,
            (false, true, true),
            "筛选词正文",
        );
        add_message(
            &conn,
            temp.path(),
            "2",
            "account-b",
            "INBOX",
            &date,
            true,
            (false, true, true),
            "筛选词正文",
        );
        add_message(
            &conn,
            temp.path(),
            "3",
            "account-a",
            "Archive",
            &date,
            true,
            (false, true, true),
            "筛选词正文",
        );
        add_message(
            &conn,
            temp.path(),
            "4",
            "account-a",
            "INBOX",
            &date,
            true,
            (true, false, false),
            "筛选词正文",
        );

        let mut req = request("筛选", 0, 10);
        req.account_id = Some("account-a".into());
        req.folder = Some("INBOX".into());
        req.is_read = Some(false);
        req.is_starred = Some(true);
        req.has_attachments = Some(true);
        let found = search_messages(&mut conn, temp.path(), &req).unwrap();
        assert_eq!(
            found
                .iter()
                .map(|message| message.uid.as_str())
                .collect::<Vec<_>>(),
            ["1"]
        );
    }

    #[test]
    fn deleting_message_removes_its_derived_search_entry() {
        let temp = tempfile::tempdir().unwrap();
        let mut conn = database(&temp);
        add_message(
            &conn,
            temp.path(),
            "1",
            "account-a",
            "INBOX",
            &rfc_date(20_000),
            true,
            (false, false, false),
            "待删除的本地正文",
        );
        assert_eq!(
            search_messages(&mut conn, temp.path(), &request("待删除", 0, 10))
                .unwrap()
                .len(),
            1
        );
        conn.execute("DELETE FROM messages WHERE uid = '1'", [])
            .unwrap();
        assert_eq!(
            search_messages(&mut conn, temp.path(), &request("待删除", 0, 10))
                .unwrap()
                .len(),
            0
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM email_search_index_state", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
