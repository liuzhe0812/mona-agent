use super::EmailAccount;
use rusqlite::{params, Connection};

pub(super) fn require_active(conn: &Connection, account_id: &str) -> Result<(), String> {
    let active: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM accounts WHERE id=?1)",
        [account_id], |row| row.get(0)).map_err(|e| e.to_string())?;
    if active { Ok(()) } else { Err("邮箱配置已更新，请刷新后重试。".into()) }
}

pub(super) fn save(conn: &mut Connection, mut account: EmailAccount, encrypted_password: Option<String>) -> Result<EmailAccount, String> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let old_id = account.id.clone();
    let (old_host, old_user, imap_password, smtp_password): (String, String, String, String) = tx.query_row(
        "SELECT imap_host,imap_username,imap_password,smtp_password FROM accounts WHERE id=?1",
        [&old_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).map_err(|_| "邮箱配置已更新，请刷新后重试。".to_string())?;
    let changed = !old_host.trim().eq_ignore_ascii_case(account.imap_host.trim())
        || old_user.trim() != account.imap_username.trim();
    if changed {
        let pending_send: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM email_outbox WHERE account_id=?1 AND status IN ('pending','unknown'))",
            [&old_id], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        if pending_send { return Err("此邮箱还有待发送或结果待核对的定时邮件，请先处理后再更换邮箱。".into()); }
        // 邮件缓存和 UID 属于原邮箱，不能因设置槽位相同就交给另一个邮箱使用。
        account.id = uuid::Uuid::new_v4().to_string();
        account.last_synced_uid = None;
        tx.execute("DELETE FROM email_pending_flags WHERE account_id=?1", [&old_id]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE email_rules SET account_id=?1 WHERE account_id=?2", params![account.id, old_id]).map_err(|e| e.to_string())?;
    }
    account.imap_password = encrypted_password.clone().unwrap_or(imap_password);
    account.smtp_password = encrypted_password.unwrap_or(smtp_password);
    tx.execute(
        "UPDATE accounts SET id=?20,
            display_name=?2,imap_host=?3,imap_port=?4,imap_username=?5,imap_password=?6,
            smtp_host=?7,smtp_port=?8,smtp_username=?9,smtp_password=?10,from_address=?11,from_name=?12,
            last_synced_uid=?13,carddav_url=?14,eas_url=?15,imap_use_ssl=?16,smtp_use_ssl=?17,
            signatures=?18,offline_sync_days=?19 WHERE id=?1",
        params![old_id, account.display_name, account.imap_host, account.imap_port, account.imap_username,
            account.imap_password, account.smtp_host, account.smtp_port, account.smtp_username, account.smtp_password,
            account.from_address, account.from_name, account.last_synced_uid, account.carddav_url, account.eas_url,
            account.imap_use_ssl, account.smtp_use_ssl, serde_json::to_string(&account.signatures).map_err(|e| e.to_string())?,
            account.offline_sync_days, account.id],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (Connection, EmailAccount) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE accounts(id TEXT PRIMARY KEY,display_name TEXT,imap_host TEXT,imap_port INTEGER,imap_username TEXT,imap_password TEXT,
            smtp_host TEXT,smtp_port INTEGER,smtp_username TEXT,smtp_password TEXT,from_address TEXT,from_name TEXT,last_synced_uid TEXT,
            carddav_url TEXT,eas_url TEXT,imap_use_ssl INTEGER,smtp_use_ssl INTEGER,signatures TEXT,offline_sync_days INTEGER);
            CREATE TABLE email_pending_flags(account_id TEXT,folder TEXT,uid TEXT,flag TEXT);
            CREATE TABLE email_outbox(account_id TEXT,status TEXT);
            CREATE TABLE email_rules(account_id TEXT);
            CREATE TABLE messages(account_id TEXT,uid TEXT,body TEXT);
            INSERT INTO accounts(id,imap_host,imap_username,imap_password,smtp_password) VALUES('old','imap.example.invalid','reader','encoded-imap','encoded-smtp');
            INSERT INTO email_pending_flags VALUES('old','Junk','42','\\Seen');
            INSERT INTO email_rules VALUES('old');
            INSERT INTO messages VALUES('old','42','cached original');").unwrap();
        let account: EmailAccount = serde_json::from_value(json!({
            "id":"old", "displayName":"Mailbox", "imapHost":"imap.example.invalid", "imapPort":993,
            "imapUsername":"reader", "imapPassword":"", "smtpHost":"smtp.example.invalid", "smtpPort":465,
            "smtpUsername":"reader", "smtpPassword":"", "fromAddress":"reader@example.invalid", "lastSyncedUid":"42",
        })).unwrap();
        (conn, account)
    }

    #[test]
    fn changing_mailbox_isolates_identical_uids_and_finishes_old_flags() {
        for change_user in [false, true] {
            let (mut conn, mut account) = fixture();
            if change_user { account.imap_username = "another-reader".into(); }
            else { account.imap_host = "another-imap.example.invalid".into(); }
            let saved = save(&mut conn, account, None).unwrap();
            assert_ne!(saved.id, "old");
            assert_eq!(saved.last_synced_uid, None);
            assert_eq!(saved.imap_password, "encoded-imap");
            assert_eq!(saved.smtp_password, "encoded-smtp");
            assert!(require_active(&conn, "old").is_err());
            require_active(&conn, &saved.id).unwrap();
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM email_pending_flags", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
            assert_eq!(conn.query_row("SELECT account_id FROM email_rules", [], |r| r.get::<_, String>(0)).unwrap(), saved.id);
            conn.execute("INSERT INTO messages VALUES(?1,'42','new original')", [&saved.id]).unwrap();
            let body: String = conn.query_row("SELECT body FROM messages WHERE account_id=?1 AND uid='42'", [&saved.id], |r| r.get(0)).unwrap();
            assert_eq!(body, "new original");
            assert_eq!(conn.query_row("SELECT body FROM messages WHERE account_id='old'", [], |r| r.get::<_, String>(0)).unwrap(), "cached original");
        }
    }

    #[test]
    fn ordinary_settings_and_password_updates_preserve_mailbox_and_flags() {
        let (mut conn, mut account) = fixture();
        account.imap_host = " IMAP.EXAMPLE.INVALID ".into();
        account.imap_port = 143;
        account.imap_use_ssl = false;
        account.display_name = "Renamed".into();
        let saved = save(&mut conn, account, Some("new-encoded".into())).unwrap();
        assert_eq!(saved.id, "old");
        assert_eq!(saved.imap_password, "new-encoded");
        assert_eq!(saved.smtp_password, "new-encoded");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM email_pending_flags", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn pending_or_unknown_send_prevents_rebinding_its_mailbox() {
        for status in ["pending", "unknown"] {
            let (mut conn, mut account) = fixture();
            conn.execute("INSERT INTO email_outbox VALUES('old',?1)", [status]).unwrap();
            account.imap_username = "another-reader".into();
            assert!(save(&mut conn, account, None).is_err());
            require_active(&conn, "old").unwrap();
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM email_pending_flags", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        }
    }
}
