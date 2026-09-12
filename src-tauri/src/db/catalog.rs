use std::sync::Arc;

use rusqlite::Connection as SqliteConnection;
use sqlx::MySqlPool;

use super::error::DbError;
use super::manager::DbHandle;
use super::types::{DbConnectionConfig, TableSummary};

pub async fn get_table_summaries_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
    database: &str,
) -> Result<Vec<TableSummary>, DbError> {
    match &handle.0 {
        DbHandle::Sqlite(sqlite_conn) => {
            let conn = Arc::clone(sqlite_conn);
            tokio::task::spawn_blocking(move || get_sqlite_table_summaries(&conn))
                .await
                .map_err(|e| DbError::ConnectionFailed(e.to_string()))?
        }
        DbHandle::Mysql(pool) => get_mysql_table_summaries(pool, database).await,
    }
}

fn get_sqlite_table_summaries(
    sqlite_conn: &Arc<std::sync::Mutex<SqliteConnection>>,
) -> Result<Vec<TableSummary>, DbError> {
    let conn = sqlite_conn
        .lock()
        .map_err(|e| DbError::ConnectionFailed(format!("Failed to lock connection: {}", e)))?;
    let mut stmt = conn.prepare(
        "SELECT name, type FROM sqlite_master \
         WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
         ORDER BY name",
    )?;
    let mut rows = stmt.query([])?;
    let mut summaries = Vec::new();
    while let Some(row) = rows.next()? {
        let name: String = row.get(0)?;
        let object_type: String = row.get(1)?;
        summaries.push(TableSummary {
            name,
            object_type: if object_type == "view" {
                "view".to_string()
            } else {
                "table".to_string()
            },
            comment: None,
            row_count: None,
            data_size: None,
            index_size: None,
            engine: None,
            charset: None,
            create_time: None,
            update_time: None,
        });
    }
    Ok(summaries)
}

async fn get_mysql_table_summaries(
    pool: &MySqlPool,
    database: &str,
) -> Result<Vec<TableSummary>, DbError> {
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
    >(
        "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS, DATA_LENGTH, \
         INDEX_LENGTH, ENGINE, TABLE_COLLATION, CAST(CREATE_TIME AS CHAR), \
         CAST(UPDATE_TIME AS CHAR) \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') \
         ORDER BY TABLE_NAME",
    )
    .bind(database)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Mysql(e.to_string()))?;

    Ok(rows
        .into_iter()
        .map(
            |(
                name,
                table_type,
                comment,
                row_count,
                data_size,
                index_size,
                engine,
                collation,
                create_time,
                update_time,
            )| TableSummary {
                name,
                object_type: if table_type.eq_ignore_ascii_case("VIEW") {
                    "view".to_string()
                } else {
                    "table".to_string()
                },
                comment,
                row_count,
                data_size,
                index_size,
                engine,
                charset: collation
                    .as_deref()
                    .and_then(|value| value.split('_').next())
                    .map(str::to_string),
                create_time,
                update_time,
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sqlite_handle() -> (DbHandle, DbConnectionConfig) {
        let conn = SqliteConnection::open_in_memory().expect("open in-memory sqlite");
        (
            DbHandle::Sqlite(Arc::new(std::sync::Mutex::new(conn))),
            DbConnectionConfig {
                id: "test".to_string(),
                name: "test".to_string(),
                db_type: super::super::types::DatabaseType::Sqlite,
                host: ":memory:".to_string(),
                port: 0,
                username: String::new(),
                password: String::new(),
                database: None,
                use_ssl: false,
                use_ssh_tunnel: false,
                ssh_host: None,
                ssh_port: None,
                ssh_username: None,
                ssh_auth: None,
            },
        )
    }

    #[tokio::test]
    async fn sqlite_table_summaries_batch_tables_and_views_without_counts() {
        let handle = sqlite_handle();
        if let DbHandle::Sqlite(conn) = &handle.0 {
            conn.lock()
                .expect("lock sqlite")
                .execute_batch(
                    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); \
                     INSERT INTO users (name) VALUES ('Ada'); \
                     CREATE VIEW user_names AS SELECT name FROM users;",
                )
                .expect("create sqlite objects");
        }

        let summaries = get_table_summaries_on_handle(&handle, "main")
            .await
            .expect("read table summaries");
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].name, "user_names");
        assert_eq!(summaries[0].object_type, "view");
        assert_eq!(summaries[1].name, "users");
        assert_eq!(summaries[1].object_type, "table");
        assert!(summaries.iter().all(|summary| {
            summary.comment.is_none()
                && summary.row_count.is_none()
                && summary.data_size.is_none()
                && summary.index_size.is_none()
                && summary.engine.is_none()
                && summary.charset.is_none()
                && summary.create_time.is_none()
                && summary.update_time.is_none()
        }));

        let databases = super::super::manager::get_databases_on_handle(&handle)
            .await
            .expect("read sqlite databases");
        assert!(databases.iter().any(|database| database == "main"));
    }

    #[test]
    fn table_summary_serializes_with_stable_fields() {
        let summary = TableSummary {
            name: "users".to_string(),
            object_type: "table".to_string(),
            comment: Some("accounts".to_string()),
            row_count: Some(1),
            data_size: Some(64),
            index_size: None,
            engine: Some("InnoDB".to_string()),
            charset: Some("utf8mb4".to_string()),
            create_time: Some("2026-09-12 10:00:00".to_string()),
            update_time: None,
        };
        assert_eq!(
            serde_json::to_value(summary).expect("serialize table summary"),
            json!({
                "name": "users",
                "object_type": "table",
                "comment": "accounts",
                "row_count": 1,
                "data_size": 64,
                "index_size": null,
                "engine": "InnoDB",
                "charset": "utf8mb4",
                "create_time": "2026-09-12 10:00:00",
                "update_time": null
            })
        );
    }
}
