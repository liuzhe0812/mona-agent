use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::terminal::commands;
use crate::terminal::config::{AuthConfig, ConnectionConfig, Protocol};
use crate::terminal::credential_store::{self, OpsSecretField};

const MAX_PRIVATE_KEY_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AuthType {
    Password,
    Key,
    Agent,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PasswordCredentials {
    password: String,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyCredentials {
    private_key: String,
    passphrase: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum Credentials {
    Password(PasswordCredentials),
    Key(KeyCredentials),
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionData {
    name: String,
    protocol: Protocol,
    host: String,
    port: u16,
    username: String,
    auth_type: AuthType,
    credentials: Option<Credentials>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: String,
    include_credentials: bool,
    #[serde(default)]
    connection_id: Option<String>,
    #[serde(default)]
    expected: Option<String>,
    #[serde(default)]
    data: Option<ConnectionData>,
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn empty_fingerprint() -> String {
    hash(b"null")
}

fn linked(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    false
}

fn key_file_version(path: &str) -> String {
    let path = Path::new(path);
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) if !linked(&metadata) && metadata.is_file() => metadata,
        _ => return "missing".into(),
    };
    let resolved = match path.canonicalize() {
        Ok(resolved) => resolved,
        Err(_) => return "missing".into(),
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_nanos().to_string())
        .unwrap_or_else(|| "unknown".into());
    format!(
        "{}:{}:{}",
        hash(resolved.to_string_lossy().as_bytes()),
        metadata.len(),
        modified
    )
}

fn protected_version(marker: &str, field: OpsSecretField) -> String {
    let Some(name) = credential_store::ops_secret_name_from_marker(marker, field) else {
        return "invalid".into();
    };
    match credential_store::secret_version(name) {
        Ok(Some(version)) => version,
        Ok(None) => "missing".into(),
        Err(_) => "unavailable".into(),
    }
}

fn legacy_version(connection: &ConnectionConfig, field: &str) -> String {
    match credential_store::legacy_credential_version(
        &connection.host,
        connection.port,
        &connection.username,
        field,
    ) {
        Ok(Some(version)) => version,
        Ok(None) => "missing".into(),
        Err(_) => "unavailable".into(),
    }
}

fn auth_type(auth: &AuthConfig) -> AuthType {
    match auth {
        AuthConfig::Password { .. } => AuthType::Password,
        AuthConfig::KeyFile { .. } => AuthType::Key,
        AuthConfig::Agent => AuthType::Agent,
    }
}

fn protocol_name(protocol: &Protocol) -> &'static str {
    match protocol {
        Protocol::Ssh => "ssh",
        Protocol::Sftp => "sftp",
        Protocol::Ftp => "ftp",
        Protocol::Vnc => "vnc",
        Protocol::Local => "local",
    }
}

fn credential_versions(connection: &ConnectionConfig) -> Vec<String> {
    match &connection.auth {
        AuthConfig::Password { password } => {
            let version = if credential_store::ops_secret_name_from_marker(
                password,
                OpsSecretField::Password,
            )
            .is_some()
            {
                protected_version(password, OpsSecretField::Password)
            } else if password == "__encrypted__" {
                legacy_version(connection, "password")
            } else if password.is_empty() {
                "none".into()
            } else {
                "unprotected-present".into()
            };
            vec![format!("password:{version}")]
        }
        AuthConfig::KeyFile {
            key_path,
            passphrase,
        } => {
            let key = if credential_store::ops_secret_name_from_marker(
                key_path,
                OpsSecretField::PrivateKey,
            )
            .is_some()
            {
                protected_version(key_path, OpsSecretField::PrivateKey)
            } else if key_path.is_empty() {
                "none".into()
            } else {
                key_file_version(key_path)
            };
            let pass = match passphrase {
                Some(value)
                    if credential_store::ops_secret_name_from_marker(
                        value,
                        OpsSecretField::Passphrase,
                    )
                    .is_some() =>
                {
                    protected_version(value, OpsSecretField::Passphrase)
                }
                Some(value) if value == "__encrypted__" => legacy_version(connection, "passphrase"),
                Some(value) if value.is_empty() => "none".into(),
                Some(_) => "unprotected-present".into(),
                None => "none".into(),
            };
            vec![format!("private_key:{key}"), format!("passphrase:{pass}")]
        }
        AuthConfig::Agent => Vec::new(),
    }
}

fn connection_fingerprint(
    connection: &ConnectionConfig,
    include_credentials: bool,
) -> Result<String, String> {
    let versions = credential_versions(connection);
    let value = json!({
        "id": connection.id,
        "name": connection.name,
        "protocol": protocol_name(&connection.protocol),
        "host": connection.host,
        "port": connection.port,
        "username": connection.username,
        "auth_type": auth_type(&connection.auth),
        "include_credentials": include_credentials,
        "credential_versions": versions,
    });
    serde_json::to_vec(&value)
        .map(|value| hash(&value))
        .map_err(|_| "运维主机指纹计算失败。".into())
}

pub(crate) fn connections_revision(connections: &[ConnectionConfig]) -> Result<String, String> {
    let mut rows = connections
        .iter()
        .map(|connection| {
            Ok((
                connection.id.clone(),
                connection_fingerprint(connection, true)?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    rows.sort_by(|left, right| left.0.cmp(&right.0));
    let bytes = serde_json::to_vec(&rows).map_err(|_| "终端连接版本计算失败。")?;
    Ok(hash(&bytes))
}

fn storage_token(path: &Path) -> Result<String, String> {
    let parent = path.parent().ok_or("终端连接配置位置无效。")?;
    let parent = parent
        .canonicalize()
        .map_err(|_| "终端连接配置位置不可用。")?;
    let file = path.file_name().ok_or("终端连接配置位置无效。")?;
    Ok(hash(parent.join(file).to_string_lossy().as_bytes()))
}

fn validate_connection_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 160 || id.chars().any(char::is_control) {
        return Err("运维主机标识无效。".into());
    }
    Ok(())
}

fn validate_expected(expected: &str) -> Result<(), String> {
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("运维主机版本无效。".into());
    }
    Ok(())
}

fn read_private_key_file(path: &str, passphrase: Option<&str>) -> Result<String, String> {
    let path = Path::new(path);
    let metadata = fs::symlink_metadata(path).map_err(|_| "私钥文件不可用。")?;
    if linked(&metadata) || !metadata.is_file() {
        return Err("私钥必须是普通文件。".into());
    }
    let resolved = path.canonicalize().map_err(|_| "私钥文件不可用。")?;
    let metadata = fs::symlink_metadata(&resolved).map_err(|_| "私钥文件不可用。")?;
    if linked(&metadata) || !metadata.is_file() || metadata.len() > MAX_PRIVATE_KEY_BYTES {
        return Err("私钥文件无效或过大。".into());
    }
    let private_key = fs::read_to_string(&resolved).map_err(|_| "私钥文件不可用。")?;
    if private_key.len() as u64 > MAX_PRIVATE_KEY_BYTES {
        return Err("私钥文件无效或过大。".into());
    }
    russh::keys::decode_secret_key(&private_key, passphrase)
        .map_err(|_| "私钥无法解码或口令不正确。")?;
    Ok(private_key)
}

fn read_credentials(connection: &ConnectionConfig) -> Result<Option<Value>, ()> {
    match &connection.auth {
        AuthConfig::Password { password } => {
            let secret_name =
                credential_store::ops_secret_name_from_marker(password, OpsSecretField::Password);
            let explicit_empty = secret_name.is_some()
                || matches!(&connection.protocol, Protocol::Ftp | Protocol::Vnc);
            let saved = if let Some(name) = secret_name {
                Some(
                    credential_store::load_secret(name)
                        .map_err(|_| ())?
                        .ok_or(())?,
                )
            } else if password.starts_with("__mona_ops_") {
                return Err(());
            } else if password == "__encrypted__" {
                credential_store::load_legacy_credential(
                    &connection.host,
                    connection.port,
                    &connection.username,
                    "password",
                )
                .map_err(|_| ())?
            } else if password == "__keyring__" {
                return Err(());
            } else if password.is_empty() {
                None
            } else {
                Some(password.clone())
            };
            match saved {
                Some(password) if !password.is_empty() || explicit_empty => {
                    Ok(Some(json!({"password": password})))
                }
                Some(_) | None => Ok(None),
            }
        }
        AuthConfig::Agent => Ok(None),
        AuthConfig::KeyFile {
            key_path,
            passphrase,
        } => {
            if key_path.is_empty() {
                return Ok(None);
            }
            let passphrase = match passphrase {
                Some(value) => {
                    if let Some(name) = credential_store::ops_secret_name_from_marker(
                        value,
                        OpsSecretField::Passphrase,
                    ) {
                        Some(
                            credential_store::load_secret(name)
                                .map_err(|_| ())?
                                .ok_or(())?,
                        )
                    } else if value.starts_with("__mona_ops_") {
                        return Err(());
                    } else if value == "__encrypted__" {
                        credential_store::load_legacy_credential(
                            &connection.host,
                            connection.port,
                            &connection.username,
                            "passphrase",
                        )
                        .map_err(|_| ())?
                    } else if value == "__keyring__" {
                        return Err(());
                    } else {
                        Some(value.clone())
                    }
                }
                None => None,
            };
            let private_key = if credential_store::ops_secret_name_from_marker(
                &key_path,
                OpsSecretField::PrivateKey,
            )
            .is_some()
            {
                credential_store::load_ops_private_key(&key_path)
                    .map_err(|_| ())?
                    .ok_or(())?
            } else {
                read_private_key_file(key_path, passphrase.as_deref()).map_err(|_| ())?
            };
            russh::keys::decode_secret_key(&private_key, passphrase.as_deref()).map_err(|_| ())?;
            Ok(Some(
                json!({"private_key": private_key, "passphrase": passphrase}),
            ))
        }
    }
}

fn expected_target_auth(connection: &ConnectionConfig, data: &ConnectionData) -> bool {
    connection.protocol == data.protocol
        && connection.host == data.host
        && connection.port == data.port
        && connection.username == data.username
        && auth_type(&connection.auth) == data.auth_type
}

fn empty_auth(auth_type: AuthType) -> AuthConfig {
    match auth_type {
        AuthType::Password => AuthConfig::Password {
            password: String::new(),
        },
        AuthType::Key => AuthConfig::KeyFile {
            key_path: String::new(),
            passphrase: None,
        },
        AuthType::Agent => AuthConfig::Agent,
    }
}

fn validate_data(data: &ConnectionData) -> Result<(), String> {
    if data.name.len() > 240
        || data.host.len() > 1024
        || data.username.len() > 1024
        || data.port == 0
        || matches!(&data.protocol, Protocol::Local)
    {
        return Err("运维主机配置无效。".into());
    }
    match &data.protocol {
        Protocol::Ssh | Protocol::Sftp => {}
        Protocol::Ftp | Protocol::Vnc if data.auth_type != AuthType::Password => {
            return Err("该协议只支持密码认证。".into());
        }
        Protocol::Ftp | Protocol::Vnc => {}
        Protocol::Local => return Err("本地终端不能同步。".into()),
    }
    match (&data.auth_type, &data.credentials) {
        (AuthType::Password, Some(Credentials::Password(_)))
        | (AuthType::Key, Some(Credentials::Key(_)))
        | (_, None) => Ok(()),
        (AuthType::Agent, Some(_)) => Err("Agent 认证不能包含凭据。".into()),
        _ => Err("凭据类型与认证方式不匹配。".into()),
    }
}

fn save_ops_secret(
    field: OpsSecretField,
    value: &str,
    created: &mut Vec<String>,
) -> Result<String, String> {
    let (marker, name) = credential_store::new_ops_secret_marker(field)
        .map_err(|_| "无法保护运维主机凭据。".to_string())?;
    credential_store::store_secret(&name, value)
        .map_err(|_| "无法保护运维主机凭据。".to_string())?;
    created.push(name);
    Ok(marker)
}

fn delete_names(names: &[String]) {
    for name in names {
        if credential_store::delete_secret(name).is_err() {
            log::warn!("Unable to remove a retired protected operations credential");
        }
    }
}

fn secret_names(auth: &AuthConfig) -> Vec<String> {
    match auth {
        AuthConfig::Password { password } => {
            credential_store::ops_secret_name_from_marker(password, OpsSecretField::Password)
                .map(str::to_string)
                .into_iter()
                .collect()
        }
        AuthConfig::KeyFile {
            key_path,
            passphrase,
        } => credential_store::ops_secret_name_from_marker(key_path, OpsSecretField::PrivateKey)
            .map(str::to_string)
            .into_iter()
            .chain(passphrase.iter().filter_map(|value| {
                credential_store::ops_secret_name_from_marker(value, OpsSecretField::Passphrase)
                    .map(str::to_string)
            }))
            .collect(),
        AuthConfig::Agent => Vec::new(),
    }
}

pub(crate) fn delete_connection_credentials(connection: &ConnectionConfig) {
    delete_names(&secret_names(&connection.auth));
}

pub(crate) fn discard_uncommitted_credentials(
    old: Option<&ConnectionConfig>,
    new: &ConnectionConfig,
) {
    let old_names = old
        .map(|connection| secret_names(&connection.auth))
        .unwrap_or_default();
    delete_names(
        &secret_names(&new.auth)
            .into_iter()
            .filter(|name| !old_names.contains(name))
            .collect::<Vec<_>>(),
    );
}

pub(crate) fn cleanup_replaced_credentials(old: Option<&ConnectionConfig>, new: &ConnectionConfig) {
    let new_names = secret_names(&new.auth);
    let old_names = old
        .map(|connection| secret_names(&connection.auth))
        .unwrap_or_default();
    delete_names(
        &old_names
            .into_iter()
            .filter(|name| !new_names.contains(name))
            .collect::<Vec<_>>(),
    );
}

fn store_cloud_auth(
    data: &ConnectionData,
    old: Option<&ConnectionConfig>,
    same_target: bool,
) -> Result<(AuthConfig, Vec<String>), String> {
    let mut created = Vec::new();
    let result: Result<AuthConfig, String> = (|| match &data.credentials {
        None if same_target => Ok(old
            .map(|connection| connection.auth.clone())
            .unwrap_or_else(|| empty_auth(data.auth_type))),
        None => Ok(empty_auth(data.auth_type)),
        Some(Credentials::Password(credentials)) if data.auth_type == AuthType::Password => {
            if credentials.password.len() > 16 * 1024 {
                Err("运维主机密码过长。".into())
            } else {
                save_ops_secret(
                    OpsSecretField::Password,
                    &credentials.password,
                    &mut created,
                )
                .map(|marker| AuthConfig::Password { password: marker })
            }
        }
        Some(Credentials::Key(credentials)) if data.auth_type == AuthType::Key => {
            if credentials.private_key.len() as u64 > MAX_PRIVATE_KEY_BYTES
                || credentials
                    .passphrase
                    .as_ref()
                    .is_some_and(|value| value.len() > 16 * 1024)
                || russh::keys::decode_secret_key(
                    &credentials.private_key,
                    credentials.passphrase.as_deref(),
                )
                .is_err()
            {
                return Err("私钥无法解码、口令不正确或文件过大。".into());
            }
            let key_marker = save_ops_secret(
                OpsSecretField::PrivateKey,
                &credentials.private_key,
                &mut created,
            )?;
            let passphrase_marker = credentials
                .passphrase
                .as_deref()
                .map(|value| save_ops_secret(OpsSecretField::Passphrase, value, &mut created))
                .transpose()?;
            Ok(AuthConfig::KeyFile {
                key_path: key_marker,
                passphrase: passphrase_marker,
            })
        }
        _ => Err("凭据类型与认证方式不匹配。".into()),
    })();
    if result.is_err() {
        delete_names(&created);
    }
    result.map(|auth| (auth, created))
}

fn build_connection(
    id: &str,
    data: &ConnectionData,
    old: Option<&ConnectionConfig>,
) -> Result<(ConnectionConfig, Vec<String>), String> {
    validate_data(data)?;
    let same_target = old.is_some_and(|connection| expected_target_auth(connection, data));
    let (auth, created) = store_cloud_auth(data, old, same_target)?;
    Ok((
        ConnectionConfig {
            id: id.into(),
            name: data.name.clone(),
            protocol: data.protocol.clone(),
            host: data.host.clone(),
            port: data.port,
            username: data.username.clone(),
            auth,
        },
        created,
    ))
}

fn apply(args: &Request, path: &Path) -> Result<Value, String> {
    let id = args.connection_id.as_deref().ok_or("缺少运维主机标识。")?;
    validate_connection_id(id)?;
    let expected = args.expected.as_deref().ok_or("缺少运维主机版本。")?;
    validate_expected(expected)?;
    let _guard = commands::CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "终端连接配置正在保存，请重试。")?;
    let mut connections = commands::load_saved_connections_at(path)?;
    let index = connections
        .iter()
        .position(|connection| connection.id == id);
    let old = index.map(|index| connections[index].clone());
    if old
        .as_ref()
        .is_some_and(|connection| matches!(&connection.protocol, Protocol::Local))
    {
        return Err("该标识属于本地终端，不能应用云配置。".into());
    }
    let current_fingerprint = old
        .as_ref()
        .map(|connection| connection_fingerprint(connection, args.include_credentials))
        .transpose()?
        .unwrap_or_else(empty_fingerprint);
    if current_fingerprint != expected {
        return Err("运维主机已变化，请重新同步。".into());
    }

    let Some(data) = args.data.as_ref() else {
        if let Some(index) = index {
            let removed = connections.remove(index);
            commands::write_saved_connections_at(path, &connections)?;
            delete_connection_credentials(&removed);
        }
        return Ok(json!({"applied": true, "fingerprint": empty_fingerprint()}));
    };

    let (connection, created) = build_connection(id, data, old.as_ref())?;
    if let Some(index) = index {
        connections[index] = connection.clone();
    } else {
        connections.push(connection.clone());
    }
    if let Err(error) = commands::write_saved_connections_at(path, &connections) {
        delete_names(&created);
        return Err(error);
    }
    cleanup_replaced_credentials(old.as_ref(), &connection);
    Ok(json!({
        "applied": true,
        "fingerprint": connection_fingerprint(&connection, args.include_credentials)?,
    }))
}

fn portable_data(connection: &ConnectionConfig, include_credentials: bool) -> Result<Value, ()> {
    let credentials = if include_credentials {
        read_credentials(connection)?
    } else {
        None
    };
    Ok(json!({
        "name": connection.name,
        "protocol": protocol_name(&connection.protocol),
        "host": connection.host,
        "port": connection.port,
        "username": connection.username,
        "auth_type": auth_type(&connection.auth),
        "credentials": credentials,
    }))
}

fn index(path: &Path, include_credentials: bool) -> Result<Value, String> {
    let _guard = commands::CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "终端连接配置正在保存，请重试。")?;
    let connections = commands::load_saved_connections_at(path)?;
    let mut items = Vec::new();
    for connection in connections {
        if matches!(&connection.protocol, Protocol::Local) {
            continue;
        }
        items.push(json!({
            "id": connection.id,
            "fingerprint": connection_fingerprint(&connection, include_credentials)?,
        }));
    }
    items.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    Ok(json!({"vault": storage_token(path)?, "items": items}))
}

fn read(args: &Request, path: &Path) -> Result<Value, String> {
    let id = args.connection_id.as_deref().ok_or("缺少运维主机标识。")?;
    validate_connection_id(id)?;
    let expected = args.expected.as_deref().ok_or("缺少运维主机版本。")?;
    validate_expected(expected)?;
    let _guard = commands::CONNECTIONS_LOCK
        .lock()
        .map_err(|_| "终端连接配置正在保存，请重试。")?;
    let connections = commands::load_saved_connections_at(path)?;
    let connection = connections
        .iter()
        .find(|connection| connection.id == id)
        .filter(|connection| !matches!(&connection.protocol, Protocol::Local))
        .ok_or_else(|| "运维主机不存在或已变化。".to_string())?;
    if connection_fingerprint(connection, args.include_credentials)? != expected {
        return Err("运维主机已变化，请重新同步。".into());
    }
    let data = match portable_data(connection, args.include_credentials) {
        Ok(data) => data,
        Err(()) => return Ok(json!({"error": {"code": "operations_credentials_invalid"}})),
    };
    let fingerprint = connection_fingerprint(connection, args.include_credentials)?;
    if fingerprint != expected {
        return Err("运维主机已变化，请重新同步。".into());
    }
    Ok(json!({"data": data, "fingerprint": fingerprint}))
}

pub(crate) fn request(args: &Value) -> Result<Value, String> {
    let path = commands::connections_path()?;
    request_at(args, &path)
}

fn request_at(args: &Value, path: &Path) -> Result<Value, String> {
    let args: Request =
        serde_json::from_value(args.clone()).map_err(|_| "运维主机同步请求无效。")?;
    match args.action.as_str() {
        "index" => index(path, args.include_credentials),
        "read" => read(&args, path),
        "apply" => apply(&args, path),
        _ => Err("不支持的运维主机同步操作。".into()),
    }
}

fn same_target_and_auth(existing: &ConnectionConfig, next: &ConnectionConfig) -> bool {
    existing.protocol == next.protocol
        && existing.host == next.host
        && existing.port == next.port
        && existing.username == next.username
        && auth_type(&existing.auth) == auth_type(&next.auth)
}

fn restore_input_passphrase(
    connection: &ConnectionConfig,
    existing: Option<&ConnectionConfig>,
    same_target: bool,
) -> Result<Option<String>, String> {
    let AuthConfig::KeyFile { passphrase, .. } = &connection.auth else {
        return Ok(None);
    };
    let Some(value) = passphrase.as_deref() else {
        return Ok(None);
    };
    if let Some(name) =
        credential_store::ops_secret_name_from_marker(value, OpsSecretField::Passphrase)
    {
        if !same_target
            || !existing.is_some_and(|old| {
                matches!(&old.auth, AuthConfig::KeyFile { passphrase: Some(old), .. } if old == value)
            })
        {
            return Err("凭据标记与当前连接不匹配。".into());
        }
        return credential_store::load_secret(name)
            .map_err(|_| "保存的口令不可用。".to_string())?
            .map(Some)
            .ok_or_else(|| "保存的口令不可用。".into());
    }
    if value.starts_with("__mona_ops_") {
        return Err("凭据标记无效。".into());
    }
    if value == "__encrypted__" || value == "__keyring__" {
        if !same_target {
            return Err("目标已变化，请重新输入认证凭据。".into());
        }
        if value == "__keyring__" {
            return Err("保存的口令不可用。".into());
        }
        return credential_store::load_legacy_credential(
            &connection.host,
            connection.port,
            &connection.username,
            "passphrase",
        )
        .map_err(|_| "保存的口令不可用。".into());
    }
    Ok(Some(value.to_string()))
}

fn keep_existing_key_marker(
    connection: &ConnectionConfig,
    existing: &ConnectionConfig,
    marker: &str,
    same_target: bool,
    created: &mut Vec<String>,
) -> Result<AuthConfig, String> {
    let old_key = match &existing.auth {
        AuthConfig::KeyFile { key_path, .. } => key_path,
        _ => return Err("凭据标记与当前连接不匹配。".into()),
    };
    if !same_target || old_key != marker {
        return Err("凭据标记与当前连接不匹配。".into());
    }
    let passphrase = restore_input_passphrase(connection, Some(existing), same_target)?;
    let old_passphrase = match &existing.auth {
        AuthConfig::KeyFile { passphrase, .. } => passphrase.as_deref(),
        _ => None,
    };
    let incoming_passphrase = match &connection.auth {
        AuthConfig::KeyFile { passphrase, .. } => passphrase.as_deref(),
        _ => None,
    };
    let passphrase_marker = if incoming_passphrase == old_passphrase {
        old_passphrase.map(str::to_string)
    } else if let Some(value) = passphrase.as_deref() {
        let key = credential_store::load_ops_private_key(marker)
            .map_err(|_| "保存的私钥不可用。".to_string())?
            .ok_or_else(|| "保存的私钥不可用。".to_string())?;
        russh::keys::decode_secret_key(&key, Some(value))
            .map_err(|_| "私钥无法解码或口令不正确。".to_string())?;
        Some(save_ops_secret(OpsSecretField::Passphrase, value, created)?)
    } else {
        None
    };
    Ok(AuthConfig::KeyFile {
        key_path: marker.to_string(),
        passphrase: passphrase_marker,
    })
}

fn store_ui_passphrase(
    connection: &ConnectionConfig,
    existing: Option<&ConnectionConfig>,
    same_target: bool,
    created: &mut Vec<String>,
) -> Result<Option<String>, String> {
    let AuthConfig::KeyFile { passphrase, .. } = &connection.auth else {
        return Ok(None);
    };
    let Some(value) = passphrase.as_deref() else {
        return Ok(None);
    };
    if credential_store::ops_secret_name_from_marker(value, OpsSecretField::Passphrase).is_some() {
        if same_target
            && existing.is_some_and(|old| {
                matches!(&old.auth, AuthConfig::KeyFile { passphrase: Some(old), .. } if old == value)
            })
        {
            return Ok(Some(value.into()));
        }
        if existing.is_some() && !same_target {
            return Ok(None);
        }
        return Err("新连接不能复用其他连接的凭据标记。".into());
    }
    if value.starts_with("__mona_ops_") {
        return Err("凭据标记无效。".into());
    }
    if value == "__encrypted__" || value == "__keyring__" {
        if same_target
            && existing.is_some_and(|old| {
                matches!(&old.auth, AuthConfig::KeyFile { passphrase: Some(old), .. } if old == value)
            })
        {
            return Ok(Some(value.into()));
        }
        if existing.is_some() && !same_target {
            return Ok(None);
        }
        return Err("新连接不能复用其他连接的凭据标记。".into());
    }
    if value.len() > 16 * 1024 {
        return Err("运维主机口令过长。".into());
    }
    if value.is_empty() {
        return Ok(None);
    }
    save_ops_secret(OpsSecretField::Passphrase, value, created).map(Some)
}

pub(crate) fn store_upsert_credentials(
    connection: ConnectionConfig,
    existing: Option<&ConnectionConfig>,
) -> Result<ConnectionConfig, String> {
    validate_connection_id(&connection.id)?;
    if connection.name.len() > 240
        || connection.host.len() > 1024
        || connection.username.len() > 1024
        || (&connection.protocol != &Protocol::Local && connection.port == 0)
    {
        return Err("终端连接配置无效。".into());
    }
    let same_target = existing.is_some_and(|old| same_target_and_auth(old, &connection));
    let mut created = Vec::new();
    let auth_result: Result<AuthConfig, String> = (|| match &connection.auth {
        AuthConfig::Password { password } => {
            if let Some(name) =
                credential_store::ops_secret_name_from_marker(password, OpsSecretField::Password)
            {
                if same_target && existing.is_some_and(|old| old.auth == connection.auth) {
                    return Ok(connection.auth.clone());
                }
                if existing.is_some() && !same_target {
                    return Ok(empty_auth(AuthType::Password));
                }
                if name.is_empty() {
                    return Err("凭据标记无效。".into());
                }
                Err("新连接不能复用其他连接的凭据标记。".into())
            } else if password.starts_with("__mona_ops_") {
                Err("凭据标记无效。".into())
            } else if password == "__encrypted__" || password == "__keyring__" {
                if same_target && existing.is_some_and(|old| old.auth == connection.auth) {
                    Ok(connection.auth.clone())
                } else if existing.is_some() && !same_target {
                    Ok(empty_auth(AuthType::Password))
                } else {
                    Err("新连接不能复用其他连接的凭据标记。".into())
                }
            } else if password.is_empty() && !matches!(&connection.protocol, Protocol::Vnc) {
                Ok(empty_auth(AuthType::Password))
            } else if password.len() > 16 * 1024 {
                Err("运维主机密码过长。".into())
            } else {
                save_ops_secret(OpsSecretField::Password, password, &mut created)
                    .map(|marker| AuthConfig::Password { password: marker })
            }
        }
        AuthConfig::KeyFile {
            key_path,
            passphrase: _,
        } => {
            if credential_store::ops_secret_name_from_marker(key_path, OpsSecretField::PrivateKey)
                .is_some()
            {
                if existing.is_some_and(|old| same_target && old.auth == connection.auth) {
                    return Ok(connection.auth.clone());
                }
                if existing.is_some() && !same_target {
                    return Ok(empty_auth(AuthType::Key));
                }
                let old =
                    existing.ok_or_else(|| "新连接不能复用其他连接的凭据标记。".to_string())?;
                keep_existing_key_marker(&connection, old, key_path, same_target, &mut created)
            } else if key_path.starts_with("__mona_ops_") {
                Err("凭据标记无效。".into())
            } else if key_path.is_empty() {
                Ok(empty_auth(AuthType::Key))
            } else {
                let passphrase_marker =
                    store_ui_passphrase(&connection, existing, same_target, &mut created)?;
                Ok(AuthConfig::KeyFile {
                    key_path: key_path.clone(),
                    passphrase: passphrase_marker,
                })
            }
        }
        AuthConfig::Agent => Ok(AuthConfig::Agent),
    })();
    let auth = match auth_result {
        Ok(auth) => auth,
        Err(error) => {
            delete_names(&created);
            return Err(error);
        }
    };
    Ok(ConnectionConfig { auth, ..connection })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn ssh_data(name: &str, host: &str) -> Value {
        json!({
            "name": name,
            "protocol": "ssh",
            "host": host,
            "port": 22,
            "username": "test-user",
            "auth_type": "password",
            "credentials": null,
        })
    }

    #[test]
    fn apply_uses_compare_and_swap_and_persists_to_the_config_file() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("terminal-connections.json");
        let id = format!("test-{}", uuid::Uuid::new_v4());
        let initial = request_at(
            &json!({"action":"index","include_credentials":false}),
            &path,
        )
        .unwrap();
        assert_eq!(initial["items"].as_array().unwrap().len(), 0);

        let applied = request_at(
            &json!({"action":"apply","include_credentials":false,
                "connection_id":id,"expected":empty_fingerprint(),"data":ssh_data("test", "host-a")}),
            &path,
        )
        .unwrap();
        assert_eq!(applied["applied"], true);
        let saved = fs::read_to_string(&path).unwrap();
        assert!(saved.contains(&id));
        assert!(!saved.contains("synthetic-password"));

        let index = request_at(
            &json!({"action":"index","include_credentials":false}),
            &path,
        )
        .unwrap();
        let current = index["items"][0]["fingerprint"].as_str().unwrap();
        assert!(request_at(
            &json!({"action":"apply","include_credentials":false,
                "connection_id":id,"expected":empty_fingerprint(),"data":ssh_data("changed", "host-a")}),
            &path,
        )
        .is_err());
        let updated = request_at(
            &json!({"action":"apply","include_credentials":false,
                "connection_id":id,"expected":current,"data":ssh_data("changed", "host-a")}),
            &path,
        )
        .unwrap();
        assert_eq!(updated["applied"], true);
    }

    #[test]
    fn null_credentials_preserve_only_the_same_target_and_authentication() {
        let (marker, _) =
            credential_store::new_ops_secret_marker(OpsSecretField::Password).unwrap();
        let old = ConnectionConfig {
            id: format!("test-{}", uuid::Uuid::new_v4()),
            name: "saved".into(),
            protocol: Protocol::Ssh,
            host: "host-a".into(),
            port: 22,
            username: "test-user".into(),
            auth: AuthConfig::Password {
                password: marker.clone(),
            },
        };
        let same = ConnectionData {
            name: "renamed".into(),
            protocol: Protocol::Ssh,
            host: "host-a".into(),
            port: 22,
            username: "test-user".into(),
            auth_type: AuthType::Password,
            credentials: None,
        };
        let (preserved, _) = build_connection(&old.id, &same, Some(&old)).unwrap();
        assert_eq!(preserved.auth, old.auth);

        let changed_target = ConnectionData {
            host: "host-b".into(),
            ..same
        };
        let (cleared, _) = build_connection(&old.id, &changed_target, Some(&old)).unwrap();
        assert_eq!(cleared.auth, empty_auth(AuthType::Password));
    }

    #[test]
    fn private_key_import_rejects_non_files_and_non_key_content() {
        let temp = tempdir().unwrap();
        assert!(read_private_key_file(temp.path().to_str().unwrap(), None).is_err());
        let file = temp.path().join("synthetic-key");
        fs::write(&file, format!("not-a-private-key-{}", uuid::Uuid::new_v4())).unwrap();
        assert!(read_private_key_file(file.to_str().unwrap(), None).is_err());
    }

    #[test]
    fn private_key_import_accepts_a_dynamically_generated_key_file() {
        let temp = tempdir().unwrap();
        let mut rng = russh::keys::key::safe_rng();
        let private_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::Algorithm::Ed25519)
                .unwrap()
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .unwrap()
                .to_string();
        let path = temp.path().join("generated-key");
        fs::write(&path, &private_key).unwrap();
        assert_eq!(
            read_private_key_file(path.to_str().unwrap(), None).unwrap(),
            private_key
        );
    }
}
