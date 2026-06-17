use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use dashmap::DashMap;
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
    Disconnecting,
    Error(String),
}

impl SessionStatus {
    pub fn can_transition_to(&self, target: &SessionStatus) -> bool {
        match (self, target) {
            (SessionStatus::Disconnected, SessionStatus::Connecting) => true,
            (SessionStatus::Connecting, SessionStatus::Connected) => true,
            (SessionStatus::Connecting, SessionStatus::Error(_)) => true,
            (SessionStatus::Connecting, SessionStatus::Disconnected) => true,
            (SessionStatus::Connected, SessionStatus::Disconnecting) => true,
            (SessionStatus::Connected, SessionStatus::Disconnected) => true,
            (SessionStatus::Connected, SessionStatus::Error(_)) => true,
            (SessionStatus::Disconnecting, SessionStatus::Disconnected) => true,
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

pub struct SharedSshConnection {
    pub handle: Arc<tokio::sync::Mutex<Option<russh::client::Handle<crate::terminal::ssh::client::SshClientHandler>>>>,
    pub ref_count: Arc<AtomicUsize>,
    pub host: String,
    pub port: u16,
    pub username: String,
}

impl SharedSshConnection {
    pub fn new(
        handle: russh::client::Handle<crate::terminal::ssh::client::SshClientHandler>,
        host: String,
        port: u16,
        username: String,
    ) -> Self {
        Self {
            handle: Arc::new(tokio::sync::Mutex::new(Some(handle))),
            ref_count: Arc::new(AtomicUsize::new(1)),
            host,
            port,
            username,
        }
    }

    pub fn inc_ref(&self) {
        self.ref_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn dec_ref(&self) -> usize {
        self.ref_count.fetch_sub(1, Ordering::SeqCst)
    }

    pub fn ref_count(&self) -> usize {
        self.ref_count.load(Ordering::Relaxed)
    }
}

fn connection_key(host: &str, port: u16, username: &str) -> String {
    format!("{}@{}:{}", username, host, port)
}

pub struct ConnectionPool {
    connections: DashMap<String, Arc<SharedSshConnection>>,
}

impl ConnectionPool {
    pub fn new() -> Self {
        Self {
            connections: DashMap::new(),
        }
    }

    pub fn get_or_create(
        &self,
        host: &str,
        port: u16,
        username: &str,
        handle: russh::client::Handle<crate::terminal::ssh::client::SshClientHandler>,
    ) -> Arc<SharedSshConnection> {
        let key = connection_key(host, port, username);
        self.connections
            .entry(key)
            .or_insert_with(|| {
                Arc::new(SharedSshConnection::new(
                    handle,
                    host.to_string(),
                    port,
                    username.to_string(),
                ))
            })
            .value()
            .clone()
    }

    pub fn get(
        &self,
        host: &str,
        port: u16,
        username: &str,
    ) -> Option<Arc<SharedSshConnection>> {
        let key = connection_key(host, port, username);
        self.connections.get(&key).map(|r| r.value().clone())
    }

    pub fn release(&self, host: &str, port: u16, username: &str) -> bool {
        let key = connection_key(host, port, username);
        if let Some(conn) = self.connections.get(&key) {
            let remaining = conn.dec_ref();
            if remaining == 0 {
                drop(conn);
                self.connections.remove(&key);
                return true;
            }
        }
        false
    }

    pub fn contains(&self, host: &str, port: u16, username: &str) -> bool {
        let key = connection_key(host, port, username);
        self.connections.contains_key(&key)
    }
}

struct SessionManagerInner {
    sessions: RwLock<HashMap<String, Session>>,
    handles: RwLock<HashMap<String, SessionHandle>>,
    connection_pool: ConnectionPool,
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
                connection_pool: ConnectionPool::new(),
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

    pub async fn get_session(&self, id: &str) -> Option<Session> {
        let sessions = self.inner.sessions.read().await;
        sessions.get(id).cloned()
    }

    pub async fn list_sessions(&self) -> Vec<Session> {
        let sessions = self.inner.sessions.read().await;
        sessions.values().cloned().collect()
    }

    pub fn pool(&self) -> &ConnectionPool {
        &self.inner.connection_pool
    }
}
