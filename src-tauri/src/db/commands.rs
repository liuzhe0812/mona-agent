use crate::db::types::*;
use crate::db::DbState;
use tauri::State;

#[tauri::command]
pub async fn db_connect(
    state: State<'_, DbState>,
    config: DbConnectionConfig,
) -> Result<ConnectionInfo, String> {
    let (handle, server_version) = super::manager::create_connection(&config)
        .await
        .map_err(|e| e.to_string())?;

    let mut manager = state.manager.lock().await;
    // If a connection with the same id already exists, disconnect it first
    if manager.contains_connection(&config.id) {
        let _ = manager.disconnect(&config.id);
    }
    manager
        .insert_connection(config, handle, server_version)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, DbState>, connection_id: String) -> Result<(), String> {
    let mut manager = state.manager.lock().await;
    manager
        .disconnect(&connection_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_test_connection(config: DbConnectionConfig) -> Result<String, String> {
    super::manager::test_connection(&config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_execute_query(
    state: State<'_, DbState>,
    connection_id: String,
    sql: String,
    limit: Option<u64>,
    database: Option<String>,
) -> Result<QueryResult, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::execute_on_handle(&handle, &sql, limit, database.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_get_databases(
    state: State<'_, DbState>,
    connection_id: String,
) -> Result<Vec<String>, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::get_databases_on_handle(&handle)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_get_tables(
    state: State<'_, DbState>,
    connection_id: String,
    database: String,
) -> Result<Vec<DatabaseObject>, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::get_tables_on_handle(&handle, &database)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_get_views(
    state: State<'_, DbState>,
    connection_id: String,
    database: String,
) -> Result<Vec<DatabaseObject>, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::get_views_on_handle(&handle, &database)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_get_routines(
    state: State<'_, DbState>,
    connection_id: String,
    database: String,
) -> Result<Vec<DatabaseObject>, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::get_routines_on_handle(&handle, &database)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_get_routine_definition(
    state: State<'_, DbState>,
    connection_id: String,
    database: String,
    name: String,
    routine_type: DatabaseObjectType,
) -> Result<String, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::get_routine_definition_on_handle(
        &handle,
        &database,
        &name,
        routine_type,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_get_table_info(
    state: State<'_, DbState>,
    connection_id: String,
    database: String,
    table: String,
) -> Result<TableInfo, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::get_table_info_on_handle(&handle, &database, &table)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_get_table_summaries(
    state: State<'_, DbState>,
    connection_id: String,
    database: String,
) -> Result<Vec<TableSummary>, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::catalog::get_table_summaries_on_handle(&handle, &database)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_preview_table_structure(
    state: State<'_, DbState>,
    connection_id: String,
    database: String,
    table: String,
    draft: super::structure::StructureDraft,
) -> Result<Vec<String>, String> {
    let handle = state.manager.lock().await.get_handle(&connection_id)
        .ok_or_else(|| format!("Connection {} not found", connection_id))?;
    super::structure::change_structure(&handle, &database, &table, draft, false)
        .await.map(|(sql, _)| sql).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn db_apply_table_structure(
    state: State<'_, DbState>,
    connection_id: String,
    database: String,
    table: String,
    draft: super::structure::StructureDraft,
) -> Result<super::structure::ApplyResult, String> {
    let handle = state.manager.lock().await.get_handle(&connection_id)
        .ok_or_else(|| format!("Connection {} not found", connection_id))?;
    super::structure::change_structure(&handle, &database, &table, draft, true)
        .await.map_err(|error| error.to_string())?
        .1.ok_or_else(|| "结构修改没有返回执行结果".to_string())
}

#[tauri::command]
pub async fn db_get_server_stats(
    state: State<'_, DbState>,
    connection_id: String,
) -> Result<ServerStats, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::get_server_stats_on_handle(&handle)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_get_processes(
    state: State<'_, DbState>,
    connection_id: String,
) -> Result<Vec<ProcessInfo>, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::get_processes_on_handle(&handle)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_get_users(
    state: State<'_, DbState>,
    connection_id: String,
) -> Result<Vec<UserInfo>, String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::get_users_on_handle(&handle)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_kill_process(
    state: State<'_, DbState>,
    connection_id: String,
    process_id: i64,
) -> Result<(), String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::kill_process_on_handle(&handle, process_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_backup_database(
    state: State<'_, DbState>,
    connection_id: String,
    database: String,
    output_path: String,
    include_ddl: Option<bool>,
    include_data: Option<bool>,
) -> Result<(), String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::backup_on_handle(
        &handle,
        &database,
        &output_path,
        include_ddl.unwrap_or(true),
        include_data.unwrap_or(true),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_restore_database(
    state: State<'_, DbState>,
    connection_id: String,
    database: String,
    input_path: String,
) -> Result<(), String> {
    let handle = {
        let manager = state.manager.lock().await;
        manager
            .get_handle(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?
    };
    super::manager::restore_on_handle(&handle, &database, &input_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_list_connections(state: State<'_, DbState>) -> Result<Vec<ConnectionInfo>, String> {
    let manager = state.manager.lock().await;
    Ok(manager.list_connections())
}

#[tauri::command]
pub async fn db_save_connections(connections: Vec<DbConnectionConfig>) -> Result<(), String> {
    let data_dir = dirs::data_dir().ok_or("Cannot determine data directory")?;
    let db_dir = data_dir.join("mona").join("db");
    std::fs::create_dir_all(&db_dir).map_err(|e| e.to_string())?;
    let path = db_dir.join("connections.json");
    let json = serde_json::to_string_pretty(&connections).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn db_load_connections() -> Result<Vec<DbConnectionConfig>, String> {
    let data_dir = dirs::data_dir().ok_or("Cannot determine data directory")?;
    let path = data_dir.join("mona").join("db").join("connections.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let connections: Vec<DbConnectionConfig> =
        serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(connections)
}

fn saved_queries_path() -> Result<std::path::PathBuf, String> {
    let data_dir = dirs::data_dir().ok_or("Cannot determine data directory")?;
    let db_dir = data_dir.join("mona").join("db");
    std::fs::create_dir_all(&db_dir).map_err(|e| e.to_string())?;
    Ok(db_dir.join("queries.json"))
}

fn read_saved_queries(path: &std::path::Path) -> Result<Vec<SavedQuery>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

fn write_saved_queries(path: &std::path::Path, queries: &[SavedQuery]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(queries).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn validate_saved_query(query: &SavedQuery) -> Result<(), String> {
    if query.id.trim().is_empty()
        || query.name.trim().is_empty()
        || query.connection_id.trim().is_empty()
        || query.database.trim().is_empty()
        || query.sql.trim().is_empty()
    {
        return Err("查询名称、数据库和 SQL 不能为空".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn db_load_saved_queries() -> Result<Vec<SavedQuery>, String> {
    read_saved_queries(&saved_queries_path()?)
}

#[tauri::command]
pub async fn db_save_query(query: SavedQuery) -> Result<(), String> {
    validate_saved_query(&query)?;
    let path = saved_queries_path()?;
    let mut queries = read_saved_queries(&path)?;
    if let Some(existing) = queries.iter_mut().find(|item| item.id == query.id) {
        *existing = query;
    } else {
        queries.push(query);
    }
    write_saved_queries(&path, &queries)
}

#[cfg(test)]
mod saved_query_tests {
    use super::*;

    fn query(sql: &str) -> SavedQuery {
        SavedQuery {
            id: "query-1".to_string(),
            name: "每日统计".to_string(),
            connection_id: "connection-1".to_string(),
            database: "analytics".to_string(),
            sql: sql.to_string(),
        }
    }

    #[test]
    fn saved_queries_round_trip_without_database_credentials() {
        let directory = tempfile::tempdir().expect("temporary saved-query directory");
        let path = directory.path().join("queries.json");
        let queries = vec![query("SELECT 1")];
        write_saved_queries(&path, &queries).expect("write saved queries");
        assert_eq!(read_saved_queries(&path).expect("read saved queries"), queries);
    }

    #[test]
    fn saved_query_requires_identity_target_and_sql() {
        assert!(validate_saved_query(&query("SELECT 1")).is_ok());
        assert!(validate_saved_query(&query("  ")).is_err());
    }
}
