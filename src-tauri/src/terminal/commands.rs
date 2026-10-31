use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

use crate::terminal::approval::{ApprovalVerdict, PendingCommand};
use crate::terminal::config::{AuthConfig, ConnectionConfig, ConnectionState, Protocol};
use crate::terminal::credential_store;
use crate::terminal::error::TerminalError;
use crate::terminal::session::{Session, SessionHandle, SessionStatus, SessionType};
use crate::terminal::sftp::batch::{
    BatchTransferControl, BatchTransferProgress, BatchTransferStatus, FileTransferProgress,
};
use crate::terminal::sftp::client as sftp_client;
use crate::terminal::sftp::client::{FileInfo, SftpClient};
use crate::terminal::sftp::upload::collect_upload_entries;
use crate::terminal::shell::local::LocalShell;
use crate::terminal::ssh::client::SshClient;
use crate::terminal::TerminalState;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;

#[cfg(test)]
#[path = "sftp/download_tests.rs"]
mod download_tests;

pub(crate) static CONNECTIONS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

async fn with_transfer_control<F, T>(
    state: &TerminalState,
    task_id: Option<&str>,
    operation: F,
) -> Result<(), String>
where
    F: FnOnce(CancellationToken) -> T,
    T: std::future::Future<Output = Result<(), String>>,
{
    let cancel = CancellationToken::new();
    if let Some(id) = task_id {
        state
            .transfer_cancels
            .write()
            .await
            .insert(id.to_owned(), cancel.clone());
    }
    let result = operation(cancel).await;
    if let Some(id) = task_id {
        state.transfer_cancels.write().await.remove(id);
    }
    if let Err(error) = &result {
        log::warn!("SFTP transfer failed (task={:?}): {}", task_id, error);
    }
    result
}

#[tauri::command]
pub async fn ssh_connect(
    app_handle: tauri::AppHandle,
    state: State<'_, TerminalState>,
    config: ConnectionConfig,
) -> Result<String, String> {
    let config = ConnectionConfig {
        auth: credential_store::restore_credential(
            &config.auth,
            &config.host,
            config.port,
            &config.username,
        )
        .map_err(|e| e)?,
        ..config
    };

    let session_id = uuid::Uuid::new_v4().to_string();

    let session_type = match config.protocol {
        Protocol::Ssh => SessionType::Ssh,
        Protocol::Sftp => SessionType::Sftp,
        Protocol::Ftp | Protocol::Local | Protocol::Vnc => SessionType::Ssh,
    };

    if session_type == SessionType::Sftp {
        let client = SftpClient::connect(&config.host, config.port, &config.username, &config.auth)
            .await
            .map_err(|e| e.to_string())?;

        let session = Session {
            id: session_id.clone(),
            config_id: config.id.clone(),
            session_type,
            status: SessionStatus::Connected,
            target_label: format!("{}@{}:{}", config.username, config.host, config.port),
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
        status: SessionStatus::Connecting,
        target_label: format!("{}@{}:{}", config.username, config.host, config.port),
        created_at: chrono::Utc::now(),
    };
    let generation = session.created_at.timestamp_millis();
    let client = Arc::new(client);

    state
        .manager
        .create(session, SessionHandle::Ssh(Arc::clone(&client)))
        .await
        .map_err(|e| e.to_string())?;

    if let Err(error) = client
        .start_shell(
            app_handle,
            Some((state.manager.clone(), generation)),
            session_id.clone(),
            80,
            24,
        )
        .await
    {
        state.manager.remove(&session_id).await;
        return Err(error.to_string());
    }

    if let Err(error) = state
        .manager
        .update_status(&session_id, SessionStatus::Connected)
        .await
    {
        state.manager.remove(&session_id).await;
        return Err(error.to_string());
    }

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
    accept_new_host_key: Option<bool>,
) -> Result<String, String> {
    log::debug!(
        "[batch] ssh_connect_with_id called: session_id={}, host={}:{}",
        session_id,
        config.host,
        config.port
    );

    let connect_result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        ssh_connect_with_id_inner(
            app_handle,
            state,
            session_id.clone(),
            config,
            cols,
            rows,
            accept_new_host_key.unwrap_or(false),
        ),
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
    accept_new_host_key: bool,
) -> Result<String, String> {
    log::debug!(
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
        auth: credential_store::restore_credential(
            &config.auth,
            &config.host,
            config.port,
            &config.username,
        )
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

    log::debug!(
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
        Protocol::Ftp | Protocol::Local | Protocol::Vnc => SessionType::Ssh,
    };

    if session_type == SessionType::Sftp {
        let client = SftpClient::connect(&config.host, config.port, &config.username, &config.auth)
            .await
            .map_err(|e| e.to_string())?;

        let session = Session {
            id: session_id.clone(),
            config_id: config.id.clone(),
            session_type,
            status: SessionStatus::Connected,
            target_label: format!("{}@{}:{}", config.username, config.host, config.port),
            created_at: chrono::Utc::now(),
        };

        state
            .manager
            .create(session, SessionHandle::Sftp(Arc::new(client)))
            .await
            .map_err(|e| e.to_string())?;

        return Ok(session_id);
    }

    let client =
        SshClient::connect_with_verify(
            &config.host,
            config.port,
            &config.username,
            &config.auth,
            state.known_hosts.clone(),
            accept_new_host_key,
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

    log::debug!(
        "[batch] SSH connected for session_id={}, host={}",
        session_id,
        config.host
    );

    let session = Session {
        id: session_id.clone(),
        config_id: config.id.clone(),
        session_type,
        status: SessionStatus::Connecting,
        target_label: format!("{}@{}:{}", config.username, config.host, config.port),
        created_at: chrono::Utc::now(),
    };
    let generation = session.created_at.timestamp_millis();
    let client = Arc::new(client);

    state
        .manager
        .create(session, SessionHandle::Ssh(Arc::clone(&client)))
        .await
        .map_err(|e| {
            log::error!(
                "[batch] Session create failed for session_id={}: {}",
                session_id,
                e
            );
            e.to_string()
        })?;

    if let Err(error) = client
        .start_shell(
            app_handle,
            Some((state.manager.clone(), generation)),
            session_id.clone(),
            cols,
            rows,
        )
        .await
    {
        log::error!(
            "[batch] start_shell failed for session_id={}: {}",
            session_id,
            error
        );
        state.manager.remove(&session_id).await;
        return Err(error.to_string());
    }

    log::debug!(
        "[batch] Shell started for session_id={}, marking connected",
        session_id
    );

    if let Err(error) = state
        .manager
        .update_status(&session_id, SessionStatus::Connected)
        .await
    {
        state.manager.remove(&session_id).await;
        return Err(error.to_string());
    }

    log::debug!(
        "[batch] Session connected successfully: session_id={}",
        session_id
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    state.docker.cancel_session(&session_id).await;
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    state
        .manager
        .update_status(&session_id, SessionStatus::Disconnected)
        .await
        .map_err(|e| e.to_string())?;

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

    let sftp_session = ssh_client.open_sftp().await.map_err(|e| e.to_string())?;

    let sftp_client = SftpClient::from_session(sftp_session, ssh_client);

    let new_session_id = uuid::Uuid::new_v4().to_string();
    let target_label = state
        .manager
        .get(&session_id)
        .await
        .map(|s| s.target_label)
        .unwrap_or_default();
    let session = Session {
        id: new_session_id.clone(),
        config_id: String::new(),
        session_type: SessionType::Sftp,
        status: SessionStatus::Connected,
        target_label,
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
    state.docker.cancel_session(&session_id).await;
    let config = ConnectionConfig {
        auth: credential_store::restore_credential(
            &config.auth,
            &config.host,
            config.port,
            &config.username,
        )
        .map_err(|e| e)?,
        ..config
    };

    let session_type = match config.protocol {
        Protocol::Ssh => SessionType::Ssh,
        Protocol::Sftp => SessionType::Sftp,
        Protocol::Ftp | Protocol::Local | Protocol::Vnc => SessionType::Ssh,
    };

    state
        .manager
        .update_status(&session_id, SessionStatus::Connecting)
        .await
        .map_err(|e| e.to_string())?;

    let client = match SshClient::connect(
        &config.host,
        config.port,
        &config.username,
        &config.auth,
        state.known_hosts.clone(),
    )
    .await
    {
        Ok(client) => client,
        Err(error) => {
            let message = error.to_string();
            let _ = state
                .manager
                .update_status(&session_id, SessionStatus::Error(message.clone()))
                .await;
            return Err(message);
        }
    };

    let created_at = chrono::Utc::now();
    let generation = created_at.timestamp_millis();
    let client = Arc::new(client);

    state
        .manager
        .create(
            Session {
                id: session_id.clone(),
                config_id: config.id.clone(),
                session_type: session_type.clone(),
                status: SessionStatus::Connecting,
                target_label: format!("{}@{}:{}", config.username, config.host, config.port),
                created_at,
            },
            SessionHandle::Ssh(Arc::clone(&client)),
        )
        .await
        .map_err(|e| e.to_string())?;

    if session_type == SessionType::Ssh {
        if let Err(error) = client
            .start_shell(
                app_handle,
                Some((state.manager.clone(), generation)),
                session_id.clone(),
                80,
                24,
            )
            .await
        {
            let message = error.to_string();
            let _ = state
                .manager
                .update_status(&session_id, SessionStatus::Error(message.clone()))
                .await;
            return Err(message);
        }
    }

    state
        .manager
        .update_status(&session_id, SessionStatus::Connected)
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
        SessionHandle::Ssh(client) => client
            .write(data.as_bytes())
            .await
            .map_err(|e| e.to_string()),
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
    cwd: Option<String>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let cwd = cwd
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    if let Some(path) = &cwd {
        if !path.is_dir() {
            return Err(format!(
                "Terminal working directory does not exist: {}",
                path.display()
            ));
        }
    }

    let shell = LocalShell::spawn(app_handle, session_id.clone(), cols, rows, cwd.as_deref())
        .map_err(|e| e.to_string())?;

    let session = Session {
        id: session_id.clone(),
        config_id: String::new(),
        session_type: SessionType::Local,
        status: SessionStatus::Connected,
        target_label: "local".to_string(),
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
pub async fn shell_kill(state: State<'_, TerminalState>, session_id: String) -> Result<(), String> {
    let Some(handle) = state.manager.get_handle(&session_id).await else {
        return Ok(());
    };
    match handle {
        SessionHandle::Local(shell) => shell.kill().map_err(|e| e.to_string())?,
        _ => return Err("Not a local shell session".into()),
    }
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

/// 获取 SFTP 客户端，支持 SFTP 会话和 SSH 会话（批量模式）。
/// 对于 SSH 会话，临时打开一个 SFTP channel。
async fn get_sftp_client_async(handle: &SessionHandle) -> Result<Arc<SftpClient>, String> {
    match handle {
        SessionHandle::Sftp(client) => Ok(Arc::clone(client)),
        SessionHandle::Ssh(ssh_client) => {
            let sftp_session = ssh_client.open_sftp().await.map_err(|e| e.to_string())?;
            Ok(Arc::new(SftpClient::from_session(
                sftp_session,
                Arc::clone(ssh_client),
            )))
        }
        _ => Err("Not an SFTP or SSH session".into()),
    }
}

#[tauri::command]
pub async fn ssh_trust_host_key(
    state: State<'_, TerminalState>,
    host: String,
    port: u16,
    fingerprint: Option<String>,
) -> Result<(), String> {
    state
        .known_hosts
        .trust_pending(&host, port, fingerprint.as_deref())
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
        SessionHandle::Sftp(client) => client.list_dir(&path).await.map_err(|e| e.to_string()),
        SessionHandle::Ssh(ssh_client) => {
            let sftp_session = ssh_client.open_sftp().await.map_err(|e| e.to_string())?;
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
    let client = get_sftp_client_async(&handle).await?;
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
    let client = get_sftp_client_async(&handle).await?;
    let sftp = client
        .create_sftp_channel()
        .await
        .map_err(|e| e.to_string())?;
    sftp_client::remove_remote_path(&sftp, &path, is_dir)
        .await
        .map_err(|e| e.to_string())
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
    let client = get_sftp_client_async(&handle).await?;
    client
        .rename(&old_path, &new_path)
        .await
        .map_err(|e| e.to_string())
}

/// 粘贴剪贴板内容到目标目录。
/// action="copy" 使用 `cp -r`，action="cut" 使用 `mv`。
/// 仅在 SSH 会话上可用（批量模式）；纯 SFTP 会话返回错误。
#[tauri::command]
pub async fn sftp_paste(
    state: State<'_, TerminalState>,
    session_id: String,
    src_paths: Vec<String>,
    target_dir: String,
    action: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id).to_string())?;
    let client = get_sftp_client_async(&handle).await?;
    let ssh = client
        .ssh_client()
        .ok_or_else(|| "Paste requires SSH session".to_string())?;

    let target_dir = target_dir.trim_end_matches('/').to_string();
    for src in &src_paths {
        let basename = std::path::Path::new(src)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if basename.is_empty() {
            continue;
        }
        let dest = format!("{}/{}", target_dir, basename);
        let cmd = if action == "cut" {
            format!("mv -f -- {:?} {:?}", src, dest)
        } else {
            format!("cp -rf -- {:?} {:?}", src, dest)
        };
        let result = ssh.exec_command(&cmd).await.map_err(|e| e.to_string())?;
        if !result.stderr.is_empty() {
            return Err(result.stderr);
        }
    }
    Ok(())
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
    let client = get_sftp_client_async(&handle).await?;
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
    let client = get_sftp_client_async(&handle).await?;
    client.canonicalize(&path).await.map_err(|e| e.to_string())
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
    let client = get_sftp_client_async(&handle).await?;
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
    let state = &*state;
    let work_task_id = task_id.clone();
    with_transfer_control(state, task_id.as_deref(), |cancel_token| async move {
        let task_id = work_task_id;
        let handle = state
            .manager
            .get_handle(&session_id)
            .await
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;
        let client = get_sftp_client_async(&handle).await?;
        if let Some(tid) = task_id {
            let sftp = client
                .create_sftp_channel()
                .await
                .map_err(|e| e.to_string())?;

            let total = data.len() as u64;
            let chunk_size: usize = 32768;
            let mut offset: usize = 0;
            let mut last_emit_time = std::time::Instant::now();
            let mut last_emit_bytes: u64 = 0;

            sftp_client::ensure_remote_parent_dirs(&sftp, &remote_path)
                .await
                .map_err(|e| e.to_string())?;
            if cancel_token.is_cancelled() {
                return Err("Transfer cancelled".into());
            }
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

            Ok(())
        } else {
            client
                .upload(&remote_path, data)
                .await
                .map_err(|e| e.to_string())
        }
    })
    .await
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
    let state = &*state;
    let work_task_id = task_id.clone();
    with_transfer_control(state, Some(task_id.as_str()), |cancel_token| async move {
        let task_id = work_task_id;
        let handle = state
            .manager
            .get_handle(&session_id)
            .await
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;
        let client = get_sftp_client_async(&handle).await?;

        let sftp = client
            .create_sftp_channel()
            .await
            .map_err(|e| e.to_string())?;

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
                    let event_name =
                        format!("sftp:transfer:{}:{}", session_id_clone, task_id_clone);
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

        result.map_err(|e| e.to_string())
    })
    .await
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
    let state = &*state;
    let work_task_id = task_id.clone();
    with_transfer_control(state, Some(task_id.as_str()), |cancel_token| async move {
        let task_id = work_task_id;
        let handle = state
            .manager
            .get_handle(&session_id)
            .await
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;
        let client = get_sftp_client_async(&handle).await?;

        let sftp = client
            .create_sftp_channel()
            .await
            .map_err(|e| e.to_string())?;

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
                    let event_name =
                        format!("sftp:transfer:{}:{}", session_id_clone, task_id_clone);
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

        result.map_err(|e| e.to_string())
    })
    .await
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

pub(crate) fn connections_path() -> Result<PathBuf, String> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Cannot determine config directory".to_string())?;
    let dir = config_dir.join("mona");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(dir.join("terminal-connections.json"))
}

pub(crate) fn load_saved_connections_unlocked() -> Result<Vec<ConnectionConfig>, String> {
    load_saved_connections_at(&connections_path()?)
}

pub(crate) fn load_saved_connections_at(path: &Path) -> Result<Vec<ConnectionConfig>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| TerminalError::ConfigLoad(e.to_string()).to_string())?;
    serde_json::from_str(&data).map_err(|e| TerminalError::ConfigLoad(e.to_string()).to_string())
}

pub(crate) fn write_saved_connections_unlocked(
    connections: &[ConnectionConfig],
) -> Result<(), String> {
    write_saved_connections_at(&connections_path()?, connections)
}

pub(crate) fn write_saved_connections_at(
    path: &Path,
    connections: &[ConnectionConfig],
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| TerminalError::ConfigSave("Invalid connection config path".into()).to_string())?;
    let json = serde_json::to_string_pretty(connections)
        .map_err(|e| TerminalError::ConfigSave(e.to_string()).to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| TerminalError::ConfigSave(e.to_string()).to_string())?;
    temporary
        .write_all(json.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|e| TerminalError::ConfigSave(e.to_string()).to_string())?;
    temporary
        .persist(&path)
        .map_err(|e| TerminalError::ConfigSave(e.error.to_string()).to_string())?;
    Ok(())
}

fn connection_state(connections: Vec<ConnectionConfig>) -> Result<ConnectionState, String> {
    let revision = crate::terminal::cloud_sync::connections_revision(&connections)?;
    Ok(ConnectionState {
        connections,
        revision,
    })
}

#[tauri::command]
pub async fn terminal_save_connections(connections: Vec<ConnectionConfig>) -> Result<(), String> {
    let _guard = CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "终端连接配置正在保存，请重试。")?;
    let safe_connections: Vec<ConnectionConfig> = connections
        .iter()
        .map(|c| ConnectionConfig {
            auth: credential_store::store_credential(&c.auth, &c.host, c.port, &c.username),
            ..c.clone()
        })
        .collect();
    if safe_connections
        .iter()
        .any(|connection| !credential_store::auth_credentials_are_protected(&connection.auth))
    {
        return Err("无法安全保存终端凭据，请重新输入后再试。".into());
    }

    write_saved_connections_unlocked(&safe_connections)
}

#[tauri::command]
pub async fn terminal_load_connections() -> Result<Vec<ConnectionConfig>, String> {
    let _guard = CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "终端连接配置正在保存，请重试。")?;
    load_saved_connections_unlocked()
}

#[tauri::command]
pub async fn terminal_load_connection_state() -> Result<ConnectionState, String> {
    let _guard = CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "终端连接配置正在保存，请重试。")?;
    connection_state(load_saved_connections_unlocked()?)
}

#[tauri::command]
pub async fn terminal_upsert_connection(
    connection: ConnectionConfig,
    expected_revision: Option<String>,
) -> Result<ConnectionState, String> {
    let _guard = CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "终端连接配置正在保存，请重试。")?;
    let mut connections = load_saved_connections_unlocked()?;
    let existing_index = connections.iter().position(|item| item.id == connection.id);
    let current_revision = crate::terminal::cloud_sync::connections_revision(&connections)?;
    match (&expected_revision, existing_index) {
        (None, None) => {}
        (Some(expected), Some(_)) if expected == &current_revision => {}
        (None, Some(_)) => return Err("该连接已存在，请重新加载后再保存。".into()),
        (Some(_), None) => return Err("该连接已删除，请重新加载连接列表。".into()),
        _ => return Err("终端连接已变化，请重新加载后再保存。".into()),
    }

    let old = existing_index.map(|index| connections[index].clone());
    let safe = crate::terminal::cloud_sync::store_upsert_credentials(connection, old.as_ref())?;
    if let Some(index) = existing_index {
        connections[index] = safe.clone();
    } else {
        connections.push(safe.clone());
    }
    if let Err(error) = write_saved_connections_unlocked(&connections) {
        crate::terminal::cloud_sync::discard_uncommitted_credentials(old.as_ref(), &safe);
        return Err(error);
    }
    crate::terminal::cloud_sync::cleanup_replaced_credentials(old.as_ref(), &safe);
    connection_state(connections)
}

#[tauri::command]
pub async fn terminal_delete_saved_connection(
    connection_id: String,
    expected_revision: String,
) -> Result<ConnectionState, String> {
    let _guard = CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "终端连接配置正在保存，请重试。")?;
    let mut connections = load_saved_connections_unlocked()?;
    let current_revision = crate::terminal::cloud_sync::connections_revision(&connections)?;
    if expected_revision != current_revision {
        return Err("终端连接已变化，请重新加载后再删除。".into());
    }
    let index = connections
        .iter()
        .position(|item| item.id == connection_id)
        .ok_or_else(|| "连接不存在或已删除。".to_string())?;
    let removed = connections.remove(index);
    write_saved_connections_unlocked(&connections)?;
    crate::terminal::cloud_sync::delete_connection_credentials(&removed);
    connection_state(connections)
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
    let mut sessions = state.manager.list_sessions().await;
    // Local shell status comes from the process, not its original spawn record.
    for session in &mut sessions {
        if let Some(SessionHandle::Local(shell)) = state.manager.get_handle(&session.id).await {
            session.status = match shell.is_running() {
                Ok(true) => SessionStatus::Connected,
                Ok(false) => SessionStatus::Disconnected,
                Err(error) => SessionStatus::Error(error.to_string()),
            };
        }
    }
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
        SessionHandle::Ssh(client) | SessionHandle::Desktop(client) => Ok(client.get_buffer()),
        SessionHandle::Local(shell) => Ok(shell.get_buffer()),
        SessionHandle::Sftp(_) => Err("SFTP session has no terminal output".into()),
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
    let (pending_cmd, rx) = state
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
        Ok(ApprovalVerdict::Rejected { reason }) => Err(format!("Command rejected: {}", reason)),
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

    let pending_cmd = state.approval.manager.respond(&request_id, verdict).await?;

    if approved && pending_cmd.execute_after_approval {
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

#[cfg(not(windows))]
#[tauri::command]
pub async fn get_file_type_icon(
    _extension: String,
    _is_directory: bool,
) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(windows)]
#[tauri::command]
pub async fn get_file_type_icon(
    extension: String,
    is_directory: bool,
) -> Result<Option<String>, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    };
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES,
    };
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

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
        let file_attrs = if is_directory {
            FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_ATTRIBUTE_NORMAL
        };

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

#[cfg(windows)]
unsafe fn icon_to_png_simple(
    hicon: windows::Win32::UI::WindowsAndMessaging::HICON,
) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::HGDIOBJ;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        GetObjectW, ReleaseDC, SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DrawIconEx, GetIconInfo, DI_NORMAL, ICONINFO};

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
    let read_dir =
        std::fs::read_dir(&dir_path).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let metadata = entry
            .metadata()
            .map_err(|e| format!("Failed to read metadata: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let file_path = entry.path().to_string_lossy().to_string();

        let modified = metadata.modified().ok().and_then(|t| {
            let dur = t.duration_since(std::time::UNIX_EPOCH).ok()?;
            Some(
                chrono::DateTime::from_timestamp(dur.as_secs() as i64, 0)?
                    .format("%Y-%m-%d %H:%M")
                    .to_string(),
            )
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

/// Tauri 命令：展开文件/文件夹混合列表，返回展示用文件列表（含相对路径）。
/// 前端在上传前调用此命令获取展开后的文件列表，用于在传输列表中展示。
#[tauri::command]
pub async fn expand_upload_paths_command(
    files: Vec<String>,
) -> Result<Vec<ExpandedFileEntry>, String> {
    Ok(collect_upload_entries(&files)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|entry| ExpandedFileEntry {
            local_path: entry.local_path.to_string_lossy().into_owned(),
            rel_prefix: entry
                .relative_path
                .rsplit_once('/')
                .map_or("", |(parent, _)| parent)
                .to_owned(),
            display_name: entry.relative_path,
        })
        .collect())
}

/// 展开后的文件条目
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedFileEntry {
    pub local_path: String,
    pub rel_prefix: String,
    pub display_name: String,
}

#[tauri::command]
pub async fn sftp_batch_upload(
    app_handle: tauri::AppHandle,
    state: State<'_, TerminalState>,
    request: BatchUploadRequest,
) -> Result<String, String> {
    if request.sessions.is_empty() || request.files.is_empty() {
        return Err("请选择上传文件和目标主机".into());
    }
    let entries = Arc::new(
        collect_upload_entries(&request.files)
            .await
            .map_err(|e| e.to_string())?,
    );
    let total_bytes = entries.iter().map(|entry| entry.size).sum();
    let mut clients = Vec::new();
    for info in request.sessions {
        match state.manager.get_handle(&info.session_id).await {
            Some(SessionHandle::Ssh(client)) => clients.push((info, client)),
            _ => return Err(format!("SSH session not found for {}", info.host)),
        }
    }
    let batch_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();
    let paused = Arc::new(AtomicBool::new(false));
    let resume = Arc::new(Notify::new());
    state.batch_transfer.active_transfers.write().await.insert(
        batch_id.clone(),
        BatchTransferControl {
            cancel_token: cancel.clone(),
            is_paused: paused.clone(),
            resume_notify: resume.clone(),
        },
    );
    let active_transfers = state.batch_transfer.active_transfers.clone();
    let task_batch_id = batch_id.clone();
    let concurrent = request.max_concurrent.unwrap_or(3).max(1);
    tokio::spawn(async move {
        let host_limit = Arc::new(Semaphore::new(concurrent));
        let mut hosts = Vec::new();
        for (info, ssh) in clients {
            let initial = BatchTransferProgress {
                batch_id: task_batch_id.clone(),
                session_id: info.session_id.clone(),
                host: info.host,
                status: BatchTransferStatus::Connecting,
                current_file: None,
                files_completed: 0,
                files_total: entries.len(),
                bytes_transferred: 0,
                bytes_total: total_bytes,
                error: None,
                speed: None,
                eta_seconds: None,
            };
            let fallback = initial.clone();
            let app = app_handle.clone();
            let entries = entries.clone();
            let cancel = cancel.clone();
            let paused = paused.clone();
            let resume = resume.clone();
            let target_dir = request.target_directory.clone();
            let host_limit = host_limit.clone();
            hosts.push((fallback, tokio::spawn(async move {
                let mut progress = initial;
                let _ = app.emit("sftp:batch_progress", &progress);
                let permit = tokio::select! {
                    _ = cancel.cancelled() => None,
                    permit = host_limit.acquire_owned() => permit.ok(),
                };
                if permit.is_none() || !crate::terminal::sftp::batch::wait_until_ready(&cancel, &paused, &resume).await {
                    progress.status = BatchTransferStatus::Cancelled;
                    let _ = app.emit("sftp:batch_progress", &progress);
                    return;
                }
                let _permit = permit;
                let setup = async {
                    let sftp = ssh.open_sftp().await.map_err(|e| e.to_string())?;
                    sftp_client::ensure_remote_parent_dirs(&sftp, &target_dir).await.map_err(|e| e.to_string())?;
                    sftp_client::ensure_remote_dir(&sftp, &target_dir).await.map_err(|e| e.to_string())?;
                    let root = sftp.canonicalize(&target_dir).await.map_err(|e| e.to_string())?;
                    let _ = sftp.close().await;
                    Ok::<String, String>(root)
                };
                let root = match tokio::select! {
                    _ = cancel.cancelled() => Err("Transfer cancelled".into()),
                    result = setup => result,
                } {
                    Ok(root) => root,
                    Err(error) => {
                        progress.status = if cancel.is_cancelled() { BatchTransferStatus::Cancelled } else { BatchTransferStatus::Error };
                        progress.error = Some(error);
                        let _ = app.emit("sftp:batch_progress", &progress);
                        return;
                    }
                };
                let completed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
                let transferred = Arc::new(std::sync::atomic::AtomicU64::new(0));
                let file_limit = Arc::new(Semaphore::new(concurrent));
                let mut jobs = tokio::task::JoinSet::new();
                for entry in entries.iter() {
                    let permit = tokio::select! {
                        _ = cancel.cancelled() => None,
                        permit = file_limit.clone().acquire_owned() => permit.ok(),
                    };
                    let Some(permit) = permit else { break; };
                    let app = app.clone();
                    let ssh = ssh.clone();
                    let cancel = cancel.clone();
                    let paused = paused.clone();
                    let resume = resume.clone();
                    let completed = completed.clone();
                    let transferred = transferred.clone();
                    let mut file_progress = progress.clone();
                    let root = root.clone();
                    let target = format!("{}/{}", root.trim_end_matches('/'), entry.relative_path);
                    let name = entry.relative_path.clone();
                    let local = entry.local_path.to_string_lossy().into_owned();
                    let is_dir = entry.is_dir;
                    let size = entry.size;
                    jobs.spawn(async move {
                        let _permit = permit;
                        let mut result = Err("Transfer cancelled".to_owned());
                        for attempt in 0..=2 {
                            if !crate::terminal::sftp::batch::wait_until_ready(&cancel, &paused, &resume).await { break; }
                            if attempt > 0 {
                                tokio::select! {
                                    _ = cancel.cancelled() => break,
                                    _ = tokio::time::sleep(std::time::Duration::from_millis(1000 << (attempt - 1))) => {},
                                }
                            }
                            let sftp = match tokio::select! {
                                _ = cancel.cancelled() => Err(TerminalError::SftpOperation("Transfer cancelled".into())),
                                result = ssh.open_sftp() => result,
                            } {
                                Ok(sftp) => sftp,
                                Err(error) => { result = Err(error.to_string()); break; }
                            };
                            file_progress.status = BatchTransferStatus::Transferring;
                            file_progress.current_file = Some(name.clone());
                            file_progress.files_completed = completed.load(Ordering::Relaxed);
                            file_progress.bytes_transferred = transferred.load(Ordering::Relaxed);
                            let _ = app.emit("sftp:batch_progress", &file_progress);
                            let (tx, mut rx) = tokio::sync::mpsc::channel::<FileTransferProgress>(16);
                            let transfer = async {
                                if !crate::terminal::sftp::batch::wait_until_ready(&cancel, &paused, &resume).await {
                                    return Err("Transfer cancelled".into());
                                }
                                sftp_client::validate_remote_destination(&sftp, &root, &target).await.map_err(|e| e.to_string())?;
                                if is_dir {
                                    drop(tx);
                                    sftp_client::ensure_remote_parent_dirs(&sftp, &target).await.map_err(|e| e.to_string())?;
                                    sftp_client::ensure_remote_dir(&sftp, &target).await.map_err(|e| e.to_string())
                                } else {
                                    sftp_client::upload_file_streaming(&sftp, &local, &target, Some(tx), Some(cancel.clone()), Some(paused.clone()))
                                        .await.map_err(|e| e.to_string())
                                }
                            };
                            let forward = async {
                                let started = std::time::Instant::now();
                                while let Some(update) = rx.recv().await {
                                    let mut update_progress = file_progress.clone();
                                    update_progress.files_completed = completed.load(Ordering::Relaxed);
                                    update_progress.bytes_transferred = transferred.load(Ordering::Relaxed) + update.bytes_transferred;
                                    update_progress.speed = Some((update.bytes_transferred as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64);
                                    let _ = app.emit("sftp:batch_progress", update_progress);
                                }
                            };
                            let (attempt_result, ()) = tokio::join!(transfer, forward);
                            let _ = sftp.close().await;
                            result = attempt_result;
                            if result.is_ok() || cancel.is_cancelled() { break; }
                        }
                        file_progress.current_file = Some(name.clone());
                        if result.is_ok() {
                            file_progress.status = BatchTransferStatus::Completed;
                            file_progress.files_completed = completed.fetch_add(1, Ordering::Relaxed) + 1;
                            file_progress.bytes_transferred = transferred.fetch_add(size, Ordering::Relaxed) + size;
                            let _ = app.emit("sftp:batch_progress", file_progress);
                            Ok(())
                        } else {
                            let error = format!("上传 {} 失败: {}", name, result.unwrap_err());
                            if !cancel.is_cancelled() {
                                file_progress.status = BatchTransferStatus::Error;
                                file_progress.error = Some(error.clone());
                                file_progress.files_completed = completed.load(Ordering::Relaxed);
                                file_progress.bytes_transferred = transferred.load(Ordering::Relaxed);
                                let _ = app.emit("sftp:batch_progress", file_progress);
                            }
                            Err(error)
                        }
                    });
                }
                let mut errors = Vec::new();
                while let Some(result) = jobs.join_next().await {
                    match result {
                        Ok(Ok(())) => {},
                        Ok(Err(error)) => errors.push(error),
                        Err(error) => errors.push(format!("上传任务未完成: {}", error)),
                    }
                }
                progress.files_completed = completed.load(Ordering::Relaxed);
                progress.bytes_transferred = transferred.load(Ordering::Relaxed);
                progress.status = if cancel.is_cancelled() {
                    BatchTransferStatus::Cancelled
                } else if !errors.is_empty() || progress.files_completed != progress.files_total {
                    BatchTransferStatus::Error
                } else {
                    BatchTransferStatus::Completed
                };
                progress.error = if errors.is_empty() { None } else { Some(errors.join("; ")) };
                let _ = app.emit("sftp:batch_progress", progress);
            })));
        }
        for (mut fallback, host) in hosts {
            if let Err(error) = host.await {
                fallback.status = BatchTransferStatus::Error;
                fallback.error = Some(format!("上传任务未完成: {}", error));
                let _ = app_handle.emit("sftp:batch_progress", fallback);
            }
        }
        active_transfers.write().await.remove(&task_batch_id);
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
    let client = get_sftp_client_async(&handle).await?;
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
    let client = get_sftp_client_async(&handle).await?;
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
        file_type, owner_r, owner_w, owner_x, group_r, group_w, group_x, other_r, other_w, other_x
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
    let client = get_sftp_client_async(&handle).await?;
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
    let state = &*state;
    let work_task_id = task_id.clone();
    with_transfer_control(state, task_id.as_deref(), |cancel_token| async move {
        let task_id = work_task_id;
        let handle = state
            .manager
            .get_handle(&session_id)
            .await
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;
        let client = get_sftp_client_async(&handle).await?;

        tokio::fs::create_dir_all(&local_path)
            .await
            .map_err(|e| format!("Failed to create local directory: {}", e))?;

        let result = if let Some(tid) = &task_id {
            let sftp = client
                .create_sftp_channel()
                .await
                .map_err(|e| e.to_string())?;

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
                        let event_name =
                            format!("sftp:transfer:{}:{}", session_id_clone, task_id_clone);
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

            result
        } else {
            let sftp = client
                .create_sftp_channel()
                .await
                .map_err(|e| e.to_string())?;
            download_dir_streaming(&sftp, &session_id, &remote_path, &local_path, None, None).await
        };
        result.map_err(|e| e.to_string())
    })
    .await
}

async fn download_dir_streaming(
    sftp: &russh_sftp::client::SftpSession,
    _session_id: &str,
    remote_path: &str,
    local_path: &str,
    progress_tx: Option<tokio::sync::mpsc::Sender<FileTransferProgress>>,
    cancel_token: Option<CancellationToken>,
) -> Result<(), TerminalError> {
    struct Entry {
        remote: String,
        local: PathBuf,
        is_dir: bool,
        size: u64,
    }

    async fn collect(
        sftp: &russh_sftp::client::SftpSession,
        remote: &str,
        local: &Path,
        root: &str,
        ancestors: &mut Vec<String>,
        plan: &mut Vec<Entry>,
        cancel: &Option<CancellationToken>,
    ) -> Result<(), TerminalError> {
        if cancel.as_ref().is_some_and(CancellationToken::is_cancelled) {
            return Err(TerminalError::SftpOperation("Transfer cancelled".into()));
        }
        let entries = sftp.read_dir(remote).await.map_err(|e| {
            TerminalError::SftpOperation(format!("无法读取远程文件夹 '{}': {}", remote, e))
        })?;
        let mut names = std::collections::HashSet::new();
        for entry in entries {
            let name = sftp_client::sanitize_filename(&entry.file_name());
            let key = if cfg!(windows) {
                name.to_lowercase()
            } else {
                name.clone()
            };
            if !names.insert(key) {
                return Err(TerminalError::SftpOperation(format!(
                    "文件夹 '{}' 中有文件名在本地会重复，已停止下载",
                    remote
                )));
            }
            let local_entry = local.join(name);
            let mut remote_entry = entry.path();
            let metadata = if entry.file_type().is_symlink() {
                let target = sftp.canonicalize(&remote_entry).await.map_err(|e| {
                    TerminalError::SftpOperation(format!(
                        "无法解析远程链接 '{}': {}",
                        remote_entry, e
                    ))
                })?;
                // SFTP paths use POSIX separators on every local platform.
                let root_prefix = format!("{}/", root.trim_end_matches('/'));
                if target != root && !target.starts_with(&root_prefix) {
                    return Err(TerminalError::SftpOperation(format!(
                        "链接 '{}' 指向所选文件夹之外，已停止下载",
                        remote_entry
                    )));
                }
                let metadata = sftp.metadata(&target).await.map_err(|e| {
                    TerminalError::SftpOperation(format!(
                        "无法读取远程链接目标 '{}': {}",
                        remote_entry, e
                    ))
                })?;
                remote_entry = target;
                metadata
            } else {
                entry.metadata()
            };
            if metadata.is_dir() && ancestors.contains(&remote_entry) {
                return Err(TerminalError::SftpOperation(format!(
                    "链接 '{}' 指向上级文件夹，已停止循环下载",
                    entry.path()
                )));
            }
            if metadata.permissions.is_some() && metadata.file_type().is_other() {
                return Err(TerminalError::SftpOperation(format!(
                    "'{}' 不是可下载的普通文件或文件夹",
                    remote_entry
                )));
            }
            plan.push(Entry {
                remote: remote_entry.clone(),
                local: local_entry.clone(),
                is_dir: metadata.is_dir(),
                size: if metadata.is_dir() { 0 } else { metadata.len() },
            });
            if metadata.is_dir() {
                ancestors.push(remote_entry.clone());
                Box::pin(collect(
                    sftp,
                    &remote_entry,
                    &local_entry,
                    root,
                    ancestors,
                    plan,
                    cancel,
                ))
                .await?;
                ancestors.pop();
            }
        }
        Ok(())
    }

    let remote_root = sftp.canonicalize(remote_path).await.map_err(|e| {
        TerminalError::SftpOperation(format!("无法解析远程文件夹 '{}': {}", remote_path, e))
    })?;
    let local_root = tokio::fs::canonicalize(local_path).await.map_err(|e| {
        TerminalError::SftpOperation(format!("无法读取本地文件夹 '{}': {}", local_path, e))
    })?;
    let mut plan = Vec::new();
    collect(
        sftp,
        &remote_root,
        &local_root,
        &remote_root,
        &mut vec![remote_root.clone()],
        &mut plan,
        &cancel_token,
    )
    .await?;
    let total_bytes = plan.iter().map(|entry| entry.size).sum();
    let mut bytes_transferred = 0;
    for entry in plan {
        if cancel_token
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(TerminalError::SftpOperation("Transfer cancelled".into()));
        }
        if tokio::fs::try_exists(&entry.local).await.map_err(|e| {
            TerminalError::SftpOperation(format!(
                "无法检查下载目标 '{}': {}",
                entry.local.display(),
                e
            ))
        })? {
            let resolved = tokio::fs::canonicalize(&entry.local).await.map_err(|e| {
                TerminalError::SftpOperation(format!(
                    "无法解析下载目标 '{}': {}",
                    entry.local.display(),
                    e
                ))
            })?;
            if !resolved.starts_with(&local_root) {
                return Err(TerminalError::SftpOperation(format!(
                    "下载目标 '{}' 指向所选文件夹之外，已停止下载",
                    entry.local.display()
                )));
            }
        }
        if entry.is_dir {
            tokio::fs::create_dir_all(&entry.local).await.map_err(|e| {
                TerminalError::SftpOperation(format!(
                    "无法创建本地文件夹 '{}': {}",
                    entry.local.display(),
                    e
                ))
            })?;
        } else {
            let (file_tx, mut file_rx) = tokio::sync::mpsc::channel::<FileTransferProgress>(16);
            let local = entry.local.to_string_lossy().into_owned();
            let transfer = sftp_client::download_file_streaming(
                sftp,
                &entry.remote,
                &local,
                Some(file_tx),
                cancel_token.clone(),
                None,
            );
            let forward = async {
                while let Some(progress) = file_rx.recv().await {
                    if let Some(tx) = &progress_tx {
                        let _ = tx.try_send(FileTransferProgress {
                            bytes_transferred: bytes_transferred + progress.bytes_transferred,
                            total_bytes,
                        });
                    }
                }
            };
            let (result, ()) = tokio::join!(transfer, forward);
            result?;
            bytes_transferred += entry.size;
        }
    }
    if let Some(tx) = progress_tx {
        let _ = tx
            .send(FileTransferProgress {
                bytes_transferred,
                total_bytes,
            })
            .await;
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
    let state = &*state;
    let work_task_id = task_id.clone();
    with_transfer_control(state, task_id.as_deref(), |cancel_token| async move {
        let task_id = work_task_id;
        let handle = state
            .manager
            .get_handle(&session_id)
            .await
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;
        let client = get_sftp_client_async(&handle).await?;

        if let Some(tid) = &task_id {
            let sftp = client
                .create_sftp_channel()
                .await
                .map_err(|e| e.to_string())?;

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
                        let event_name =
                            format!("sftp:transfer:{}:{}", session_id_clone, task_id_clone);
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
                &local_path,
                &remote_path,
                Some(progress_tx),
                Some(cancel_token),
            )
            .await;

            drop(sftp);
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), progress_task).await;

            result.map_err(|e| e.to_string())
        } else {
            let sftp = client
                .create_sftp_channel()
                .await
                .map_err(|e| e.to_string())?;
            upload_dir_streaming(&sftp, &local_path, &remote_path, None, Some(cancel_token))
                .await
                .map_err(|e| e.to_string())
        }
    })
    .await
}

async fn upload_dir_streaming(
    sftp: &russh_sftp::client::SftpSession,
    local_path: &str,
    remote_path: &str,
    progress_tx: Option<tokio::sync::mpsc::Sender<FileTransferProgress>>,
    cancel_token: Option<CancellationToken>,
) -> Result<(), TerminalError> {
    let entries = collect_upload_entries(&[local_path.to_owned()]).await?;
    let selected_name = entries
        .first()
        .ok_or_else(|| TerminalError::SftpOperation("请选择要上传的文件夹".into()))?
        .relative_path
        .clone();
    let total_bytes = entries.iter().map(|entry| entry.size).sum();
    let mut bytes_transferred = 0;
    let mut remote_root: Option<String> = None;
    for entry in entries {
        if cancel_token
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(TerminalError::SftpOperation("Transfer cancelled".into()));
        }
        let relative = entry
            .relative_path
            .strip_prefix(&selected_name)
            .unwrap()
            .trim_start_matches('/');
        let target = if relative.is_empty() {
            remote_path.to_owned()
        } else {
            format!("{}/{}", remote_path.trim_end_matches('/'), relative)
        };
        if let Some(root) = &remote_root {
            sftp_client::validate_remote_destination(sftp, root, &target).await?;
        }
        if entry.is_dir {
            sftp_client::ensure_remote_parent_dirs(sftp, &target).await?;
            sftp_client::ensure_remote_dir(sftp, &target).await?;
            if remote_root.is_none() {
                remote_root = Some(sftp.canonicalize(&target).await.map_err(|e| {
                    TerminalError::SftpOperation(format!("无法解析上传目标 '{}': {}", target, e))
                })?);
            }
        } else {
            let local = entry.local_path.to_string_lossy().into_owned();
            let (file_tx, mut file_rx) = tokio::sync::mpsc::channel::<FileTransferProgress>(16);
            let transfer = sftp_client::upload_file_streaming(
                sftp,
                &local,
                &target,
                Some(file_tx),
                cancel_token.clone(),
                None,
            );
            let forward = async {
                while let Some(progress) = file_rx.recv().await {
                    if let Some(tx) = &progress_tx {
                        let _ = tx.try_send(FileTransferProgress {
                            bytes_transferred: bytes_transferred + progress.bytes_transferred,
                            total_bytes,
                        });
                    }
                }
            };
            let (result, ()) = tokio::join!(transfer, forward);
            result?;
            bytes_transferred += entry.size;
        }
    }
    if let Some(tx) = progress_tx {
        let _ = tx
            .send(FileTransferProgress {
                bytes_transferred,
                total_bytes,
            })
            .await;
    }
    Ok(())
}
