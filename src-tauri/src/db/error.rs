use thiserror::Error;

#[derive(Error, Debug)]
pub enum DbError {
    #[error("Connection not found: {0}")]
    ConnectionNotFound(String),

    #[error("Connection already exists: {0}")]
    ConnectionAlreadyExists(String),

    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Query failed: {0}")]
    QueryFailed(String),

    #[error("Invalid connection config: {0}")]
    InvalidConfig(String),

    #[error("Unsupported database type: {0}")]
    UnsupportedType(String),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("MySQL error: {0}")]
    Mysql(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl From<DbError> for String {
    fn from(e: DbError) -> String {
        e.to_string()
    }
}
