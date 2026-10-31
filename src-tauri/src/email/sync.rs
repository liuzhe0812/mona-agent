use super::{decrypt_password, get_imap_credentials, read_meta_json, read_meta_json_under, write_meta_json, write_meta_json_under, EmailState, EmlMeta, SetFlagRequest};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

type LockKey = (PathBuf, String, String, String);
type MailLocks = Mutex<HashMap<LockKey, Weak<tokio::sync::Mutex<()>>>>;
static MAIL_LOCKS: OnceLock<MailLocks> = OnceLock::new();
static FLAG_FLUSH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(super) async fn lock_flag_flush() -> tokio::sync::MutexGuard<'static, ()> {
    FLAG_FLUSH.lock().await
}

pub(super) fn mail_lock(state: &EmailState, account: &str, folder: &str, operation: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    let mut locks = MAIL_LOCKS.get_or_init(|| Mutex::new(HashMap::new())).lock().map_err(|e| e.to_string())?;
    if locks.len() > 1024 { locks.retain(|_, value| value.strong_count() > 0); }
    let key = (state.db_path().to_path_buf(), account.into(), folder.into(), operation.into());
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) { return Ok(lock); }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

pub(super) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS email_pending_flags (
        account_id TEXT NOT NULL, folder TEXT NOT NULL, uid TEXT NOT NULL, flag TEXT NOT NULL,
        add_value INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, last_error TEXT,
        uid_validity TEXT NOT NULL DEFAULT '', PRIMARY KEY(account_id, folder, uid, flag));").map_err(|e| e.to_string())?;
    let has_version: bool = conn.query_row("SELECT COUNT(*)>0 FROM pragma_table_info('email_pending_flags') WHERE name='uid_validity'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !has_version { conn.execute("ALTER TABLE email_pending_flags ADD COLUMN uid_validity TEXT NOT NULL DEFAULT ''", []).map_err(|e| e.to_string())?; }
    Ok(())
}

pub(super) fn queue_flag(state: &EmailState, req: &SetFlagRequest) -> Result<(), String> {
    let column = match req.flag.as_str() {
        "\\Seen" => "is_read", "\\Flagged" => "is_starred", _ => return Err("不支持的邮件标志".into()),
    };
    let mut conn = state.conn()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let updated = tx.execute(&format!("UPDATE messages SET {column} = ?1 WHERE account_id = ?2 AND folder = ?3 AND uid = ?4"),
        params![req.add, req.account_id, req.mailbox, req.uid]).map_err(|e| e.to_string())?;
    if updated == 0 { return Err("这封邮件已不存在，请刷新列表。".into()); }
    let uid_validity = tx.query_row("SELECT COALESCE(uid_validity,'') FROM folders WHERE account_id=?1 AND name=?2", params![req.account_id, req.mailbox], |r| r.get::<_, String>(0)).optional().map_err(|e| e.to_string())?.unwrap_or_default();
    tx.execute("INSERT INTO email_pending_flags(account_id, folder, uid, flag, add_value, uid_validity) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(account_id, folder, uid, flag) DO UPDATE SET add_value = excluded.add_value,
        revision = email_pending_flags.revision + 1, uid_validity = excluded.uid_validity, last_error = NULL",
        params![req.account_id, req.mailbox, req.uid, req.flag, req.add, uid_validity]).map_err(|e| e.to_string())?;
    let original_meta = read_meta_json(&req.account_id, &req.mailbox, &req.uid);
    if let Some(mut meta) = original_meta.clone() {
        if req.flag == "\\Seen" { meta.is_read = req.add; } else { meta.is_starred = req.add; }
        write_meta_json(&meta)?;
    }
    if let Err(error) = tx.commit() {
        if let Some(meta) = original_meta { write_meta_json(&meta)?; }
        return Err(error.to_string());
    }
    Ok(())
}

pub(super) fn pending_keys(state: &EmailState, account: &str, folder: &str) -> Result<HashSet<(String, String)>, String> {
    let conn = state.conn()?;
    let mut stmt = conn.prepare("SELECT uid, flag FROM email_pending_flags WHERE account_id = ?1 AND folder = ?2 AND COALESCE(last_error,'') != 'stale'").map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![account, folder], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| e.to_string())?;
    rows.collect::<Result<HashSet<_>, _>>().map_err(|e| e.to_string())
}

pub(super) fn seen_revisions(state: &EmailState, account: &str, folder: &str) -> Result<Vec<(String, i64)>, String> {
    let conn = state.conn()?;
    let mut stmt = conn.prepare("SELECT uid, revision FROM email_pending_flags WHERE account_id=?1 AND folder=?2 AND flag='\\Seen' AND COALESCE(last_error,'')!='stale'").map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![account, folder], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub(super) fn complete_mark_all_read(
    state: &EmailState,
    root: &Path,
    account: &str,
    folder: &str,
    previous: &[(String, i64)],
) -> Result<(), String> {
    let mut conn = state.conn()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    // 批量操作覆盖此前的未读意图，之后新产生的单封修改仍然优先。
    for (uid, revision) in previous {
        tx.execute("DELETE FROM email_pending_flags WHERE account_id=?1 AND folder=?2 AND uid=?3 AND flag='\\Seen' AND revision=?4",
            params![account, folder, uid, revision]).map_err(|e| e.to_string())?;
    }
    tx.execute("UPDATE messages SET is_read=1 WHERE account_id=?1 AND folder=?2 AND is_read=0
        AND NOT EXISTS(SELECT 1 FROM email_pending_flags p WHERE p.account_id=messages.account_id AND p.folder=messages.folder AND p.uid=messages.uid AND p.flag='\\Seen' AND COALESCE(p.last_error,'')!='stale')",
        params![account, folder]).map_err(|e| e.to_string())?;
    let records = {
        let mut stmt = tx.prepare("SELECT uid,is_read,is_starred,has_attachments,body_fetched,COALESCE(message_id,''),received_at FROM messages WHERE account_id=?1 AND folder=?2").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![account, folder], |row| Ok(EmlMeta {
            uid: row.get(0)?, account_id: account.into(), folder: folder.into(),
            is_read: row.get(1)?, is_starred: row.get(2)?, has_attachments: row.get(3)?,
            body_fetched: row.get(4)?, message_id: row.get(5)?, eml_mtime: 0,
            received_at: row.get(6)?,
        })).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    for record in records {
        let mut meta = match read_meta_json_under(root, account, folder, &record.uid) {
            Some(meta) if meta.is_read == record.is_read => continue,
            Some(meta) => meta,
            None => record.clone(),
        };
        meta.is_read = record.is_read;
        write_meta_json_under(root, &meta)?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn apply_flags(state: &EmailState, account: &str, folder: &str, flags: &[Value], protected: &HashSet<(String, String)>) -> Result<(), String> {
    let mut pending = pending_keys(state, account, folder)?;
    pending.extend(protected.iter().cloned());
    let mut conn = state.conn()?;
    for flag in flags {
        let Some(uid) = flag["uid"].as_str() else { continue; };
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        let current: Option<(bool, bool)> = tx.query_row("SELECT is_read, is_starred FROM messages WHERE account_id=?1 AND folder=?2 AND uid=?3",
            params![account, folder, uid], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|e| e.to_string())?;
        let Some((old_read, old_star)) = current else { continue; };
        let read = if pending.contains(&(uid.into(), "\\Seen".into())) { old_read } else { flag["isRead"].as_bool().unwrap_or(old_read) };
        let star = if pending.contains(&(uid.into(), "\\Flagged".into())) { old_star } else { flag["isStarred"].as_bool().unwrap_or(old_star) };
        if read == old_read && star == old_star { continue; }
        tx.execute("UPDATE messages SET
            is_read=CASE WHEN EXISTS(SELECT 1 FROM email_pending_flags p WHERE p.account_id=messages.account_id AND p.folder=messages.folder AND p.uid=messages.uid AND p.flag='\\Seen' AND COALESCE(p.last_error,'')!='stale') THEN is_read ELSE ?1 END,
            is_starred=CASE WHEN EXISTS(SELECT 1 FROM email_pending_flags p WHERE p.account_id=messages.account_id AND p.folder=messages.folder AND p.uid=messages.uid AND p.flag='\\Flagged' AND COALESCE(p.last_error,'')!='stale') THEN is_starred ELSE ?2 END
            WHERE account_id=?3 AND folder=?4 AND uid=?5",
            params![read, star, account, folder, uid]).map_err(|e| e.to_string())?;
        let (read, star): (bool, bool) = tx.query_row("SELECT is_read, is_starred FROM messages WHERE account_id=?1 AND folder=?2 AND uid=?3",
            params![account, folder, uid], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
        if let Some(mut meta) = read_meta_json(account, folder, uid) {
            if meta.is_read != read || meta.is_starred != star {
                meta.is_read = read; meta.is_starred = star;
                write_meta_json(&meta)?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) async fn flush_flags(state: &EmailState, service_url: &str) -> Result<bool, String> {
    if service_url.is_empty() { return Ok(false); }
    let Ok(_guard) = FLAG_FLUSH.try_lock() else { return Ok(false); };
    let changes: Vec<(String, String, String, String, bool, i64, Option<String>, String)> = {
        let conn = state.conn()?;
        let mut stmt = conn.prepare("SELECT account_id, folder, uid, flag, add_value, revision, last_error, uid_validity FROM email_pending_flags p WHERE COALESCE(last_error,'') != 'stale' AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=p.account_id) ORDER BY account_id, folder, uid").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };
    let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let mut failed_accounts = HashSet::new();
    let mut needs_attention = false;
    for (account_id, folder, uid, flag, add, revision, previous_error, uid_validity) in changes {
        if failed_accounts.contains(&account_id) { continue; }
        let request = (|| -> Result<Value, String> {
            let conn = state.conn()?;
            let account = get_imap_credentials(&conn, &account_id)?;
            Ok(json!({"accountId":account_id, "imapHost":account.imap_host, "imapPort":account.imap_port,
                "imapUsername":account.imap_username, "imapPassword":decrypt_password(&account.imap_password)?,
                "useSsl":account.imap_use_ssl, "mailbox":folder, "uid":uid, "flag":flag, "add":add, "uidValidity":uid_validity}))
        })();
        let error = match request {
            Ok(request) => match client.post(format!("{}/email/set_flag", service_url.trim_end_matches('/'))).json(&request).send().await {
                Ok(response) if response.status().is_success() => None,
                Ok(response) => {
                    let payload: Value = response.json().await.unwrap_or_default();
                    Some(if payload["uidValidityChanged"] == true { "stale" } else { "server" })
                }
                Err(_) => Some("network"),
            },
            Err(_) => {
                log::warn!("[email] pending flags credentials unavailable for account={}", account_id);
                Some("credentials")
            }
        };
        let conn = state.conn()?;
        if let Some(kind) = error {
            conn.execute("UPDATE email_pending_flags SET last_error=?1 WHERE account_id=?2 AND folder=?3 AND uid=?4 AND flag=?5 AND revision=?6",
                params![kind, account_id, folder, uid, flag, revision]).map_err(|e| e.to_string())?;
            needs_attention |= kind != "network" && previous_error.as_deref() != Some(kind);
            failed_accounts.insert(account_id);
        } else {
            conn.execute("DELETE FROM email_pending_flags WHERE account_id=?1 AND folder=?2 AND uid=?3 AND flag=?4 AND revision=?5",
                params![account_id, folder, uid, flag, revision]).map_err(|e| e.to_string())?;
        }
    }
    Ok(needs_attention)
}

#[cfg(test)]
mod tests {
    use super::{apply_flags, complete_mark_all_read, init_schema, pending_keys, queue_flag, seen_revisions};
    use crate::email::{read_meta_json_under, write_meta_json_under, EmlMeta, EmailState, SetFlagRequest};
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::sync::{
        atomic::AtomicBool,
        Arc,
    };
    use tempfile::TempDir;

    const FOLDER: &str = "INBOX";

    fn isolated_state(temp: &TempDir) -> (EmailState, String) {
        let state = EmailState {
            db_path: temp.path().join("email.sqlite3"),
            schema_initialized: Arc::new(AtomicBool::new(false)),
            user_fetch_in_progress: Arc::new(AtomicBool::new(false)),
        };
        let account = format!(
            "__mona_test_email_sync_{}",
            temp.path().file_name().unwrap().to_string_lossy()
        );
        let conn = state.conn().unwrap();
        init_schema(&conn).unwrap();
        (state, account)
    }

    fn insert_message(
        conn: &Connection,
        account: &str,
        uid: &str,
        is_read: bool,
        is_starred: bool,
    ) {
        conn.execute(
            "INSERT INTO messages
             (uid, account_id, folder, subject, from_address, to_addresses, date, is_read, is_starred)
             VALUES (?1, ?2, ?3, 'test', 'sender@example.invalid', '',
                     '2026-10-26T00:00:00Z', ?4, ?5)",
            params![uid, account, FOLDER, is_read, is_starred],
        )
        .unwrap();
    }

    fn request(account: &str, uid: &str, flag: &str, add: bool) -> SetFlagRequest {
        SetFlagRequest {
            account_id: account.into(),
            imap_host: String::new(),
            imap_port: 993,
            imap_username: String::new(),
            imap_password: String::new(),
            mailbox: FOLDER.into(),
            uid: uid.into(),
            flag: flag.into(),
            add,
            use_ssl: true,
        }
    }

    fn message_flags(state: &EmailState, account: &str, uid: &str) -> (bool, bool) {
        state
            .conn()
            .unwrap()
            .query_row(
                "SELECT is_read, is_starred FROM messages
                 WHERE account_id=?1 AND folder=?2 AND uid=?3",
                params![account, FOLDER, uid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    #[test]
    fn queue_flag_persists_local_value_and_increments_revision_on_reversal() {
        let temp = tempfile::tempdir().unwrap();
        let (state, account) = isolated_state(&temp);
        insert_message(&state.conn().unwrap(), &account, "42", false, false);

        queue_flag(&state, &request(&account, "42", "\\Seen", true)).unwrap();
        assert_eq!(message_flags(&state, &account, "42"), (true, false));
        let pending: (bool, i64) = state
            .conn()
            .unwrap()
            .query_row(
                "SELECT add_value, revision FROM email_pending_flags
                 WHERE account_id=?1 AND folder=?2 AND uid='42' AND flag='\\Seen'",
                params![account, FOLDER],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(pending, (true, 1));

        queue_flag(&state, &request(&account, "42", "\\Seen", false)).unwrap();
        assert_eq!(message_flags(&state, &account, "42"), (false, false));
        let pending: (bool, i64) = state
            .conn()
            .unwrap()
            .query_row(
                "SELECT add_value, revision FROM email_pending_flags
                 WHERE account_id=?1 AND folder=?2 AND uid='42' AND flag='\\Seen'",
                params![account, FOLDER],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(pending, (false, 2));
    }

    #[test]
    fn remote_false_clears_local_true_without_pending_intent() {
        let temp = tempfile::tempdir().unwrap();
        let (state, account) = isolated_state(&temp);
        insert_message(&state.conn().unwrap(), &account, "42", true, false);

        apply_flags(
            &state,
            &account,
            FOLDER,
            &[json!({"uid":"42", "isRead":false, "isStarred":true})],
            &Default::default(),
        )
        .unwrap();

        assert_eq!(message_flags(&state, &account, "42"), (false, true));
        assert!(pending_keys(&state, &account, FOLDER).unwrap().is_empty());
    }

    #[test]
    fn pending_and_captured_intent_survive_an_older_remote_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let (state, account) = isolated_state(&temp);
        let conn = state.conn().unwrap();
        insert_message(&conn, &account, "pending", false, false);
        insert_message(&conn, &account, "captured", false, false);
        drop(conn);

        queue_flag(
            &state,
            &request(&account, "pending", "\\Seen", true),
        )
        .unwrap();
        queue_flag(
            &state,
            &request(&account, "captured", "\\Seen", true),
        )
        .unwrap();
        let protected = pending_keys(&state, &account, FOLDER).unwrap();

        state
            .conn()
            .unwrap()
            .execute(
                "DELETE FROM email_pending_flags
                 WHERE account_id=?1 AND folder=?2 AND uid='captured' AND flag='\\Seen'",
                params![account, FOLDER],
            )
            .unwrap();

        apply_flags(
            &state,
            &account,
            FOLDER,
            &[
                json!({"uid":"pending", "isRead":false, "isStarred":false}),
                json!({"uid":"captured", "isRead":false, "isStarred":false}),
            ],
            &protected,
        )
        .unwrap();

        assert_eq!(message_flags(&state, &account, "pending"), (true, false));
        assert_eq!(message_flags(&state, &account, "captured"), (true, false));
        assert_eq!(pending_keys(&state, &account, FOLDER).unwrap().len(), 1);
    }

    #[test]
    fn stale_intent_cannot_protect_a_reused_uid_from_server_flags() {
        let temp = tempfile::tempdir().unwrap();
        let (state, account) = isolated_state(&temp);
        insert_message(&state.conn().unwrap(), &account, "42", false, false);
        queue_flag(&state, &request(&account, "42", "\\Seen", true)).unwrap();
        state.conn().unwrap().execute(
            "UPDATE email_pending_flags SET last_error='stale' WHERE account_id=?1",
            params![account],
        ).unwrap();

        apply_flags(&state, &account, FOLDER, &[json!({"uid":"42", "isRead":false, "isStarred":false})], &Default::default()).unwrap();

        assert_eq!(message_flags(&state, &account, "42"), (false, false));
        assert!(pending_keys(&state, &account, FOLDER).unwrap().is_empty());
    }

    #[test]
    fn mark_all_read_persists_before_restart_and_supersedes_old_unread_intent() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("mail");
        let (state, account) = isolated_state(&temp);
        let conn = state.conn().unwrap();
        insert_message(&conn, &account, "42", false, true);
        insert_message(&conn, &account, "43", false, false);
        insert_message(&conn, &account, "99", false, false);
        conn.execute("UPDATE messages SET folder='Sent' WHERE account_id=?1 AND uid='99'", params![account]).unwrap();
        insert_message(&conn, "other-account", "42", false, false);
        drop(conn);
        queue_flag(&state, &request(&account, "42", "\\Seen", false)).unwrap();
        queue_flag(&state, &request(&account, "42", "\\Flagged", true)).unwrap();
        write_meta_json_under(&root, &EmlMeta {
            uid: "42".into(), account_id: account.clone(), folder: FOLDER.into(),
            is_read: false, is_starred: true, has_attachments: false, body_fetched: false,
            message_id: String::new(), eml_mtime: 123,
            received_at: None,
        }).unwrap();
        let previous = seen_revisions(&state, &account, FOLDER).unwrap();

        complete_mark_all_read(&state, &root, &account, FOLDER, &previous).unwrap();
        let (reopened, _) = isolated_state(&temp);
        assert_eq!(message_flags(&reopened, &account, "42"), (true, true));
        assert_eq!(message_flags(&reopened, &account, "43"), (true, false));
        assert_eq!(message_flags(&reopened, "other-account", "42"), (false, false));
        assert!(!reopened.conn().unwrap().query_row("SELECT is_read FROM messages WHERE account_id=?1 AND folder='Sent' AND uid='99'", params![account], |row| row.get::<_, bool>(0)).unwrap());
        let pending = pending_keys(&reopened, &account, FOLDER).unwrap();
        assert!(!pending.contains(&("42".into(), "\\Seen".into())));
        assert!(pending.contains(&("42".into(), "\\Flagged".into())));
        let meta = read_meta_json_under(&root, &account, FOLDER, "42").unwrap();
        assert!(meta.is_read && meta.is_starred);
        assert_eq!(meta.eml_mtime, 123);
        assert!(read_meta_json_under(&root, &account, FOLDER, "43").unwrap().is_read);
    }

    #[test]
    fn mark_all_read_preserves_newer_explicit_unread_changes() {
        let temp = tempfile::tempdir().unwrap();
        let (state, account) = isolated_state(&temp);
        insert_message(&state.conn().unwrap(), &account, "42", false, false);
        insert_message(&state.conn().unwrap(), &account, "43", true, false);
        queue_flag(&state, &request(&account, "42", "\\Seen", false)).unwrap();
        let previous = seen_revisions(&state, &account, FOLDER).unwrap();
        queue_flag(&state, &request(&account, "42", "\\Seen", false)).unwrap();
        queue_flag(&state, &request(&account, "43", "\\Seen", false)).unwrap();

        complete_mark_all_read(&state, temp.path(), &account, FOLDER, &previous).unwrap();
        assert_eq!(message_flags(&state, &account, "42"), (false, false));
        assert_eq!(message_flags(&state, &account, "43"), (false, false));
        assert_eq!(pending_keys(&state, &account, FOLDER).unwrap().len(), 2);
        assert!(!read_meta_json_under(temp.path(), &account, FOLDER, "42").unwrap().is_read);
    }

    #[test]
    fn mark_all_read_reports_disk_failure_without_acknowledging_local_state() {
        let temp = tempfile::tempdir().unwrap();
        let (state, account) = isolated_state(&temp);
        insert_message(&state.conn().unwrap(), &account, "42", false, false);
        queue_flag(&state, &request(&account, "42", "\\Seen", false)).unwrap();
        let previous = seen_revisions(&state, &account, FOLDER).unwrap();
        let blocked_root = temp.path().join("not-a-directory");
        std::fs::write(&blocked_root, b"blocked").unwrap();

        assert!(complete_mark_all_read(&state, &blocked_root, &account, FOLDER, &previous).is_err());
        assert_eq!(message_flags(&state, &account, "42"), (false, false));
        assert!(pending_keys(&state, &account, FOLDER).unwrap().contains(&("42".into(), "\\Seen".into())));
    }

    #[test]
    fn missing_message_does_not_create_pending_flag() {
        let temp = tempfile::tempdir().unwrap();
        let (state, account) = isolated_state(&temp);

        assert!(queue_flag(&state, &request(&account, "missing", "\\Seen", true)).is_err());
        assert!(pending_keys(&state, &account, FOLDER).unwrap().is_empty());
    }
}
