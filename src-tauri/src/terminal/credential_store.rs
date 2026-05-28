use std::fs;
use std::path::PathBuf;

use log::{error, warn};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use crate::terminal::config::AuthConfig;

const ENCRYPTED_MARKER: &str = "__encrypted__";
const LEGACY_KEYRING_MARKER: &str = "__keyring__";
const VAULT_FILENAME: &str = "credential-vault.json";

fn vault_path() -> Result<PathBuf, String> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Cannot determine config directory".to_string())?;
    let dir = config_dir.join("mona");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(dir.join(VAULT_FILENAME))
}

fn derive_key() -> [u8; 32] {
    let hostname = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown".to_string());
    let username = whoami::username();
    let seed = format!("mona-terminal-credentials:{}:{}", hostname, username);
    let hash = digest(&SHA256, seed.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(hash.as_ref());
    key
}

fn encrypt(plaintext: &str) -> Result<String, String> {
    let key_bytes = derive_key();
    let unbound_key = UnboundKey::new(&AES_256_GCM, &key_bytes)
        .map_err(|e| format!("Failed to create AES key: {}", e))?;
    let key = LessSafeKey::new(unbound_key);

    let rng = SystemRandom::new();
    let mut nonce_bytes = [0u8; 12];
    rng.fill(&mut nonce_bytes)
        .map_err(|e| format!("Failed to generate nonce: {}", e))?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut in_out = plaintext.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, Aad::empty(), &mut in_out)
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let mut result = Vec::with_capacity(12 + in_out.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&in_out);

    Ok(data_encoding::BASE64URL_NOPAD.encode(&result))
}

fn decrypt(ciphertext: &str) -> Result<String, String> {
    let data = data_encoding::BASE64URL_NOPAD
        .decode(ciphertext.as_bytes())
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    if data.len() < 12 {
        return Err("Ciphertext too short".to_string());
    }

    let (nonce_bytes, encrypted) = data.split_at(12);
    let nonce = Nonce::assume_unique_for_key(
        nonce_bytes
            .try_into()
            .map_err(|_| "Invalid nonce length")?,
    );

    let key_bytes = derive_key();
    let unbound_key = UnboundKey::new(&AES_256_GCM, &key_bytes)
        .map_err(|e| format!("Failed to create AES key: {}", e))?;
    let key = LessSafeKey::new(unbound_key);

    let mut in_out = encrypted.to_vec();
    let plaintext = key
        .open_in_place(nonce, Aad::empty(), &mut in_out)
        .map_err(|e| format!("Decryption failed: {}", e))?;

    String::from_utf8(plaintext.to_vec()).map_err(|e| format!("UTF-8 decode failed: {}", e))
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct Vault {
    entries: std::collections::HashMap<String, String>,
}

fn vault_key(host: &str, port: u16, username: &str, field: &str) -> String {
    format!("{}@{}:{}:{}", username, host, port, field)
}

fn load_vault() -> Vault {
    let path = match vault_path() {
        Ok(p) => p,
        Err(e) => {
            warn!("Failed to get vault path: {}", e);
            return Vault::default();
        }
    };

    if !path.exists() {
        return Vault::default();
    }

    match fs::read_to_string(&path) {
        Ok(data) => match serde_json::from_str(&data) {
            Ok(vault) => vault,
            Err(e) => {
                warn!("Failed to parse vault: {}", e);
                Vault::default()
            }
        },
        Err(e) => {
            warn!("Failed to read vault: {}", e);
            Vault::default()
        }
    }
}

fn save_vault(vault: &Vault) -> Result<(), String> {
    let path = vault_path()?;
    let json = serde_json::to_string_pretty(vault)
        .map_err(|e| format!("Failed to serialize vault: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write vault: {}", e))
}

pub fn store_credential(auth: &AuthConfig, host: &str, port: u16, username: &str) -> AuthConfig {
    match auth {
        AuthConfig::Password { password } => {
            if !password.is_empty() {
                let key = vault_key(host, port, username, "password");
                match encrypt(password) {
                    Ok(encrypted) => {
                        let mut vault = load_vault();
                        vault.entries.insert(key, encrypted);
                        if let Err(e) = save_vault(&vault) {
                            warn!("Failed to save vault: {}", e);
                            return auth.clone();
                        }
                        return AuthConfig::Password {
                            password: ENCRYPTED_MARKER.into(),
                        };
                    }
                    Err(e) => {
                        warn!("Failed to encrypt password: {}", e);
                    }
                }
            }
            auth.clone()
        }
        AuthConfig::KeyFile {
            key_path,
            passphrase,
        } => {
            if let Some(pp) = passphrase {
                if !pp.is_empty() {
                    let key = vault_key(host, port, username, "passphrase");
                    match encrypt(pp) {
                        Ok(encrypted) => {
                            let mut vault = load_vault();
                            vault.entries.insert(key, encrypted);
                            if let Err(e) = save_vault(&vault) {
                                warn!("Failed to save vault: {}", e);
                                return auth.clone();
                            }
                            return AuthConfig::KeyFile {
                                key_path: key_path.clone(),
                                passphrase: Some(ENCRYPTED_MARKER.into()),
                            };
                        }
                        Err(e) => {
                            warn!("Failed to encrypt passphrase: {}", e);
                        }
                    }
                }
            }
            auth.clone()
        }
        AuthConfig::Agent => AuthConfig::Agent,
    }
}

pub fn restore_credential(
    auth: &AuthConfig,
    host: &str,
    port: u16,
    username: &str,
) -> Result<AuthConfig, String> {
    match auth {
        AuthConfig::Password { password } => {
            if password == ENCRYPTED_MARKER {
                let key = vault_key(host, port, username, "password");
                let vault = load_vault();
                match vault.entries.get(&key) {
                    Some(encrypted) => match decrypt(encrypted) {
                        Ok(decrypted) => Ok(AuthConfig::Password {
                            password: decrypted,
                        }),
                        Err(e) => {
                            error!("Failed to decrypt password for {}: {}", key, e);
                            Err(format!(
                                "Failed to decrypt saved password: {}. Please re-enter the password.",
                                e
                            ))
                        }
                    },
                    None => {
                        error!("Password entry not found in vault for {}", key);
                        Err(
                            "Saved password not found. Please re-enter the password.".to_string(),
                        )
                    }
                }
            } else if password == LEGACY_KEYRING_MARKER {
                Err("Password storage format has been upgraded. Please re-enter the password.".to_string())
            } else {
                Ok(auth.clone())
            }
        }
        AuthConfig::KeyFile {
            key_path,
            passphrase,
        } => {
            let restored_passphrase = match passphrase {
                Some(pp) if pp == ENCRYPTED_MARKER => {
                    let key = vault_key(host, port, username, "passphrase");
                    let vault = load_vault();
                    vault
                        .entries
                        .get(&key)
                        .and_then(|encrypted| decrypt(encrypted).ok())
                }
                Some(pp) if pp == LEGACY_KEYRING_MARKER => None,
                Some(pp) => Some(pp.clone()),
                None => None,
            };
            Ok(AuthConfig::KeyFile {
                key_path: key_path.clone(),
                passphrase: restored_passphrase,
            })
        }
        AuthConfig::Agent => Ok(AuthConfig::Agent),
    }
}

pub fn delete_credential(host: &str, port: u16, username: &str) {
    let mut vault = load_vault();
    for field in &["password", "passphrase"] {
        let key = vault_key(host, port, username, field);
        vault.entries.remove(&key);
    }
    if let Err(e) = save_vault(&vault) {
        warn!("Failed to save vault after deletion: {}", e);
    }
}
