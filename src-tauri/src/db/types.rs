use serde::{Deserialize, Serialize};

/// Database type. Only `Sqlite` and `Mysql` are currently implemented; the
/// remaining variants are reserved for future support and are retained for
/// frontend select options and `connections.json` serde compatibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseType {
    Mysql,
    #[allow(dead_code)]
    PostgreSQL,
    Sqlite,
    #[allow(dead_code)]
    SqlServer,
    #[allow(dead_code)]
    Oracle,
    #[allow(dead_code)]
    Mongodb,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: DatabaseType,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub database: Option<String>,
    pub use_ssl: bool,
    pub use_ssh_tunnel: bool,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_username: Option<String>,
    pub ssh_auth: Option<SshAuthConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthConfig {
    Password { password: String },
    Key { key_path: String, passphrase: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub id: String,
    pub config: DbConnectionConfig,
    pub status: ConnectionStatus,
    pub server_version: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<CellValue>>,
    pub affected_rows: u64,
    pub execution_time_ms: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
}

#[derive(Debug, Clone)]
pub enum CellValue {
    Null,
    Integer(i64),
    Float(f64),
    Text(String),
    Blob(String),
    Bool(bool),
}

impl serde::Serialize for CellValue {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            CellValue::Null => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("type", "null")?;
                map.end()
            }
            CellValue::Integer(v) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("type", "integer")?;
                map.serialize_entry("value", v)?;
                map.end()
            }
            CellValue::Float(v) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("type", "float")?;
                map.serialize_entry("value", v)?;
                map.end()
            }
            CellValue::Text(v) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("type", "text")?;
                map.serialize_entry("value", v)?;
                map.end()
            }
            CellValue::Blob(v) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("type", "blob")?;
                map.serialize_entry("value", v)?;
                map.end()
            }
            CellValue::Bool(v) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("type", "bool")?;
                map.serialize_entry("value", v)?;
                map.end()
            }
        }
    }
}

impl<'de> serde::Deserialize<'de> for CellValue {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let obj = value.as_object().ok_or_else(|| {
            serde::de::Error::custom("CellValue must be an object")
        })?;
        let type_str = obj.get("type").and_then(|v| v.as_str()).ok_or_else(|| {
            serde::de::Error::custom("CellValue missing 'type' field")
        })?;
        match type_str {
            "null" => Ok(CellValue::Null),
            "integer" => obj
                .get("value")
                .and_then(|v| v.as_i64())
                .map(CellValue::Integer)
                .ok_or_else(|| serde::de::Error::custom("invalid integer value")),
            "float" => obj
                .get("value")
                .and_then(|v| v.as_f64())
                .map(CellValue::Float)
                .ok_or_else(|| serde::de::Error::custom("invalid float value")),
            "text" => obj
                .get("value")
                .and_then(|v| v.as_str())
                .map(|s| CellValue::Text(s.to_string()))
                .ok_or_else(|| serde::de::Error::custom("invalid text value")),
            "blob" => obj
                .get("value")
                .and_then(|v| v.as_str())
                .map(|s| CellValue::Blob(s.to_string()))
                .ok_or_else(|| serde::de::Error::custom("invalid blob value")),
            "bool" => obj
                .get("value")
                .and_then(|v| v.as_bool())
                .map(CellValue::Bool)
                .ok_or_else(|| serde::de::Error::custom("invalid bool value")),
            _ => Err(serde::de::Error::custom(format!(
                "unknown CellValue type: {}",
                type_str
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseObject {
    pub name: String,
    pub schema: Option<String>,
    pub object_type: DatabaseObjectType,
    pub children: Vec<DatabaseObject>,
}

/// Database object type. Only `Table` and `View` are currently constructed by
/// the backend; the remaining variants are reserved for future support and
/// are retained because the frontend `dbStore.ts` hardcodes `"database"` and
/// `"folder"` strings when building the connection tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseObjectType {
    #[allow(dead_code)]
    Server,
    #[allow(dead_code)]
    Database,
    Table,
    View,
    #[allow(dead_code)]
    Procedure,
    #[allow(dead_code)]
    Function,
    #[allow(dead_code)]
    Index,
    #[allow(dead_code)]
    Trigger,
    #[allow(dead_code)]
    Event,
    #[allow(dead_code)]
    Column,
    #[allow(dead_code)]
    Folder,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub schema: Option<String>,
    pub engine: Option<String>,
    pub charset: Option<String>,
    pub collation: Option<String>,
    pub row_count: Option<i64>,
    pub data_size: Option<String>,
    pub index_size: Option<String>,
    pub auto_increment: Option<i64>,
    pub create_time: Option<String>,
    pub update_time: Option<String>,
    pub columns: Vec<ColumnDefinition>,
    pub indexes: Vec<IndexDefinition>,
    pub foreign_keys: Vec<ForeignKeyDefinition>,
    pub ddl: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDefinition {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub is_unique: bool,
    pub is_auto_increment: bool,
    pub extra: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexDefinition {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub is_primary: bool,
    pub index_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyDefinition {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_delete: Option<String>,
    pub on_update: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerStats {
    pub connections: i64,
    pub max_connections: i64,
    pub qps: i64,
    pub slow_queries: i64,
    pub buffer_pool_hit_rate: Option<f64>,
    pub replication_lag_seconds: Option<f64>,
    pub disk_usage_gb: Option<f64>,
    pub disk_total_gb: Option<f64>,
    pub uptime_seconds: Option<i64>,
    pub server_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub id: i64,
    pub user: String,
    pub host: String,
    pub database: Option<String>,
    pub command: String,
    pub time: i64,
    pub state: Option<String>,
    pub info: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserInfo {
    pub username: String,
    pub host: String,
    pub password_expired: bool,
    pub account_locked: bool,
}
