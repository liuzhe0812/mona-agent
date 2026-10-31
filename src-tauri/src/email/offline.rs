use rusqlite::{params, Connection, Transaction, TransactionBehavior};

pub(super) const DEFAULT_DAYS: u16 = 90;

pub(super) fn validate_days(days: u16) -> Result<(), String> {
    if matches!(days, 0 | 90 | 365) {
        Ok(())
    } else {
        Err("请选择近三个月、近一年或全部历史邮件。".into())
    }
}

pub(super) fn read_days(conn: &Connection, account_id: &str) -> Result<u16, String> {
    let days = conn
        .query_row(
            "SELECT offline_sync_days FROM accounts WHERE id = ?1",
            [account_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("读取邮箱离线范围失败: {e}"))?;
    validate_days(days)?;
    Ok(days)
}

pub(super) fn init_schema(conn: &Connection) -> Result<(), String> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let has_policy: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('accounts') WHERE name='offline_sync_days')",
        [], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if !has_policy {
        tx.execute(
            "ALTER TABLE accounts ADD COLUMN offline_sync_days INTEGER NOT NULL DEFAULT 90
                    CHECK (offline_sync_days IN (0, 90, 365))",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    let has_received: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('messages') WHERE name='received_at')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !has_received {
        tx.execute("ALTER TABLE messages ADD COLUMN received_at INTEGER", [])
            .map_err(|e| e.to_string())?;
        // Existing caches have no IMAP INTERNALDATE; use their original Date once as a fallback.
        let rows = {
            let mut stmt = tx
                .prepare("SELECT rowid, date FROM messages")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        for (rowid, date) in rows {
            if let Some(timestamp) = super::search::parse_timestamp(&date) {
                tx.execute(
                    "UPDATE messages SET received_at=?1 WHERE rowid=?2",
                    params![timestamp, rowid],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

pub(super) struct PrefetchPlan {
    pub days: u16,
    pub cutoff: Option<i64>,
    pub max_uid: i64,
    pub uids: Vec<String>,
}

impl PrefetchPlan {
    pub fn load(
        conn: &Connection,
        account_id: &str,
        folder: &str,
        now: i64,
    ) -> Result<Self, String> {
        let days = read_days(conn, account_id)?;
        let cutoff = (days != 0).then(|| now - i64::from(days) * 86_400);
        let max_uid = conn
            .query_row(
                "SELECT COALESCE(MAX(uid_int), 0) FROM messages WHERE account_id=?1 AND folder=?2",
                params![account_id, folder],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT uid FROM messages
             WHERE account_id=?1 AND folder=?2 AND body_fetched=0 AND uid_int>0
               AND (?3 IS NULL OR received_at>=?3)
             ORDER BY uid_int DESC",
            )
            .map_err(|e| e.to_string())?;
        let uids = stmt
            .query_map(params![account_id, folder, cutoff], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            days,
            cutoff,
            max_uid,
            uids,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{init_schema, read_days, validate_days, PrefetchPlan};
    use rusqlite::{params, Connection};

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE accounts(id TEXT PRIMARY KEY);
             INSERT INTO accounts VALUES ('account');
             CREATE TABLE messages(uid TEXT, uid_int INTEGER, account_id TEXT, folder TEXT,
                                   date TEXT, body_fetched INTEGER);
             INSERT INTO messages VALUES('1',1,'account','INBOX','2015-01-01T00:00:00Z',0);",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn migration_defaults_to_three_months_and_preserves_cached_history() {
        let conn = database();
        assert_eq!(read_days(&conn, "account").unwrap(), 90);
        let received: i64 = conn
            .query_row("SELECT received_at FROM messages WHERE uid='1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(received, 1_420_070_400);
        conn.execute("UPDATE messages SET body_fetched=1 WHERE uid='1'", [])
            .unwrap();
        conn.execute("UPDATE accounts SET offline_sync_days=365", [])
            .unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(read_days(&conn, "account").unwrap(), 365);
        assert!(conn
            .query_row("SELECT body_fetched FROM messages WHERE uid='1'", [], |r| r
                .get::<_, bool>(0))
            .unwrap());
        assert!(validate_days(30).is_err());
        assert!(conn
            .execute("UPDATE accounts SET offline_sync_days=30", [])
            .is_err());
    }

    #[test]
    fn policy_uses_received_time_and_keeps_all_headers_and_existing_bodies() {
        let conn = database();
        let now = 1_800_000_000_i64;
        for (uid, days, date, fetched) in [
            (2, 1, "2010-01-01T00:00:00Z", false),
            (3, 100, "2030-01-01T00:00:00Z", false),
            (4, 400, "2020-01-01T00:00:00Z", true),
        ] {
            conn.execute(
                "INSERT INTO messages(uid,uid_int,account_id,folder,date,body_fetched,received_at)
                          VALUES(?1,?2,'account','INBOX',?3,?4,?5)",
                params![uid.to_string(), uid, date, fetched, now - days * 86_400],
            )
            .unwrap();
        }
        assert_eq!(
            PrefetchPlan::load(&conn, "account", "INBOX", now)
                .unwrap()
                .uids,
            ["2"]
        );
        conn.execute("UPDATE accounts SET offline_sync_days=365", [])
            .unwrap();
        assert_eq!(
            PrefetchPlan::load(&conn, "account", "INBOX", now)
                .unwrap()
                .uids,
            ["3", "2"]
        );
        conn.execute("UPDATE accounts SET offline_sync_days=0", [])
            .unwrap();
        let all = PrefetchPlan::load(&conn, "account", "INBOX", now).unwrap();
        assert_eq!(all.uids, ["3", "2", "1"]);
        assert_eq!(all.cutoff, None);
        conn.execute("UPDATE accounts SET offline_sync_days=90", [])
            .unwrap();
        assert_eq!(
            PrefetchPlan::load(&conn, "account", "INBOX", now)
                .unwrap()
                .uids,
            ["2"]
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM messages", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
    }

    #[test]
    fn range_changes_apply_to_an_existing_account_after_reopening() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("email.sqlite3");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE accounts(id TEXT PRIMARY KEY); INSERT INTO accounts VALUES('account');
                            CREATE TABLE messages(date TEXT);",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        conn.execute("UPDATE accounts SET offline_sync_days=0", [])
            .unwrap();
        drop(conn);
        let conn = Connection::open(path).unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(read_days(&conn, "account").unwrap(), 0);
    }
}
