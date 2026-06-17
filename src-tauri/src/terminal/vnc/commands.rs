//! Tauri IPC commands for VNC sessions.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::bridge;
use super::VncState;
use crate::terminal::session::{Session, SessionHandle, SessionStatus, SessionType};
use crate::terminal::TerminalState;

/// VNC connection configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VncConnectConfig {
    pub host: String,
    pub port: u16,
    /// Optional VNC password (sent to noVNC which handles VNC auth).
    pub password: Option<String>,
    /// Optional display name for the session tab.
    pub name: Option<String>,
}

/// VNC session info returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VncSessionInfo {
    pub id: String,
    pub ws_url: String,
    pub ws_token: String,
    pub host: String,
    pub port: u16,
}

/// Connect to a VNC server.
///
/// 1. Creates a WS <-> TCP proxy bridge to the VNC server
/// 2. Returns session info including the WS URL for noVNC to connect to
#[tauri::command]
pub async fn vnc_connect(
    vnc_state: State<'_, Arc<VncState>>,
    terminal_state: State<'_, TerminalState>,
    config: VncConnectConfig,
) -> Result<VncSessionInfo, String> {
    let vnc_addr = format!("{}:{}", config.host, config.port);

    // Verify VNC server is reachable by attempting a TCP connection
    let test_conn = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::TcpStream::connect(&vnc_addr),
    )
    .await
    .map_err(|_| format!("连接 VNC 服务器超时: {}", vnc_addr))?
    .map_err(|e| format!("无法连接 VNC 服务器 {}: {}", vnc_addr, e))?;
    drop(test_conn);

    // Start WS <-> TCP proxy bridge
    let session_id = uuid::Uuid::new_v4().to_string();
    let (ws_port, ws_token, bridge_handle) =
        bridge::start_proxy(vnc_addr.clone(), session_id.clone())
            .await
            .map_err(|e| e.to_string())?;

    log::info!(
        "VNC: bridge started for {} -> ws://127.0.0.1:{} (session {})",
        vnc_addr,
        ws_port,
        session_id
    );

    // Register in VNC state
    let vnc_session = super::VncSession {
        vnc_addr: vnc_addr.clone(),
        ws_port,
        ws_token: ws_token.clone(),
        bridge_handle,
    };
    vnc_state
        .sessions
        .write()
        .await
        .insert(session_id.clone(), vnc_session);

    // Also register in terminal session manager
    let session = Session {
        id: session_id.clone(),
        config_id: String::new(),
        session_type: SessionType::Vnc,
        status: SessionStatus::Connected,
        created_at: chrono::Utc::now(),
    };
    terminal_state
        .manager
        .create(session, SessionHandle::Vnc)
        .await
        .map_err(|e| e.to_string())?;

    let ws_url = format!("ws://127.0.0.1:{}", ws_port);

    Ok(VncSessionInfo {
        id: session_id,
        ws_url,
        ws_token,
        host: config.host,
        port: config.port,
    })
}

/// Disconnect a VNC session.
#[tauri::command]
pub async fn vnc_disconnect(
    vnc_state: State<'_, Arc<VncState>>,
    terminal_state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = vnc_state.sessions.write().await;
    match sessions.remove(&session_id) {
        Some(session) => {
            log::info!("VNC: disconnecting session {}", session_id);
            session.bridge_handle.abort();
        }
        None => {
            log::debug!("VNC: session {} already removed", session_id);
        }
    }

    terminal_state
        .manager
        .update_status(&session_id, SessionStatus::Disconnected)
        .await
        .map_err(|e| e.to_string())?;
    terminal_state.manager.remove(&session_id).await;
    Ok(())
}

/// Reconnect a VNC session by rebuilding the WS bridge.
///
/// The VNC TCP connection stays alive. A new bridge is spawned with
/// a new WS port and token. The old bridge is aborted first.
#[tauri::command]
pub async fn vnc_reconnect(
    vnc_state: State<'_, Arc<VncState>>,
    session_id: String,
) -> Result<VncSessionInfo, String> {
    let vnc_addr = {
        let sessions = vnc_state.sessions.read().await;
        let session = sessions
            .get(&session_id)
            .ok_or_else(|| format!("VNC session '{}' not found", session_id))?;
        session.vnc_addr.clone()
    };

    // Abort old bridge
    {
        let sessions = vnc_state.sessions.read().await;
        if let Some(session) = sessions.get(&session_id) {
            session.bridge_handle.abort();
        }
    }

    // Start new bridge
    let (ws_port, ws_token, bridge_handle) =
        bridge::start_proxy(vnc_addr.clone(), session_id.clone())
            .await
            .map_err(|e| e.to_string())?;

    log::info!("VNC: reconnected session {} on ws port {}", session_id, ws_port);

    // Update session
    {
        let mut sessions = vnc_state.sessions.write().await;
        if let Some(session) = sessions.get_mut(&session_id) {
            session.ws_port = ws_port;
            session.ws_token = ws_token.clone();
            session.bridge_handle = bridge_handle;
        }
    }

    let ws_url = format!("ws://127.0.0.1:{}", ws_port);

    // Extract host/port from vnc_addr
    let parts: Vec<&str> = vnc_addr.rsplitn(2, ':').collect();
    let (host, port) = if parts.len() == 2 {
        (parts[1].to_string(), parts[0].parse().unwrap_or(5900))
    } else {
        (vnc_addr.clone(), 5900)
    };

    Ok(VncSessionInfo {
        id: session_id,
        ws_url,
        ws_token,
        host,
        port,
    })
}

/// List all active VNC sessions.
#[tauri::command]
pub async fn vnc_list_sessions(
    vnc_state: State<'_, Arc<VncState>>,
) -> Result<Vec<VncSessionInfo>, String> {
    let sessions = vnc_state.sessions.read().await;
    let mut result = Vec::new();
    for (id, session) in sessions.iter() {
        let parts: Vec<&str> = session.vnc_addr.rsplitn(2, ':').collect();
        let (host, port) = if parts.len() == 2 {
            (parts[1].to_string(), parts[0].parse().unwrap_or(5900))
        } else {
            (session.vnc_addr.clone(), 5900)
        };

        result.push(VncSessionInfo {
            id: id.clone(),
            ws_url: format!("ws://127.0.0.1:{}", session.ws_port),
            ws_token: session.ws_token.clone(),
            host,
            port,
        });
    }
    Ok(result)
}
