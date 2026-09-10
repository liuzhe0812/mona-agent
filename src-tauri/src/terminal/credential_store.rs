use std::fs;
use std::path::PathBuf;

use log::{error, warn};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use crate::terminal::config::AuthConfig;

const ENCRYPTED_MARKER: &str = "__encrypted__";
const LEGACY_KEYRING_MARKER: &str = "__keyring__";
const VAULT_FILENAME: &str = "credential-vault.json";
const KEY_FILENAME: &str = "credential-key.bin";
const DPAPI_SECRET_PREFIX: &str = "dpapi:";
const VAULT_SECRET_PREFIX: &str = "vault:";

fn config_dir() -> Result<PathBuf, String> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Cannot determine config directory".to_string())?;
    let dir = config_dir.join("mona");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(dir)
}

fn vault_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(VAULT_FILENAME))
}

fn key_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(KEY_FILENAME))
}

fn secret_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("Invalid secret name".to_string());
    }
    Ok(config_dir()?.join(format!("secret-{}.bin", name)))
}

fn get_or_create_key() -> Result<[u8; 32], String> {
    let path = key_path()?;

    if path.exists() {
        match fs::read(&path) {
            Ok(data) => {
                if data.len() == 32 {
                    let mut key = [0u8; 32];
                    key.copy_from_slice(&data);
                    return Ok(key);
                }
                warn!(
                    "Credential key file has invalid length ({}), regenerating",
                    data.len()
                );
            }
            Err(e) => {
                warn!("Failed to read credential key file: {}, regenerating", e);
            }
        }
    }

    let rng = SystemRandom::new();
    let mut key = [0u8; 32];
    rng.fill(&mut key)
        .map_err(|e| format!("Failed to generate key: {}", e))?;

    fs::write(&path, key).map_err(|e| format!("Failed to write key file: {}", e))?;

    Ok(key)
}

fn encrypt(plaintext: &str) -> Result<String, String> {
    let key_bytes = get_or_create_key()?;
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

    let key_bytes = get_or_create_key()?;
    let unbound_key = UnboundKey::new(&AES_256_GCM, &key_bytes)
        .map_err(|e| format!("Failed to create AES key: {}", e))?;
    let key = LessSafeKey::new(unbound_key);

    let mut in_out = encrypted.to_vec();
    let plaintext = key
        .open_in_place(nonce, Aad::empty(), &mut in_out)
        .map_err(|e| format!("Decryption failed: {}", e))?;

    String::from_utf8(plaintext.to_vec()).map_err(|e| format!("UTF-8 decode failed: {}", e))
}

#[cfg(windows)]
fn protect_secret(value: &str) -> Result<String, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let bytes = value.as_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| "Secret is too large")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("Windows credential protection failed: {}", e))?;
        let protected = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let encoded = data_encoding::BASE64URL_NOPAD.encode(protected);
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(format!("{}{}", DPAPI_SECRET_PREFIX, encoded))
    }
}

#[cfg(windows)]
fn unprotect_secret(value: &str) -> Result<String, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let encoded = value
        .strip_prefix(DPAPI_SECRET_PREFIX)
        .ok_or_else(|| "Invalid protected secret".to_string())?;
    let mut bytes = data_encoding::BASE64URL_NOPAD
        .decode(encoded.as_bytes())
        .map_err(|e| format!("Protected secret decode failed: {}", e))?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| "Secret is too large")?,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("Windows credential unprotection failed: {}", e))?;
        let plaintext = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let result = String::from_utf8(plaintext.to_vec())
            .map_err(|e| format!("Protected secret is not UTF-8: {}", e));
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        result
    }
}

#[cfg(not(windows))]
fn protect_secret(value: &str) -> Result<String, String> {
    Ok(format!("{}{}", VAULT_SECRET_PREFIX, encrypt(value)?))
}

#[cfg(not(windows))]
fn unprotect_secret(value: &str) -> Result<String, String> {
    let encrypted = value
        .strip_prefix(VAULT_SECRET_PREFIX)
        .ok_or_else(|| "Invalid protected secret".to_string())?;
    decrypt(encrypted)
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

pub fn store_secret(name: &str, value: &str) -> Result<(), String> {
    fs::write(secret_path(name)?, protect_secret(value)?)
        .map_err(|e| format!("Failed to store secret: {}", e))
}

pub fn load_secret(name: &str) -> Result<Option<String>, String> {
    let path = secret_path(name)?;
    if !path.exists() {
        return Ok(None);
    }
    let value = fs::read_to_string(path).map_err(|e| format!("Failed to read secret: {}", e))?;
    if value.starts_with(DPAPI_SECRET_PREFIX) || value.starts_with(VAULT_SECRET_PREFIX) {
        return unprotect_secret(&value).map(Some);
    }
    let legacy = decrypt(&value)?;
    store_secret(name, &legacy)?;
    Ok(Some(legacy))
}

pub fn delete_secret(name: &str) -> Result<(), String> {
    let path = secret_path(name)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Failed to delete secret: {}", e))?;
    }
    Ok(())
}

pub fn store_credential(auth: &AuthConfig, host: &str, port: u16, username: &str) -> AuthConfig {
    match auth {
        AuthConfig::Password { password } => {
            if password == ENCRYPTED_MARKER || password == LEGACY_KEYRING_MARKER {
                // Already a stored-credential marker; don't re-encrypt it.
                return auth.clone();
            }
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
                if pp == ENCRYPTED_MARKER || pp == LEGACY_KEYRING_MARKER {
                    return auth.clone();
                }
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

#[cfg(test)]
mod secret_tests {
    use super::secret_path;

    #[test]
    fn secret_names_cannot_escape_the_config_directory() {
        assert!(secret_path("../auth-token").is_err());
        assert!(secret_path("auth/token").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_secret_round_trip() {
        let protected = super::protect_secret("scoped-account-token").unwrap();
        assert!(!protected.contains("scoped-account-token"));
        assert_eq!(
            super::unprotect_secret(&protected).unwrap(),
            "scoped-account-token"
        );
    }
}
