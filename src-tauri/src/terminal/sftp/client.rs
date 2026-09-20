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

/// Every directory that must exist for `remote_path` to be writable, outermost
/// first. Handles absolute and relative paths; a bare `file` or `/file` needs
/// no parent.
///
/// Split out from the SFTP calls so the path logic is testable without a live
/// server — an upload into a not-yet-existing directory is exactly what used to
/// fail.
pub fn remote_parent_dirs(remote_path: &str) -> Vec<String> {
    let parent = match remote_path.rfind('/') {
        None | Some(0) => return Vec::new(),
        Some(idx) => &remote_path[..idx],
    };
    let mut dirs = Vec::new();
    for (idx, ch) in parent.char_indices() {
        // Skip the leading '/' of an absolute path: it always exists.
        if ch == '/' && idx > 0 {
            dirs.push(parent[..idx].to_string());
        }
    }
    dirs.push(parent.to_string());
    dirs
}

/// Write one remote file, creating any missing parent directory first.
///
/// `SftpSession::write` opens with `WRITE` alone, so it can create neither a
/// new file nor a missing parent — an upload to a fresh path always failed.
/// This creates the parents and opens with `CREATE | TRUNCATE | WRITE`, which
/// is what the GUI upload path already does.
pub async fn write_file_creating_parents(
    session: &russh_sftp::client::SftpSession,
    remote_path: &str,
    data: &[u8],
) -> Result<(), TerminalError> {
    let parent_dirs = remote_parent_dirs(remote_path);
    for dir in &parent_dirs {
        // An existing directory is the common case and reports an error here;
        // a real permission/transport problem surfaces from the open below.
        let _ = session.create_dir(dir).await;
    }
    let mut file = session.create(remote_path).await.map_err(|e| {
        if parent_dirs.is_empty() {
            TerminalError::SftpOperation(format!("无法创建文件: {}", e))
        } else {
            TerminalError::SftpOperation(format!(
                "无法创建文件（已尝试自动创建父目录 {}）: {}",
                parent_dirs.join("、"),
                e
            ))
        }
    })?;
    file.write_all(data).await.map_err(|e| {
        TerminalError::SftpOperation(format!("写入失败: {}", e))
    })?;
    file.shutdown().await.map_err(|e| {
        TerminalError::SftpOperation(format!("关闭文件失败: {}", e))
    })
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
        // Same contract as the maintenance upload path: creating a file in a
        // directory that does not exist yet must work.
        write_file_creating_parents(session, remote_path, &data).await
    }

    pub async fn touch(&self, path: &str) -> Result<(), TerminalError> {
        let guard = self.session.lock().await;
        let session = guard.as_ref().ok_or_else(|| {
            TerminalError::SftpOperation("SFTP session not connected".into())
        })?;
        // `write` opens with WRITE only, so it cannot create the file or its
        // parent — "new file" would fail on both counts.
        write_file_creating_parents(session, path, &[]).await.map_err(|e| {
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

#[cfg(test)]
mod tests {
    use super::remote_parent_dirs;

    #[test]
    fn creates_each_missing_ancestor_outermost_first() {
        // The regression case: uploading into a directory that does not exist
        // yet ("/root/sglang-gateway-docker/Dockerfile") failed with
        // "No such file" because nothing created the parent.
        assert_eq!(
            remote_parent_dirs("/root/sglang-gateway-docker/Dockerfile"),
            vec!["/root", "/root/sglang-gateway-docker"],
        );
        assert_eq!(
            remote_parent_dirs("/a/b/c/file.txt"),
            vec!["/a", "/a/b", "/a/b/c"],
        );
    }

    #[test]
    fn needs_no_parent_for_root_level_or_bare_names() {
        assert!(remote_parent_dirs("/file.txt").is_empty());
        assert!(remote_parent_dirs("file.txt").is_empty());
        assert!(remote_parent_dirs("Dockerfile").is_empty());
    }

    #[test]
    fn handles_relative_and_nested_paths() {
        assert_eq!(
            remote_parent_dirs("build/docker/Dockerfile"),
            vec!["build", "build/docker"],
        );
    }

    #[test]
    fn ignores_a_trailing_separator_on_the_parent() {
        assert_eq!(
            remote_parent_dirs("/root/dir/"),
            vec!["/root", "/root/dir"],
        );
    }

    /// Verification against a live SFTP server (127.0.0.1:2222).
    ///
    /// Not a committed regression test — CI has no SFTP server — but this is
    /// what proves the fix, since the original bug hid behind mocked IPC.
    #[tokio::test]
    #[ignore = "requires the local verify SFTP server"]
    async fn live_upload_creates_missing_parent_dirs() {
        use crate::terminal::config::AuthConfig;

        let client = super::SftpClient::connect(
            "127.0.0.1",
            2222,
            "monauser",
            &AuthConfig::Password {
                password: "monapass".to_string(),
            },
        )
        .await
        .expect("connect to local sftp server");

        let guard = client.session.lock().await;
        let session = guard.as_ref().expect("sftp session");

        // The exact shape that failed in production: a new file inside a
        // directory that does not exist yet.
        super::write_file_creating_parents(
            session,
            "/newdir/sub/Dockerfile",
            b"FROM scratch\n",
        )
        .await
        .expect("upload into a not-yet-existing directory");

        // And the previous primitive must still fail there, which is the bug.
        let old = session.write("/otherdir/Dockerfile", b"x").await;
        assert!(
            old.is_err(),
            "sanity check: plain write() is expected to fail on a new path"
        );
        drop(guard);

        // The GUI single-file upload and "new file" share the fixed primitive.
        client
            .upload("/gui/deep/file.conf", b"k=v\n".to_vec())
            .await
            .expect("gui upload into a not-yet-existing directory");
        client
            .touch("/gui/deep/created-by-touch.conf")
            .await
            .expect("create a new empty file");
    }
}
