use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::terminal::error::TerminalError;
use crate::terminal::shell::local::LocalShell;
use crate::terminal::sftp::client::SftpClient;
use crate::terminal::ssh::client::SshClient;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionType {
    Ssh,
    Local,
    Sftp,
    Desktop,
    Vnc,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionStatus {
    Disconnected,
    Connecting,
    Connected,
    Error(String),
}

impl SessionStatus {
    pub fn can_transition_to(&self, target: &SessionStatus) -> bool {
        match (self, target) {
            (SessionStatus::Disconnected, SessionStatus::Connecting) => true,
            (SessionStatus::Connecting, SessionStatus::Connected) => true,
            (SessionStatus::Connecting, SessionStatus::Error(_)) => true,
            (SessionStatus::Connecting, SessionStatus::Disconnected) => true,
            (SessionStatus::Connected, SessionStatus::Disconnected) => true,
            (SessionStatus::Connected, SessionStatus::Error(_)) => true,
            (SessionStatus::Error(_), SessionStatus::Connecting) => true,
            (SessionStatus::Error(_), SessionStatus::Disconnected) => true,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub config_id: String,
    pub session_type: SessionType,
    pub status: SessionStatus,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub enum SessionHandle {
    Ssh(Arc<SshClient>),
    Local(Arc<LocalShell>),
    Sftp(Arc<SftpClient>),
    Desktop(Arc<SshClient>),
    Vnc,
}

impl SessionHandle {
    pub fn clone_handle(&self) -> SessionHandle {
        match self {
            SessionHandle::Ssh(client) => SessionHandle::Ssh(Arc::clone(client)),
            SessionHandle::Local(shell) => SessionHandle::Local(Arc::clone(shell)),
            SessionHandle::Sftp(client) => SessionHandle::Sftp(Arc::clone(client)),
            SessionHandle::Desktop(client) => SessionHandle::Desktop(Arc::clone(client)),
            SessionHandle::Vnc => SessionHandle::Vnc,
        }
    }
}

struct SessionManagerInner {
    sessions: RwLock<HashMap<String, Session>>,
    handles: RwLock<HashMap<String, SessionHandle>>,
    max_sessions: usize,
}

#[derive(Clone)]
pub struct SessionManager {
    inner: Arc<SessionManagerInner>,
}

impl SessionManager {
    pub fn new(max_sessions: usize) -> Self {
        Self {
            inner: Arc::new(SessionManagerInner {
                sessions: RwLock::new(HashMap::new()),
                handles: RwLock::new(HashMap::new()),
                max_sessions,
            }),
        }
    }

    pub async fn create(
        &self,
        session: Session,
        handle: SessionHandle,
    ) -> Result<(), TerminalError> {
        let mut sessions = self.inner.sessions.write().await;
        if sessions.len() >= self.inner.max_sessions {
            return Err(TerminalError::TooManySessions);
        }
        let mut handles = self.inner.handles.write().await;
        let id = session.id.clone();
        sessions.insert(id.clone(), session);
        handles.insert(id, handle);
        Ok(())
    }

    pub async fn get_handle(&self, id: &str) -> Option<SessionHandle> {
        let handles = self.inner.handles.read().await;
        handles.get(id).map(|h| h.clone_handle())
    }

    pub async fn remove(&self, id: &str) -> Option<Session> {
        self.inner.handles.write().await.remove(id);
        self.inner.sessions.write().await.remove(id)
    }

    pub async fn update_status(
        &self,
        id: &str,
        status: SessionStatus,
    ) -> Result<(), TerminalError> {
        let mut sessions = self.inner.sessions.write().await;
        match sessions.get_mut(id) {
            Some(session) => {
                if session.status.can_transition_to(&status) {
                    session.status = status;
                    Ok(())
                } else {
                    Err(TerminalError::SshConnection(format!(
                        "Invalid state transition: {:?} -> {:?}",
                        session.status, status
                    )))
                }
            }
            None => Err(TerminalError::SessionNotFound(id.to_string())),
        }
    }

    pub async fn list_sessions(&self) -> Vec<Session> {
        let sessions = self.inner.sessions.read().await;
        sessions.values().cloned().collect()
    }
}
