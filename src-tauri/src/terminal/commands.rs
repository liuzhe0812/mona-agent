use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::AsyncWriteExt;

use crate::terminal::approval::{ApprovalVerdict, PendingCommand};
use crate::terminal::config::{AuthConfig, ConnectionConfig, Protocol};
use crate::terminal::credential_store;
use crate::terminal::error::TerminalError;
use crate::terminal::session::{
    Session, SessionHandle, SessionStatus, SessionType,
};
use crate::terminal::shell::local::LocalShell;
use crate::terminal::sftp::batch::{
    BatchTransferControl, BatchTransferProgress, BatchTransferStatus, FileTransferProgress,
};
use crate::terminal::sftp::client::{FileInfo, SftpClient};
use crate::terminal::sftp::client as sftp_client;
use crate::terminal::ssh::client::SshClient;
use crate::terminal::TerminalState;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Semaphore, Notify};
use tokio_util::sync::CancellationToken;

#[tauri::command]
pub async fn ssh_connect(
    app_handle: tauri::AppHandle,
    state: State<'_, TerminalState>,
    config: ConnectionConfig,
) -> Result<String, String> {
    let config = ConnectionConfig {
        auth: credential_store::restore_credential(&config.auth, &config.host, config.port, &config.username)
            .map_err(|e| e)?,
        ..config
    };

    let session_id = uuid::Uuid::new_v4().to_string();

    let session_type = match config.protocol {
        Protocol::Ssh => SessionType::Ssh,
        Protocol::Sftp => SessionType::Sftp,
        _ => SessionType::Ssh,
    };

    if session_type == SessionType::Sftp {
        let client = SftpClient::connect(
            &config.host,
            config.port,
            &config.username,
            &config.auth,
        )
        .await
        .map_err(|e| e.to_string())?;

        let session = Session {
            id: session_id.clone(),
            config_id: config.id.clone(),
            session_type,
            status: SessionStatus::Connected,
            created_at: chrono::Utc::now(),
        };

        state
            .manager
            .create(session, SessionHandle::Sftp(Arc::new(client)))
            .await
            .map_err(|e| e.to_string())?;

        return Ok(session_id);
    }

    let client = SshClient::connect(
        &config.host,
        config.port,
        &config.username,
        &config.auth,
        state.known_hosts.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;

    let session = Session {
        id: session_id.clone(),
        config_id: config.id.clone(),
        session_type,
        status: SessionStatus::Connected,
        created_at: chrono::Utc::now(),
    };

    client
        .start_shell(
            app_handle,
            session_id.clone(),
            80,
            24,
        )
        .await
        .map_err(|e| e.to_string())?;

    state
        .manager
        .create(session, SessionHandle::Ssh(Arc::new(client)))
        .await
        .map_err(|e| e.to_string())?;

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_connect_with_id(
    app_handle: tauri::AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    config: ConnectionConfig,
    cols: u32,
    rows: u32,
) -> Result<String, String> {
    log::info!(
        "[batch] ssh_connect_with_id called: session_id={}, host={}:{}",
        session_id,
        config.host,
        config.port
    );

    let connect_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        ssh_connect_with_id_inner(app_handle, state, session_id.clone(), config, cols, rows),
    )
    .await
    .map_err(|_| {
        log::error!(
            "[batch] ssh_connect_with_id timed out for session_id={}",
            session_id
        );
        format!("连接超时(30秒): session_id={}", session_id)
    })?;

    connect_result
}

async fn ssh_connect_with_id_inner(
    app_handle: tauri::AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    config: ConnectionConfig,
    cols: u32,
    rows: u32,
) -> Result<String, String> {
    log::info!(
        "[batch] ssh_connect_with_id_inner: session_id={}, host={}:{}, username={}, auth_type={}",
        session_id,
        config.host,
        config.port,
        config.username,
        match &config.auth {
            AuthConfig::Password { password } => format!("password(len={})", password.len()),
            AuthConfig::KeyFile { key_path, .. } => format!("key({})", key_path),
            AuthConfig::Agent => "agent".to_string(),
        }
    );

    let config = ConnectionConfig {
        auth: credential_store::restore_credential(&config.auth, &config.host, config.port, &config.username)
            .map_err(|e| {
                log::error!(
                    "[batch] restore_credential failed for {}@{}:{}: {}",
                    config.username,
                    config.host,
                    config.port,
                    e
                );
                e
            })?,
        ..config
    };

    log::info!(
        "[batch] After restore_credential: session_id={}, auth_type={}",
        session_id,
        match &config.auth {
            AuthConfig::Password { password } => format!("password(len={})", password.len()),
            AuthConfig::KeyFile { key_path, .. } => format!("key({})", key_path),
            AuthConfig::Agent => "agent".to_string(),
        }
    );

    let session_type = match config.protocol {
        Protocol::Ssh => SessionType::Ssh,
        Protocol::Sftp => SessionType::Sftp,
        _ => SessionType::Ssh,
    };

    if session_type == SessionType::Sftp {
        let client = SftpClient::connect(
            &config.host,
            config.port,
            &config.username,
            &config.auth,
        )
        .await
        .map_err(|e| e.to_string())?;

        let session = Session {
            id: session_id.clone(),
            config_id: config.id.clone(),
            session_type,
            status: SessionStatus::Connected,
            created_at: chrono::Utc::now(),
        };

        state
            .manager
            .create(session, SessionHandle::Sftp(Arc::new(client)))
            .await
            .map_err(|e| e.to_string())?;

        return Ok(session_id);
    }

    let client = SshClient::connect_skip_verify(
        &config.host,
        config.port,
        &config.username,
        &config.auth,
    )
    .await
    .map_err(|e| {
        log::error!(
            "[batch] SSH connect failed for session_id={}, host={}: {}",
            session_id,
            config.host,
            e
        );
        e.to_string()
    })?;

    log::info!(
        "[batch] SSH connected for session_id={}, host={}",
        session_id,
        config.host
    );

    let session = Session {
        id: session_id.clone(),
        config_id: config.id.clone(),
        session_type,
        status: SessionStatus::Connected,
        created_at: chrono::Utc::now(),
    };

    client
        .start_shell(
            app_handle,
            session_id.clone(),
            cols,
            rows,
        )
        .await
        .map_err(|e| {
            log::error!(
                "[batch] start_shell failed for session_id={}: {}",
                session_id,
                e
            );
            e.to_string()
        })?;

    log::info!(
        "[batch] Shell started for session_id={}, registering session",
        session_id
    );

    state
        .manager
        .create(session, SessionHandle::Ssh(Arc::new(client)))
        .await
        .map_err(|e| {
            log::error!(
                "[batch] Session create failed for session_id={}: {}",
                session_id,
                e
            );
            e.to_string()
        })?;

    log::info!(
        "[batch] Session registered successfully: session_id={}",
        session_id
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Ssh(client) => {
            client.disconnect().await.map_err(|e| e.to_string())?;
        }
        SessionHandle::Sftp(client) => {
            client.disconnect().await.map_err(|e| e.to_string())?;
        }
        SessionHandle::Desktop(client) => {
            client.disconnect().await.map_err(|e| e.to_string())?;
        }
        SessionHandle::Local(_) | SessionHandle::Vnc => {}
    }

    state
        .manager
        .update_status(&session_id, SessionStatus::Disconnected)
        .await
        .map_err(|e| e.to_string())?;
    state.manager.remove(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn ssh_open_sftp(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<String, String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    let ssh_client = match &handle {
        SessionHandle::Ssh(client) => Arc::clone(client),
        _ => return Err("Not an SSH session".into()),
    };

    let sftp_session = ssh_client
        .open_sftp()
        .await
        .map_err(|e| e.to_string())?;

    let sftp_client = SftpClient::from_session(sftp_session, ssh_client);

    let new_session_id = uuid::Uuid::new_v4().to_string();
    let session = Session {
        id: new_session_id.clone(),
        config_id: String::new(),
        session_type: SessionType::Sftp,
        status: SessionStatus::Connected,
        created_at: chrono::Utc::now(),
    };

    state
        .manager
        .create(session, SessionHandle::Sftp(Arc::new(sftp_client)))
        .await
        .map_err(|e| e.to_string())?;

    Ok(new_session_id)
}

#[tauri::command]
pub async fn ssh_reconnect(
    app_handle: tauri::AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    config: ConnectionConfig,
) -> Result<String, String> {
    let config = ConnectionConfig {
        auth: credential_store::restore_credential(&config.auth, &config.host, config.port, &config.username)
            .map_err(|e| e)?,
        ..config
    };

    let session_type = match config.protocol {
        Protocol::Ssh => SessionType::Ssh,
        Protocol::Sftp => SessionType::Sftp,
        _ => SessionType::Ssh,
    };

    let client = SshClient::connect(
        &config.host,
        config.port,
        &config.username,
        &config.auth,
        state.known_hosts.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;

    if session_type == SessionType::Ssh {
        client
            .start_shell(
                app_handle,
                session_id.clone(),
                80,
                24,
            )
            .await
            .map_err(|e| e.to_string())?;
    }

    state
        .manager
        .update_status(&session_id, SessionStatus::Connected)
        .await
        .map_err(|e| e.to_string())?;
    state
        .manager
        .create(
            Session {
                id: session_id.clone(),
                config_id: config.id.clone(),
                session_type,
                status: SessionStatus::Connected,
                created_at: chrono::Utc::now(),
            },
            SessionHandle::Ssh(Arc::new(client)),
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Ssh(client) => {
            client
                .write(data.as_bytes())
                .await
                .map_err(|e| e.to_string())
        }
        _ => Err("Not an SSH session".into()),
    }
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Ssh(client) => client.resize(cols, rows).await.map_err(|e| e.to_string()),
        _ => Err("Not an SSH session".into()),
    }
}

#[tauri::command]
pub async fn shell_spawn(
    app_handle: tauri::AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    let shell =
        LocalShell::spawn(
            app_handle,
            session_id.clone(),
            cols,
            rows,
        )
        .map_err(|e| e.to_string())?;

    let session = Session {
        id: session_id.clone(),
        config_id: String::new(),
        session_type: SessionType::Local,
        status: SessionStatus::Connected,
        created_at: chrono::Utc::now(),
    };

    state
        .manager
        .create(session, SessionHandle::Local(Arc::new(shell)))
        .await
        .map_err(|e| e.to_string())?;

    Ok(session_id)
}

#[tauri::command]
pub async fn shell_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Local(shell) => shell.write(data.as_bytes()).map_err(|e| e.to_string()),
        _ => Err("Not a local shell session".into()),
    }
}

#[tauri::command]
pub async fn shell_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Local(shell) => shell.resize(cols, rows).map_err(|e| e.to_string()),
        _ => Err("Not a local shell session".into()),
    }
}

#[tauri::command]
pub async fn shell_kill(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Local(shell) => {
            shell.kill().map_err(|e| e.to_string())?;
        }
        _ => {}
    }

    state
        .manager
        .update_status(&session_id, SessionStatus::Disconnected)
        .await
        .map_err(|e| e.to_string())?;
    state.manager.remove(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn shell_get_buffer(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<String, String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Local(shell) => Ok(shell.get_buffer()),
        _ => Err("Not a local shell session".into()),
    }
}

fn get_sftp_client(
    handle: &SessionHandle,
) -> Result<Arc<SftpClient>, String> {
    match handle {
        SessionHandle::Sftp(client) => Ok(Arc::clone(client)),
        _ => Err("Not an SFTP session".into()),
    }
}

#[tauri::command]
pub async fn ssh_trust_host_key(
    state: State<'_, TerminalState>,
    host: String,
    port: u16,
) -> Result<(), String> {
    state
        .known_hosts
        .trust_last_unknown(&host, port)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_remove_host_key(
    state: State<'_, TerminalState>,
    host: String,
    port: u16,
) -> Result<(), String> {
    state
        .known_hosts
        .remove(&host, port)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<Vec<FileInfo>, String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    match &handle {
        SessionHandle::Sftp(client) => {
            client.list_dir(&path).await.map_err(|e| e.to_string())
        }
        SessionHandle::Ssh(ssh_client) => {
            let sftp_session = ssh_client
                .open_sftp()
                .await
                .map_err(|e| e.to_string())?;
            let sftp_client = SftpClient::from_session(sftp_session, Arc::clone(ssh_client));
            sftp_client.list_dir(&path).await.map_err(|e| e.to_string())
        }
        _ => Err("Not an SFTP or SSH session".into()),
    }
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    let client = get_sftp_client(&handle)?;
    client.mkdir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    let client = get_sftp_client(&handle)?;
    if is_dir {
        if let Some(ssh) = client.ssh_client() {
            let result = ssh
                .exec_command(&format!("rm -rf {:?}", path))
                .await
                .map_err(|e| e.to_string())?;
            if !result.stderr.is_empty() {
                return Err(result.stderr);
            }
            Ok(())
        } else {
            let sftp = client.create_sftp_channel().await.map_err(|e| e.to_string())?;
            client.remove_dir_recursive(&sftp, &path).await.map_err(|e| e.to_string())
        }
    } else {
        client.remove(&path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, TerminalState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    let client = get_sftp_client(&handle)?;
    client
        .rename(&old_path, &new_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_stat(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<FileInfo, String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    let client = get_sftp_client(&handle)?;
    client.stat(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_canonicalize(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    let client = get_sftp_client(&handle)?;
    client
        .canonicalize(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, TerminalState>,
    session_id: String,
    remote_path: String,
) -> Result<Vec<u8>, String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    let client = get_sftp_client(&handle)?;
    client
        .download(&remote_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_upload(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    remote_path: String,
    data: Vec<u8>,
    task_id: Option<String>,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;
    let client = get_sftp_client(&handle)?;
    if let Some(tid) = task_id {
        let sftp = client.create_sftp_channel().await.map_err(|e| e.to_string())?;

        let cancel_token = CancellationToken::new();
        {
            let mut cancels = state.transfer_cancels.write().await;
            cancels.insert(tid.clone(), cancel_token.clone());
        }

        let total = data.len() as u64;
        let chunk_size: usize = 32768;
        let mut offset: usize = 0;
        let mut last_emit_time = std::time::Instant::now();
        let mut last_emit_bytes: u64 = 0;

        let mut file = sftp.create(&remote_path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("create failed: {}", e)).to_string()
        })?;

        while offset < data.len() {
            if cancel_token.is_cancelled() {
                return Err("Transfer cancelled".to_string());
            }
            let end = std::cmp::min(offset + chunk_size, data.len());
            file.write_all(&data[offset..end]).await.map_err(|e| {
                TerminalError::SftpOperation(format!("write failed: {}", e)).to_string()
            })?;
            offset = end;

            let now = std::time::Instant::now();
            let elapsed = now.duration_since(last_emit_time);
            if elapsed >= std::time::Duration::from_millis(200) || offset == data.len() {
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
                let event_name = format!("sftp:transfer:{}:{}", session_id, tid);
                let _ = app_handle.emit(
                    &event_name,
                    serde_json::json!({
                        "taskId": tid,
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
            TerminalError::SftpOperation(format!("close failed: {}", e)).to_string()
        })?;

        drop(sftp);

        {
            let mut cancels = state.transfer_cancels.write().await;
            cancels.remove(&tid);
        }

        Ok(())
    } else {
        client
            .upload(&remote_path, data)
            .await
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn sftp_upload_file(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    task_id: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;
    let client = get_sftp_client(&handle)?;

    let sftp = client.create_sftp_channel().await.map_err(|e| e.to_string())?;

    let cancel_token = CancellationToken::new();
    {
        let mut cancels = state.transfer_cancels.write().await;
        cancels.insert(task_id.clone(), cancel_token.clone());
    }

    let (progress_tx, mut progress_rx) =
        tokio::sync::mpsc::channel::<FileTransferProgress>(100);

    let app_clone = app_handle.clone();
    let session_id_clone = session_id.clone();
    let task_id_clone = task_id.clone();
    let remote_path_clone = remote_path.clone();
    let progress_task = tokio::spawn(async move {
        let mut last_emit_time = std::time::Instant::now();
        let mut last_emit_bytes: u64 = 0;
        while let Some(progress) = progress_rx.recv().await {
            let now = std::time::Instant::now();
            let elapsed = now.duration_since(last_emit_time);
            if elapsed >= std::time::Duration::from_millis(200) {
                let speed = if elapsed.as_secs_f64() > 0.0 {
                    ((progress.bytes_transferred - last_emit_bytes) as f64
                        / elapsed.as_secs_f64()) as u64
                } else {
                    0
                };
                let percentage = if progress.total_bytes > 0 {
                    (progress.bytes_transferred * 100 / progress.total_bytes) as u32
                } else {
                    0
                };
                let event_name = format!("sftp:transfer:{}:{}", session_id_clone, task_id_clone);
                let _ = app_clone.emit(
                    &event_name,
                    serde_json::json!({
                        "taskId": task_id_clone,
                        "sessionId": session_id_clone,
                        "type": "upload",
                        "path": remote_path_clone,
                        "bytesTransferred": progress.bytes_transferred,
                        "totalBytes": progress.total_bytes,
                        "percentage": percentage,
                        "speed": speed,
                    }),
                );
                last_emit_time = now;
                last_emit_bytes = progress.bytes_transferred;
            }
        }
    });

    let result = sftp_client::upload_file_streaming(
        &sftp,
        &local_path,
        &remote_path,
        Some(progress_tx),
        Some(cancel_token),
        None,
    )
    .await;

    drop(sftp);

    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), progress_task).await;

    {
        let mut cancels = state.transfer_cancels.write().await;
        cancels.remove(&task_id);
    }

    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_download_file(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    task_id: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;
    let client = get_sftp_client(&handle)?;

    let sftp = client.create_sftp_channel().await.map_err(|e| e.to_string())?;

    let cancel_token = CancellationToken::new();
    {
        let mut cancels = state.transfer_cancels.write().await;
        cancels.insert(task_id.clone(), cancel_token.clone());
    }

    let (progress_tx, mut progress_rx) =
        tokio::sync::mpsc::channel::<FileTransferProgress>(100);

    let app_clone = app_handle.clone();
    let session_id_clone = session_id.clone();
    let task_id_clone = task_id.clone();
    let remote_path_clone = remote_path.clone();
    let progress_task = tokio::spawn(async move {
        let mut last_emit_time = std::time::Instant::now();
        let mut last_emit_bytes: u64 = 0;
        while let Some(progress) = progress_rx.recv().await {
            let now = std::time::Instant::now();
            let elapsed = now.duration_since(last_emit_time);
            if elapsed >= std::time::Duration::from_millis(200) {
                let speed = if elapsed.as_secs_f64() > 0.0 {
                    ((progress.bytes_transferred - last_emit_bytes) as f64
                        / elapsed.as_secs_f64()) as u64
                } else {
                    0
                };
                let percentage = if progress.total_bytes > 0 {
                    (progress.bytes_transferred * 100 / progress.total_bytes) as u32
                } else {
                    0
                };
                let event_name = format!("sftp:transfer:{}:{}", session_id_clone, task_id_clone);
                let _ = app_clone.emit(
                    &event_name,
                    serde_json::json!({
                        "taskId": task_id_clone,
                        "sessionId": session_id_clone,
                        "type": "download",
                        "path": remote_path_clone,
                        "bytesTransferred": progress.bytes_transferred,
                        "totalBytes": progress.total_bytes,
                        "percentage": percentage,
                        "speed": speed,
                    }),
                );
                last_emit_time = now;
                last_emit_bytes = progress.bytes_transferred;
            }
        }
    });

    let result = sftp_client::download_file_streaming(
        &sftp,
        &remote_path,
        &local_path,
        Some(progress_tx),
        Some(cancel_token),
        None,
    )
    .await;

    drop(sftp);

    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), progress_task).await;

    {
        let mut cancels = state.transfer_cancels.write().await;
        cancels.remove(&task_id);
    }

    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: State<'_, TerminalState>,
    task_id: String,
) -> Result<(), String> {
    let cancels = state.transfer_cancels.read().await;
    if let Some(token) = cancels.get(&task_id) {
        token.cancel();
        Ok(())
    } else {
        Err(format!("Transfer task not found: {}", task_id))
    }
}

fn connections_path() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir().ok_or_else(|| "Cannot determine config directory".to_string())?;
    let dir = config_dir.join("mona");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(dir.join("terminal-connections.json"))
}

#[tauri::command]
pub async fn terminal_save_connections(
    connections: Vec<ConnectionConfig>,
) -> Result<(), String> {
    let safe_connections: Vec<ConnectionConfig> = connections
        .iter()
        .map(|c| ConnectionConfig {
            auth: credential_store::store_credential(&c.auth, &c.host, c.port, &c.username),
            ..c.clone()
        })
        .collect();

    let path = connections_path()?;
    let json = serde_json::to_string_pretty(&safe_connections)
        .map_err(|e| TerminalError::ConfigSave(e.to_string()).to_string())?;
    let mut file = std::fs::File::create(&path)
        .map_err(|e| TerminalError::ConfigSave(e.to_string()).to_string())?;
    file.write_all(json.as_bytes())
        .map_err(|e| TerminalError::ConfigSave(e.to_string()).to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_load_connections() -> Result<Vec<ConnectionConfig>, String> {
    let path = connections_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| TerminalError::ConfigLoad(e.to_string()).to_string())?;
    let connections: Vec<ConnectionConfig> = serde_json::from_str(&data)
        .map_err(|e| TerminalError::ConfigLoad(e.to_string()).to_string())?;
    Ok(connections)
}

#[derive(serde::Serialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub config_id: String,
    pub session_type: String,
    pub status: String,
    pub created_at: String,
}

#[tauri::command]
pub async fn terminal_list_sessions(
    state: State<'_, TerminalState>,
) -> Result<Vec<SessionInfo>, String> {
    let sessions = state.manager.list_sessions().await;
    Ok(sessions
        .into_iter()
        .map(|s| SessionInfo {
            id: s.id,
            config_id: s.config_id,
            session_type: match s.session_type {
                SessionType::Ssh => "ssh".to_string(),
                SessionType::Local => "local".to_string(),
                SessionType::Sftp => "sftp".to_string(),
                SessionType::Desktop => "desktop".to_string(),
                SessionType::Vnc => "vnc".to_string(),
            },
            status: match s.status {
                SessionStatus::Disconnected => "disconnected".to_string(),
                SessionStatus::Connecting => "connecting".to_string(),
                SessionStatus::Connected => "connected".to_string(),
                SessionStatus::Disconnecting => "disconnecting".to_string(),
                SessionStatus::Error(e) => format!("error:{}", e),
            },
            created_at: s.created_at.to_rfc3339(),
        })
        .collect())
}

#[tauri::command]
pub async fn terminal_get_output(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<String, String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Ssh(client) => Ok(client.get_buffer()),
        SessionHandle::Local(shell) => Ok(shell.get_buffer()),
        SessionHandle::Sftp(_) => Err("SFTP session has no terminal output".into()),
        SessionHandle::Desktop(_) => Err("Desktop session has no terminal output".into()),
        SessionHandle::Vnc => Err("VNC session has no terminal output".into()),
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

#[tauri::command]
pub async fn terminal_exec_command(
    state: State<'_, TerminalState>,
    session_id: String,
    command: String,
    source: Option<String>,
) -> Result<(), String> {
    if source.as_deref() == Some("ai") && is_dangerous_command(&command) {
        return Err(
            "Dangerous command requires approval. Use terminal_request_exec instead.".into(),
        );
    }

    let data = format!("{}\n", command);
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Ssh(client) => client
            .write(data.as_bytes())
            .await
            .map_err(|e| e.to_string()),
        SessionHandle::Local(shell) => shell.write(data.as_bytes()).map_err(|e| e.to_string()),
        SessionHandle::Sftp(_) => Err("Cannot execute command in SFTP session".into()),
        SessionHandle::Desktop(_) => Err("Cannot write to desktop session".into()),
        SessionHandle::Vnc => Err("Cannot write to VNC session".into()),
    }
}

#[tauri::command]
pub async fn terminal_request_exec(
    app_handle: tauri::AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    command: String,
    source: String,
) -> Result<String, String> {
    let (pending_cmd, mut rx) = state
        .approval
        .manager
        .submit(session_id, command, source)
        .await;

    let payload = serde_json::json!({
        "requestId": pending_cmd.request_id,
        "sessionId": pending_cmd.session_id,
        "command": pending_cmd.command,
        "source": pending_cmd.source,
    });
    let _ = app_handle.emit("terminal-exec-request", payload);

    match rx.await {
        Ok(ApprovalVerdict::Approved) => Ok("approved".to_string()),
        Ok(ApprovalVerdict::Rejected { reason }) => {
            Err(format!("Command rejected: {}", reason))
        }
        Err(_) => Err("Approval channel closed".to_string()),
    }
}

#[tauri::command]
pub async fn terminal_respond_exec(
    state: State<'_, TerminalState>,
    request_id: String,
    approved: bool,
    reason: Option<String>,
) -> Result<(), String> {
    let verdict = if approved {
        ApprovalVerdict::Approved
    } else {
        ApprovalVerdict::Rejected {
            reason: reason.unwrap_or_else(|| "User rejected".to_string()),
        }
    };

    let pending_cmd = state
        .approval
        .manager
        .respond(&request_id, verdict)
        .await?;

    if approved {
        let data = format!("{}\n", pending_cmd.command);
        let handle = state
            .manager
            .get_handle(&pending_cmd.session_id)
            .await
            .ok_or_else(|| {
                TerminalError::SessionNotFound(pending_cmd.session_id.clone()).to_string()
            })?;

        match handle {
            SessionHandle::Ssh(client) => {
                client
                    .write(data.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            SessionHandle::Local(shell) => {
                shell.write(data.as_bytes()).map_err(|e| e.to_string())?;
            }
            SessionHandle::Sftp(_) => {
                return Err("Cannot execute command in SFTP session".into());
            }
            SessionHandle::Desktop(_) => {
                return Err("Cannot write to desktop session".into());
            }
            SessionHandle::Vnc => {
                return Err("Cannot write to VNC session".into());
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn terminal_list_pending_exec(
    state: State<'_, TerminalState>,
) -> Result<Vec<PendingCommand>, String> {
    Ok(state.approval.manager.list_pending().await)
}

#[tauri::command]
pub async fn get_file_icon(path: String) -> Result<String, String> {
    let icon = file_icon_provider::get_file_icon(&path, 16)
        .map_err(|e| format!("Failed to get icon: {}", e))?;

    let mut png_data = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_data, icon.width, icon.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("PNG header error: {}", e))?;
        writer
            .write_image_data(&icon.pixels)
            .map_err(|e| format!("PNG write error: {}", e))?;
    }

    Ok(data_encoding::BASE64.encode(&png_data))
}

#[tauri::command]
pub async fn get_file_type_icon(extension: String, is_directory: bool) -> Result<Option<String>, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES,
    };
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;

    let fake_name = if is_directory {
        "C:\\__sftp__\\__folder__\\".to_string()
    } else if extension.is_empty() {
        "C:\\__sftp__\\file".to_string()
    } else {
        format!("C:\\__sftp__\\file.{}", extension)
    };

    let path_wide: Vec<u16> = std::ffi::OsStr::new(&fake_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let icon_data = unsafe {
        let mut shfi: SHFILEINFOW = std::mem::zeroed();
        let flags = SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES;
        let file_attrs = FILE_FLAGS_AND_ATTRIBUTES(if is_directory { 0x10 } else { 0 });

        let result = SHGetFileInfoW(
            windows::core::PCWSTR(path_wide.as_ptr()),
            file_attrs,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        );

        if result == 0 || shfi.hIcon.is_invalid() {
            return Ok(None);
        }

        let png_data = icon_to_png_simple(shfi.hIcon);
        let _ = DestroyIcon(shfi.hIcon);
        png_data
    };

    match icon_data {
        Some(data) => Ok(Some(data_encoding::BASE64.encode(&data))),
        None => Ok(None),
    }
}

unsafe fn icon_to_png_simple(
    hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
) -> Option<Vec<u8>> {
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO, DrawIconEx, DI_NORMAL};
    use windows::Win32::Graphics::Gdi::{
        GetDC, ReleaseDC, CreateCompatibleDC, DeleteDC, DeleteObject, SelectObject,
        CreateCompatibleBitmap, GetDIBits, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
        GetObjectW, BITMAP,
    };
    use windows::Win32::Graphics::Gdi::HGDIOBJ;

    let mut icon_info: ICONINFO = std::mem::zeroed();
    if GetIconInfo(hicon, &mut icon_info).is_err() {
        return None;
    }

    let mut width: i32 = 16;
    let mut height: i32 = 16;

    if !icon_info.hbmColor.is_invalid() {
        let mut bmp: BITMAP = std::mem::zeroed();
        if GetObjectW(
            icon_info.hbmColor.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        ) != 0
        {
            width = bmp.bmWidth;
            height = bmp.bmHeight;
        }
    }

    let hdc_screen = GetDC(None);
    let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
    let hbitmap = CreateCompatibleBitmap(hdc_screen, width, height);
    if hbitmap.is_invalid() {
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(None, hdc_screen);
        let _ = DeleteObject(HGDIOBJ::from(icon_info.hbmColor));
        let _ = DeleteObject(HGDIOBJ::from(icon_info.hbmMask));
        return None;
    }

    let old_bitmap = SelectObject(hdc_mem, HGDIOBJ::from(hbitmap));
    let draw_result = DrawIconEx(hdc_mem, 0, 0, hicon, width, height, 0, None, DI_NORMAL);

    if draw_result.is_err() {
        SelectObject(hdc_mem, old_bitmap);
        let _ = DeleteObject(HGDIOBJ::from(hbitmap));
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(None, hdc_screen);
        if !icon_info.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ::from(icon_info.hbmColor));
        }
        if !icon_info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ::from(icon_info.hbmMask));
        }
        return None;
    }

    let mut buffer: Vec<u8> = vec![0u8; (width * height * 4) as usize];
    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = width;
    bmi.bmiHeader.biHeight = -height;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;

    let scan_lines = GetDIBits(
        hdc_mem,
        hbitmap,
        0,
        height as u32,
        Some(buffer.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );

    SelectObject(hdc_mem, old_bitmap);
    let _ = DeleteObject(HGDIOBJ::from(hbitmap));
    let _ = DeleteDC(hdc_mem);
    ReleaseDC(None, hdc_screen);

    if !icon_info.hbmColor.is_invalid() {
        let _ = DeleteObject(HGDIOBJ::from(icon_info.hbmColor));
    }
    if !icon_info.hbmMask.is_invalid() {
        let _ = DeleteObject(HGDIOBJ::from(icon_info.hbmMask));
    }

    if scan_lines == 0 {
        return None;
    }

    for chunk in buffer.chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }

    let mut png_data = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_data, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&buffer).ok()?;
    }

    Some(png_data)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified: Option<String>,
}

#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<Vec<LocalFileInfo>, String> {
    let dir_path = PathBuf::from(&path);
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let metadata = entry.metadata().map_err(|e| format!("Failed to read metadata: {}", e))?;
        let name = entry
            .file_name()
            .to_string_lossy()
            .to_string();
        let file_path = entry.path().to_string_lossy().to_string();

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| {
                let dur = t.duration_since(std::time::UNIX_EPOCH).ok()?;
                Some(chrono::DateTime::from_timestamp(dur.as_secs() as i64, 0)?
                    .format("%Y-%m-%d %H:%M")
                    .to_string())
            });

        entries.push(LocalFileInfo {
            name,
            path: file_path,
            is_dir: metadata.is_dir(),
            size: if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            },
            modified,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn local_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

#[tauri::command]
pub async fn local_desktop_dir() -> Result<String, String> {
    dirs::desktop_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine desktop directory".to_string())
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BatchSessionInfo {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchUploadRequest {
    pub sessions: Vec<BatchSessionInfo>,
    pub files: Vec<String>,
    pub target_directory: String,
    pub max_concurrent: Option<usize>,
}

#[tauri::command]
pub async fn sftp_batch_upload(
    app_handle: tauri::AppHandle,
    state: State<'_, TerminalState>,
    request: BatchUploadRequest,
) -> Result<String, String> {
    let batch_id = uuid::Uuid::new_v4().to_string();
    let max_concurrent = request.max_concurrent.unwrap_or(3);
    let retry_count: u32 = 2;
    let retry_delay_ms: u64 = 1000;

    let mut ssh_clients: Vec<(BatchSessionInfo, Arc<crate::terminal::ssh::client::SshClient>)> = Vec::new();
    for info in &request.sessions {
        let handle = state.manager.get_handle(&info.session_id).await;
        if let Some(SessionHandle::Ssh(ssh_client)) = handle {
            ssh_clients.push((info.clone(), ssh_client));
        } else {
            return Err(format!("SSH session not found for {}", info.host));
        }
    }

    let semaphore = Arc::new(Semaphore::new(max_concurrent));
    let cancel_token = CancellationToken::new();
    let is_paused = Arc::new(AtomicBool::new(false));
    let resume_notify = Arc::new(Notify::new());
    let target_dir = request.target_directory.clone();
    let files = request.files.clone();
    let batch_id_clone = batch_id.clone();

    {
        let control = BatchTransferControl {
            cancel_token: cancel_token.clone(),
            is_paused: is_paused.clone(),
            resume_notify: resume_notify.clone(),
        };
        let mut transfers = state.batch_transfer.active_transfers.write().await;
        transfers.insert(batch_id.clone(), control);
    }

    let active_transfers = state.batch_transfer.active_transfers.clone();

    tokio::spawn(async move {
        let mut handles = Vec::new();

        for (info, ssh_client) in ssh_clients {
            if cancel_token.is_cancelled() {
                break;
            }

            let permit = match semaphore.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => break,
            };

            let app_handle = app_handle.clone();
            let batch_id = batch_id_clone.clone();
            let target_dir = target_dir.clone();
            let files = files.clone();
            let cancel_token = cancel_token.clone();
            let is_paused = is_paused.clone();
            let resume_notify = resume_notify.clone();
            let session_id = info.session_id.clone();
            let host = info.host.clone();
            let file_max_concurrent = max_concurrent;

            let handle = tokio::spawn(async move {
                let _permit = permit;

                loop {
                    if !is_paused.load(Ordering::Relaxed) {
                        break;
                    }
                    resume_notify.notified().await;
                }
                if cancel_token.is_cancelled() {
                    let _ = app_handle.emit(
                        "sftp:batch_progress",
                        BatchTransferProgress {
                            batch_id: batch_id.clone(),
                            session_id: session_id.clone(),
                            host: host.clone(),
                            status: BatchTransferStatus::Cancelled,
                            current_file: None,
                            files_completed: 0,
                            files_total: files.len(),
                            bytes_transferred: 0,
                            bytes_total: 0,
                            error: Some("任务已取消".to_string()),
                            speed: None,
                            eta_seconds: None,
                        },
                    );
                    return;
                }

                let _ = app_handle.emit(
                    "sftp:batch_progress",
                    BatchTransferProgress {
                        batch_id: batch_id.clone(),
                        session_id: session_id.clone(),
                        host: host.clone(),
                        status: BatchTransferStatus::Connecting,
                        current_file: None,
                        files_completed: 0,
                        files_total: files.len(),
                        bytes_transferred: 0,
                        bytes_total: 0,
                        error: None,
                        speed: None,
                        eta_seconds: None,
                    },
                );

                let files_completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
                let bytes_transferred = Arc::new(std::sync::atomic::AtomicU64::new(0));
                let upload_errors: Arc<tokio::sync::RwLock<Vec<String>>> =
                    Arc::new(tokio::sync::RwLock::new(Vec::new()));

                let mut total_bytes_all_files: u64 = 0;
                for local_path in &files {
                    if let Ok(metadata) = tokio::fs::metadata(local_path).await {
                        total_bytes_all_files += metadata.len();
                    }
                }

                let file_semaphore = Arc::new(Semaphore::new(file_max_concurrent));
                let mut file_handles = Vec::new();

                for local_path in &files {
                    if cancel_token.is_cancelled() {
                        break;
                    }

                    let filename = local_path
                        .rsplit(|c| c == '\\' || c == '/')
                        .next()
                        .unwrap_or("file");
                    let remote_path = format!(
                        "{}/{}",
                        target_dir.trim_end_matches('/'),
                        filename
                    );

                    let file_permit = match file_semaphore.clone().acquire_owned().await {
                        Ok(p) => p,
                        Err(_) => break,
                    };

                    let ssh_client_clone = ssh_client.clone();
                    let app_handle_clone = app_handle.clone();
                    let batch_id_clone = batch_id.clone();
                    let session_id_clone = session_id.clone();
                    let host_clone = host.clone();
                    let filename_clone = filename.to_string();
                    let local_path_clone = local_path.clone();
                    let cancel_token_clone = cancel_token.clone();
                    let is_paused_clone = is_paused.clone();
                    let resume_notify_clone = resume_notify.clone();
                    let files_completed_clone = files_completed.clone();
                    let bytes_transferred_clone = bytes_transferred.clone();
                    let upload_errors_clone = upload_errors.clone();
                    let files_total = files.len();

                    let file_handle = tokio::spawn(async move {
                        let _permit = file_permit;

                        loop {
                            if !is_paused_clone.load(Ordering::Relaxed) {
                                break;
                            }
                            resume_notify_clone.notified().await;
                        }
                        if cancel_token_clone.is_cancelled() {
                            return;
                        }

                        let mut last_error: Option<String> = None;
                        let mut upload_ok = false;

                        for attempt in 0..=retry_count {
                            if cancel_token_clone.is_cancelled() {
                                break;
                            }
                            if attempt > 0 {
                                let delay = retry_delay_ms * (1 << (attempt - 1));
                                log::warn!(
                                    "[{}] Upload retry {}/{} for {}, waiting {}ms",
                                    host_clone,
                                    attempt,
                                    retry_count,
                                    filename_clone,
                                    delay
                                );
                                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                            }

                            match ssh_client_clone.open_sftp().await {
                                Ok(channel) => {
                                    let (progress_tx, progress_rx) =
                                        tokio::sync::mpsc::channel::<crate::terminal::sftp::batch::FileTransferProgress>(100);

                                    let progress_app = app_handle_clone.clone();
                                    let progress_batch_id = batch_id_clone.clone();
                                    let progress_session_id = session_id_clone.clone();
                                    let progress_host = host_clone.clone();
                                    let progress_filename = filename_clone.clone();
                                    let progress_files_completed =
                                        files_completed_clone.clone();
                                    let progress_bytes_transferred =
                                        bytes_transferred_clone.clone();

                                    let progress_forward = tokio::spawn(async move {
                                        let mut last_time = std::time::Instant::now();
                                        let start_time = std::time::Instant::now();
                                        let mut rx = progress_rx;
                                        while let Some(p) = rx.recv().await {
                                            if last_time.elapsed().as_millis() >= 500 {
                                                let elapsed = start_time.elapsed().as_secs();
                                                let speed = if elapsed > 0 {
                                                    Some(p.bytes_transferred / elapsed)
                                                } else {
                                                    None
                                                };
                                                let current_completed = progress_files_completed.load(Ordering::Relaxed);
                                                let current_bytes = progress_bytes_transferred.load(Ordering::Relaxed);
                                                let _ = progress_app.emit(
                                                    "sftp:batch_progress",
                                                    BatchTransferProgress {
                                                        batch_id: progress_batch_id.clone(),
                                                        session_id: progress_session_id.clone(),
                                                        host: progress_host.clone(),
                                                        status: BatchTransferStatus::Transferring,
                                                        current_file: Some(progress_filename.clone()),
                                                        files_completed: current_completed,
                                                        files_total,
                                                        bytes_transferred: current_bytes + p.bytes_transferred,
                                                        bytes_total: total_bytes_all_files,
                                                        error: None,
                                                        speed,
                                                        eta_seconds: None,
                                                    },
                                                );
                                                last_time = std::time::Instant::now();
                                            }
                                        }
                                    });

                                    let result = sftp_client::upload_file_streaming(
                                        &channel,
                                        &local_path_clone,
                                        &remote_path,
                                        Some(progress_tx),
                                        Some(cancel_token_clone.clone()),
                                        Some(is_paused_clone.clone()),
                                    )
                                    .await;

                                    let _ = channel.close().await;
                                    let _ = tokio::time::timeout(
                                        std::time::Duration::from_secs(1),
                                        progress_forward,
                                    )
                                    .await;

                                    match result {
                                        Ok(()) => {
                                            if let Ok(metadata) =
                                                tokio::fs::metadata(&local_path_clone).await
                                            {
                                                bytes_transferred_clone
                                                    .fetch_add(metadata.len(), Ordering::Relaxed);
                                            }
                                            upload_ok = true;
                                            break;
                                        }
                                        Err(e) => {
                                            last_error = Some(format!("{}", e));
                                            log::warn!(
                                                "[{}] Upload failed (attempt {}/{}): {} - {}",
                                                host_clone,
                                                attempt + 1,
                                                retry_count + 1,
                                                filename_clone,
                                                e
                                            );
                                        }
                                    }
                                }
                                Err(e) => {
                                    last_error = Some(format!("{}", e));
                                    log::warn!(
                                        "[{}] Failed to create SFTP channel (attempt {}/{}): {}",
                                        host_clone,
                                        attempt + 1,
                                        retry_count + 1,
                                        e
                                    );
                                }
                            }
                        }

                        if upload_ok {
                            let new_completed =
                                files_completed_clone.fetch_add(1, Ordering::Relaxed) + 1;
                            let current_bytes =
                                bytes_transferred_clone.load(Ordering::Relaxed);
                            let _ = app_handle_clone.emit(
                                "sftp:batch_progress",
                                BatchTransferProgress {
                                    batch_id: batch_id_clone.clone(),
                                    session_id: session_id_clone.clone(),
                                    host: host_clone.clone(),
                                    status: BatchTransferStatus::Completed,
                                    current_file: Some(filename_clone.clone()),
                                    files_completed: new_completed,
                                    files_total,
                                    bytes_transferred: current_bytes,
                                    bytes_total: total_bytes_all_files,
                                    error: None,
                                    speed: None,
                                    eta_seconds: None,
                                },
                            );
                        } else {
                            let err_msg = last_error.unwrap_or_default();
                            let mut errors = upload_errors_clone.write().await;
                            errors.push(format!("上传 {} 失败: {}", filename_clone, err_msg));
                        }
                    });

                    file_handles.push(file_handle);
                }

                for handle in file_handles {
                    let _ = handle.await;
                }

                let final_files_completed = files_completed.load(Ordering::Relaxed);
                let final_bytes = bytes_transferred.load(Ordering::Relaxed);
                let final_errors: Vec<String> = upload_errors.read().await.clone();

                let final_status = if cancel_token.is_cancelled() {
                    BatchTransferStatus::Cancelled
                } else if !final_errors.is_empty() {
                    BatchTransferStatus::Error
                } else {
                    BatchTransferStatus::Completed
                };

                let error_summary = if final_errors.is_empty() {
                    None
                } else {
                    Some(format!(
                        "{} 个文件失败: {}",
                        final_errors.len(),
                        final_errors.join("; ")
                    ))
                };

                let _ = app_handle.emit(
                    "sftp:batch_progress",
                    BatchTransferProgress {
                        batch_id: batch_id.clone(),
                        session_id: session_id.clone(),
                        host: host.clone(),
                        status: final_status,
                        current_file: None,
                        files_completed: final_files_completed,
                        files_total: files.len(),
                        bytes_transferred: final_bytes,
                        bytes_total: final_bytes,
                        error: error_summary,
                        speed: None,
                        eta_seconds: None,
                    },
                );
            });

            handles.push(handle);
        }

        for handle in handles {
            let _ = handle.await;
        }

        {
            let mut transfers = active_transfers.write().await;
            transfers.remove(&batch_id_clone);
        }
    });

    Ok(batch_id)
}

#[tauri::command]
pub async fn sftp_batch_cancel(
    state: State<'_, TerminalState>,
    batch_id: String,
) -> Result<(), String> {
    state
        .batch_transfer
        .cancel_batch(&batch_id)
        .await
        .map_err(|e| e)
}

#[tauri::command]
pub async fn sftp_batch_pause(
    state: State<'_, TerminalState>,
    batch_id: String,
) -> Result<(), String> {
    state
        .batch_transfer
        .pause_batch(&batch_id)
        .await
        .map_err(|e| e)
}

#[tauri::command]
pub async fn sftp_batch_resume(
    state: State<'_, TerminalState>,
    batch_id: String,
) -> Result<(), String> {
    state
        .batch_transfer
        .resume_batch(&batch_id)
        .await
        .map_err(|e| e)
}

#[tauri::command]
pub async fn sftp_touch(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    let client = get_sftp_client(&handle)?;
    client.touch(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    let client = get_sftp_client(&handle)?;
    client
        .set_permissions(&path, mode)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatDetail {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: u32,
    pub mode_string: String,
    pub owner: String,
    pub group: String,
    pub mtime: Option<String>,
    pub atime: Option<String>,
}

fn format_mode_string(permissions: u32) -> String {
    let file_type = if (permissions & 0o40000) != 0 {
        'd'
    } else if (permissions & 0o120000) != 0 {
        'l'
    } else {
        '-'
    };
    let owner_r = if (permissions & 0o400) != 0 { 'r' } else { '-' };
    let owner_w = if (permissions & 0o200) != 0 { 'w' } else { '-' };
    let owner_x = if (permissions & 0o100) != 0 { 'x' } else { '-' };
    let group_r = if (permissions & 0o040) != 0 { 'r' } else { '-' };
    let group_w = if (permissions & 0o020) != 0 { 'w' } else { '-' };
    let group_x = if (permissions & 0o010) != 0 { 'x' } else { '-' };
    let other_r = if (permissions & 0o004) != 0 { 'r' } else { '-' };
    let other_w = if (permissions & 0o002) != 0 { 'w' } else { '-' };
    let other_x = if (permissions & 0o001) != 0 { 'x' } else { '-' };
    format!(
        "{}{}{}{}{}{}{}{}{}{}",
        file_type,
        owner_r, owner_w, owner_x,
        group_r, group_w, group_x,
        other_r, other_w, other_x
    )
}

fn format_unix_timestamp(ts: Option<u32>) -> Option<String> {
    ts.map(|t| {
        chrono::DateTime::from_timestamp(t as i64, 0)
            .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_default()
    })
}

#[tauri::command]
pub async fn sftp_stat_detail(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<FileStatDetail, String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    let client = get_sftp_client(&handle)?;
    let info = client.stat(&path).await.map_err(|e| e.to_string())?;
    let permissions = info.permissions.unwrap_or(0);
    Ok(FileStatDetail {
        name: info.name,
        path: info.path,
        is_dir: info.is_dir,
        size: info.size.unwrap_or(0),
        permissions,
        mode_string: format_mode_string(permissions),
        owner: info.owner.unwrap_or_default(),
        group: info.group.unwrap_or_default(),
        mtime: format_unix_timestamp(info.mtime),
        atime: None,
    })
}

#[tauri::command]
pub async fn sftp_download_dir(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    task_id: Option<String>,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;
    let client = get_sftp_client(&handle)?;

    tokio::fs::create_dir_all(&local_path)
        .await
        .map_err(|e| format!("Failed to create local directory: {}", e))?;

    if let Some(tid) = &task_id {
        let sftp = client.create_sftp_channel().await.map_err(|e| e.to_string())?;
        let cancel_token = CancellationToken::new();
        {
            let mut cancels = state.transfer_cancels.write().await;
            cancels.insert(tid.clone(), cancel_token.clone());
        }

        let (progress_tx, mut progress_rx) =
            tokio::sync::mpsc::channel::<FileTransferProgress>(100);
        let app_clone = app.clone();
        let session_id_clone = session_id.clone();
        let task_id_clone = tid.clone();
        let remote_path_for_event = remote_path.clone();
        let progress_task = tokio::spawn(async move {
            let mut last_emit_time = std::time::Instant::now();
            let mut last_emit_bytes: u64 = 0;
            while let Some(progress) = progress_rx.recv().await {
                let now = std::time::Instant::now();
                let elapsed = now.duration_since(last_emit_time);
                if elapsed >= std::time::Duration::from_millis(200) {
                    let speed = if elapsed.as_secs_f64() > 0.0 {
                        ((progress.bytes_transferred - last_emit_bytes) as f64
                            / elapsed.as_secs_f64()) as u64
                    } else {
                        0
                    };
                    let percentage = if progress.total_bytes > 0 {
                        (progress.bytes_transferred * 100 / progress.total_bytes) as u32
                    } else {
                        0
                    };
                    let event_name = format!("sftp:transfer:{}:{}", session_id_clone, task_id_clone);
                    let _ = app_clone.emit(
                        &event_name,
                        serde_json::json!({
                            "taskId": task_id_clone,
                            "sessionId": session_id_clone,
                            "type": "download",
                            "path": remote_path_for_event,
                            "bytesTransferred": progress.bytes_transferred,
                            "totalBytes": progress.total_bytes,
                            "percentage": percentage,
                            "speed": speed,
                        }),
                    );
                    last_emit_time = now;
                    last_emit_bytes = progress.bytes_transferred;
                }
            }
        });

        let result = download_dir_streaming(
            &sftp,
            &session_id,
            &remote_path,
            &local_path,
            Some(progress_tx),
            Some(cancel_token),
        )
        .await;

        drop(sftp);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), progress_task).await;

        {
            let mut cancels = state.transfer_cancels.write().await;
            cancels.remove(tid.as_str());
        }

        result.map_err(|e| e.to_string())
    } else {
        download_dir_recursive(&client, &app, &session_id, &remote_path, &local_path)
            .await
            .map_err(|e| e.to_string())
    }
}

async fn download_dir_streaming(
    sftp: &russh_sftp::client::SftpSession,
    _session_id: &str,
    remote_path: &str,
    local_path: &str,
    progress_tx: Option<tokio::sync::mpsc::Sender<FileTransferProgress>>,
    cancel_token: Option<CancellationToken>,
) -> Result<(), TerminalError> {
    let local_path = std::path::Path::new(local_path);

    async fn download_dir_inner(
        sftp: &russh_sftp::client::SftpSession,
        remote_dir: &str,
        local_dir: &std::path::Path,
        progress_tx: &Option<tokio::sync::mpsc::Sender<FileTransferProgress>>,
        cancel_token: &Option<CancellationToken>,
        bytes_transferred: &mut u64,
        total_bytes: u64,
    ) -> Result<(), TerminalError> {
        if let Some(ref token) = cancel_token {
            if token.is_cancelled() {
                return Err(TerminalError::SftpOperation("Transfer cancelled".into()));
            }
        }

        let entries = sftp.read_dir(remote_dir).await.map_err(|e| {
            TerminalError::SftpOperation(format!("read_dir failed: {}", e))
        })?;

        for entry in entries {
            if let Some(ref token) = cancel_token {
                if token.is_cancelled() {
                    return Err(TerminalError::SftpOperation("Transfer cancelled".into()));
                }
            }

            let name = entry.file_name();
            let sanitized_name = {
                let invalid_chars = ['<', '>', ':', '"', '|', '?', '*'];
                let result: String = name.chars().map(|c| {
                    if invalid_chars.contains(&c) || (c as u32) <= 0x1F { '_' } else { c }
                }).collect();
                let trimmed = result.trim_end_matches(|c| c == ' ' || c == '.');
                if trimmed.is_empty() { "_".to_string() } else { trimmed.to_string() }
            };
            let local_entry_path = local_dir.join(&sanitized_name);
            let remote_entry_path = if remote_dir.ends_with('/') {
                format!("{}{}", remote_dir, name)
            } else {
                format!("{}/{}", remote_dir, name)
            };

            let file_type = entry.file_type();
            if file_type.is_dir() {
                tokio::fs::create_dir_all(&local_entry_path).await.map_err(|e| {
                    TerminalError::SftpOperation(format!(
                        "Failed to create directory '{}': {}",
                        local_entry_path.display(), e
                    ))
                })?;
                Box::pin(download_dir_inner(
                    sftp,
                    &remote_entry_path,
                    &local_entry_path,
                    progress_tx,
                    cancel_token,
                    bytes_transferred,
                    total_bytes,
                ))
                .await?;
            } else {
                let local_str = local_entry_path.to_string_lossy().to_string();
                sftp_client::download_file_streaming(
                    sftp,
                    &remote_entry_path,
                    &local_str,
                    None,
                    cancel_token.clone(),
                    None,
                )
                .await?;

                let metadata = entry.metadata();
                *bytes_transferred += metadata.size.unwrap_or(0);
                if let Some(ref tx) = progress_tx {
                    let _ = tx.try_send(FileTransferProgress {
                        bytes_transferred: *bytes_transferred,
                        total_bytes,
                    });
                }
            }
        }
        Ok(())
    }

    let entries = sftp.read_dir(remote_path).await.map_err(|e| {
        TerminalError::SftpOperation(format!("read_dir failed: {}", e))
    })?;

    let mut total_bytes: u64 = 0;
    for entry in entries {
        if !entry.file_type().is_dir() {
            total_bytes += entry.metadata().size.unwrap_or(0);
        }
    }

    let mut bytes_transferred: u64 = 0;
    download_dir_inner(
        sftp,
        remote_path,
        local_path,
        &progress_tx,
        &cancel_token,
        &mut bytes_transferred,
        total_bytes,
    )
    .await
}

async fn download_dir_recursive(
    client: &SftpClient,
    app: &AppHandle,
    session_id: &str,
    remote_path: &str,
    local_path: &str,
) -> Result<(), TerminalError> {
    let entries = client.list_dir(remote_path).await?;

    for entry in &entries {
        let sanitized_name = {
            let invalid_chars = ['<', '>', ':', '"', '|', '?', '*'];
            let result: String = entry.name.chars().map(|c| {
                if invalid_chars.contains(&c) || (c as u32) <= 0x1F { '_' } else { c }
            }).collect();
            let trimmed = result.trim_end_matches(|c| c == ' ' || c == '.');
            if trimmed.is_empty() { "_".to_string() } else { trimmed.to_string() }
        };
        let local_entry_path = std::path::Path::new(local_path).join(&sanitized_name);
        let local_entry_str = local_entry_path.to_string_lossy().to_string();
        let remote_entry_path = if remote_path.ends_with('/') {
            format!("{}{}", remote_path, entry.name)
        } else {
            format!("{}/{}", remote_path, entry.name)
        };

        if entry.is_dir {
            Box::pin(download_dir_recursive(
                client,
                app,
                session_id,
                &remote_entry_path,
                &local_entry_str,
            ))
            .await?;
        } else {
            let total_size = entry.size;
            let data = client
                .download_file_with_progress(
                    app.clone(),
                    session_id.to_string(),
                    &remote_entry_path,
                    total_size,
                )
                .await?;

            tokio::fs::write(&local_entry_str, &data)
                .await
                .map_err(|e| {
                    TerminalError::SftpOperation(format!(
                        "Failed to write local file: {}",
                        e
                    ))
                })?;

            let _ = app.emit(
                "sftp:transfer_progress",
                serde_json::json!({
                    "sessionId": session_id,
                    "path": remote_entry_path,
                    "direction": "download",
                    "bytesTransferred": data.len() as u64,
                    "totalBytes": total_size,
                }),
            );
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn sftp_upload_dir(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    task_id: Option<String>,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;
    let client = get_sftp_client(&handle)?;

    if let Some(tid) = &task_id {
        let sftp = client.create_sftp_channel().await.map_err(|e| e.to_string())?;
        let cancel_token = CancellationToken::new();
        {
            let mut cancels = state.transfer_cancels.write().await;
            cancels.insert(tid.clone(), cancel_token.clone());
        }

        client.mkdir_if_not_exists(&remote_path).await.map_err(|e| e.to_string())?;

        let (progress_tx, mut progress_rx) =
            tokio::sync::mpsc::channel::<FileTransferProgress>(100);
        let app_clone = app.clone();
        let session_id_clone = session_id.clone();
        let task_id_clone = tid.clone();
        let remote_path_for_event = remote_path.clone();
        let progress_task = tokio::spawn(async move {
            let mut last_emit_time = std::time::Instant::now();
            let mut last_emit_bytes: u64 = 0;
            while let Some(progress) = progress_rx.recv().await {
                let now = std::time::Instant::now();
                let elapsed = now.duration_since(last_emit_time);
                if elapsed >= std::time::Duration::from_millis(200) {
                    let speed = if elapsed.as_secs_f64() > 0.0 {
                        ((progress.bytes_transferred - last_emit_bytes) as f64
                            / elapsed.as_secs_f64()) as u64
                    } else {
                        0
                    };
                    let percentage = if progress.total_bytes > 0 {
                        (progress.bytes_transferred * 100 / progress.total_bytes) as u32
                    } else {
                        0
                    };
                    let event_name = format!("sftp:transfer:{}:{}", session_id_clone, task_id_clone);
                    let _ = app_clone.emit(
                        &event_name,
                        serde_json::json!({
                            "taskId": task_id_clone,
                            "sessionId": session_id_clone,
                            "type": "upload",
                            "path": remote_path_for_event,
                            "bytesTransferred": progress.bytes_transferred,
                            "totalBytes": progress.total_bytes,
                            "percentage": percentage,
                            "speed": speed,
                        }),
                    );
                    last_emit_time = now;
                    last_emit_bytes = progress.bytes_transferred;
                }
            }
        });

        let result = upload_dir_streaming(
            &sftp,
            &app,
            &session_id,
            &local_path,
            &remote_path,
            Some(progress_tx),
            Some(cancel_token),
        )
        .await;

        drop(sftp);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), progress_task).await;

        {
            let mut cancels = state.transfer_cancels.write().await;
            cancels.remove(tid.as_str());
        }

        result.map_err(|e| e.to_string())
    } else {
        client.mkdir_if_not_exists(&remote_path).await.map_err(|e| e.to_string())?;
        upload_dir_recursive(&client, &app, &session_id, &local_path, &remote_path)
            .await
            .map_err(|e| e.to_string())
    }
}

async fn upload_dir_streaming(
    sftp: &russh_sftp::client::SftpSession,
    _app: &AppHandle,
    _session_id: &str,
    local_path: &str,
    remote_path: &str,
    progress_tx: Option<tokio::sync::mpsc::Sender<FileTransferProgress>>,
    cancel_token: Option<CancellationToken>,
) -> Result<(), TerminalError> {
    let local_path = std::path::Path::new(local_path);
    let mut total_bytes: u64 = 0;
    let mut file_count: usize = 0;

    fn collect_files(dir: &std::path::Path, total: &mut u64, count: &mut usize) -> Result<(), TerminalError> {
        let entries = std::fs::read_dir(dir).map_err(|e| {
            TerminalError::SftpOperation(format!("Failed to read directory: {}", e))
        })?;
        for entry in entries {
            let entry = entry.map_err(|e| {
                TerminalError::SftpOperation(format!("Failed to read entry: {}", e))
            })?;
            let metadata = entry.metadata().map_err(|e| {
                TerminalError::SftpOperation(format!("Failed to read metadata: {}", e))
            })?;
            if metadata.is_dir() {
                collect_files(&entry.path(), total, count)?;
            } else {
                *total += metadata.len();
                *count += 1;
            }
        }
        Ok(())
    }
    collect_files(local_path, &mut total_bytes, &mut file_count)?;

    let mut bytes_transferred: u64 = 0;

    async fn upload_dir_inner(
        sftp: &russh_sftp::client::SftpSession,
        local_dir: &std::path::Path,
        remote_dir: &str,
        progress_tx: &Option<tokio::sync::mpsc::Sender<FileTransferProgress>>,
        cancel_token: &Option<CancellationToken>,
        bytes_transferred: &mut u64,
        total_bytes: u64,
    ) -> Result<(), TerminalError> {
        if let Some(ref token) = cancel_token {
            if token.is_cancelled() {
                return Err(TerminalError::SftpOperation("Transfer cancelled".into()));
            }
        }

        let mut read_dir = tokio::fs::read_dir(local_dir).await.map_err(|e| {
            TerminalError::SftpOperation(format!("Failed to read directory: {}", e))
        })?;

        while let Some(entry) = read_dir.next_entry().await.map_err(|e| {
            TerminalError::SftpOperation(format!("Failed to read entry: {}", e))
        })? {
            if let Some(ref token) = cancel_token {
                if token.is_cancelled() {
                    return Err(TerminalError::SftpOperation("Transfer cancelled".into()));
                }
            }

            let name = entry.file_name().to_string_lossy().to_string();
            let local_entry_path = entry.path();
            let remote_entry_path = if remote_dir.ends_with('/') {
                format!("{}{}", remote_dir, name)
            } else {
                format!("{}/{}", remote_dir, name)
            };

            let metadata = entry.metadata().await.map_err(|e| {
                TerminalError::SftpOperation(format!("Failed to read metadata: {}", e))
            })?;

            if metadata.is_dir() {
                if let Err(e) = sftp.create_dir(&remote_entry_path).await {
                    let err_str = format!("{}", e).to_lowercase();
                    if !err_str.contains("exist") && !err_str.contains("failure") {
                        return Err(TerminalError::SftpOperation(format!("mkdir failed: {}", e)));
                    }
                }
                Box::pin(upload_dir_inner(
                    sftp,
                    &local_entry_path,
                    &remote_entry_path,
                    progress_tx,
                    cancel_token,
                    bytes_transferred,
                    total_bytes,
                ))
                .await?;
            } else {
                let local_str = local_entry_path.to_string_lossy().to_string();
                sftp_client::upload_file_streaming(
                    sftp,
                    &local_str,
                    &remote_entry_path,
                    None,
                    cancel_token.clone(),
                    None,
                )
                .await?;

                *bytes_transferred += metadata.len();
                if let Some(ref tx) = progress_tx {
                    let _ = tx.try_send(FileTransferProgress {
                        bytes_transferred: *bytes_transferred,
                        total_bytes,
                    });
                }
            }
        }
        Ok(())
    }

    upload_dir_inner(
        sftp,
        local_path,
        remote_path,
        &progress_tx,
        &cancel_token,
        &mut bytes_transferred,
        total_bytes,
    )
    .await
}

async fn upload_dir_recursive(
    client: &SftpClient,
    app: &AppHandle,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
) -> Result<(), TerminalError> {
    let mut read_dir = tokio::fs::read_dir(local_path)
        .await
        .map_err(|e| {
            TerminalError::SftpOperation(format!("Failed to read local directory: {}", e))
        })?;

    while let Some(entry) = read_dir.next_entry().await.map_err(|e| {
        TerminalError::SftpOperation(format!("Failed to read directory entry: {}", e))
    })? {
        let name = entry.file_name().to_string_lossy().to_string();
        let local_entry_path = entry.path().to_string_lossy().to_string();
        let remote_entry_path = if remote_path.ends_with('/') {
            format!("{}{}", remote_path, name)
        } else {
            format!("{}/{}", remote_path, name)
        };

        let metadata = entry.metadata().await.map_err(|e| {
            TerminalError::SftpOperation(format!("Failed to read local metadata: {}", e))
        })?;

        if metadata.is_dir() {
            client.mkdir_if_not_exists(&remote_entry_path).await?;
            Box::pin(upload_dir_recursive(
                client,
                app,
                session_id,
                &local_entry_path,
                &remote_entry_path,
            ))
            .await?;
        } else {
            let data = tokio::fs::read(&local_entry_path).await.map_err(|e| {
                TerminalError::SftpOperation(format!("Failed to read local file: {}", e))
            })?;
            let total = data.len() as u64;
            client
                .upload_file_with_progress(
                    app.clone(),
                    session_id.to_string(),
                    &remote_entry_path,
                    data,
                )
                .await?;

            let _ = app.emit(
                "sftp:transfer_progress",
                serde_json::json!({
                    "sessionId": session_id,
                    "path": remote_entry_path,
                    "direction": "upload",
                    "bytesTransferred": total,
                    "totalBytes": total,
                }),
            );
        }
    }

    Ok(())
}
