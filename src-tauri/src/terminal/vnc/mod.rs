pub mod bridge;
pub mod commands;

use std::collections::HashMap;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

/// An active VNC session.
pub struct VncSession {
    /// The VNC host:port we're connected to.
    pub vnc_addr: String,
    /// The local WebSocket port the frontend connects to.
    pub ws_port: u16,
    /// One-time token for WS authentication.
    pub ws_token: String,
    /// The bridge task handle (WS ↔ TCP proxy).
    pub bridge_handle: JoinHandle<()>,
}

/// Global state for VNC sessions, managed by Tauri.
pub struct VncState {
    pub sessions: RwLock<HashMap<String, VncSession>>,
}

impl VncState {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// Shut down all active VNC sessions (called on app exit).
    pub async fn shutdown(&self) {
        let mut sessions = self.sessions.write().await;
        for (id, session) in sessions.drain() {
            log::info!("Shutting down VNC session: {}", id);
            session.bridge_handle.abort();
        }
    }
}
