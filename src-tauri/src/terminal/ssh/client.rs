use std::sync::Arc;
use std::time::Duration;

use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{client, ChannelMsg, ChannelWriteHalf, Disconnect};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::terminal::config::AuthConfig;
use crate::terminal::error::TerminalError;
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
        let result = self.known_hosts.verify(&self.host, self.port, server_public_key);
        *self.verification_result.lock().await = Some(result);
        Ok(true)
    }
}

pub struct SshClient {
    pub handle: Arc<Mutex<client::Handle<SshClientHandler>>>,
    writer: Arc<Mutex<Option<ChannelWriteHalf<client::Msg>>>>,
    scroll_buffer: Arc<ScrollBuffer>,
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
            log::error!(
                "[batch] SSH connect failed for {}:{}: {}",
                host,
                port,
                e
            );
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
                match reader.wait().await {
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
                        let payload = serde_json::json!({
                            "sessionId": session_id,
                            "data": "\r\n[Connection closed]\r\n",
                        });
                        let _ = app_handle.emit("terminal-output", payload);
                        break;
                    }
                    None => break,
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
    pub async fn exec_command_structured(
        &self,
        command: &str,
        timeout: Duration,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StructuredExecResult, TerminalError> {
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

        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
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
            let _ = channel.close().await;
        }

        Ok(StructuredExecResult {
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
            exit_code,
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out,
            cancelled,
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

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| {
                TerminalError::SftpOperation(format!(
                    "Failed to request SFTP subsystem: {}",
                    e
                ))
            })?;

        let sftp_session = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| {
                TerminalError::SftpOperation(format!(
                    "Failed to init SFTP session: {}",
                    e
                ))
            })?;

        Ok(sftp_session)
    }
}
