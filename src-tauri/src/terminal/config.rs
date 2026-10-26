use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Ssh,
    Sftp,
    Ftp,
    Local,
    Vnc,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AuthConfig {
    Password { password: String },
    #[serde(rename = "key")]
    KeyFile {
        #[serde(rename = "keyPath", alias = "key_path")]
        key_path: String,
        passphrase: Option<String>,
    },
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionState {
    pub connections: Vec<ConnectionConfig>,
    pub revision: String,
}

#[cfg(test)]
mod tests {
    use super::AuthConfig;
    use serde_json::json;

    #[test]
    fn key_auth_matches_ui_contract_and_reads_legacy_saved_paths() {
        for field in ["keyPath", "key_path"] {
            let mut payload = json!({"type": "key", "passphrase": null});
            payload[field] = json!("saved-key-reference");
            let auth: AuthConfig = serde_json::from_value(payload).unwrap();
            let serialized = serde_json::to_value(auth).unwrap();
            assert_eq!(serialized["keyPath"], "saved-key-reference");
            assert!(serialized.get("key_path").is_none());
        }
    }
}
