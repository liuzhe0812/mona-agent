use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{client, Disconnect};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::terminal::config::AuthConfig;
use crate::terminal::error::TerminalError;
use crate::terminal::ssh::client::SshClient;

struct SftpClientHandler;

impl client::Handler for SftpClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub permissions: Option<u32>,
    pub mtime: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

pub struct SftpClient {
    handle: Option<client::Handle<SftpClientHandler>>,
    ssh_client: Option<Arc<SshClient>>,
    session: Arc<Mutex<Option<russh_sftp::client::SftpSession>>>,
}

impl SftpClient {
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        auth: &AuthConfig,
    ) -> Result<Self, TerminalError> {
        let config = client::Config {
            ..Default::default()
        };
        let config = Arc::new(config);
        let handler = SftpClientHandler;

        let mut handle = client::connect(config, (host, port), handler)
            .await
            .map_err(|e| TerminalError::SshConnection(e.to_string()))?;

        match auth {
            AuthConfig::Password { password } => {
                let auth_result = handle
                    .authenticate_password(username, password.as_str())
                    .await
                    .map_err(|e| TerminalError::AuthFailed(e.to_string()))?;
                if !auth_result.success() {
                    return Err(TerminalError::AuthFailed(
                        "Password authentication failed".into(),
                    ));
                }
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
                return Err(TerminalError::AuthFailed(
                    "SSH agent authentication not yet supported".into(),
                ));
            }
        }

        let channel = handle
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

        Ok(Self {
            handle: Some(handle),
            ssh_client: None,
            session: Arc::new(Mutex::new(Some(sftp_session))),
        })
    }

    pub fn from_session(
        sftp_session: russh_sftp::client::SftpSession,
        ssh_client: Arc<SshClient>,
    ) -> Self {
        Self {
            handle: None,
            ssh_client: Some(ssh_client),
            session: Arc::new(Mutex::new(Some(sftp_session))),
        }
    }

    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileInfo>, TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;

        let read_dir = session.read_dir(path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("read_dir failed: {}", e))
        })?;

        let mut entries = Vec::new();
        for entry in read_dir {
            let metadata = entry.metadata();
            let file_type = entry.file_type();
            entries.push(FileInfo {
                name: entry.file_name(),
                path: entry.path(),
                is_dir: file_type.is_dir(),
                size: metadata.size,
                permissions: metadata.permissions,
                mtime: metadata.mtime,
                owner: metadata.user.clone(),
                group: metadata.group.clone(),
            });
        }

        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(entries)
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        session.create_dir(path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("mkdir failed: {}", e))
        })
    }

    pub async fn mkdir_if_not_exists(&self, path: &str) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        match session.create_dir(path).await {
            Ok(()) => Ok(()),
            Err(e) => {
                let err_str = format!("{}", e).to_lowercase();
                if err_str.contains("exist") || err_str.contains("failure") {
                    Ok(())
                } else {
                    Err(TerminalError::SftpOperation(format!(
                        "mkdir failed: {}",
                        e
                    )))
                }
            }
        }
    }

    pub async fn rmdir(&self, path: &str) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        session.remove_dir(path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("rmdir failed: {}", e))
        })
    }

    pub async fn remove_dir_recursive(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        path: &str,
    ) -> Result<(), TerminalError> {
        let entries = sftp.read_dir(path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("read_dir failed: {}", e))
        })?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let entry_path = if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };
            if entry.file_type().is_dir() {
                Box::pin(self.remove_dir_recursive(sftp, &entry_path)).await?;
            } else {
                sftp.remove_file(&entry_path).await.map_err(|e| {
                    TerminalError::SftpOperation(format!("remove failed: {}", e))
                })?;
            }
        }
        sftp.remove_dir(path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("rmdir failed: {}", e))
        })
    }

    pub async fn remove(&self, path: &str) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        session.remove_file(path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("remove failed: {}", e))
        })
    }

    pub async fn rename(
        &self,
        old_path: &str,
        new_path: &str,
    ) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        session.rename(old_path, new_path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("rename failed: {}", e))
        })
    }

    pub async fn stat(&self, path: &str) -> Result<FileInfo, TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        let metadata = session.metadata(path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("stat failed: {}", e))
        })?;
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        Ok(FileInfo {
            name,
            path: path.to_string(),
            is_dir: metadata.permissions.map_or(false, |p| (p & 0o40000) != 0),
            size: metadata.size,
            permissions: metadata.permissions,
            mtime: metadata.mtime,
            owner: metadata.user.clone(),
            group: metadata.group.clone(),
        })
    }

    pub async fn canonicalize(&self, path: &str) -> Result<String, TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        session.canonicalize(path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("canonicalize failed: {}", e))
        })
    }

    pub async fn download(&self, remote_path: &str) -> Result<Vec<u8>, TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        session.read(remote_path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("download failed: {}", e))
        })
    }

    pub async fn upload(
        &self,
        remote_path: &str,
        data: Vec<u8>,
    ) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        let mut file = session.create(remote_path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("create failed: {}", e))
        })?;
        file.write_all(&data).await.map_err(|e| {
            TerminalError::SftpOperation(format!("write failed: {}", e))
        })?;
        file.shutdown().await.map_err(|e| {
            TerminalError::SftpOperation(format!("close failed: {}", e))
        })
    }

    pub async fn upload_with_progress(
        &self,
        app_handle: AppHandle,
        session_id: String,
        task_id: String,
        remote_path: &str,
        data: Vec<u8>,
    ) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let sftp = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;

        let mut file = sftp.create(remote_path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("create failed: {}", e))
        })?;

        let total = data.len() as u64;
        let chunk_size: usize = 32768;
        let mut offset: usize = 0;
        let mut last_emit_time = std::time::Instant::now();
        let mut last_emit_bytes: u64 = 0;

        while offset < data.len() {
            let end = std::cmp::min(offset + chunk_size, data.len());
            file.write_all(&data[offset..end]).await.map_err(|e| {
                TerminalError::SftpOperation(format!("write failed: {}", e))
            })?;
            offset = end;

            let now = std::time::Instant::now();
            let elapsed = now.duration_since(last_emit_time);
            if elapsed >= Duration::from_millis(200) || offset == data.len() {
                let speed = if elapsed.as_secs_f64() > 0.0 {
                    ((offset as u64 - last_emit_bytes) as f64 / elapsed.as_secs_f64()) as u64
                } else {
                    0
                };
                let percentage = if total > 0 {
                    (offset as u64 * 100 / total) as u32
                } else {
                    100
                };
                let event_name = format!("sftp:transfer:{}:{}", session_id, task_id);
                let _ = app_handle.emit(
                    &event_name,
                    serde_json::json!({
                        "taskId": task_id,
                        "sessionId": session_id,
                        "type": "upload",
                        "path": remote_path,
                        "bytesTransferred": offset as u64,
                        "totalBytes": total,
                        "percentage": percentage,
                        "speed": speed,
                    }),
                );
                last_emit_time = now;
                last_emit_bytes = offset as u64;
            }
        }

        file.shutdown().await.map_err(|e| {
            TerminalError::SftpOperation(format!("close failed: {}", e))
        })
    }

    pub async fn touch(&self, path: &str) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        session.write(path, &[]).await.map_err(|e| {
            TerminalError::SftpOperation(format!("touch failed: {}", e))
        })
    }

    pub async fn set_permissions(
        &self,
        path: &str,
        mode: u32,
    ) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        let mut metadata = russh_sftp::protocol::FileAttributes::empty();
        metadata.permissions = Some(mode);
        session.set_metadata(path, metadata).await.map_err(|e| {
            TerminalError::SftpOperation(format!("set_permissions failed: {}", e))
        })
    }

    pub async fn disconnect(&self) -> Result<(), TerminalError> {
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.take() {
            let _ = session.close().await;
        }
        drop(guard);
        if let Some(handle) = &self.handle {
            handle
                .disconnect(Disconnect::ByApplication, "", "")
                .await
                .map_err(|e| TerminalError::SshConnection(e.to_string()))?;
        }
        Ok(())
    }

    pub async fn download_file_with_progress(
        &self,
        app_handle: AppHandle,
        session_id: String,
        remote_path: &str,
        total_size: Option<u64>,
    ) -> Result<Vec<u8>, TerminalError> {
        let guard = self.session.lock().await;
        let sftp = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;

        let mut file = sftp.open(remote_path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("open failed: {}", e))
        })?;

        let chunk_size: usize = 32768;
        let mut buf = Vec::new();
        let mut read_buf = vec![0u8; chunk_size];
        let mut bytes_read: u64 = 0;

        loop {
            let n = file.read(&mut read_buf).await.map_err(|e| {
                TerminalError::SftpOperation(format!("read failed: {}", e))
            })?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&read_buf[..n]);
            bytes_read += n as u64;

            let _ = app_handle.emit(
                "sftp-transfer-progress",
                serde_json::json!({
                    "sessionId": session_id,
                    "path": remote_path,
                    "direction": "download",
                    "bytesTransferred": bytes_read,
                    "totalBytes": total_size,
                }),
            );
        }

        file.shutdown().await.map_err(|e| {
            TerminalError::SftpOperation(format!("close failed: {}", e))
        })?;

        Ok(buf)
    }

    pub async fn upload_file_with_progress(
        &self,
        app_handle: AppHandle,
        session_id: String,
        remote_path: &str,
        data: Vec<u8>,
    ) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let sftp = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;

        let mut file = sftp.create(remote_path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("create failed: {}", e))
        })?;

        let total = data.len() as u64;
        let chunk_size: usize = 32768;
        let mut offset: usize = 0;

        while offset < data.len() {
            let end = std::cmp::min(offset + chunk_size, data.len());
            file.write_all(&data[offset..end]).await.map_err(|e| {
                TerminalError::SftpOperation(format!("write failed: {}", e))
            })?;
            offset = end;

            let _ = app_handle.emit(
                "sftp-transfer-progress",
                serde_json::json!({
                    "sessionId": session_id,
                    "path": remote_path,
                    "direction": "upload",
                    "bytesTransferred": offset as u64,
                    "totalBytes": total,
                }),
            );
        }

        file.shutdown().await.map_err(|e| {
            TerminalError::SftpOperation(format!("close failed: {}", e))
        })?;

        Ok(())
    }

    pub fn ssh_client(&self) -> Option<&Arc<SshClient>> {
        self.ssh_client.as_ref()
    }

    pub async fn create_sftp_channel(
        &self,
    ) -> Result<russh_sftp::client::SftpSession, TerminalError> {
        if let Some(ssh) = &self.ssh_client {
            return ssh.open_sftp().await;
        }
        let handle = self.handle.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation(
                "No SSH handle available for channel creation".into(),
            )
        })?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| {
                TerminalError::SftpOperation(format!(
                    "Failed to open SSH channel: {}",
                    e
                ))
            })?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| {
                TerminalError::SftpOperation(format!(
                    "Failed to request SFTP subsystem: {}",
                    e
                ))
            })?;
        let sftp =
            russh_sftp::client::SftpSession::new(channel.into_stream())
                .await
                .map_err(|e| {
                    TerminalError::SftpOperation(format!(
                        "Failed to create SFTP session: {}",
                        e
                    ))
                })?;
        Ok(sftp)
    }
}

pub async fn upload_file_streaming(
    sftp: &russh_sftp::client::SftpSession,
    local_path: &str,
    remote_path: &str,
    progress_tx: Option<tokio::sync::mpsc::Sender<super::batch::FileTransferProgress>>,
    cancel_token: Option<CancellationToken>,
    is_paused: Option<Arc<AtomicBool>>,
) -> Result<(), TerminalError> {
    let metadata = tokio::fs::metadata(local_path).await.map_err(|e| {
        TerminalError::SftpOperation(format!(
            "Failed to read local file metadata: {}",
            e
        ))
    })?;
    let total_bytes = metadata.len();
    let mut local_file = tokio::fs::File::open(local_path).await.map_err(
        |e| {
            TerminalError::SftpOperation(format!(
                "Failed to open local file: {}",
                e
            ))
        },
    )?;
    let mut remote_file = sftp.create(remote_path).await.map_err(|e| {
        TerminalError::SftpOperation(format!("Failed to create remote file: {}", e))
    })?;
    let mut buffer = vec![0u8; 65536];
    let mut bytes_transferred: u64 = 0;
    loop {
        if let Some(ref token) = cancel_token {
            if token.is_cancelled() {
                return Err(TerminalError::SftpOperation(
                    "Transfer cancelled".into(),
                ));
            }
        }
        if let Some(ref paused) = is_paused {
            if paused.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        }
        let n = local_file.read(&mut buffer).await.map_err(|e| {
            TerminalError::SftpOperation(format!("Failed to read local file: {}", e))
        })?;
        if n == 0 {
            break;
        }
        remote_file.write_all(&buffer[..n]).await.map_err(|e| {
            TerminalError::SftpOperation(format!(
                "Failed to write remote file: {}",
                e
            ))
        })?;
        bytes_transferred += n as u64;
        if let Some(ref tx) = progress_tx {
            let _ = tx.try_send(super::batch::FileTransferProgress {
                bytes_transferred,
                total_bytes,
            });
        }
    }
    remote_file.shutdown().await.map_err(|e| {
        TerminalError::SftpOperation(format!("Failed to close remote file: {}", e))
    })?;
    Ok(())
}

fn sanitize_filename(name: &str) -> String {
    let invalid_chars = ['<', '>', ':', '"', '|', '?', '*'];
    let result: String = name
        .chars()
        .map(|c| {
            if invalid_chars.contains(&c) || (c as u32) <= 0x1F {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = result.trim_end_matches(|c| c == ' ' || c == '.');
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed.to_string()
    }
}

pub async fn download_file_streaming(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
    local_path: &str,
    progress_tx: Option<tokio::sync::mpsc::Sender<super::batch::FileTransferProgress>>,
    cancel_token: Option<CancellationToken>,
    is_paused: Option<Arc<AtomicBool>>,
) -> Result<(), TerminalError> {
    let local_path = std::path::Path::new(local_path).to_path_buf();
    let local_path = if let Some(name) = local_path.file_name() {
        let name_str = name.to_string_lossy();
        let sanitized = sanitize_filename(&name_str);
        if sanitized != name_str {
            local_path.with_file_name(&sanitized)
        } else {
            local_path
        }
    } else {
        local_path
    };
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            TerminalError::SftpOperation(format!(
                "Failed to create parent directory '{}': {}",
                parent.display(),
                e
            ))
        })?;
    }
    let metadata = sftp.metadata(remote_path).await.map_err(|e| {
        TerminalError::SftpOperation(format!(
            "Failed to get remote file metadata: {}",
            e
        ))
    })?;
    let total_bytes = metadata.len();
    let mut remote_file = sftp.open(remote_path).await.map_err(|e| {
        TerminalError::SftpOperation(format!("Failed to open remote file: {}", e))
    })?;
    let mut local_file = tokio::fs::File::create(&local_path).await.map_err(
        |e| {
            TerminalError::SftpOperation(format!(
                "Failed to create local file '{}': {}",
                local_path.display(),
                e
            ))
        },
    )?;
    let mut buffer = vec![0u8; 65536];
    let mut bytes_transferred: u64 = 0;
    loop {
        if let Some(ref token) = cancel_token {
            if token.is_cancelled() {
                return Err(TerminalError::SftpOperation(
                    "Transfer cancelled".into(),
                ));
            }
        }
        if let Some(ref paused) = is_paused {
            if paused.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        }
        let n = remote_file.read(&mut buffer).await.map_err(|e| {
            TerminalError::SftpOperation(format!(
                "Failed to read remote file: {}",
                e
            ))
        })?;
        if n == 0 {
            break;
        }
        local_file.write_all(&buffer[..n]).await.map_err(|e| {
            TerminalError::SftpOperation(format!(
                "Failed to write local file: {}",
                e
            ))
        })?;
        bytes_transferred += n as u64;
        if let Some(ref tx) = progress_tx {
            let _ = tx.try_send(super::batch::FileTransferProgress {
                bytes_transferred,
                total_bytes,
            });
        }
    }
    local_file.shutdown().await.map_err(|e| {
        TerminalError::SftpOperation(format!("Failed to close local file: {}", e))
    })?;
    Ok(())
}
