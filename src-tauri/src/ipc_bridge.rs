use std::sync::Arc;

use crate::terminal::maintenance_cmds;
use crate::terminal::TerminalState;
use serde_json::Value;
use subtle::ConstantTimeEq;
use tauri::Emitter;
use tauri::Manager;

const IPC_META_FILE_NAME: &str = "ipc_bridge.json";
const LEGACY_PORT_FILE_NAME: &str = "ipc_bridge_port";
const IPC_PORT_RANGE: std::ops::Range<u16> = 17860..17871;
const TOKEN_HEADER: &str = "x-mona-ipc-token";

fn generate_token() -> String {
    let mut buf = [0u8; 32];
    if getrandom::fill(&mut buf).is_err() {
        return uuid::Uuid::new_v4().to_string().replace('-', "");
    }
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

fn mona_dir() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".mona")
}

/// Persist port + token as one metadata file so the Python side can
/// authenticate every bridge request.
fn write_meta_file(port: u16, token: &str) {
    let dir = mona_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(IPC_META_FILE_NAME);
    let content = serde_json::json!({ "port": port, "token": token }).to_string();
    if let Err(e) = std::fs::write(&path, content) {
        log::error!("Failed to write IPC bridge meta file {:?}: {}", path, e);
    } else {
        log::info!("IPC bridge metadata written to {:?}", path);
    }
    // Remove the stale token-less port file so old consumers cannot mistake
    // the bridge for an unauthenticated one.
    let _ = std::fs::remove_file(dir.join(LEGACY_PORT_FILE_NAME));
}

pub fn remove_port_file() {
    let dir = mona_dir();
    let _ = std::fs::remove_file(dir.join(IPC_META_FILE_NAME));
    let _ = std::fs::remove_file(dir.join(LEGACY_PORT_FILE_NAME));
}

fn extract_token(request: &str) -> Option<&str> {
    let header_end = request.find("\r\n\r\n")?;
    for line in request[..header_end].lines() {
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case(TOKEN_HEADER) {
                return Some(value.trim());
            }
        }
    }
    None
}

fn token_matches(provided: &str, expected: &str) -> bool {
    let (a, b) = (provided.as_bytes(), expected.as_bytes());
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

pub struct IpcBridge {
    app_handle: tauri::AppHandle,
    token: String,
}

impl IpcBridge {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self {
            app_handle,
            token: generate_token(),
        }
    }

    pub async fn start(self: Arc<Self>, terminal_state: TerminalState) -> Result<(), String> {
        let listener = {
            let mut found = None;
            for port in IPC_PORT_RANGE {
                match tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port)).await {
                    Ok(l) => {
                        found = Some(l);
                        break;
                    }
                    Err(_) => continue,
                }
            }
            found.ok_or("IPC bridge: no available port in range 17860-17870")?
        };

        let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();
        log::info!("IPC bridge listening on http://127.0.0.1:{}", actual_port);
        write_meta_file(actual_port, &self.token);

        loop {
            let (stream, _) = listener
                .accept()
                .await
                .map_err(|e| format!("IPC bridge accept failed: {}", e))?;

            let bridge = self.clone();
            let ts = terminal_state.clone();
            tokio::spawn(async move {
                if let Err(e) = bridge.handle_connection(stream, ts).await {
                    log::error!("IPC bridge connection error: {}", e);
                }
            });
        }
    }

    async fn handle_connection(
        &self,
        stream: tokio::net::TcpStream,
        terminal_state: TerminalState,
    ) -> Result<(), String> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut buf = vec![0u8; 131072];
        let (mut reader, mut writer) = stream.into_split();

        // Read the full HTTP request. TCP is a stream protocol, so a single
        // read may not return the complete payload. Loop until we have at
        // least the headers AND the full body (per Content-Length).
        let mut total = 0;
        let mut content_length: Option<usize> = None;
        loop {
            let n = reader
                .read(&mut buf[total..])
                .await
                .map_err(|e| format!("Read failed: {}", e))?;
            if n == 0 {
                break;
            }
            total += n;

            // Try to parse headers once we have enough data.
            if content_length.is_none() {
                let s = String::from_utf8_lossy(&buf[..total]);
                if let Some(header_end) = s.find("\r\n\r\n") {
                    let headers = &s[..header_end];
                    for line in headers.lines() {
                        if let Some(val) = line.strip_prefix("Content-Length:") {
                            content_length = Some(val.trim().parse::<usize>().unwrap_or(0));
                            break;
                        }
                    }
                    if let Some(cl) = content_length {
                        let header_len = header_end + 4; // +4 for \r\n\r\n
                        if total >= header_len + cl {
                            break; // We have the full request
                        }
                    } else {
                        // No Content-Length header — assume body is everything after headers
                        break;
                    }
                }
            } else if let Some(cl) = content_length {
                let s = String::from_utf8_lossy(&buf[..total]);
                if let Some(header_end) = s.find("\r\n\r\n") {
                    let header_len = header_end + 4;
                    if total >= header_len + cl {
                        break;
                    }
                }
            }

            if total >= buf.len() {
                buf.resize(buf.len() * 2, 0);
            }
        }

        if total == 0 {
            return Ok(());
        }

        let request_str = String::from_utf8_lossy(&buf[..total]);

        // Token gate: unauthenticated requests never reach command dispatch.
        let authorized = extract_token(&request_str)
            .map(|t| token_matches(t, &self.token))
            .unwrap_or(false);
        if !authorized {
            let body = serde_json::json!({"error": "Unauthorized"}).to_string();
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            writer
                .write_all(response.as_bytes())
                .await
                .map_err(|e| format!("Write failed: {}", e))?;
            let _ = writer.flush().await;
            log::warn!("IPC bridge rejected unauthenticated request");
            return Ok(());
        }

        let body = extract_body(&request_str);

        let response_body = match body {
            Some(body_str) => {
                let invoke_req: serde_json::Value =
                    serde_json::from_str(body_str).unwrap_or_default();
                let cmd = invoke_req
                    .get("cmd")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let args = invoke_req.get("args").cloned().unwrap_or_default();

                log::debug!("IPC bridge received cmd={:?}, args keys={:?}", cmd, args.as_object().map(|o| o.keys().collect::<Vec<_>>()));

                let result = self
                    .dispatch_command(cmd, args, &terminal_state)
                    .await;

                match result {
                    Ok(v) => serde_json::json!({"result": v}),
                    Err(e) => serde_json::json!({"error": e}),
                }
            }
            None => serde_json::json!({"error": "No request body"}),
        };

        let response_str = serde_json::to_string(&response_body).unwrap_or_default();
        let http_response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_str.len(),
            response_str
        );

        writer
            .write_all(http_response.as_bytes())
            .await
            .map_err(|e| format!("Write failed: {}", e))?;
        writer
            .flush()
            .await
            .map_err(|e| format!("Flush failed: {}", e))?;

        Ok(())
    }

    async fn dispatch_command(
        &self,
        cmd: &str,
        args: Value,
        state: &TerminalState,
    ) -> Result<Value, String> {
        match cmd {
            "terminal_list_sessions" => {
                let sessions = state.manager.list_sessions().await;
                serde_json::to_value(sessions).map_err(|e| e.to_string())
            }
            "terminal_get_output" => {
                let session_id = args
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing sessionId")?;
                let handle = state
                    .manager
                    .get_handle(session_id)
                    .await
                    .ok_or(format!("Session not found: {}", session_id))?;
                match handle {
                    crate::terminal::session::SessionHandle::Ssh(client)
                    | crate::terminal::session::SessionHandle::Desktop(client) => {
                        Ok(Value::String(client.get_buffer()))
                    }
                    crate::terminal::session::SessionHandle::Local(shell) => {
                        Ok(Value::String(shell.get_buffer()))
                    }
                    _ => Err("Cannot get output from this session type".into()),
                }
            }
            "terminal_exec_command" => {
                let session_id = args
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing sessionId")?;
                let command = args
                    .get("command")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing command")?;
                let source = args.get("source").and_then(|v| v.as_str());

                if source == Some("ai") && is_dangerous_command(command) {
                    return Err(
                        "Dangerous command requires approval. Use terminal_request_exec instead."
                            .into(),
                    );
                }

                let data = format!("{}\n", command);
                let handle = state
                    .manager
                    .get_handle(session_id)
                    .await
                    .ok_or(format!("Session not found: {}", session_id))?;

                match handle {
                    crate::terminal::session::SessionHandle::Ssh(client) => client
                        .write(data.as_bytes())
                        .await
                        .map_err(|e| e.to_string()),
                    crate::terminal::session::SessionHandle::Local(shell) => shell
                        .write(data.as_bytes())
                        .map_err(|e| e.to_string()),
                    _ => Err("Cannot execute command in this session type".into()),
                }?;
                Ok(Value::Null)
            }
            "terminal_request_exec" => {
                let session_id = args
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing sessionId")?;
                let command = args
                    .get("command")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing command")?;
                let source = args
                    .get("source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("AI Agent");

                let (pending, rx) = state
                    .approval
                    .manager
                    .submit(session_id.to_string(), command.to_string(), source.to_string())
                    .await;

                let payload = serde_json::json!({
                    "requestId": pending.request_id,
                    "sessionId": pending.session_id,
                    "command": pending.command,
                    "source": pending.source,
                });
                let _ = self.app_handle.emit("terminal-exec-request", &payload);

                match rx.await {
                    Ok(crate::terminal::approval::ApprovalVerdict::Approved) => {
                        Ok(serde_json::json!({"status": "approved"}))
                    }
                    Ok(crate::terminal::approval::ApprovalVerdict::Rejected { reason }) => {
                        Err(format!("Command rejected: {}", reason))
                    }
                    Err(_) => Err("Approval channel closed".to_string()),
                }
            }
            "terminal_upload_file" => {
                let session_id = args
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing sessionId")?;
                let remote_path = args
                    .get("remotePath")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing remotePath")?;
                let content_b64 = args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing content (base64)")?;

                let data = base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    content_b64,
                )
                .map_err(|e| format!("Invalid base64 content: {}", e))?;

                let handle = state
                    .manager
                    .get_handle(session_id)
                    .await
                    .ok_or(format!("Session not found: {}", session_id))?;

                match handle {
                    crate::terminal::session::SessionHandle::Ssh(client) => {
                        let sftp_session = client
                            .open_sftp()
                            .await
                            .map_err(|e| format!("Failed to open SFTP: {}", e))?;
                        sftp_session
                            .write(remote_path, &data)
                            .await
                            .map_err(|e| format!("SFTP upload failed: {}", e))?;
                        Ok(serde_json::json!({
                            "status": "uploaded",
                            "remotePath": remote_path,
                            "bytes": data.len()
                        }))
                    }
                    _ => Err("File upload is only supported for SSH sessions".into()),
                }
            }
            "terminal_list_pending_exec" => {
                let pending = state.approval.manager.list_pending().await;
                serde_json::to_value(pending).map_err(|e| e.to_string())
            }
            "terminal_maintenance_start" => {
                maintenance_cmds::bridge_start(&self.app_handle, state, &args).await
            }
            "terminal_maintenance_execute_step" => {
                maintenance_cmds::bridge_execute_step(&self.app_handle, state, &args).await
            }
            "terminal_maintenance_execute_upload" => {
                maintenance_cmds::bridge_execute_upload(&self.app_handle, state, &args).await
            }
            "terminal_maintenance_finish" => {
                maintenance_cmds::bridge_finish(&self.app_handle, state, &args).await
            }
            "terminal_maintenance_fail" => {
                maintenance_cmds::bridge_fail(&self.app_handle, state, &args).await
            }
            "db_execute_query" => {
                let db_state = self.app_handle.state::<crate::db::DbState>();
                let connection_id = args.get("connectionId").and_then(|v| v.as_str()).ok_or("Missing connectionId")?;
                let sql = args.get("sql").and_then(|v| v.as_str()).ok_or("Missing sql")?;
                let limit = args.get("limit").and_then(|v| v.as_u64());
                let database = args.get("database").and_then(|v| v.as_str());
                let handle = {
                    let manager = db_state.manager.lock().await;
                    manager.get_handle(connection_id)
                        .ok_or_else(|| format!("Connection {} not found", connection_id))?
                };
                let result = crate::db::manager::execute_on_handle(&handle, sql, limit, database)
                    .await
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "db_get_table_info" => {
                let db_state = self.app_handle.state::<crate::db::DbState>();
                let connection_id = args.get("connectionId").and_then(|v| v.as_str()).ok_or("Missing connectionId")?;
                let database = args.get("database").and_then(|v| v.as_str()).ok_or("Missing database")?;
                let table = args.get("table").and_then(|v| v.as_str()).ok_or("Missing table")?;
                let handle = {
                    let manager = db_state.manager.lock().await;
                    manager.get_handle(connection_id)
                        .ok_or_else(|| format!("Connection {} not found", connection_id))?
                };
                let result = crate::db::manager::get_table_info_on_handle(&handle, database, table)
                    .await
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "db_get_server_stats" => {
                let db_state = self.app_handle.state::<crate::db::DbState>();
                let connection_id = args.get("connectionId").and_then(|v| v.as_str()).ok_or("Missing connectionId")?;
                let handle = {
                    let manager = db_state.manager.lock().await;
                    manager.get_handle(connection_id)
                        .ok_or_else(|| format!("Connection {} not found", connection_id))?
                };
                let result = crate::db::manager::get_server_stats_on_handle(&handle)
                    .await
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "db_execute_ai_read" => {
                let db_state = self.app_handle.state::<crate::db::DbState>();
                let connection_id = args.get("connectionId").and_then(|v| v.as_str()).ok_or("Missing connectionId")?;
                let sql = args.get("sql").and_then(|v| v.as_str()).ok_or("Missing sql")?;
                let database = args.get("database").and_then(|v| v.as_str());
                let handle = {
                    let manager = db_state.manager.lock().await;
                    manager.get_handle(connection_id)
                        .ok_or_else(|| format!("Connection {} not found", connection_id))?
                };
                let result = crate::db::manager::execute_on_handle(&handle, sql, Some(100), database)
                    .await
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "db_ai_inspect" => {
                let db_state = self.app_handle.state::<crate::db::DbState>();
                let connection_id = args.get("connectionId").and_then(|v| v.as_str()).ok_or("Missing connectionId")?;
                let action = args.get("action").and_then(|v| v.as_str()).ok_or("Missing action")?;
                let database = args.get("database").and_then(|v| v.as_str());
                let table = args.get("table").and_then(|v| v.as_str());
                let sql_param = args.get("sql").and_then(|v| v.as_str());

                let (handle, server_version) = {
                    let manager = db_state.manager.lock().await;
                    let (h, c, v) = manager.get_handle_with_version(connection_id)
                        .ok_or_else(|| format!("Connection {} not found", connection_id))?;
                    ((h, c), v)
                };

                let db_type = match handle.1.db_type {
                    crate::db::types::DatabaseType::Mysql => "mysql",
                    crate::db::types::DatabaseType::Sqlite => "sqlite",
                    _ => "unknown",
                };

                match action {
                    "connection" => {
                        let mut lines = vec![
                            format!("Database type: {}", db_type),
                            format!("Server version: {}", server_version.unwrap_or_default()),
                        ];
                        if let Some(db) = &database {
                            lines.push(format!("Current database: {}", db));
                        }
                        Ok(Value::String(lines.join("\n")))
                    }
                    "table" => {
                        let table_name = table.ok_or("table parameter required for 'table' action")?;
                        let db = database.unwrap_or("main");
                        let info = crate::db::manager::get_table_info_on_handle(&handle, db, table_name)
                            .await
                            .map_err(|e| e.to_string())?;
                        let mut lines = vec![format!("Table: {}.{}", db, info.name)];
                        if let Some(engine) = &info.engine {
                            lines.push(format!("Engine: {}", engine));
                        }
                        if let Some(row_count) = info.row_count {
                            lines.push(format!("Estimated rows: {}", row_count));
                        }
                        lines.push("Columns:".to_string());
                        for col in &info.columns {
                            let pk = if col.is_primary_key { " [PK]" } else { "" };
                            let nullable = if col.nullable { "" } else { " NOT NULL" };
                            lines.push(format!("  {} {}{}{}", col.name, col.data_type, nullable, pk));
                        }
                        Ok(Value::String(lines.join("\n")))
                    }
                    "indexes" => {
                        let table_name = table.ok_or("table parameter required for 'indexes' action")?;
                        let db = database.unwrap_or("main");
                        let info = crate::db::manager::get_table_info_on_handle(&handle, db, table_name)
                            .await
                            .map_err(|e| e.to_string())?;
                        if info.indexes.is_empty() {
                            return Ok(Value::String("No indexes found.".to_string()));
                        }
                        let mut lines = vec!["Indexes:".to_string()];
                        for idx in &info.indexes {
                            let unique = if idx.is_unique { "UNIQUE " } else { "" };
                            let primary = if idx.is_primary { "PRIMARY " } else { "" };
                            let idx_type = idx.index_type.as_deref().unwrap_or("");
                            lines.push(format!("  {}{}{} ({}) [{}]", primary, unique, idx.name, idx.columns.join(", "), idx_type));
                        }
                        Ok(Value::String(lines.join("\n")))
                    }
                    "explain" => {
                        let sql_str = sql_param.ok_or("sql parameter required for 'explain' action")?;
                        let explain_sql = if sql_str.trim().to_uppercase().starts_with("EXPLAIN") {
                            sql_str.to_string()
                        } else {
                            format!("EXPLAIN {}", sql_str)
                        };
                        let result = crate::db::manager::execute_on_handle(&handle, &explain_sql, Some(100), database)
                            .await
                            .map_err(|e| e.to_string())?;
                        let mut lines = vec!["EXPLAIN result:".to_string()];
                        let col_names: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
                        lines.push(col_names.join(" | "));
                        for row in &result.rows {
                            let cells: Vec<String> = row.iter().map(|cell| {
                                match cell {
                                    crate::db::types::CellValue::Null => "NULL".to_string(),
                                    crate::db::types::CellValue::Integer(i) => i.to_string(),
                                    crate::db::types::CellValue::Float(f) => f.to_string(),
                                    crate::db::types::CellValue::Text(s) => s.clone(),
                                    crate::db::types::CellValue::Blob(b) => format!("0x{}", b),
                                    crate::db::types::CellValue::Bool(b) => b.to_string(),
                                }
                            }).collect();
                            lines.push(cells.join(" | "));
                        }
                        Ok(Value::String(lines.join("\n")))
                    }
                    "health" => {
                        match handle.1.db_type {
                            crate::db::types::DatabaseType::Mysql => {
                                let stats = crate::db::manager::get_server_stats_on_handle(&handle)
                                    .await
                                    .map_err(|e| e.to_string())?;
                                let lines = vec![
                                    format!("Connections: {}/{}", stats.connections, stats.max_connections),
                                    format!("QPS: {}", stats.qps),
                                    format!("Slow queries: {}", stats.slow_queries),
                                    format!("Buffer pool hit rate: {}", stats.buffer_pool_hit_rate.map(|r| format!("{:.1}%", r)).unwrap_or_else(|| "N/A".to_string())),
                                    format!("Uptime: {}s", stats.uptime_seconds.unwrap_or(0)),
                                ];
                                Ok(Value::String(lines.join("\n")))
                            }
                            crate::db::types::DatabaseType::Sqlite => {
                                let pragmas = vec!["PRAGMA integrity_check", "PRAGMA journal_mode", "PRAGMA page_count"];
                                let mut lines = vec![];
                                for pragma in pragmas {
                                    let result = crate::db::manager::execute_on_handle(&handle, pragma, None, None)
                                        .await
                                        .map_err(|e| e.to_string())?;
                                    let val = if !result.rows.is_empty() && !result.rows[0].is_empty() {
                                        match &result.rows[0][0] {
                                            crate::db::types::CellValue::Text(s) => s.clone(),
                                            crate::db::types::CellValue::Integer(i) => i.to_string(),
                                            _ => "N/A".to_string(),
                                        }
                                    } else {
                                        "N/A".to_string()
                                    };
                                    lines.push(format!("{}: {}", pragma, val));
                                }
                                Ok(Value::String(lines.join("\n")))
                            }
                            _ => Err("Health check not supported for this database type".to_string()),
                        }
                    }
                    _ => Err(format!("Unknown inspect action: {}", action)),
                }
            }
            "db_publish_sql_draft" => {
                let sql = args.get("sql").and_then(|v| v.as_str()).ok_or("Missing sql")?;
                let statement_type = args.get("statementType").and_then(|v| v.as_str()).ok_or("Missing statementType")?;
                let target_objects: Vec<String> = args.get("targetObjects")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                let operation_class = args.get("operationClass").and_then(|v| v.as_str()).ok_or("Missing operationClass")?;
                let explanation = args.get("explanation").and_then(|v| v.as_str()).ok_or("Missing explanation")?;

                let draft = crate::db::types::DbSqlDraft {
                    sql: sql.to_string(),
                    statement_type: statement_type.to_string(),
                    target_objects,
                    operation_class: operation_class.to_string(),
                    explanation: explanation.to_string(),
                };

                self.app_handle
                    .emit("db-sql-draft-ready", &draft)
                    .map_err(|e| format!("Failed to emit SQL draft event: {}", e))?;

                Ok(Value::String("SQL draft published.".to_string()))
            }
            "report_save_temp" => {
                let title = args
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("report");
                let content = args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing content")?;

                let workspace = crate::notes::read_workspace_path_from_config();
                let tmp_dir = workspace.join(".mona").join("tmp").join("reports");
                std::fs::create_dir_all(&tmp_dir)
                    .map_err(|e| format!("Failed to create reports dir: {}", e))?;

                let safe_name = title
                    .replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");
                let file_name = format!(
                    "{}_{}.html",
                    safe_name,
                    chrono::Local::now().format("%Y%m%d%H%M%S")
                );
                let file_path = tmp_dir.join(&file_name);
                std::fs::write(&file_path, content)
                    .map_err(|e| format!("Failed to write report: {}", e))?;

                let abs_path = file_path
                    .to_str()
                    .ok_or("Invalid report path")?
                    .to_string();

                self.app_handle
                    .emit(
                        "terminal-report-ready",
                        serde_json::json!({
                            "title": title,
                            "path": &abs_path,
                            "fileName": file_name,
                        }),
                    )
                    .map_err(|e| format!("Failed to emit report event: {}", e))?;

                Ok(serde_json::json!({
                    "status": "saved",
                    "path": abs_path,
                    "fileName": file_name,
                }))
            }
            "browser_create_tab" => {
                let browser_state = self.app_handle.state::<crate::browser::BrowserState>();
                let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing id")?;
                let url = args.get("url").and_then(|v| v.as_str()).ok_or("Missing url")?;
                let is_incognito = args.get("isIncognito").and_then(|v| v.as_bool()).unwrap_or(false);
                let ad_block_enabled = args.get("adBlockEnabled").and_then(|v| v.as_bool()).unwrap_or(true);
                let result = browser_state.create_tab(&self.app_handle, id, url, is_incognito, ad_block_enabled).await?;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            "browser_close_tab" => {
                let browser_state = self.app_handle.state::<crate::browser::BrowserState>();
                let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing id")?;
                browser_state.close_tab(&self.app_handle, id).await?;
                Ok(Value::Null)
            }
            "browser_navigate_tab" => {
                let browser_state = self.app_handle.state::<crate::browser::BrowserState>();
                let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing id")?;
                let url = args.get("url").and_then(|v| v.as_str()).ok_or("Missing url")?;
                browser_state.navigate_tab(&self.app_handle, id, url).await?;
                Ok(Value::Null)
            }
            "browser_go_back" => {
                let browser_state = self.app_handle.state::<crate::browser::BrowserState>();
                let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing id")?;
                browser_state.go_back(&self.app_handle, id).await?;
                Ok(Value::Null)
            }
            "browser_go_forward" => {
                let browser_state = self.app_handle.state::<crate::browser::BrowserState>();
                let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing id")?;
                browser_state.go_forward(&self.app_handle, id).await?;
                Ok(Value::Null)
            }
            "browser_reload" => {
                let browser_state = self.app_handle.state::<crate::browser::BrowserState>();
                let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing id")?;
                browser_state.reload(&self.app_handle, id).await?;
                Ok(Value::Null)
            }
            "browser_list_tabs" => {
                let browser_state = self.app_handle.state::<crate::browser::BrowserState>();
                let tabs = browser_state.list_tabs();
                serde_json::to_value(tabs).map_err(|e| e.to_string())
            }
            "browser_get_cdp_port" => {
                let browser_state = self.app_handle.state::<crate::browser::BrowserState>();
                let id = args.get("id").and_then(|v| v.as_str()).ok_or("Missing id")?;
                let port = browser_state.get_cdp_port(id)?;
                Ok(Value::Number(port.into()))
            }
            "notes_vault_get_path" => {
                let path = crate::notes::notes_vault_get_path().await?;
                serde_json::to_value(path).map_err(|e| e.to_string())
            }
            "notes_create_from_chat" => {
                let title = args
                    .get("title")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing title")?
                    .to_string();
                let content_markdown = args
                    .get("contentMarkdown")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing contentMarkdown")?
                    .to_string();
                let notebook_id = args
                    .get("notebookId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let note_id = crate::notes::notes_create_from_chat(
                    title,
                    content_markdown,
                    notebook_id,
                )
                .await?;
                Ok(Value::String(note_id))
            }
            "notes_search_all" => {
                let query = args
                    .get("query")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing query")?
                    .to_string();
                let limit = args
                    .get("limit")
                    .and_then(|v| v.as_i64())
                    .map(|n| n as usize);
                let results = crate::notes::notes_search_all(query, limit).await?;
                serde_json::to_value(results).map_err(|e| e.to_string())
            }
            "notes_read_note_content" => {
                let note_id = args
                    .get("noteId")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing noteId")?
                    .to_string();
                let content = crate::notes::notes_read_note_content(note_id).await?;
                serde_json::to_value(content).map_err(|e| e.to_string())
            }
            "notes_save_image" => {
                let file_path = args
                    .get("filePath")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing filePath")?
                    .to_string();
                let file_name = args
                    .get("fileName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let saved_path =
                    crate::notes::notes_save_image(file_path, file_name).await?;
                Ok(Value::String(saved_path))
            }
            "license_has_access" => {
                let has_access = crate::license::check_license_access();
                Ok(Value::Bool(has_access))
            }
            "email_fetch_body" => {
                // 纯本地 Tauri IPC：读 SQLite + 读 .eml + mailparse 解析。
                // 仅在本地 .eml 不存在或解析失败时，才回退到 gateway 拉取（gatewayUrl 可选）。
                let gateway_url = args
                    .get("gatewayUrl")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let account_id = args
                    .get("accountId")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing accountId")?
                    .to_string();
                let uid = args
                    .get("uid")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing uid")?
                    .to_string();
                let mailbox = args
                    .get("mailbox")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing mailbox")?
                    .to_string();
                let email_state = self.app_handle.state::<crate::email::EmailState>();
                crate::email::email_fetch_body(
                    email_state,
                    self.app_handle.clone(),
                    account_id,
                    uid,
                    mailbox,
                    Some(gateway_url),
                )
                .await
            }
            "write_mona_provider_config" => {
                let provider = args
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing provider")?;
                let api_key = args
                    .get("apiKey")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing apiKey")?;
                let api_base = args.get("apiBase").and_then(|v| v.as_str());
                crate::settings::write_mona_provider_config(provider, api_key, api_base)
                    .map(|_| Value::Null)
            }
            "write_mona_model_config" => {
                let model = args
                    .get("model")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing model")?;
                let provider = args
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing provider")?;
                crate::settings::write_mona_model_config(model, provider).map(|_| Value::Null)
            }
            "write_mona_image_gen_config" => {
                let provider = args
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing provider")?;
                let model = args
                    .get("model")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing model")?;
                let enabled = args.get("enabled").and_then(|v| v.as_bool());
                crate::settings::write_mona_image_gen_config(provider, model, enabled)
                    .map(|_| Value::Null)
            }
            "write_mona_video_gen_config" => {
                let provider = args
                    .get("provider")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing provider")?;
                let model = args
                    .get("model")
                    .and_then(|v| v.as_str())
                    .ok_or("Missing model")?;
                let enabled = args.get("enabled").and_then(|v| v.as_bool());
                crate::settings::write_mona_video_gen_config(provider, model, enabled)
                    .map(|_| Value::Null)
            }
            _ => Err(format!("Unknown command: {}", cmd)),
        }
    }
}

fn is_dangerous_command(cmd: &str) -> bool {
    let lower = cmd.to_lowercase();
    let patterns = [
        "rm -rf /",
        "rm -rf /*",
        "mkfs.",
        "dd if=",
        "> /dev/sd",
        ":(){ :|:& };:",
    ];
    patterns.iter().any(|p| lower.contains(p))
}

fn extract_body(request: &str) -> Option<&str> {
    let header_end = request.find("\r\n\r\n")?;
    Some(&request[header_end + 4..])
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQ: &str = "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}";

    #[test]
    fn missing_token_is_rejected() {
        assert!(extract_token(REQ).is_none());
        let expected = "abc123";
        let authorized = extract_token(REQ)
            .map(|t| token_matches(t, expected))
            .unwrap_or(false);
        assert!(!authorized);
    }

    #[test]
    fn wrong_token_is_rejected() {
        let req = format!(
            "POST / HTTP/1.1\r\nX-Mona-Ipc-Token: wrong\r\nContent-Length: 2\r\n\r\n{{}}"
        );
        assert!(!token_matches(extract_token(&req).unwrap(), "right-token"));
    }

    #[test]
    fn correct_token_is_accepted_case_insensitive_header() {
        let expected = generate_token();
        let req = format!(
            "POST / HTTP/1.1\r\nx-mona-ipc-token: {}\r\nContent-Length: 2\r\n\r\n{{}}",
            expected
        );
        assert!(token_matches(extract_token(&req).unwrap(), &expected));
    }

    #[test]
    fn token_compare_is_length_safe() {
        assert!(!token_matches("short", "much-longer-token"));
        assert!(token_matches("same-len-a", "same-len-a"));
        assert!(!token_matches("same-len-a", "same-len-b"));
    }

    #[test]
    fn generated_tokens_are_unique_and_hex() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }
}
