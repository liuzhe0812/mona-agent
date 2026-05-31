use std::sync::Arc;

use crate::terminal::TerminalState;
use serde_json::Value;
use tauri::Emitter;
use tauri::Manager;

const IPC_PORT_FILE_NAME: &str = "ipc_bridge_port";
const IPC_PORT_RANGE: std::ops::Range<u16> = 17860..17871;

fn write_port_file(port: u16) {
    let dir = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join(".mona");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(IPC_PORT_FILE_NAME);
    if let Err(e) = std::fs::write(&path, port.to_string()) {
        log::error!("Failed to write IPC bridge port file {:?}: {}", path, e);
    } else {
        log::info!("IPC bridge port {} written to {:?}", port, path);
    }
}

pub fn remove_port_file() {
    let path = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".mona")
        .join(IPC_PORT_FILE_NAME);
    let _ = std::fs::remove_file(&path);
}

pub struct IpcBridge {
    app_handle: tauri::AppHandle,
}

impl IpcBridge {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
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
        write_port_file(actual_port);

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

        let mut buf = vec![0u8; 65536];
        let (mut reader, mut writer) = stream.into_split();
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| format!("Read failed: {}", e))?;

        if n == 0 {
            return Ok(());
        }

        let request_str = String::from_utf8_lossy(&buf[..n]);
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
                    crate::terminal::session::SessionHandle::Ssh(client) => {
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

                let (pending, mut rx) = state
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
