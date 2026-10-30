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
    Unknown {
        fingerprint: String,
    },
    Changed {
        expected_fingerprint: String,
        actual_fingerprint: String,
    },
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
    pending: RwLock<HashMap<String, (String, String)>>,
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

fn verify_entry(
    entries: &HashMap<String, Vec<HostKeyEntry>>,
    host: &str,
    key_type: &str,
    fingerprint: &str,
) -> HostKeyVerification {
    match entries
        .get(host)
        .and_then(|stored| stored.iter().find(|entry| entry.key_type == key_type))
    {
        Some(entry) if entry.fingerprint == fingerprint => HostKeyVerification::Trusted,
        Some(entry) => HostKeyVerification::Changed {
            expected_fingerprint: entry.fingerprint.clone(),
            actual_fingerprint: fingerprint.to_string(),
        },
        None => HostKeyVerification::Unknown {
            fingerprint: fingerprint.to_string(),
        },
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
            pending: RwLock::new(HashMap::new()),
        })
    }

    pub fn new_in_memory() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            path: PathBuf::new(),
            pending: RwLock::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_path(path: PathBuf) -> Self {
        let mut store = Self::new_in_memory();
        store.path = path;
        store
    }

    pub fn load(&self) -> Result<(), TerminalError> {
        let mut current = self.entries.write().unwrap();
        if !self.path.exists() {
            return Ok(());
        }
        let data = std::fs::read_to_string(&self.path)
            .map_err(|e| TerminalError::ConfigLoad(e.to_string()))?;
        let entries: HashMap<String, Vec<HostKeyEntry>> =
            serde_json::from_str(&data).map_err(|e| TerminalError::ConfigLoad(e.to_string()))?;
        *current = entries;
        Ok(())
    }

    pub fn save(&self) -> Result<(), TerminalError> {
        let entries = self.entries.write().unwrap();
        self.save_entries(&entries)
    }

    fn save_entries(
        &self,
        entries: &HashMap<String, Vec<HostKeyEntry>>,
    ) -> Result<(), TerminalError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| TerminalError::ConfigSave(e.to_string()))?;
        }
        let data = serde_json::to_string_pretty(entries)
            .map_err(|e| TerminalError::ConfigSave(e.to_string()))?;
        std::fs::write(&self.path, data).map_err(|e| TerminalError::ConfigSave(e.to_string()))?;
        Ok(())
    }

    fn insert_and_save(
        &self,
        entries: &mut HashMap<String, Vec<HostKeyEntry>>,
        host_key: String,
        entry: HostKeyEntry,
    ) -> Result<(), TerminalError> {
        let previous = entries.get(&host_key).cloned();
        let host_entries = entries.entry(host_key.clone()).or_default();
        host_entries.retain(|item| item.key_type != entry.key_type);
        host_entries.push(entry);
        if let Err(error) = self.save_entries(entries) {
            match previous {
                Some(old) => {
                    entries.insert(host_key, old);
                }
                None => {
                    entries.remove(&host_key);
                }
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn verify(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyVerification {
        let fp = fingerprint(key);
        let kt = key_type(key);
        let ek = entry_key(host, port);

        let entries = self.entries.read().unwrap();
        let result = verify_entry(&entries, &ek, &kt, &fp);
        drop(entries);

        if !matches!(&result, HostKeyVerification::Trusted) {
            self.pending.write().unwrap().insert(ek, (kt, fp));
        }

        result
    }

    pub fn verify_or_trust_new(
        &self,
        host: &str,
        port: u16,
        key: &PublicKey,
        accept_new: bool,
    ) -> Result<HostKeyVerification, TerminalError> {
        let result = self.verify(host, port, key);
        if !accept_new || !matches!(result, HostKeyVerification::Unknown { .. }) {
            return Ok(result);
        }

        let fp = fingerprint(key);
        let kt = key_type(key);
        let ek = entry_key(host, port);
        let mut entries = self.entries.write().unwrap();
        let mut result = verify_entry(&entries, &ek, &kt, &fp);
        if matches!(result, HostKeyVerification::Unknown { .. }) {
            if let Some(known) = entries.get(&ek).and_then(|keys| keys.first()) {
                result = HostKeyVerification::Changed {
                    expected_fingerprint: known.fingerprint.clone(),
                    actual_fingerprint: fp.clone(),
                };
            }
        }
        if !matches!(result, HostKeyVerification::Unknown { .. }) {
            drop(entries);
            let mut pending = self.pending.write().unwrap();
            if matches!(result, HostKeyVerification::Changed { .. }) {
                pending.insert(ek, (kt, fp));
            } else if pending.get(&ek) == Some(&(kt, fp)) {
                pending.remove(&ek);
            }
            return Ok(result);
        }
        self.insert_and_save(
            &mut entries,
            ek.clone(),
            HostKeyEntry {
                host: host.to_string(),
                port,
                key_type: kt.clone(),
                fingerprint: fp.clone(),
            },
        )?;
        drop(entries);
        let mut pending = self.pending.write().unwrap();
        if pending.get(&ek) == Some(&(kt, fp)) {
            pending.remove(&ek);
        }
        Ok(HostKeyVerification::Trusted)
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
        self.insert_and_save(&mut entries, ek, entry)
    }

    pub fn remove(&self, host: &str, port: u16) -> Result<(), TerminalError> {
        let ek = entry_key(host, port);
        let mut entries = self.entries.write().unwrap();
        let previous = entries.remove(&ek);
        if let Err(error) = self.save_entries(&entries) {
            if let Some(previous) = previous {
                entries.insert(ek, previous);
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn trust_last_unknown(&self, host: &str, port: u16) -> Result<(), TerminalError> {
        self.trust_pending(host, port, None)
    }

    pub fn trust_pending(
        &self,
        host: &str,
        port: u16,
        expected_fingerprint: Option<&str>,
    ) -> Result<(), TerminalError> {
        let ek = entry_key(host, port);
        let mut pending = self.pending.write().unwrap();
        let (kt, fp) = pending.get(&ek).cloned().ok_or_else(|| {
            TerminalError::ConfigSave("No pending host key to trust for this host".into())
        })?;
        if expected_fingerprint.is_some_and(|expected| expected != fp) {
            return Err(TerminalError::ConfigSave(
                "Pending host key fingerprint does not match".into(),
            ));
        }
        let entry = HostKeyEntry {
            host: host.to_string(),
            port,
            key_type: kt.clone(),
            fingerprint: fp,
        };

        let mut entries = self.entries.write().unwrap();
        self.insert_and_save(&mut entries, ek.clone(), entry)?;
        pending.remove(&ek);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{fingerprint, HostKeyVerification, KnownHostsStore};
    use russh::keys::{Algorithm, PrivateKey, PublicKey};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Barrier, RwLock};

    fn key() -> PublicKey {
        let mut rng = russh::keys::key::safe_rng();
        PrivateKey::random(&mut rng, Algorithm::Ed25519)
            .unwrap()
            .public_key()
            .clone()
    }

    fn store(path: PathBuf) -> KnownHostsStore {
        KnownHostsStore {
            entries: RwLock::new(HashMap::new()),
            path,
            pending: RwLock::new(HashMap::new()),
        }
    }

    #[test]
    fn pending_keys_are_bound_to_each_host_and_fingerprint() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(store(temp.path().join("known_hosts.json")));
        let first = key();
        let second = key();
        std::thread::scope(|scope| {
            let first_store = store.clone();
            let second_store = store.clone();
            let first = &first;
            let second = &second;
            let a = scope.spawn(move || first_store.verify("host-a", 22, first));
            let b = scope.spawn(move || second_store.verify("host-b", 2222, second));
            assert!(matches!(
                a.join().unwrap(),
                HostKeyVerification::Unknown { .. }
            ));
            assert!(matches!(
                b.join().unwrap(),
                HostKeyVerification::Unknown { .. }
            ));
        });
        assert!(store
            .trust_pending("host-a", 22, Some("wrong-fingerprint"))
            .is_err());
        std::thread::scope(|scope| {
            let first_store = store.clone();
            let second_store = store.clone();
            let first_fingerprint = fingerprint(&first);
            let a = scope
                .spawn(move || first_store.trust_pending("host-a", 22, Some(&first_fingerprint)));
            let b = scope.spawn(move || second_store.trust_last_unknown("host-b", 2222));
            a.join().unwrap().unwrap();
            b.join().unwrap().unwrap();
        });
        assert_eq!(
            store.verify("host-a", 22, &first),
            HostKeyVerification::Trusted
        );
        assert_eq!(
            store.verify("host-b", 2222, &second),
            HostKeyVerification::Trusted
        );
        let reloaded = self::store(temp.path().join("known_hosts.json"));
        reloaded.load().unwrap();
        assert_eq!(
            reloaded.verify("host-a", 22, &first),
            HostKeyVerification::Trusted
        );
        assert_eq!(
            reloaded.verify("host-b", 2222, &second),
            HostKeyVerification::Trusted
        );
    }

    #[test]
    fn accept_new_persists_a_key_but_rejects_a_changed_one() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("known_hosts.json");
        let store = store(path.clone());
        let first = key();
        let changed = key();
        assert_eq!(
            store.verify_or_trust_new("host", 22, &first, true).unwrap(),
            HostKeyVerification::Trusted
        );
        let reloaded = self::store(path);
        reloaded.load().unwrap();
        assert_eq!(
            reloaded.verify("host", 22, &first),
            HostKeyVerification::Trusted
        );
        assert!(matches!(
            store
                .verify_or_trust_new("host", 22, &changed, true)
                .unwrap(),
            HostKeyVerification::Changed { .. }
        ));
        assert_eq!(
            store.verify("host", 22, &first),
            HostKeyVerification::Trusted
        );
        store
            .trust_pending("host", 22, Some(&fingerprint(&changed)))
            .unwrap();
        assert_eq!(
            store.verify("host", 22, &changed),
            HostKeyVerification::Trusted
        );
    }

    #[test]
    fn strict_mode_leaves_new_keys_pending() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path().join("known_hosts.json"));
        let key = key();
        assert!(matches!(
            store.verify_or_trust_new("host", 22, &key, false).unwrap(),
            HostKeyVerification::Unknown { .. }
        ));
        store
            .trust_pending("host", 22, Some(&fingerprint(&key)))
            .unwrap();
        assert_eq!(store.verify("host", 22, &key), HostKeyVerification::Trusted);
    }

    #[test]
    fn in_memory_store_does_not_trust_new_keys_without_a_file() {
        let store = KnownHostsStore::new_in_memory();
        let key = key();
        assert!(store.verify_or_trust_new("host", 22, &key, true).is_err());
        assert!(matches!(
            store.verify("host", 22, &key),
            HostKeyVerification::Unknown { .. }
        ));
    }

    #[test]
    fn accept_new_does_not_trust_another_key_algorithm_for_a_known_host() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path().join("known_hosts.json"));
        let key = key();
        store.verify_or_trust_new("host", 22, &key, true).unwrap();
        store.entries.write().unwrap().get_mut("host").unwrap()[0].key_type =
            "other-algorithm".into();
        assert!(matches!(
            store.verify_or_trust_new("host", 22, &key, true).unwrap(),
            HostKeyVerification::Changed { .. }
        ));
    }

    #[test]
    fn failed_persistence_does_not_trust_or_consume_a_key() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(temp.path().to_path_buf());
        let key = key();
        assert!(store.verify_or_trust_new("host", 22, &key, true).is_err());
        assert!(matches!(
            store.verify("host", 22, &key),
            HostKeyVerification::Unknown { .. }
        ));
        assert!(store
            .trust_pending("host", 22, Some(&fingerprint(&key)))
            .is_err());
        assert!(store.pending.read().unwrap().contains_key("host"));
    }

    #[test]
    fn concurrent_first_keys_never_replace_each_other() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(store(temp.path().join("known_hosts.json")));
        let keys = [key(), key()];
        let barrier = Arc::new(Barrier::new(2));
        let results = std::thread::scope(|scope| {
            let tasks: Vec<_> = keys
                .iter()
                .map(|key| {
                    let store = store.clone();
                    let barrier = barrier.clone();
                    scope.spawn(move || {
                        barrier.wait();
                        store.verify_or_trust_new("host", 22, key, true).unwrap()
                    })
                })
                .collect();
            tasks
                .into_iter()
                .map(|task| task.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, HostKeyVerification::Trusted))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, HostKeyVerification::Changed { .. }))
                .count(),
            1
        );
        let changed = results
            .iter()
            .position(|r| matches!(r, HostKeyVerification::Changed { .. }))
            .unwrap();
        store
            .trust_pending("host", 22, Some(&fingerprint(&keys[changed])))
            .unwrap();
        assert_eq!(
            store.verify("host", 22, &keys[changed]),
            HostKeyVerification::Trusted
        );
    }
}
