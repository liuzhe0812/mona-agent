use std::sync::Arc;

use crate::terminal::TerminalState;
use serde_json::Value;

pub struct IpcBridge {
    port: u16,
}

impl IpcBridge {
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub async fn start(self: Arc<Self>, terminal_state: TerminalState) -> Result<(), String> {
        let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", self.port))
            .await
            .map_err(|e| format!("IPC bridge bind failed: {}", e))?;

        log::info!("IPC bridge listening on http://127.0.0.1:{}", self.port);

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

                let result = self.dispatch_command(cmd, args, &terminal_state).await;

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

                let (pending, _rx) = state
                    .approval
                    .manager
                    .submit(session_id.to_string(), command.to_string(), source.to_string())
                    .await;

                Ok(serde_json::json!({
                    "requestId": pending.request_id,
                    "status": "pending"
                }))
            }
            "terminal_list_pending_exec" => {
                let pending = state.approval.manager.list_pending().await;
                serde_json::to_value(pending).map_err(|e| e.to_string())
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
