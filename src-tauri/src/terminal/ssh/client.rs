use std::sync::Arc;
use std::time::Duration;

use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{client, ChannelMsg, ChannelWriteHalf, Disconnect};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::terminal::config::AuthConfig;
use crate::terminal::error::TerminalError;
use crate::terminal::session::{SessionManager, SessionStatus};
use crate::terminal::shell::local::ScrollBuffer;
use crate::terminal::ssh::agent::SshAgentClient;
use crate::terminal::ssh::known_hosts::{HostKeyVerification, KnownHostsStore};

#[derive(serde::Serialize)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredExecResult {
    pub stdout: String,
    pub stderr: String,
    /// `None` only when the connection dropped or the channel closed before
    /// the remote exit-status arrived — such results must not be treated as
    /// success.
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub cancelled: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum ExecOutputStream {
    Stdout,
    Stderr,
}

pub struct SshClientHandler {
    host: String,
    port: u16,
    known_hosts: Arc<KnownHostsStore>,
    verification_result: Arc<Mutex<Option<HostKeyVerification>>>,
}

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let result = self
            .known_hosts
            .verify(&self.host, self.port, server_public_key);
        *self.verification_result.lock().await = Some(result);
        Ok(true)
    }
}

pub struct SshClient {
    pub handle: Arc<Mutex<client::Handle<SshClientHandler>>>,
    writer: Arc<Mutex<Option<ChannelWriteHalf<client::Msg>>>>,
    scroll_buffer: Arc<ScrollBuffer>,
}

/// Stop waiting on a command whose step was cancelled or timed out.
///
/// This deliberately does NOT try to kill the remote process. Verified against
/// a real OpenSSH 9.6p1 host: the SSH signal request is never delivered to the
/// command, and neither closing the channel nor dropping the connection makes
/// sshd reap it. The only mechanism that worked was running an explicit
/// `kill` over a second channel, which is not worth the machinery — and for
/// package operations it is actively harmful, since killing apt/dpkg
/// mid-transaction is what leaves a stale lock and a half-configured database.
///
/// So the remote command is left running and the caller is told the outcome is
/// unknown. The connection stays healthy for subsequent steps.
async fn abandon_channel(channel: &mut russh::Channel<client::Msg>) {
    let _ = channel.eof().await;
    let _ = channel.close().await;
}

impl SshClient {
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        auth: &AuthConfig,
        known_hosts: Arc<KnownHostsStore>,
    ) -> Result<Self, TerminalError> {
        Self::connect_with_verify(host, port, username, auth, known_hosts, false).await
    }

    pub async fn connect_skip_verify(
        host: &str,
        port: u16,
        username: &str,
        auth: &AuthConfig,
    ) -> Result<Self, TerminalError> {
        let known_hosts = Arc::new(KnownHostsStore::new_in_memory());
        Self::connect_with_verify(host, port, username, auth, known_hosts, true).await
    }

    async fn connect_with_verify(
        host: &str,
        port: u16,
        username: &str,
        auth: &AuthConfig,
        known_hosts: Arc<KnownHostsStore>,
        skip_verify: bool,
    ) -> Result<Self, TerminalError> {
        let verification_result = Arc::new(Mutex::new(None));

        let config = client::Config {
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            ..Default::default()
        };
        let config = Arc::new(config);
        let handler = SshClientHandler {
            host: host.to_string(),
            port,
            known_hosts: known_hosts.clone(),
            verification_result: verification_result.clone(),
        };

        let connect_timeout = Duration::from_secs(15);
        let mut handle = tokio::time::timeout(
            connect_timeout,
            client::connect(config, (host, port), handler),
        )
        .await
        .map_err(|_| {
            log::error!(
                "[batch] SSH connect timeout for {}:{} after {}s",
                host,
                port,
                connect_timeout.as_secs()
            );
            TerminalError::SshConnection(format!(
                "连接超时: 无法在{}秒内连接到 {}:{}",
                connect_timeout.as_secs(),
                host,
                port
            ))
        })?
        .map_err(|e| {
            log::error!("[batch] SSH connect failed for {}:{}: {}", host, port, e);
            TerminalError::SshConnection(e.to_string())
        })?;

        let verification = verification_result.lock().await;
        match verification.as_ref() {
            Some(HostKeyVerification::Trusted) => {}
            Some(HostKeyVerification::Unknown { fingerprint }) => {
                if skip_verify {
                    log::debug!(
                        "[batch] Skipping host key verification for {}:{} (fingerprint: {})",
                        host,
                        port,
                        fingerprint
                    );
                } else {
                    let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
                    return Err(TerminalError::HostKeyUnknown(fingerprint.clone()));
                }
            }
            Some(HostKeyVerification::Changed {
                expected_fingerprint,
                actual_fingerprint,
            }) => {
                if skip_verify {
                    log::warn!(
                        "[batch] Host key changed for {}:{}, skipping verification",
                        host,
                        port
                    );
                } else {
                    let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
                    return Err(TerminalError::HostKeyChanged {
                        expected: expected_fingerprint.clone(),
                        actual: actual_fingerprint.clone(),
                    });
                }
            }
            None => {
                if skip_verify {
                    log::debug!(
                        "[batch] No host key verification performed for {}:{}, continuing",
                        host,
                        port
                    );
                } else {
                    let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
                    return Err(TerminalError::SshConnection(
                        "Host key verification not performed".into(),
                    ));
                }
            }
        }

        match auth {
            AuthConfig::Password { password } => {
                log::debug!(
                    "[batch] Authenticating with password for {}@{}:{} (pwd_len={})",
                    username,
                    host,
                    port,
                    password.len()
                );
                let auth_result = handle
                    .authenticate_password(username, password.as_str())
                    .await
                    .map_err(|e| {
                        log::error!(
                            "[batch] authenticate_password error for {}@{}:{}: {}",
                            username,
                            host,
                            port,
                            e
                        );
                        TerminalError::AuthFailed(e.to_string())
                    })?;
                if !auth_result.success() {
                    log::error!(
                        "[batch] Password authentication rejected for {}@{}:{} (pwd_len={})",
                        username,
                        host,
                        port,
                        password.len()
                    );
                    return Err(TerminalError::AuthFailed(
                        "Password authentication failed".into(),
                    ));
                }
                log::debug!(
                    "[batch] Password authentication succeeded for {}@{}:{}",
                    username,
                    host,
                    port
                );
            }
            AuthConfig::KeyFile {
                key_path,
                passphrase: _,
            } => {
                let key_pair = load_secret_key(key_path, None)
                    .map_err(|e| TerminalError::AuthFailed(e.to_string()))?;
                let auth_result = handle
                    .authenticate_publickey(
                        username,
                        PrivateKeyWithHashAlg::new(Arc::new(key_pair), None),
                    )
                    .await
                    .map_err(|e| TerminalError::AuthFailed(e.to_string()))?;
                if !auth_result.success() {
                    return Err(TerminalError::AuthFailed(
                        "Public key authentication failed".into(),
                    ));
                }
            }
            AuthConfig::Agent => {
                let mut agent_client = SshAgentClient::connect().await?;
                agent_client.authenticate(&mut handle, username).await?;
            }
        }

        Ok(Self {
            handle: Arc::new(Mutex::new(handle)),
            writer: Arc::new(Mutex::new(None)),
            scroll_buffer: Arc::new(ScrollBuffer::new()),
        })
    }

    pub async fn start_shell(
        &self,
        app_handle: AppHandle,
        session_manager: Option<(SessionManager, i64)>,
        session_id: String,
        cols: u32,
        rows: u32,
    ) -> Result<(), TerminalError> {
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        channel
            .request_shell(true)
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        let (read_half, write_half) = channel.split();
        *self.writer.lock().await = Some(write_half);

        let sb = self.scroll_buffer.clone();
        tokio::spawn(async move {
            let mut reader = read_half;
            loop {
                let message = reader.wait().await;
                if let Some((manager, generation)) = session_manager.as_ref() {
                    if !manager
                        .is_generation_current(&session_id, *generation)
                        .await
                    {
                        break;
                    }
                }
                match message {
                    Some(ChannelMsg::Data { data }) => {
                        let output = String::from_utf8_lossy(&data).to_string();
                        sb.push(output);
                        let payload = serde_json::json!({
                            "sessionId": session_id,
                            "data": String::from_utf8_lossy(&data).to_string(),
                        });
                        let _ = app_handle.emit("terminal-output", payload);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let output = String::from_utf8_lossy(&data).to_string();
                        sb.push(output);
                        let payload = serde_json::json!({
                            "sessionId": session_id,
                            "data": String::from_utf8_lossy(&data).to_string(),
                        });
                        let _ = app_handle.emit("terminal-output", payload);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                        let current_generation =
                            if let Some((manager, generation)) = session_manager.as_ref() {
                                manager
                                    .update_status_if_generation(
                                        &session_id,
                                        *generation,
                                        SessionStatus::Disconnected,
                                    )
                                    .await
                                    .unwrap_or(false)
                            } else {
                                false
                            };
                        if session_manager.is_none() || current_generation {
                            let payload = serde_json::json!({
                                "sessionId": session_id,
                                "data": "\r\n[Connection closed]\r\n",
                            });
                            let _ = app_handle.emit("terminal-output", payload);
                            let _ = app_handle.emit(
                                "terminal-session-status",
                                serde_json::json!({
                                    "sessionId": session_id,
                                    "status": "disconnected",
                                }),
                            );
                        }
                        break;
                    }
                    None => {
                        let current_generation =
                            if let Some((manager, generation)) = session_manager.as_ref() {
                                manager
                                    .update_status_if_generation(
                                        &session_id,
                                        *generation,
                                        SessionStatus::Disconnected,
                                    )
                                    .await
                                    .unwrap_or(false)
                            } else {
                                false
                            };
                        if current_generation {
                            let _ = app_handle.emit(
                                "terminal-session-status",
                                serde_json::json!({
                                    "sessionId": session_id,
                                    "status": "disconnected",
                                }),
                            );
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    pub async fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        let guard = self.writer.lock().await;
        match guard.as_ref() {
            Some(ch) => ch
                .data_bytes(data.to_vec())
                .await
                .map_err(|e| TerminalError::SshConnection(e.to_string())),
            None => Err(TerminalError::SshConnection("No active channel".into())),
        }
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<(), TerminalError> {
        let guard = self.writer.lock().await;
        match guard.as_ref() {
            Some(ch) => ch
                .window_change(cols, rows, 0, 0)
                .await
                .map_err(|e| TerminalError::SshConnection(e.to_string())),
            None => Err(TerminalError::SshConnection("No active channel".into())),
        }
    }

    pub fn get_buffer(&self) -> String {
        self.scroll_buffer.get_all()
    }

    pub async fn disconnect(&self) -> Result<(), TerminalError> {
        self.handle
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "", "")
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;
        *self.writer.lock().await = None;
        Ok(())
    }

    pub async fn exec_command(&self, command: &str) -> Result<ExecResult, TerminalError> {
        let mut channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        channel
            .exec(true, command)
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;

        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    stdout.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExtendedData { data, ext }) => {
                    if ext == 1 {
                        stderr.extend_from_slice(&data);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = Some(exit_status);
                }
                // Do not break on Eof: servers may deliver exit-status after EOF.
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) => break,
                None => break,
                _ => {}
            }
        }

        Ok(ExecResult {
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
            exit_code,
        })
    }

    /// Execute a command on an independent channel with exit-status capture,
    /// timeout and cancellation. This is the only execution path for AI
    /// maintenance steps.
    pub async fn exec_command_structured<F>(
        &self,
        command: &str,
        timeout: Duration,
        cancel: tokio_util::sync::CancellationToken,
        on_output: F,
    ) -> Result<StructuredExecResult, TerminalError>
    where
        F: FnMut(&str),
    {
        self.exec_command_structured_bounded(command, timeout, cancel, usize::MAX, on_output)
            .await
    }

    pub async fn exec_command_structured_bounded<F>(
        &self,
        command: &str,
        timeout: Duration,
        cancel: tokio_util::sync::CancellationToken,
        max_output_bytes: usize,
        mut on_output: F,
    ) -> Result<StructuredExecResult, TerminalError>
    where
        F: FnMut(&str),
    {
        let started = std::time::Instant::now();
        let mut channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        channel
            .exec(true, command)
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;
        let mut timed_out = false;
        let mut cancelled = false;
        let mut truncated = false;

        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let chunk = String::from_utf8_lossy(&data);
                            on_output(&chunk);
                            let remaining = max_output_bytes
                                .saturating_sub(stdout.len().saturating_add(stderr.len()));
                            let take = remaining.min(data.len());
                            stdout.extend_from_slice(&data[..take]);
                            truncated |= take < data.len();
                        }
                        Some(ChannelMsg::ExtendedData { data, ext }) => {
                            if ext == 1 {
                                let chunk = String::from_utf8_lossy(&data);
                                on_output(&chunk);
                                let remaining = max_output_bytes
                                    .saturating_sub(stdout.len().saturating_add(stderr.len()));
                                let take = remaining.min(data.len());
                                stderr.extend_from_slice(&data[..take]);
                                truncated |= take < data.len();
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            exit_code = Some(exit_status);
                        }
                        // Do not break on Eof: exit-status may arrive after EOF;
                        // wait for Close so the exit code is reliably captured.
                        Some(ChannelMsg::Eof) => {}
                        Some(ChannelMsg::Close) => break,
                        None => break,
                        _ => {}
                    }
                }
                _ = &mut deadline => {
                    timed_out = true;
                    break;
                }
                _ = cancel.cancelled() => {
                    cancelled = true;
                    break;
                }
            }
        }

        if timed_out || cancelled {
            abandon_channel(&mut channel).await;
        }

        Ok(StructuredExecResult {
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
            exit_code,
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out,
            cancelled,
            truncated,
        })
    }

    /// Execute a long-running command without retaining its output. Docker
    /// logs and events use this so a remote stream cannot grow Mona's memory.
    pub async fn exec_command_streaming<F>(
        &self,
        command: &str,
        timeout: Duration,
        cancel: tokio_util::sync::CancellationToken,
        mut on_output: F,
    ) -> Result<StructuredExecResult, TerminalError>
    where
        F: FnMut(ExecOutputStream, &str),
    {
        let started = std::time::Instant::now();
        let mut channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        channel
            .exec(true, command)
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        let mut exit_code = None;
        let mut timed_out = false;
        let mut cancelled = false;
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            on_output(ExecOutputStream::Stdout, &String::from_utf8_lossy(&data));
                        }
                        Some(ChannelMsg::ExtendedData { data, ext }) if ext == 1 => {
                            on_output(ExecOutputStream::Stderr, &String::from_utf8_lossy(&data));
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            exit_code = Some(exit_status);
                        }
                        Some(ChannelMsg::Eof) => {}
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
                _ = &mut deadline => {
                    timed_out = true;
                    break;
                }
                _ = cancel.cancelled() => {
                    cancelled = true;
                    break;
                }
            }
        }

        if timed_out || cancelled {
            abandon_channel(&mut channel).await;
        }

        Ok(StructuredExecResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code,
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out,
            cancelled,
            truncated: false,
        })
    }

    /// Append synthetic output (e.g. AI maintenance step echo) to the scroll
    /// buffer so `terminal_output` reads stay consistent with what happened.
    pub fn append_buffer(&self, chunk: String) {
        self.scroll_buffer.push(chunk);
    }

    pub async fn open_sftp(&self) -> Result<russh_sftp::client::SftpSession, TerminalError> {
        let channel = self
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            TerminalError::SftpOperation(format!("Failed to request SFTP subsystem: {}", e))
        })?;

        let sftp_session = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| {
                TerminalError::SftpOperation(format!("Failed to init SFTP session: {}", e))
            })?;

        Ok(sftp_session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cancelling a step must end the exec wait promptly and report why.
    ///
    /// Uses the verify SSH server (127.0.0.1:2223). This covers Mona's half of
    /// the contract: the cancel token unblocks the exec loop, the result is
    /// reported as cancelled, and the remote command is deliberately left
    /// running (see `abandon_channel`) rather than killed. That the token is
    /// what a caller's hang-up triggers is covered by the
    /// `watch_for_client_disconnect` tests in `ipc_bridge`.
    #[tokio::test]
    #[ignore = "requires the local verify SSH server"]
    async fn live_cancel_unblocks_the_exec_wait() {
        let known_hosts = Arc::new(KnownHostsStore::new_in_memory());
        let client = SshClient::connect_with_verify(
            "127.0.0.1",
            2223,
            "monauser",
            &AuthConfig::Password {
                password: "monapass".to_string(),
            },
            known_hosts,
            true,
        )
        .await
        .expect("connect to local ssh server");

        let token = tokio_util::sync::CancellationToken::new();
        let cancel = token.clone();
        // Must keep running until cancelled — `sleep` does not exist in
        // Windows cmd.exe, which would make the command exit immediately.
        let command = if cfg!(windows) {
            "ping -n 300 127.0.0.1 >nul"
        } else {
            "sleep 300"
        };
        let exec = tokio::spawn(async move {
            client
                .exec_command_structured(command, Duration::from_secs(120), cancel, |_| {})
                .await
        });

        tokio::time::sleep(Duration::from_millis(500)).await;
        token.cancel();

        let started = std::time::Instant::now();
        let result = exec
            .await
            .expect("exec task should not panic")
            .expect("exec should return a result");
        assert!(result.cancelled, "step should be reported as cancelled");
        // Must not sit out the full 120s step timeout.
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "cancel should unblock the exec wait promptly"
        );
        // The outcome is genuinely unknown: no exit status was observed, so the
        // result must not look like a completed command either way.
        assert_eq!(result.exit_code, None, "no exit code can have been observed");
    }
}
