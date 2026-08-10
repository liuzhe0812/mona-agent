use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use rusqlite::Connection as SqliteConnection;
use sqlx::mysql::MySqlPoolOptions;
use sqlx::{Column, MySqlPool, Row, TypeInfo};

use super::error::DbError;
use super::types::*;

pub enum DbHandle {
    Sqlite(Arc<std::sync::Mutex<SqliteConnection>>),
    Mysql(MySqlPool),
}

impl Clone for DbHandle {
    fn clone(&self) -> Self {
        match self {
            DbHandle::Sqlite(conn) => DbHandle::Sqlite(Arc::clone(conn)),
            DbHandle::Mysql(pool) => DbHandle::Mysql(pool.clone()),
        }
    }
}

struct ManagedConnection {
    handle: DbHandle,
    config: DbConnectionConfig,
    server_version: Option<String>,
}

pub struct ConnectionManager {
    connections: HashMap<String, ManagedConnection>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: HashMap::new(),
        }
    }

    pub fn contains_connection(&self, id: &str) -> bool {
        self.connections.contains_key(id)
    }

    pub fn get_handle(&self, connection_id: &str) -> Option<(DbHandle, DbConnectionConfig)> {
        self.connections.get(connection_id)
            .map(|conn| (conn.handle.clone(), conn.config.clone()))
    }

    pub fn get_handle_with_version(&self, connection_id: &str) -> Option<(DbHandle, DbConnectionConfig, Option<String>)> {
        self.connections.get(connection_id)
            .map(|conn| (conn.handle.clone(), conn.config.clone(), conn.server_version.clone()))
    }

    pub fn insert_connection(
        &mut self,
        config: DbConnectionConfig,
        handle: DbHandle,
        server_version: Option<String>,
    ) -> Result<ConnectionInfo, DbError> {
        if self.connections.contains_key(&config.id) {
            return Err(DbError::ConnectionAlreadyExists(config.id.clone()));
        }
        let info = ConnectionInfo {
            id: config.id.clone(),
            config: config.clone(),
            status: ConnectionStatus::Connected,
            server_version: server_version.clone(),
            error_message: None,
        };
        self.connections.insert(
            config.id.clone(),
            ManagedConnection {
                handle,
                config,
                server_version,
            },
        );
        Ok(info)
    }

    pub fn disconnect(&mut self, connection_id: &str) -> Result<(), DbError> {
        if let Some(conn) = self.connections.remove(connection_id) {
            if let DbHandle::Mysql(pool) = conn.handle {
                tokio::spawn(async move {
                    pool.close().await;
                });
            }
        }
        Ok(())
    }

    pub fn list_connections(&self) -> Vec<ConnectionInfo> {
        self.connections.values().map(|conn| ConnectionInfo {
            id: conn.config.id.clone(),
            config: conn.config.clone(),
            status: ConnectionStatus::Connected,
            server_version: conn.server_version.clone(),
            error_message: None,
        }).collect()
    }

    fn connect_sqlite(config: &DbConnectionConfig) -> Result<(DbHandle, Option<String>), DbError> {
        let path = resolve_sqlite_path(&config.host)?;
        let conn = SqliteConnection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_CREATE
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;

        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        let version: String = conn.query_row("SELECT sqlite_version()", [], |row| row.get(0))?;

        Ok((DbHandle::Sqlite(Arc::new(std::sync::Mutex::new(conn))), Some(format!("SQLite {}", version))))
    }

    async fn connect_mysql(config: &DbConnectionConfig) -> Result<(DbHandle, Option<String>), DbError> {
        let url = build_mysql_url(config)?;
        let pool = MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(&url)
            .await
            .map_err(|e| DbError::ConnectionFailed(format!("MySQL connection failed: {}", e)))?;

        let version: String = sqlx::query_scalar("SELECT VERSION()")
            .fetch_one(&pool)
            .await
            .map_err(|e| DbError::Mysql(e.to_string()))?;

        Ok((DbHandle::Mysql(pool), Some(version)))
    }
}

fn execute_sqlite(
    conn: &Arc<std::sync::Mutex<SqliteConnection>>,
    sql: &str,
    limit: Option<u64>,
) -> Result<QueryResult, DbError> {
    let conn = conn.lock().map_err(|e| DbError::ConnectionFailed(e.to_string()))?;
    let start = Instant::now();

    let trimmed = sql.trim().to_uppercase();
    let is_select = trimmed.starts_with("SELECT")
        || trimmed.starts_with("PRAGMA")
        || trimmed.starts_with("EXPLAIN")
        || trimmed.starts_with("WITH");

    if is_select {
        let limit_val = limit.unwrap_or(1000);
        let limited_sql = if trimmed.contains("LIMIT") {
            sql.to_string()
        } else {
            format!("{} LIMIT {}", sql.trim().trim_end_matches(';'), limit_val)
        };

        let mut stmt = conn.prepare(&limited_sql)?;
        let column_count = stmt.column_count();

        let column_names: Vec<String> = (0..column_count)
            .map(|i| stmt.column_name(i).unwrap_or("unknown").to_string())
            .collect();

        let mut rows = Vec::new();
        let mut result_iter = stmt.query([])?;
        let columns = if let Some(first_row) = result_iter.next()? {
            let cols: Vec<ColumnInfo> = (0..column_count)
                .map(|i| {
                    let col_type = first_row.get_ref(i).map(|v| match v {
                        rusqlite::types::ValueRef::Null => "TEXT",
                        rusqlite::types::ValueRef::Integer(_) => "INTEGER",
                        rusqlite::types::ValueRef::Real(_) => "REAL",
                        rusqlite::types::ValueRef::Text(_) => "TEXT",
                        rusqlite::types::ValueRef::Blob(_) => "BLOB",
                    }).unwrap_or("TEXT").to_string();
                    ColumnInfo {
                        name: column_names[i].clone(),
                        data_type: col_type,
                        nullable: true,
                        is_primary_key: false,
                        is_auto_increment: false,
                    }
                })
                .collect();

            let mut cells = Vec::with_capacity(column_count);
            for i in 0..column_count {
                let cell = sqlite_cell_value(&first_row, i)?;
                cells.push(cell);
            }
            rows.push(cells);
            cols
        } else {
            (0..column_count)
                .map(|i| ColumnInfo {
                    name: column_names[i].clone(),
                    data_type: "TEXT".to_string(),
                    nullable: true,
                    is_primary_key: false,
                    is_auto_increment: false,
                })
                .collect()
        };

        while let Some(row) = result_iter.next()? {
            let mut cells = Vec::with_capacity(column_count);
            for i in 0..column_count {
                let cell = sqlite_cell_value(&row, i)?;
                cells.push(cell);
            }
            rows.push(cells);
        }

        let execution_time_ms = start.elapsed().as_millis() as u64;
        let row_count = rows.len();
        Ok(QueryResult {
            columns,
            rows,
            affected_rows: 0,
            execution_time_ms,
            message: Some(format!("{} row(s) returned", row_count)),
        })
    } else {
        let affected = conn.execute(sql, [])?;
        let execution_time_ms = start.elapsed().as_millis() as u64;
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: affected as u64,
            execution_time_ms,
            message: Some(format!("{} row(s) affected", affected)),
        })
    }
}

fn sqlite_cell_value(row: &rusqlite::Row, idx: usize) -> Result<CellValue, DbError> {
    let val: rusqlite::types::Value = row.get_ref(idx)?.into();
    Ok(match val {
        rusqlite::types::Value::Null => CellValue::Null,
        rusqlite::types::Value::Integer(i) => CellValue::Integer(i),
        rusqlite::types::Value::Real(f) => CellValue::Float(f),
        rusqlite::types::Value::Text(s) => CellValue::Text(s),
        rusqlite::types::Value::Blob(b) => CellValue::Blob(hex::encode(b)),
    })
}

async fn execute_mysql(
    pool: &MySqlPool,
    sql: &str,
    limit: Option<u64>,
    database: Option<&str>,
) -> Result<QueryResult, DbError> {
    let start = Instant::now();
    let trimmed = sql.trim().to_uppercase();
    let is_select = trimmed.starts_with("SELECT")
        || trimmed.starts_with("SHOW")
        || trimmed.starts_with("DESCRIBE")
        || trimmed.starts_with("EXPLAIN")
        || trimmed.starts_with("WITH");

    if is_select {
        let limit_val = limit.unwrap_or(1000);
        let limited_sql = if trimmed.contains("LIMIT") || trimmed.starts_with("SHOW") || trimmed.starts_with("DESCRIBE") {
            sql.to_string()
        } else {
            format!("{} LIMIT {}", sql.trim().trim_end_matches(';'), limit_val)
        };

        let rows_raw = if let Some(db) = database {
            let use_sql = format!("USE `{}`", db);
            sqlx::query(&use_sql)
                .execute(pool)
                .await
                .map_err(|e| DbError::Mysql(format!("Failed to USE {}: {}", db, e)))?;
            sqlx::query(&limited_sql)
                .fetch_all(pool)
                .await
                .map_err(|e| DbError::Mysql(e.to_string()))?
        } else {
            sqlx::query(&limited_sql)
                .fetch_all(pool)
                .await
                .map_err(|e| DbError::Mysql(e.to_string()))?
        };

        let columns: Vec<ColumnInfo> = if let Some(row) = rows_raw.first() {
            let col_count = row.columns().len();
            (0..col_count)
                .map(|i| {
                    let col = row.column(i);
                    ColumnInfo {
                        name: col.name().to_string(),
                        data_type: col.type_info().name().to_string(),
                        nullable: true,
                        is_primary_key: false,
                        is_auto_increment: false,
                    }
                })
                .collect()
        } else {
            vec![]
        };

        let mut rows = Vec::new();
        for row in &rows_raw {
            let mut cells = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                let cell = mysql_cell_value(row, i);
                cells.push(cell);
            }
            rows.push(cells);
        }

        let execution_time_ms = start.elapsed().as_millis() as u64;
        let row_count = rows.len();
        Ok(QueryResult {
            columns,
            rows,
            affected_rows: 0,
            execution_time_ms,
            message: Some(format!("{} row(s) returned", row_count)),
        })
    } else {
        let result = sqlx::query(sql)
            .execute(pool)
            .await
            .map_err(|e| DbError::Mysql(e.to_string()))?;

        let execution_time_ms = start.elapsed().as_millis() as u64;
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: result.rows_affected(),
            execution_time_ms,
            message: Some(format!("{} row(s) affected", result.rows_affected())),
        })
    }
}

fn mysql_cell_value(row: &sqlx::mysql::MySqlRow, idx: usize) -> CellValue {
    use sqlx::{Row, TypeInfo};
    let col = row.column(idx);
    let type_name = col.type_info().name().to_uppercase();

    if type_name.contains("INT")
        || type_name.contains("BIT")
        || type_name.contains("BOOL")
        || type_name == "YEAR"
    {
        let val: Option<i64> = row.try_get_unchecked(idx).ok();
        if let Some(i) = val {
            return CellValue::Integer(i);
        }
        let val: Option<bool> = row.try_get_unchecked(idx).ok();
        if let Some(b) = val {
            return CellValue::Bool(b);
        }
        return CellValue::Null;
    }

    if type_name.contains("FLOAT")
        || type_name.contains("DOUBLE")
        || type_name.contains("DECIMAL")
        || type_name.contains("NUMERIC")
    {
        let val: Option<f64> = row.try_get_unchecked(idx).ok();
        if let Some(f) = val {
            return CellValue::Float(f);
        }
        let val: Option<i64> = row.try_get_unchecked(idx).ok();
        if let Some(i) = val {
            return CellValue::Integer(i);
        }
        return CellValue::Null;
    }

    if type_name.contains("BLOB")
        || type_name.contains("BINARY")
        || type_name == "GEOMETRY"
    {
        let val: Option<Vec<u8>> = row.try_get_unchecked(idx).ok();
        if let Some(b) = val {
            return CellValue::Blob(hex::encode(b));
        }
        return CellValue::Null;
    }

    let val: Option<String> = row.try_get_unchecked(idx).ok();
    if let Some(s) = val {
        return CellValue::Text(s);
    }
    CellValue::Null
}

fn get_sqlite_table_info(conn: &Arc<std::sync::Mutex<SqliteConnection>>, table: &str) -> Result<TableInfo, DbError> {
    let conn = conn.lock().map_err(|e| DbError::ConnectionFailed(e.to_string()))?;

    let mut columns = Vec::new();
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{}\")", table))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let pk: i32 = row.get(5)?;
        columns.push(ColumnDefinition {
            name: row.get(1)?,
            data_type: row.get::<_, String>(2)?,
            nullable: row.get::<_, i32>(3)? == 0,
            default_value: row.get(4)?,
            is_primary_key: pk > 0,
            is_unique: false,
            is_auto_increment: pk > 0 && row.get::<_, String>(2)?.contains("INTEGER"),
            extra: None,
            comment: None,
        });
    }

    let mut indexes = Vec::new();
    let mut stmt = conn.prepare(&format!("PRAGMA index_list(\"{}\")", table))?;
    let mut idx_rows = stmt.query([])?;
    while let Some(idx_row) = idx_rows.next()? {
        let idx_name: String = idx_row.get(1)?;
        let is_unique: bool = idx_row.get(2)?;
        let is_primary = idx_name.starts_with("sqlite_autoindex_");

        let mut idx_columns = Vec::new();
        let mut col_stmt = conn.prepare(&format!("PRAGMA index_info(\"{}\")", idx_name))?;
        let mut col_rows = col_stmt.query([])?;
        while let Some(col_row) = col_rows.next()? {
            idx_columns.push(col_row.get(2)?);
        }

        indexes.push(IndexDefinition {
            name: idx_name,
            columns: idx_columns,
            is_unique,
            is_primary,
            index_type: None,
        });
    }

    let ddl: Option<String> = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
        [table],
        |row| row.get(0),
    ).ok();

    let row_count: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM \"{}\"", table),
        [],
        |row| row.get(0),
    ).unwrap_or(0);

    Ok(TableInfo {
        name: table.to_string(),
        schema: Some("main".to_string()),
        engine: None,
        charset: None,
        collation: None,
        row_count: Some(row_count),
        data_size: None,
        index_size: None,
        auto_increment: None,
        create_time: None,
        update_time: None,
        columns,
        indexes,
        foreign_keys: vec![],
        ddl,
    })
}

async fn get_mysql_table_info(pool: &MySqlPool, database: &str, table: &str) -> Result<TableInfo, DbError> {
    let columns_rows = sqlx::query_as::<_, (String, String, Option<String>, String, Option<String>, Option<String>, Option<String>)>(
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION"
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Mysql(e.to_string()))?;

    let columns: Vec<ColumnDefinition> = columns_rows.into_iter().map(|(name, data_type, nullable, key, default, extra, comment)| {
        ColumnDefinition {
            name,
            data_type,
            nullable: nullable.as_deref() == Some("YES"),
            default_value: default,
            is_primary_key: key == "PRI",
            is_unique: key == "UNI",
            is_auto_increment: extra.as_deref() == Some("auto_increment"),
            extra,
            comment,
        }
    }).collect();

    let index_rows = sqlx::query_as::<_, (String, i64, String, String, Option<String>)>(
        "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX"
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Mysql(e.to_string()))?;

    let mut index_map: std::collections::BTreeMap<String, (bool, Vec<String>, Option<String>)> = std::collections::BTreeMap::new();
    for (idx_name, non_unique, col_name, _seq, idx_type) in index_rows {
        let entry = index_map.entry(idx_name).or_insert((non_unique == 0, vec![], idx_type));
        entry.1.push(col_name);
    }

    let indexes: Vec<IndexDefinition> = index_map.into_iter().map(|(name, (is_unique, cols, idx_type))| {
        let is_primary = name == "PRIMARY";
        IndexDefinition {
            name,
            columns: cols,
            is_unique,
            is_primary,
            index_type: idx_type,
        }
    }).collect();

    let fk_rows = sqlx::query_as::<_, (String, String, String, String, Option<String>, Option<String>)>(
        "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, DELETE_RULE, UPDATE_RULE FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL"
    )
    .bind(database)
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(|e| DbError::Mysql(e.to_string()))?;

    let foreign_keys: Vec<ForeignKeyDefinition> = fk_rows.into_iter().map(|(name, col, ref_table, ref_col, on_delete, on_update)| {
        ForeignKeyDefinition {
            name,
            columns: vec![col],
            ref_table,
            ref_columns: vec![ref_col],
            on_delete,
            on_update,
        }
    }).collect();

    let table_row = sqlx::query_as::<_, (Option<String>, Option<String>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<String>, Option<String>, Option<String>)>(
        "SELECT ENGINE, TABLE_COLLATION, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT, CREATE_TIME, UPDATE_TIME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?"
    )
    .bind(database)
    .bind(table)
    .fetch_one(pool)
    .await
    .map_err(|e| DbError::Mysql(e.to_string()))?;

    let (engine, collation, row_count, data_length, index_length, auto_increment, create_time, update_time, _comment) = table_row;

    let ddl = sqlx::query(&format!("SHOW CREATE TABLE `{}`.`{}`", database, table))
        .fetch_one(pool)
        .await
        .ok()
        .and_then(|row| {
            use sqlx::Row;
            row.try_get_unchecked::<String, _>(1).ok()
        });

    Ok(TableInfo {
        name: table.to_string(),
        schema: Some(database.to_string()),
        engine,
        charset: collation.as_deref().and_then(|c| c.split('_').next()).map(|s| s.to_string()),
        collation,
        row_count,
        data_size: data_length.map(|b| format!("{:.1} MB", b as f64 / 1024.0 / 1024.0)),
        index_size: index_length.map(|b| format!("{:.1} MB", b as f64 / 1024.0 / 1024.0)),
        auto_increment,
        create_time,
        update_time,
        columns,
        indexes,
        foreign_keys,
        ddl,
    })
}

async fn mysql_status_value(pool: &MySqlPool, name: &str) -> i64 {
    let query = format!("SHOW STATUS LIKE '{}'", name);
    let row: (String, String) = match sqlx::query_as(&query).fetch_one(pool).await {
        Ok(r) => r,
        Err(_) => return 0,
    };
    row.1.parse::<i64>().unwrap_or(0)
}

async fn mysql_variable_value(pool: &MySqlPool, name: &str) -> i64 {
    let query = format!("SHOW VARIABLES LIKE '{}'", name);
    let row: (String, String) = match sqlx::query_as(&query).fetch_one(pool).await {
        Ok(r) => r,
        Err(_) => return 0,
    };
    row.1.parse::<i64>().unwrap_or(0)
}

fn resolve_sqlite_path(host: &str) -> Result<PathBuf, DbError> {
    if host == ":memory:" {
        return Ok(PathBuf::from(":memory:"));
    }
    let path = PathBuf::from(host);
    if path.is_absolute() {
        Ok(path)
    } else {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| DbError::InvalidConfig("Cannot determine data directory".to_string()))?;
        Ok(data_dir.join("mona").join("db").join(host))
    }
}

pub async fn create_connection(config: &DbConnectionConfig) -> Result<(DbHandle, Option<String>), DbError> {
    match config.db_type {
        DatabaseType::Sqlite => ConnectionManager::connect_sqlite(config),
        DatabaseType::Mysql => ConnectionManager::connect_mysql(config).await,
        _ => Err(DbError::UnsupportedType(format!("{:?} driver not yet implemented", config.db_type))),
    }
}

pub async fn test_connection(config: &DbConnectionConfig) -> Result<String, DbError> {
    match config.db_type {
        DatabaseType::Sqlite => {
            let path = resolve_sqlite_path(&config.host)?;
            let conn = SqliteConnection::open_with_flags(
                &path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            let version: String = conn.query_row(
                "SELECT sqlite_version()",
                [],
                |row| row.get(0),
            )?;
            Ok(format!("SQLite {}", version))
        }
        DatabaseType::Mysql => {
            let url = build_mysql_url(config)?;
            let pool = MySqlPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(std::time::Duration::from_secs(10))
                .connect(&url)
                .await
                .map_err(|e| DbError::Mysql(e.to_string()))?;
            let version: String = sqlx::query_scalar("SELECT VERSION()")
                .fetch_one(&pool)
                .await
                .map_err(|e| DbError::Mysql(e.to_string()))?;
            pool.close().await;
            Ok(version)
        }
        _ => Err(DbError::UnsupportedType(format!("{:?} driver not yet implemented", config.db_type))),
    }
}

pub async fn execute_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
    sql: &str,
    limit: Option<u64>,
    database: Option<&str>,
) -> Result<QueryResult, DbError> {
    match &handle.0 {
        DbHandle::Sqlite(sqlite_conn) => {
            let conn = sqlite_conn.clone();
            let sql = sql.to_string();
            tokio::task::spawn_blocking(move || execute_sqlite(&conn, &sql, limit))
                .await
                .map_err(|e| DbError::ConnectionFailed(e.to_string()))?
        }
        DbHandle::Mysql(pool) => {
            execute_mysql(pool, sql, limit, database).await
        }
    }
}

pub async fn get_databases_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
) -> Result<Vec<String>, DbError> {
    match &handle.0 {
        DbHandle::Sqlite(sqlite_conn) => {
            let conn = sqlite_conn.clone();
            tokio::task::spawn_blocking(move || {
                let conn = conn.lock()
                    .map_err(|e| DbError::ConnectionFailed(format!("Failed to lock connection: {}", e)))?;
                let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='database' ORDER BY name")?;
                let rows = stmt.query_map([], |row| row.get(0))?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            })
            .await
            .map_err(|e| DbError::ConnectionFailed(e.to_string()))?
        }
        DbHandle::Mysql(pool) => {
            let rows: Vec<(String,)> = sqlx::query_as("SHOW DATABASES")
                .fetch_all(pool)
                .await
                .map_err(|e| DbError::Mysql(e.to_string()))?;
            Ok(rows.into_iter().map(|r| r.0).collect())
        }
    }
}

pub async fn get_tables_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
    database: &str,
) -> Result<Vec<DatabaseObject>, DbError> {
    match &handle.0 {
        DbHandle::Sqlite(sqlite_conn) => {
            let conn = sqlite_conn.clone();
            tokio::task::spawn_blocking(move || {
                let conn = conn.lock()
                    .map_err(|e| DbError::ConnectionFailed(format!("Failed to lock connection: {}", e)))?;
                let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
                Ok(rows.filter_map(|r| r.ok()).map(|name| DatabaseObject {
                    name,
                    schema: None,
                    object_type: DatabaseObjectType::Table,
                    children: vec![],
                }).collect())
            })
            .await
            .map_err(|e| DbError::ConnectionFailed(e.to_string()))?
        }
        DbHandle::Mysql(pool) => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
            )
            .bind(database)
            .fetch_all(pool)
            .await
            .map_err(|e| DbError::Mysql(e.to_string()))?;
            Ok(rows.into_iter().map(|r| DatabaseObject { name: r.0, schema: Some(database.to_string()), object_type: DatabaseObjectType::Table, children: vec![] }).collect())
        }
    }
}

pub async fn get_views_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
    database: &str,
) -> Result<Vec<DatabaseObject>, DbError> {
    match &handle.0 {
        DbHandle::Sqlite(sqlite_conn) => {
            let conn = sqlite_conn.clone();
            tokio::task::spawn_blocking(move || {
                let conn = conn.lock()
                    .map_err(|e| DbError::ConnectionFailed(format!("Failed to lock connection: {}", e)))?;
                let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name")?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
                Ok(rows.filter_map(|r| r.ok()).map(|name| DatabaseObject { name, schema: None, object_type: DatabaseObjectType::View, children: vec![] }).collect())
            })
            .await
            .map_err(|e| DbError::ConnectionFailed(e.to_string()))?
        }
        DbHandle::Mysql(pool) => {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME"
            )
            .bind(database)
            .fetch_all(pool)
            .await
            .map_err(|e| DbError::Mysql(e.to_string()))?;
            Ok(rows.into_iter().map(|r| DatabaseObject { name: r.0, schema: Some(database.to_string()), object_type: DatabaseObjectType::View, children: vec![] }).collect())
        }
    }
}

pub async fn get_table_info_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
    database: &str,
    table: &str,
) -> Result<TableInfo, DbError> {
    match &handle.0 {
        DbHandle::Sqlite(sqlite_conn) => {
            let conn = sqlite_conn.clone();
            let table = table.to_string();
            tokio::task::spawn_blocking(move || {
                get_sqlite_table_info(&conn, &table)
            })
            .await
            .map_err(|e| DbError::ConnectionFailed(e.to_string()))?
        }
        DbHandle::Mysql(pool) => {
            get_mysql_table_info(pool, database, table).await
        }
    }
}

pub async fn get_server_stats_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
) -> Result<ServerStats, DbError> {
    match &handle.0 {
        DbHandle::Sqlite(_) => Err(DbError::UnsupportedType("SQLite does not support server stats".to_string())),
        DbHandle::Mysql(pool) => {
            let connections = mysql_status_value(pool, "Threads_connected").await;
        let max_connections = mysql_variable_value(pool, "max_connections").await;
        let qps = mysql_status_value(pool, "Queries").await;
        let slow_queries = mysql_status_value(pool, "Slow_queries").await;
        let uptime = mysql_status_value(pool, "Uptime").await;

        let version: String = sqlx::query_scalar("SELECT VERSION()")
            .fetch_one(pool)
            .await
            .unwrap_or_default();

        Ok(ServerStats {
            connections,
            max_connections,
            qps,
            slow_queries,
                buffer_pool_hit_rate: None,
                replication_lag_seconds: None,
                disk_usage_gb: None,
                disk_total_gb: None,
                uptime_seconds: Some(uptime),
                server_version: Some(version),
            })
        }
    }
}

pub async fn get_processes_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
) -> Result<Vec<ProcessInfo>, DbError> {
    match &handle.0 {
        DbHandle::Sqlite(_) => Err(DbError::UnsupportedType("SQLite does not support process list".to_string())),
        DbHandle::Mysql(pool) => {
            let rows: Vec<(i64, String, String, Option<String>, String, i64, Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT Id, User, Host, db, Command, Time, State, Info FROM information_schema.PROCESSLIST ORDER BY Time DESC"
            )
            .fetch_all(pool)
            .await
            .map_err(|e| DbError::Mysql(e.to_string()))?;

            Ok(rows.into_iter().map(|(id, user, host, database, command, time, state, info)| {
                ProcessInfo { id, user, host, database, command, time, state, info }
            }).collect())
        }
    }
}

pub async fn get_users_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
) -> Result<Vec<UserInfo>, DbError> {
    match &handle.0 {
        DbHandle::Sqlite(_) => Err(DbError::UnsupportedType("SQLite does not support user management".to_string())),
        DbHandle::Mysql(pool) => {
            let rows: Vec<(String, String, String, String)> = sqlx::query_as(
                "SELECT User, Host, password_expired, account_locked FROM mysql.user ORDER BY User"
            )
            .fetch_all(pool)
            .await
            .map_err(|e| DbError::Mysql(e.to_string()))?;

            Ok(rows.into_iter().map(|(username, host, pw_expired, locked)| {
                UserInfo {
                    username,
                    host,
                    password_expired: pw_expired == "Y",
                    account_locked: locked == "Y",
                }
            }).collect())
        }
    }
}

pub async fn kill_process_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
    process_id: i64,
) -> Result<(), DbError> {
    match &handle.0 {
        DbHandle::Sqlite(_) => Err(DbError::UnsupportedType("SQLite does not support kill process".to_string())),
        DbHandle::Mysql(pool) => {
            let query = format!("KILL {}", process_id);
            sqlx::query(&query)
                .execute(pool)
                .await
                .map_err(|e| DbError::Mysql(e.to_string()))?;
            Ok(())
        }
    }
}

pub async fn backup_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
    database: &str,
    output_path: &str,
    include_ddl: bool,
    include_data: bool,
) -> Result<(), DbError> {
    match &handle.0 {
        DbHandle::Sqlite(_) => {
            let host = handle.1.host.clone();
            let output_path = output_path.to_string();
            tokio::task::spawn_blocking(move || {
                let db_path = resolve_sqlite_path(&host)?;
                let output = std::path::Path::new(&output_path);
                if let Some(parent) = output.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(&db_path, output)
                    .map_err(|e| DbError::Mysql(format!("Failed to copy SQLite database: {}", e)))?;
                Ok(())
            })
            .await
            .map_err(|e| DbError::ConnectionFailed(e.to_string()))?
        }
        DbHandle::Mysql(pool) => {
            backup_mysql(pool, database, output_path, include_ddl, include_data).await
        }
    }
}

pub async fn restore_on_handle(
    handle: &(DbHandle, DbConnectionConfig),
    database: &str,
    input_path: &str,
) -> Result<(), DbError> {
    match &handle.0 {
        DbHandle::Sqlite(_) => {
            Err(DbError::UnsupportedType("SQLite restore is not supported yet".to_string()))
        }
        DbHandle::Mysql(pool) => {
            restore_mysql(pool, database, input_path).await
        }
    }
}

const MONA_STMT_SEP: &str = "-- !MONA_SEP!";

async fn backup_mysql(
    pool: &MySqlPool,
    database: &str,
    output_path: &str,
    include_ddl: bool,
    include_data: bool,
) -> Result<(), DbError> {
    let output = std::path::Path::new(output_path);
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut content = String::new();
    content.push_str("-- Mona Database Backup\n");
    content.push_str(&format!("-- Database: {}\n", database));
    content.push_str(&format!("-- Date: {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")));
    content.push_str("\n");

    let mut push_stmt = |s: &str| {
        content.push_str(s);
        content.push('\n');
        content.push_str(MONA_STMT_SEP);
        content.push_str("\n\n");
    };

    push_stmt("SET FOREIGN_KEY_CHECKS=0");

    if include_ddl {
        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
        )
        .bind(database)
        .fetch_all(pool)
        .await
        .map_err(|e| DbError::Mysql(e.to_string()))?;

        for (table_name,) in &tables {
            let row = sqlx::query(&format!("SHOW CREATE TABLE `{}`.`{}`", database, table_name))
                .fetch_one(pool)
                .await
                .map_err(|e| DbError::Mysql(e.to_string()))?;

            let ddl: String = row.try_get_unchecked(1)
                .map_err(|e| DbError::Mysql(e.to_string()))?;

            push_stmt(&format!("DROP TABLE IF EXISTS `{}`.`{}`", database, table_name));
            push_stmt(&ddl);
        }

        let views: Vec<(String,)> = sqlx::query_as(
            "SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME"
        )
        .bind(database)
        .fetch_all(pool)
        .await
        .map_err(|e| DbError::Mysql(e.to_string()))?;

        for (view_name,) in &views {
            let row = sqlx::query(&format!("SHOW CREATE VIEW `{}`.`{}`", database, view_name))
                .fetch_one(pool)
                .await;
            if let Ok(row) = row {
                let ddl: String = row.try_get_unchecked(1).unwrap_or_default();
                push_stmt(&format!("DROP VIEW IF EXISTS `{}`.`{}`", database, view_name));
                push_stmt(&ddl);
            }
        }
    }

    if include_data {
        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
        )
        .bind(database)
        .fetch_all(pool)
        .await
        .map_err(|e| DbError::Mysql(e.to_string()))?;

        for (table_name,) in &tables {
            let rows = sqlx::query(&format!("SELECT * FROM `{}`.`{}`", database, table_name))
                .fetch_all(pool)
                .await
                .map_err(|e| DbError::Mysql(e.to_string()))?;

            if !rows.is_empty() {
                for row in &rows {
                    let col_count = row.columns().len();
                    let mut values = Vec::new();
                    for i in 0..col_count {
                        let cell = mysql_cell_value(row, i);
                        values.push(match cell {
                            CellValue::Null => "NULL".to_string(),
                            CellValue::Integer(i) => i.to_string(),
                            CellValue::Float(f) => f.to_string(),
                            CellValue::Text(s) => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
                            CellValue::Bool(b) => if b { "1".to_string() } else { "0".to_string() },
                            CellValue::Blob(hex) => format!("X'{}'", hex),
                        });
                    }
                    push_stmt(&format!("INSERT INTO `{}`.`{}` VALUES ({})", database, table_name, values.join(", ")));
                }
            }
        }
    }

    push_stmt("SET FOREIGN_KEY_CHECKS=1");

    std::fs::write(output_path, &content)
        .map_err(|e| DbError::Mysql(format!("Failed to write backup file: {}", e)))?;

    Ok(())
}

async fn restore_mysql(
    pool: &MySqlPool,
    database: &str,
    input_path: &str,
) -> Result<(), DbError> {
    let content = std::fs::read_to_string(input_path)
        .map_err(|e| DbError::Mysql(format!("Failed to read backup file: {}", e)))?;

    let mut conn = pool.acquire().await
        .map_err(|e| DbError::Mysql(format!("Failed to acquire connection: {}", e)))?;

    sqlx::query(&format!("USE `{}`", database))
        .execute(&mut *conn)
        .await
        .map_err(|e| DbError::Mysql(format!("Failed to USE {}: {}", database, e)))?;

    sqlx::query("SET FOREIGN_KEY_CHECKS=0")
        .execute(&mut *conn)
        .await
        .map_err(|e| DbError::Mysql(format!("Failed to disable foreign key checks: {}", e)))?;

    let statements = if content.contains(MONA_STMT_SEP) {
        content.split(MONA_STMT_SEP).collect::<Vec<_>>()
    } else {
        content.split(';').collect::<Vec<_>>()
    };

    for statement in &statements {
        let sql: String = statement
            .lines()
            .filter(|line| !line.trim().starts_with("--"))
            .collect::<Vec<_>>()
            .join("\n");
        let trimmed = sql.trim();
        if trimmed.is_empty() {
            continue;
        }
        sqlx::query(trimmed)
            .execute(&mut *conn)
            .await
            .map_err(|e| DbError::Mysql(format!("Failed to execute restore statement: {}", e)))?;
    }

    sqlx::query("SET FOREIGN_KEY_CHECKS=1")
        .execute(&mut *conn)
        .await
        .map_err(|e| DbError::Mysql(format!("Failed to re-enable foreign key checks: {}", e)))?;

    Ok(())
}

fn build_mysql_url(config: &DbConnectionConfig) -> Result<String, DbError> {
    let db = config.database.as_deref().unwrap_or("mysql");
    let ssl_mode = if config.use_ssl { "true" } else { "disabled" };
    Ok(format!(
        "mysql://{}:{}@{}:{}/{}?ssl-mode={}",
        urlencoding::encode(&config.username),
        urlencoding::encode(&config.password),
        config.host,
        config.port,
        db,
        ssl_mode,
    ))
}
