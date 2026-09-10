use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use data_encoding::BASE64;
use russh::keys::PublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::terminal::error::TerminalError;

#[derive(Debug, Clone, PartialEq)]
pub enum HostKeyVerification {
    Trusted,
    Unknown { fingerprint: String },
    Changed { expected_fingerprint: String, actual_fingerprint: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HostKeyEntry {
    host: String,
    port: u16,
    key_type: String,
    fingerprint: String,
}

pub struct KnownHostsStore {
    entries: RwLock<HashMap<String, Vec<HostKeyEntry>>>,
    path: PathBuf,
    last_unknown: RwLock<Option<(String, u16, String, String)>>,
}

fn fingerprint(key: &PublicKey) -> String {
    let bytes = key.to_bytes().unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = hasher.finalize();
    format!("SHA256:{}", BASE64.encode(&hash).trim_end_matches('='))
}

fn key_type(key: &PublicKey) -> String {
    let alg = key.algorithm();
    let name = alg.as_str();
    match name {
        "ssh-rsa" => "RSA".into(),
        "ssh-ed25519" => "Ed25519".into(),
        "ecdsa-sha2-nistp256" => "ECDSA".into(),
        "ecdsa-sha2-nistp384" => "ECDSA384".into(),
        "ecdsa-sha2-nistp521" => "ECDSA521".into(),
        other => other.into(),
    }
}

fn entry_key(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{}]:{}", host, port)
    }
}

impl KnownHostsStore {
    pub fn new() -> Result<Self, TerminalError> {
        let path = dirs::config_dir()
            .ok_or_else(|| TerminalError::ConfigLoad("Cannot find config dir".into()))?
            .join("mona")
            .join("known_hosts.json");
        Ok(Self {
            entries: RwLock::new(HashMap::new()),
            path,
            last_unknown: RwLock::new(None),
        })
    }

    pub fn new_in_memory() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            path: PathBuf::new(),
            last_unknown: RwLock::new(None),
        }
    }

    pub fn load(&self) -> Result<(), TerminalError> {
        if !self.path.exists() {
            return Ok(());
        }
        let data = std::fs::read_to_string(&self.path)
            .map_err(|e| TerminalError::ConfigLoad(e.to_string()))?;
        let entries: HashMap<String, Vec<HostKeyEntry>> =
            serde_json::from_str(&data).map_err(|e| TerminalError::ConfigLoad(e.to_string()))?;
        *self.entries.write().unwrap() = entries;
        Ok(())
    }

    pub fn save(&self) -> Result<(), TerminalError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| TerminalError::ConfigSave(e.to_string()))?;
        }
        let entries = self.entries.read().unwrap();
        let data = serde_json::to_string_pretty(&*entries)
            .map_err(|e| TerminalError::ConfigSave(e.to_string()))?;
        std::fs::write(&self.path, data)
            .map_err(|e| TerminalError::ConfigSave(e.to_string()))?;
        Ok(())
    }

    pub fn verify(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyVerification {
        let fp = fingerprint(key);
        let kt = key_type(key);
        let ek = entry_key(host, port);

        let entries = self.entries.read().unwrap();
        let result = match entries.get(&ek) {
            Some(stored) => {
                if let Some(matching) = stored.iter().find(|e| e.key_type == kt) {
                    if matching.fingerprint == fp {
                        HostKeyVerification::Trusted
                    } else {
                        HostKeyVerification::Changed {
                            expected_fingerprint: matching.fingerprint.clone(),
                            actual_fingerprint: fp.clone(),
                        }
                    }
                } else {
                    HostKeyVerification::Unknown { fingerprint: fp.clone() }
                }
            }
            None => HostKeyVerification::Unknown { fingerprint: fp.clone() },
        };

        if !matches!(&result, HostKeyVerification::Trusted) {
            drop(entries);
            *self.last_unknown.write().unwrap() =
                Some((host.to_string(), port, kt, fp));
        }

        result
    }

    pub fn trust(&self, host: &str, port: u16, key: &PublicKey) -> Result<(), TerminalError> {
        let fp = fingerprint(key);
        let kt = key_type(key);
        let ek = entry_key(host, port);
        let entry = HostKeyEntry {
            host: host.to_string(),
            port,
            key_type: kt.clone(),
            fingerprint: fp,
        };

        let mut entries = self.entries.write().unwrap();
        let host_entries = entries.entry(ek).or_default();
        host_entries.retain(|item| item.key_type != kt);
        host_entries.push(entry);
        drop(entries);

        self.save()
    }

    pub fn remove(&self, host: &str, port: u16) -> Result<(), TerminalError> {
        let ek = entry_key(host, port);
        let mut entries = self.entries.write().unwrap();
        entries.remove(&ek);
        drop(entries);
        self.save()
    }

    pub fn trust_last_unknown(
        &self,
        host: &str,
        port: u16,
    ) -> Result<(), TerminalError> {
        let info = self
            .last_unknown
            .write()
            .unwrap()
            .take()
            .ok_or_else(|| {
                TerminalError::ConfigSave("No pending unknown host key to trust".into())
            })?;

        let (stored_host, stored_port, kt, fp) = info;
        if stored_host != host || stored_port != port {
            return Err(TerminalError::ConfigSave(
                "Host/port mismatch for pending unknown key".into(),
            ));
        }

        let ek = entry_key(host, port);
        let entry = HostKeyEntry {
            host: host.to_string(),
            port,
            key_type: kt.clone(),
            fingerprint: fp,
        };

        let mut entries = self.entries.write().unwrap();
        let host_entries = entries.entry(ek).or_default();
        host_entries.retain(|item| item.key_type != kt);
        host_entries.push(entry);
        drop(entries);

        self.save()
    }
}
