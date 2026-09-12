use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::terminal::error::TerminalError;
use crate::terminal::sftp::client::SftpClient;
use crate::terminal::shell::local::LocalShell;
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
    /// Snapshot of `user@host:port` (or a local/desktop/vnc label) taken at
    /// connect time — maintenance records stay identifiable even after the
    /// connection config is deleted.
    #[serde(default)]
    pub target_label: String,
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
        let id = session.id.clone();
        if !sessions.contains_key(&id) && sessions.len() >= self.inner.max_sessions {
            return Err(TerminalError::TooManySessions);
        }
        let mut handles = self.inner.handles.write().await;
        sessions.insert(id.clone(), session);
        handles.insert(id, handle);
        Ok(())
    }

    pub async fn get_handle(&self, id: &str) -> Option<SessionHandle> {
        let handles = self.inner.handles.read().await;
        handles.get(id).map(|h| h.clone_handle())
    }

    pub async fn get(&self, id: &str) -> Option<Session> {
        let sessions = self.inner.sessions.read().await;
        sessions.get(id).cloned()
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

    pub async fn update_status_if_generation(
        &self,
        id: &str,
        generation: i64,
        status: SessionStatus,
    ) -> Result<bool, TerminalError> {
        let mut sessions = self.inner.sessions.write().await;
        let Some(session) = sessions.get_mut(id) else {
            return Ok(false);
        };
        if session.created_at.timestamp_millis() != generation || session.status == status {
            return Ok(false);
        }
        if !session.status.can_transition_to(&status) {
            return Err(TerminalError::SshConnection(format!(
                "Invalid state transition: {:?} -> {:?}",
                session.status, status
            )));
        }
        session.status = status;
        Ok(true)
    }

    pub async fn is_generation_current(&self, id: &str, generation: i64) -> bool {
        self.inner
            .sessions
            .read()
            .await
            .get(id)
            .is_some_and(|session| session.created_at.timestamp_millis() == generation)
    }

    pub async fn list_sessions(&self) -> Vec<Session> {
        let sessions = self.inner.sessions.read().await;
        sessions.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, created_at: chrono::DateTime<chrono::Utc>) -> Session {
        Session {
            id: id.to_string(),
            config_id: "config".to_string(),
            session_type: SessionType::Ssh,
            status: SessionStatus::Connected,
            target_label: "user@example:22".to_string(),
            created_at,
        }
    }

    #[tokio::test]
    async fn stale_connection_generation_cannot_disconnect_reconnected_session() {
        let manager = SessionManager::new(1);
        let first_time = chrono::Utc::now();
        manager
            .create(session("session", first_time), SessionHandle::Vnc)
            .await
            .unwrap();

        let second_time = first_time + chrono::Duration::milliseconds(1);
        manager
            .create(session("session", second_time), SessionHandle::Vnc)
            .await
            .unwrap();

        assert!(!manager
            .update_status_if_generation(
                "session",
                first_time.timestamp_millis(),
                SessionStatus::Disconnected,
            )
            .await
            .unwrap());
        assert_eq!(
            manager.get("session").await.unwrap().status,
            SessionStatus::Connected
        );
        assert!(manager
            .update_status_if_generation(
                "session",
                second_time.timestamp_millis(),
                SessionStatus::Disconnected,
            )
            .await
            .unwrap());
        assert!(
            !manager
                .is_generation_current("session", first_time.timestamp_millis())
                .await
        );
        assert!(
            manager
                .is_generation_current("session", second_time.timestamp_millis())
                .await
        );
    }
}
