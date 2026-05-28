use thiserror::Error;

#[derive(Error, Debug)]
pub enum TerminalError {
    #[error("SSH connection failed: {0}")]
    SshConnection(String),

    #[error("SFTP operation failed: {0}")]
    SftpOperation(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Authentication failed: {0}")]
    AuthFailed(String),

    #[error("Shell spawn failed: {0}")]
    ShellSpawn(String),

    #[error("Too many sessions")]
    TooManySessions,

    #[error("Config load failed: {0}")]
    ConfigLoad(String),

    #[error("Config save failed: {0}")]
    ConfigSave(String),

    #[error("Host key unknown: {0}")]
    HostKeyUnknown(String),

    #[error("Host key changed: expected {expected}, got {actual}")]
    HostKeyChanged { expected: String, actual: String },
}

impl From<TerminalError> for String {
    fn from(err: TerminalError) -> String {
        err.to_string()
    }
}
