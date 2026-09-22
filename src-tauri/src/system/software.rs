// 软件管理：注册表读取已安装列表、winget 检测和执行，以及可确认的残留候选扫描。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use super::{win11debloat, SystemState};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ===== 数据结构（与前端 mockData.ts SoftwareUpdate 对齐） =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WingetStatus {
    pub available: bool,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSoftware {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub install_date: Option<String>,
    pub software_type: String,
    pub estimated_size_bytes: Option<u64>,
    pub install_location: String,
    pub uninstall_kind: String,
    pub can_uninstall: bool,
    #[serde(skip)]
    uninstall_command: String,
    #[serde(skip)]
    quiet_uninstall_command: String,
    #[serde(skip)]
    uninstall_registry_hive: String,
    #[serde(skip)]
    uninstall_registry_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareUpdate {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub current_version: String,
    pub next_version: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreApp {
    pub id: String,
    pub name: String,
    pub version: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareCheckResult {
    pub updates: Vec<SoftwareUpdate>,
    pub installed: Vec<InstalledSoftware>,
    pub installed_count: usize,
    pub known_size_bytes: u64,
    pub known_size_count: usize,
    pub failed_count: usize,
    pub failures: Vec<SoftwareFailure>,
    pub winget_available: bool,
    pub winget_version: String,
    pub last_check: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeProgress {
    pub id: String,
    pub line: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub id: String,
    pub name: String,
    pub line: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeResult {
    pub success: bool,
    pub message: String,
    pub exit_code: Option<i32>,
    pub residuals: Vec<ResidualCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareFailure {
    pub package_id: String,
    pub name: String,
    pub action: String,
    pub ts: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidualCandidate {
    pub id: String,
    pub path: String,
    pub size_bytes: u64,
    pub category: String,
    pub requires_confirmation: bool,
    pub kind: String,
    pub confidence: String,
    pub recommended: bool,
    pub can_delete: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsAppEntry {
    pub id: String,
    pub app_ids: Vec<String>,
    pub name: String,
    pub description: String,
    pub recommendation: String,
    pub removal_method: String,
    pub installed: bool,
    pub selected_by_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsAppCatalogResult {
    pub items: Vec<WindowsAppEntry>,
    pub total: usize,
    pub installed_count: usize,
    pub source_version: String,
}

fn now_ts() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn init_software_tables(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS software_operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            package_id TEXT NOT NULL,
            name TEXT NOT NULL,
            action TEXT NOT NULL,
            success INTEGER NOT NULL,
            exit_code INTEGER,
            message TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_software_operations_latest
            ON software_operations(package_id, action, id);",
    )
}

#[allow(clippy::too_many_arguments)]
fn record_software_operation(
    conn: &rusqlite::Connection,
    ts: i64,
    package_id: &str,
    name: &str,
    action: &str,
    success: bool,
    exit_code: Option<i32>,
    message: &str,
) -> rusqlite::Result<()> {
    init_software_tables(conn)?;
    conn.execute(
        "INSERT INTO software_operations
            (ts, package_id, name, action, success, exit_code, message)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            ts,
            package_id,
            name,
            action,
            success as i32,
            exit_code,
            message
        ],
    )?;
    Ok(())
}

fn unresolved_failure_count(conn: &rusqlite::Connection) -> rusqlite::Result<usize> {
    init_software_tables(conn)?;
    let count: i64 = conn.query_row(
        "SELECT COUNT(*)
         FROM software_operations current
         JOIN (
             SELECT package_id, action, MAX(id) AS latest_id
             FROM software_operations
             GROUP BY package_id, action
         ) latest ON latest.latest_id = current.id
         WHERE current.success = 0",
        [],
        |row| row.get(0),
    )?;
    Ok(count as usize)
}

fn unresolved_failures(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<SoftwareFailure>> {
    init_software_tables(conn)?;
    let mut statement = conn.prepare(
        "SELECT current.package_id, current.name, current.action, current.ts, current.message
         FROM software_operations current
         JOIN (
             SELECT package_id, action, MAX(id) AS latest_id
             FROM software_operations
             GROUP BY package_id, action
         ) latest ON latest.latest_id = current.id
         WHERE current.success = 0
         ORDER BY current.ts DESC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(SoftwareFailure {
                package_id: row.get(0)?,
                name: row.get(1)?,
                action: row.get(2)?,
                ts: row.get(3)?,
                message: row.get(4)?,
            })
        })?
        .collect();
    rows
}

fn is_safe_name_component(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        && Path::new(name).components().count() == 1
}

fn residual_protected_roots() -> Vec<PathBuf> {
    [
        "LOCALAPPDATA",
        "APPDATA",
        "PROGRAMDATA",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "SystemRoot",
    ]
    .into_iter()
    .filter_map(|key| std::env::var_os(key).map(PathBuf::from))
    .filter_map(|path| path.canonicalize().ok())
    .collect()
}

fn authorize_residual_action(
    software_id: &str,
    action: AuthorizedResidualAction,
    size_bytes: u64,
) -> Option<String> {
    let mut authorizations = residual_authorizations().lock().ok()?;
    let now = Instant::now();
    authorizations.retain(|_, authorization| authorization.expires_at > now);
    let id = uuid::Uuid::new_v4().to_string();
    authorizations.insert(
        id.clone(),
        AuthorizedResidual {
            software_id: software_id.to_string(),
            action,
            size_bytes,
            expires_at: now + RESIDUAL_AUTHORIZATION_TTL,
        },
    );
    Some(id)
}


fn authorize_residual(
    software_id: &str,
    path: &Path,
    size_bytes: u64,
    is_directory: bool,
) -> Option<String> {
    authorize_residual_action(
        software_id,
        AuthorizedResidualAction::FileSystem {
            path: path.to_path_buf(),
            is_directory,
        },
        size_bytes,
    )
}

fn residual_aliases(name: &str, install_path: Option<&Path>) -> (Vec<String>, Option<String>) {
    let mut product_aliases = Vec::new();
    if is_safe_name_component(name) {
        product_aliases.push(name.trim().to_string());
    }
    if let Some(alias) = install_path
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .filter(|name| is_safe_name_component(name))
    {
        if !product_aliases.iter().any(|existing| existing.eq_ignore_ascii_case(alias)) {
            product_aliases.push(alias.to_string());
        }
    }
    let vendor_alias = install_path
        .and_then(|path| path.parent())
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .filter(|name| is_safe_name_component(name))
        .map(str::to_string);
    (product_aliases, vendor_alias)
}

fn scan_residual_candidates(
    software_id: &str,
    name: &str,
    publisher: &str,
    install_location: Option<String>,
    uninstall_registry_key: Option<String>,
) -> Vec<ResidualCandidate> {
    let input = super::software_residuals::ResidualScanInput {
        name: name.to_string(),
        publisher: publisher.to_string(),
        install_location: install_location
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from),
        uninstall_registry_key,
    };
    super::software_residuals::scan_residuals(&input)
        .into_iter()
        .filter_map(|discovery| {
            let is_directory = discovery.kind == super::software_residuals::ResidualKind::Directory;
            let size_bytes = if is_directory {
                super::dir_size(&discovery.target).0
            } else {
                std::fs::metadata(&discovery.target).map(|metadata| metadata.len()).unwrap_or(0)
            };
            let can_delete = discovery.category != "用户资料";
            let id = if can_delete {
                authorize_residual(software_id, &discovery.target, size_bytes, is_directory)?
            } else {
                uuid::Uuid::new_v4().to_string()
            };
            Some(ResidualCandidate {
                id,
                path: discovery.target.to_string_lossy().to_string(),
                size_bytes,
                category: discovery.category,
                requires_confirmation: true,
                kind: discovery.kind.as_str().to_string(),
                confidence: discovery.confidence.as_str().to_string(),
                recommended: discovery.recommended,
                can_delete,
                reason: discovery.reason,
            })
        })
        .collect()
}

fn append_system_residuals(
    software_id: &str,
    candidates: &mut Vec<ResidualCandidate>,
    residuals: Vec<super::software_system_residuals::SystemResidual>,
) {
    use super::software_system_residuals::SystemResidualAction;
    for residual in residuals {
        let action = residual.action.map(|action| match action {
            SystemResidualAction::Registry { hive, path } => {
                AuthorizedResidualAction::Registry { hive, path }
            }
        });
        let id = action
            .and_then(|action| authorize_residual_action(software_id, action, 0))
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        candidates.push(ResidualCandidate {
            id,
            path: residual.target,
            size_bytes: 0,
            category: residual.category,
            requires_confirmation: true,
            kind: residual.kind,
            confidence: residual.confidence,
            recommended: residual.recommended,
            can_delete: residual.can_delete,
            reason: residual.reason,
        });
    }
}

fn take_residual_authorization(id: &str) -> Result<AuthorizedResidual, String> {
    let mut authorizations = residual_authorizations()
        .lock()
        .map_err(|_| "残留授权状态不可用".to_string())?;
    let now = Instant::now();
    authorizations.retain(|_, authorization| authorization.expires_at > now);
    authorizations
        .remove(id)
        .ok_or_else(|| "残留项已过期，请重新执行卸载检测".to_string())
}

fn restore_residual_authorization(id: String, authorization: AuthorizedResidual) {
    if authorization.expires_at <= Instant::now() {
        return;
    }
    if let Ok(mut authorizations) = residual_authorizations().lock() {
        authorizations.insert(id, authorization);
    }
}

fn validate_authorized_filesystem(
    path: &Path,
    is_directory: bool,
) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("无法读取残留项：{error}"))?;
    if metadata.file_type().is_symlink()
        || (is_directory && !metadata.is_dir())
        || (!is_directory && !metadata.is_file())
    {
        return Err("残留项类型已改变，请重新检测".to_string());
    }
    let current = path
        .canonicalize()
        .map_err(|error| format!("无法解析残留路径：{error}"))?;
    if current != path {
        return Err("残留路径已改变，请重新检测".to_string());
    }
    if current.parent().is_none()
        || residual_protected_roots().iter().any(|root| root == &current)
    {
        return Err("不允许删除受保护目录".to_string());
    }
    Ok(Some(current))
}

#[cfg(windows)]
fn powershell_residual_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{value}")
    } else if let Some(value) = value.strip_prefix(r"\\?\") {
        value.to_string()
    } else {
        value.into_owned()
    }
}

#[cfg(windows)]
fn run_elevated_powershell(script: &str) -> Result<(), String> {
    use base64::Engine;
    let bytes = script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    super::run_elevated(
        "powershell.exe",
        &format!("-NoProfile -NonInteractive -EncodedCommand {encoded}"),
        120_000,
    )
}

#[cfg(windows)]
fn remove_residual_filesystem(path: &Path, is_directory: bool) -> Result<(), String> {
    let direct = if is_directory {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    if direct.is_ok() {
        return Ok(());
    }
    let safe_path = powershell_residual_path(path).replace('\'', "''");
    let recurse = if is_directory { " -Recurse" } else { "" };
    run_elevated_powershell(&format!(
        "Remove-Item -LiteralPath '{safe_path}'{recurse} -Force -ErrorAction Stop; if (Test-Path -LiteralPath '{safe_path}') {{ throw '删除后目标仍然存在' }}"
    ))
}

#[cfg(not(windows))]
fn remove_residual_filesystem(path: &Path, is_directory: bool) -> Result<(), String> {
    let result = if is_directory {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|error| format!("删除残留项失败：{error}"))
}

#[cfg(windows)]
fn delete_system_residual(action: &AuthorizedResidualAction) -> Result<(), String> {
    let script = match action {
        AuthorizedResidualAction::Registry { hive, path } => {
            let target = format!("Registry::{hive}\\{path}").replace('\'', "''");
            format!(
                "Remove-Item -LiteralPath '{target}' -Recurse -Force -ErrorAction Stop; if (Test-Path -LiteralPath '{target}') {{ throw '注册表项仍然存在' }}"
            )
        }
        AuthorizedResidualAction::FileSystem { .. } => {
            return Err("残留类型不匹配".to_string());
        }
    };
    run_elevated_powershell(&script)
}

#[cfg(not(windows))]
fn delete_system_residual(_action: &AuthorizedResidualAction) -> Result<(), String> {
    Err("当前系统不支持清理系统残留".to_string())
}

fn delete_authorized_residual(authorization: &AuthorizedResidual) -> Result<u64, String> {
    match &authorization.action {
        AuthorizedResidualAction::FileSystem { path, is_directory } => {
            let Some(path) = validate_authorized_filesystem(path, *is_directory)? else {
                return Ok(0);
            };
            let current_size = if *is_directory {
                super::dir_size(&path).0
            } else {
                std::fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0)
            }
            .max(authorization.size_bytes);
            remove_residual_filesystem(&path, *is_directory)?;
            if path.exists() {
                return Err("删除后目标仍然存在".to_string());
            }
            Ok(current_size)
        }
        action => {
            delete_system_residual(action)?;
            Ok(0)
        }
    }
}

fn delete_authorized_residuals(ids: Vec<String>) -> ResidualDeleteResult {
    let mut deleted_ids = Vec::new();
    let mut freed_bytes = 0u64;
    let mut failures = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let installed_ids = read_installed_software()
        .into_iter()
        .map(|software| software.id)
        .collect::<std::collections::HashSet<_>>();
    for id in ids {
        if !seen.insert(id.clone()) {
            continue;
        }
        let authorization = match take_residual_authorization(&id) {
            Ok(authorization) => authorization,
            Err(message) => {
                failures.push(ResidualDeleteFailure { id, message });
                continue;
            }
        };
        if installed_ids.contains(&authorization.software_id) {
            restore_residual_authorization(id.clone(), authorization);
            failures.push(ResidualDeleteFailure {
                id,
                message: "软件已重新安装，请重新执行残留检测".to_string(),
            });
            continue;
        }
        match delete_authorized_residual(&authorization) {
            Ok(size_bytes) => {
                freed_bytes = freed_bytes.saturating_add(size_bytes);
                deleted_ids.push(id);
            }
            Err(message) => {
                restore_residual_authorization(id.clone(), authorization);
                failures.push(ResidualDeleteFailure { id, message });
            }
        }
    }
    ResidualDeleteResult {
        deleted_ids,
        freed_bytes,
        failures,
    }
}

fn command_message(stdout: &[u8], stderr: &[u8]) -> String {
    let stderr = strip_ansi(&super::decode_windows_output(stderr));
    let stdout = strip_ansi(&super::decode_windows_output(stdout));
    let text = if stderr.trim().is_empty() { &stdout } else { &stderr };
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    let mut chars: Vec<char> = text.chars().rev().take(1000).collect();
    chars.reverse();
    chars.into_iter().collect()
}

fn persist_operation(
    state: &SystemState,
    package_id: &str,
    name: &str,
    action: &str,
    success: bool,
    exit_code: Option<i32>,
    message: &str,
) {
    let Ok(inner) = state.0.lock() else {
        log::error!("software operation history: state lock failed");
        return;
    };
    if let Err(error) = record_software_operation(
        &inner.db,
        now_ts(),
        package_id,
        name,
        action,
        success,
        exit_code,
        message,
    ) {
        log::warn!("software operation history: {error}");
    }
}

// ===== ANSI 转义码剥离 =====

fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&nc) = chars.peek() {
                    chars.next();
                    if nc.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else {
            result.push(c);
        }
    }
    result
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidualDeleteFailure {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidualDeleteResult {
    pub deleted_ids: Vec<String>,
    pub freed_bytes: u64,
    pub failures: Vec<ResidualDeleteFailure>,
}

#[derive(Debug, Clone)]
struct AuthorizedResidual {
    software_id: String,
    action: AuthorizedResidualAction,
    size_bytes: u64,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
enum AuthorizedResidualAction {
    FileSystem { path: PathBuf, is_directory: bool },
    Registry { hive: String, path: String },
}

const RESIDUAL_AUTHORIZATION_TTL: Duration = Duration::from_secs(30 * 60);
static RESIDUAL_AUTHORIZATIONS: OnceLock<Mutex<HashMap<String, AuthorizedResidual>>> = OnceLock::new();

fn residual_authorizations() -> &'static Mutex<HashMap<String, AuthorizedResidual>> {
    RESIDUAL_AUTHORIZATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn classify_uninstall_kind(
    windows_installer: bool,
    uninstall_command: &str,
    quiet_uninstall_command: &str,
) -> &'static str {
    if windows_installer
        || uninstall_command.to_ascii_lowercase().contains("msiexec")
        || quiet_uninstall_command.to_ascii_lowercase().contains("msiexec")
    {
        "msi"
    } else if !quiet_uninstall_command.trim().is_empty() || !uninstall_command.trim().is_empty() {
        "desktop"
    } else {
        "unavailable"
    }
}

fn registry_uninstall_commands(quiet: &str, normal: &str) -> Vec<String> {
    let mut commands = Vec::new();
    if !quiet.trim().is_empty() {
        commands.push(quiet.to_string());
    }
    if !normal.trim().is_empty() && !commands.iter().any(|command| command == normal) {
        commands.push(normal.to_string());
    }
    commands
}

// ===== 注册表读取已安装软件 =====

#[cfg(windows)]
fn read_uninstall_from_root(
    root: &windows_registry::Key,
    path: &str,
    stype: &str,
    seen: &mut std::collections::HashSet<String>,
) -> Vec<InstalledSoftware> {
    let mut entries = Vec::new();
    let parent = match root.open(path) {
        Ok(k) => k,
        Err(_) => return entries,
    };
    let iter = match parent.keys() {
        Ok(it) => it,
        Err(_) => return entries,
    };
    for subkey_name in iter {
        let subkey = match parent.open(&subkey_name) {
            Ok(k) => k,
            Err(_) => continue,
        };
        let system_component = subkey.get_u32("SystemComponent").unwrap_or(0);
        if system_component == 1 {
            continue;
        }
        let name = subkey.get_string("DisplayName").unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        // 跳过 Windows 更新补丁
        if name.starts_with("KB") || name.contains("Update for") {
            continue;
        }
        let publisher = subkey.get_string("Publisher").unwrap_or_default();
        let version = subkey.get_string("DisplayVersion").unwrap_or_default();
        let install_date = subkey.get_string("InstallDate").ok();
        let estimated_size_bytes = subkey
            .get_u32("EstimatedSize")
            .ok()
            .map(|size_kib| u64::from(size_kib) * 1024);
        let install_location = subkey.get_string("InstallLocation").unwrap_or_default();
        let identity_key = format!("{name}|{publisher}|{version}|{install_location}").to_lowercase();
        if !seen.insert(identity_key) {
            continue;
        }
        let uninstall_command = subkey.get_string("UninstallString").unwrap_or_default();
        let quiet_uninstall_command = subkey.get_string("QuietUninstallString").unwrap_or_default();
        let windows_installer = subkey.get_u32("WindowsInstaller").unwrap_or(0) == 1;
        let uninstall_kind = classify_uninstall_kind(
            windows_installer,
            &uninstall_command,
            &quiet_uninstall_command,
        )
        .to_string();
        let can_uninstall = uninstall_kind != "unavailable";
        let uninstall_registry_hive = if stype == "user" { "HKCU" } else { "HKLM" }.to_string();
        let uninstall_registry_path = format!("{path}\\{subkey_name}");
        entries.push(InstalledSoftware {
            id: format!("registry:{uninstall_registry_hive}:{uninstall_registry_path}"),
            name,
            publisher,
            version,
            install_date,
            software_type: stype.to_string(),
            estimated_size_bytes,
            install_location,
            uninstall_kind,
            can_uninstall,
            uninstall_command,
            quiet_uninstall_command,
            uninstall_registry_hive,
            uninstall_registry_path,
        });
    }
    entries
}

#[cfg(windows)]
fn read_installed_software() -> Vec<InstalledSoftware> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};
    let mut all = Vec::new();
    let mut seen = std::collections::HashSet::new();
    all.extend(read_uninstall_from_root(
        LOCAL_MACHINE,
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "system",
        &mut seen,
    ));
    all.extend(read_uninstall_from_root(
        LOCAL_MACHINE,
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "system",
        &mut seen,
    ));
    all.extend(read_uninstall_from_root(
        CURRENT_USER,
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "user",
        &mut seen,
    ));
    all
}

#[cfg(not(windows))]
fn read_installed_software() -> Vec<InstalledSoftware> {
    Vec::new()
}

// ===== 进程运行状态检测 =====

#[cfg(windows)]
fn check_running_processes(names: &[String]) -> std::collections::HashSet<String> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        false,
        ProcessRefreshKind::nothing(),
    );
    let mut running = std::collections::HashSet::new();
    for name in names {
        let name_lower = name.to_lowercase();
        let words: Vec<&str> = name_lower
            .split_whitespace()
            .filter(|w| w.len() >= 3)
            .collect();
        for (_, proc) in sys.processes() {
            let p_name = proc.name().to_string_lossy().to_lowercase();
            let p_stem = p_name.trim_end_matches(".exe");
            if p_stem.is_empty() || p_stem.len() < 3 {
                continue;
            }
            // 进程名等于软件名中的某个显著词（如 "chrome" in "Google Chrome"）
            if words.iter().any(|word| *word == p_stem) {
                running.insert(name.clone());
                break;
            }
            // 归一化后完全匹配（去空格）
            if name_lower.replace(' ', "") == p_stem.replace(' ', "") {
                running.insert(name.clone());
                break;
            }
        }
    }
    running
}

#[cfg(not(windows))]
fn check_running_processes(_names: &[String]) -> std::collections::HashSet<String> {
    std::collections::HashSet::new()
}

// ===== winget 输出解析 =====

struct RawWingetEntry {
    name: String,
    id: String,
    current_version: String,
    next_version: String,
}

/// 解析 `winget list --upgrade-available` 的文本表格输出
fn parse_winget_upgrade_list(output: &str) -> Vec<RawWingetEntry> {
    let lines: Vec<String> = output.lines().map(|l| strip_ansi(l)).collect();
    let separator_idx = match lines.iter().position(|line| {
        let trimmed = line.trim();
        trimmed.len() >= 3 && trimmed.chars().all(|c| c == '-')
    }) {
        Some(idx) => idx,
        None => return vec![],
    };

    lines
        .iter()
        .skip(separator_idx + 1)
        .filter_map(|line| {
            let mut fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 5 {
                return None;
            }
            let source = fields.pop()?;
            if source != "winget" && source != "msstore" {
                return None;
            }
            let next_version = fields.pop()?.to_string();
            let current_version = fields.pop()?.to_string();
            let id = fields.pop()?.to_string();
            let name = fields.join(" ");
            if name.is_empty() {
                return None;
            }
            Some(RawWingetEntry {
                name,
                id,
                current_version,
                next_version,
            })
        })
        .collect()
}

/// 解析应用搜索的文本表格，并把结果转换成商店使用的稳定字段。
fn parse_winget_search_list(output: &str) -> Vec<StoreApp> {
    let lines: Vec<String> = output.lines().map(strip_ansi).collect();
    let separator_idx = match lines.iter().position(|line| {
        let trimmed = line.trim();
        trimmed.len() >= 3 && trimmed.chars().all(|c| c == '-')
    }) {
        Some(idx) => idx,
        None => return vec![],
    };

    let mut seen = std::collections::HashSet::new();
    lines
        .iter()
        .skip(separator_idx + 1)
        .filter_map(|line| {
            let lower_line = line.trim().to_ascii_lowercase();
            if lower_line.starts_with("no package")
                || lower_line.contains("package found")
                || lower_line.contains("packages found")
            {
                return None;
            }
            let mut fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 3 {
                return None;
            }
            // When a source is not explicitly shown, the command's fixed
            // source filter lets us infer the same internal source value.
            if fields
                .last()
                .is_some_and(|value| value.eq_ignore_ascii_case("winget"))
                || fields
                    .last()
                    .is_some_and(|value| value.eq_ignore_ascii_case("msstore"))
            {
                let source = fields.pop()?;
                if !source.eq_ignore_ascii_case("winget") {
                    return None;
                }
            }

            // Search may append a match column such as `Tag: 微信`. Locate
            // the ID/version boundary instead of assuming the final columns.
            let mut id_position = None;
            for index in 1..fields.len().saturating_sub(1) {
                if fields[index].contains('.')
                    && looks_like_store_version(fields[index + 1])
                {
                    id_position = Some(index);
                    break;
                }
            }
            if id_position.is_none() {
                for index in 1..fields.len().saturating_sub(1) {
                    if looks_like_store_id(fields[index])
                        && looks_like_store_version(fields[index + 1])
                    {
                        id_position = Some(index);
                        break;
                    }
                }
            }
            let id_position = id_position?;
            let id = fields[id_position].to_string();
            let version = fields.get(id_position + 1)?.to_string();
            let name = fields[..id_position].join(" ");
            let lower_id = id.to_ascii_lowercase();
            if name.is_empty()
                || lower_id == "package"
                || lower_id == "packages"
                || !seen.insert(lower_id)
            {
                return None;
            }
            Some(StoreApp {
                id,
                name,
                version,
                // This is an internal source identifier used for installation;
                // the UI presents its own human-readable source label.
                source: "winget".to_string(),
            })
        })
        .collect()
}

fn looks_like_store_version(value: &str) -> bool {
    let value = value.trim();
    value.eq_ignore_ascii_case("unknown")
        || value.eq_ignore_ascii_case("latest")
        || value.chars().next().is_some_and(|c| c.is_ascii_digit())
}

fn looks_like_store_id(value: &str) -> bool {
    !value.is_empty()
        && !value.ends_with(':')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
        && value.chars().any(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.')
}

fn build_store_search_args(query: &str) -> Vec<String> {
    let mut args = vec!["search".to_string(), query.to_string()];
    args.extend([
        "--source".to_string(),
        "winget".to_string(),
        "--accept-source-agreements".to_string(),
        "--disable-interactivity".to_string(),
    ]);
    args
}

fn build_store_install_args(id: &str) -> Result<Vec<String>, String> {
    let id = id.trim();
    if id.is_empty() || id.chars().any(char::is_control) {
        return Err("应用标识无效".to_string());
    }
    Ok(vec![
        "install".to_string(),
        "--id".to_string(),
        id.to_string(),
        "--exact".to_string(),
        "--source".to_string(),
        "winget".to_string(),
        "--silent".to_string(),
        "--accept-source-agreements".to_string(),
        "--accept-package-agreements".to_string(),
        "--disable-interactivity".to_string(),
    ])
}

/// 不把内部执行器名称或原始命令输出直接暴露给用户。
fn hide_internal_store_name(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut result = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find("winget") {
        let start = cursor + offset;
        result.push_str(&text[cursor..start]);
        result.push_str("安装服务");
        cursor = start + "winget".len();
    }
    result.push_str(&text[cursor..]);
    result
}

fn store_failure_message() -> String {
    "安装失败，请稍后重试".to_string()
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn system_winget_status() -> Result<WingetStatus, String> {
    #[cfg(windows)]
    {
        let output = tokio::task::spawn_blocking(|| {
            std::process::Command::new("winget")
                .args(["--version"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
        })
        .await
        .map_err(|e| format!("执行失败: {}", e))?;

        match output {
            Ok(out) => {
                let version = super::decode_windows_output(&out.stdout).trim().to_string();
                Ok(WingetStatus {
                    available: !version.is_empty(),
                    version,
                })
            }
            Err(_) => Ok(WingetStatus {
                available: false,
                version: String::new(),
            }),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(WingetStatus {
            available: false,
            version: String::new(),
        })
    }
}

#[tauri::command]
pub async fn system_search_apps(query: String) -> Result<Vec<StoreApp>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if query.chars().any(char::is_control) {
        return Err("搜索内容无效".to_string());
    }

    #[cfg(windows)]
    {
        let output = run_winget(build_store_search_args(&query))
            .await
            .map_err(|_| "搜索应用失败，请稍后重试".to_string())?;
        if !output.status.success() {
            return Err("搜索应用失败，请稍后重试".to_string());
        }
        let stdout = super::decode_windows_output(&output.stdout);
        return Ok(parse_winget_search_list(&stdout));
    }

    #[cfg(not(windows))]
    {
        let _ = query;
        Err("当前系统不支持应用搜索".to_string())
    }
}

#[tauri::command]
pub async fn system_install_app(
    app: AppHandle,
    id: String,
    name: String,
) -> Result<UpgradeResult, String> {
    let package_id = id.trim().to_string();
    let display_name = if name.trim().is_empty() {
        package_id.clone()
    } else {
        name.trim().to_string()
    };
    let args = build_store_install_args(&package_id)?;

    #[cfg(not(windows))]
    {
        let _ = (app, args, display_name);
        return Err("当前系统不支持应用安装".to_string());
    }

    #[cfg(windows)]
    {
        let _ = app.emit(
            "software-install-progress",
            InstallProgress {
                id: package_id.clone(),
                name: display_name.clone(),
                line: "正在准备安装".to_string(),
                status: "running".to_string(),
            },
        );

        let app_for_stream = app.clone();
        let id_for_stream = package_id.clone();
        let name_for_stream = display_name.clone();
        let (status, stderr_text) = match run_winget_streaming(args, move |line: &str| {
            let _ = app_for_stream.emit(
                "software-install-progress",
                InstallProgress {
                    id: id_for_stream.clone(),
                    name: name_for_stream.clone(),
                    line: hide_internal_store_name(line),
                    status: "running".to_string(),
                },
            );
        })
        .await
        {
            Ok(value) => value,
            Err(_) => {
                let message = store_failure_message();
                let _ = app.emit(
                    "software-install-progress",
                    InstallProgress {
                        id: package_id,
                        name: display_name,
                        line: message.clone(),
                        status: "failed".to_string(),
                    },
                );
                return Ok(UpgradeResult {
                    success: false,
                    message,
                    exit_code: None,
                    residuals: vec![],
                });
            }
        };

        let success = status.success();
        let message = if success {
            "安装完成".to_string()
        } else if stderr_text.trim().is_empty() {
            store_failure_message()
        } else {
            // Keep a useful but sanitized detail while hiding implementation names.
            let detail = hide_internal_store_name(&strip_ansi(&stderr_text));
            if detail.trim().is_empty() {
                store_failure_message()
            } else {
                detail
            }
        };
        let _ = app.emit(
            "software-install-progress",
            InstallProgress {
                id: package_id,
                name: display_name,
                line: message.clone(),
                status: if success { "done" } else { "failed" }.to_string(),
            },
        );
        Ok(UpgradeResult {
            success,
            message,
            exit_code: status.code(),
            residuals: vec![],
        })
    }
}

#[tauri::command]
pub async fn system_list_software() -> Result<Vec<InstalledSoftware>, String> {
    let list = tokio::task::spawn_blocking(read_installed_software)
        .await
        .map_err(|e| format!("读取已安装软件失败: {}", e))?;
    Ok(list)
}

#[tauri::command]
pub async fn system_check_updates(
    state: State<'_, SystemState>,
) -> Result<SoftwareCheckResult, String> {
    // 1. 探测 winget
    let winget = system_winget_status().await?;

    // 2. 读取已安装列表（获取 count + publisher 映射）
    let installed = tokio::task::spawn_blocking(read_installed_software)
        .await
        .map_err(|e| format!("读取已安装软件失败: {}", e))?;
    let installed_count = installed.len();
    let known_size_count = installed
        .iter()
        .filter(|software| software.estimated_size_bytes.is_some())
        .count();
    let known_size_bytes = installed
        .iter()
        .filter_map(|software| software.estimated_size_bytes)
        .sum();
    let failures = {
        let inner = state.0.lock().map_err(|e| format!("State lock: {e}"))?;
        unresolved_failures(&inner.db)
            .map_err(|e| format!("读取软件操作记录失败: {e}"))?
    };
    let failed_count = failures.len();

    // 构建 name → publisher 映射（用于补全 winget 输出缺失的 publisher）
    let publisher_map: std::collections::HashMap<String, String> = installed
        .iter()
        .map(|s| (s.name.to_lowercase(), s.publisher.clone()))
        .collect();

    if !winget.available {
        return Ok(SoftwareCheckResult {
            updates: vec![],
            installed,
            installed_count,
            known_size_bytes,
            known_size_count,
            failed_count,
            failures,
            winget_available: false,
            winget_version: String::new(),
            last_check: now_ts(),
        });
    }

    // 3. 执行 winget list --upgrade-available
    #[cfg(windows)]
    {
        let output = tokio::task::spawn_blocking(|| {
            std::process::Command::new("winget")
                .args([
                    "list",
                    "--upgrade-available",
                    "--accept-source-agreements",
                    "--disable-interactivity",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
        })
        .await
        .map_err(|e| format!("执行失败: {}", e))?
        .map_err(|e| format!("winget 执行失败: {}", e))?;

        if !output.status.success() {
            let message = command_message(&output.stdout, &output.stderr);
            return Err(if message.is_empty() {
                "WinGet 检查更新失败".to_string()
            } else {
                message
            });
        }

        let stdout = super::decode_windows_output(&output.stdout);
        let raw_entries = parse_winget_upgrade_list(&stdout);

        // 4. 检测运行中进程
        let names: Vec<String> = raw_entries.iter().map(|e| e.name.clone()).collect();
        let running = tokio::task::spawn_blocking(move || check_running_processes(&names))
            .await
            .map_err(|e| format!("进程检测失败: {}", e))?;

        // 5. 组装结果
        let updates: Vec<SoftwareUpdate> = raw_entries
            .into_iter()
            .map(|e| {
                let status = if running.contains(&e.name) {
                    "运行中".to_string()
                } else {
                    "可更新".to_string()
                };
                let publisher = publisher_map
                    .get(&e.name.to_lowercase())
                    .cloned()
                    .unwrap_or_default();
                SoftwareUpdate {
                    id: e.id,
                    name: e.name,
                    publisher,
                    current_version: e.current_version,
                    next_version: e.next_version,
                    status,
                }
            })
            .collect();

        Ok(SoftwareCheckResult {
            updates,
            installed,
            installed_count,
            known_size_bytes,
            known_size_count,
            failed_count,
            failures,
            winget_available: true,
            winget_version: winget.version,
            last_check: now_ts(),
        })
    }
    #[cfg(not(windows))]
    {
        Ok(SoftwareCheckResult {
            updates: vec![],
            installed,
            installed_count,
            known_size_bytes,
            known_size_count,
            failed_count,
            failures,
            winget_available: false,
            winget_version: String::new(),
            last_check: now_ts(),
        })
    }
}

#[cfg(windows)]
fn installed_appx_names() -> std::collections::HashSet<String> {
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-AppxPackage -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    output.ok().filter(|value| value.status.success()).map(|value| {
        super::decode_windows_output(&value.stdout).lines().map(|line| line.trim().to_ascii_lowercase())
            .filter(|line| !line.is_empty()).collect()
    }).unwrap_or_default()
}

#[cfg(not(windows))]
fn installed_appx_names() -> std::collections::HashSet<String> { std::collections::HashSet::new() }

fn known_desktop_app_installed(name: &str) -> bool {
    let candidates = match name {
        "Microsoft Edge" => vec![std::env::var_os("PROGRAMFILES(X86)").map(PathBuf::from).map(|root| root.join("Microsoft/Edge/Application/msedge.exe"))],
        "OneDrive" => vec![
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from).map(|root| root.join("Microsoft/OneDrive/OneDrive.exe")),
            std::env::var_os("PROGRAMFILES").map(PathBuf::from).map(|root| root.join("Microsoft OneDrive/OneDrive.exe")),
        ],
        _ => Vec::new(),
    };
    candidates.into_iter().flatten().any(|path| path.exists())
}

#[tauri::command]
pub async fn system_list_windows_apps() -> Result<WindowsAppCatalogResult, String> {
    let catalog = win11debloat::windows_app_catalog()?;
    let installed_names = tokio::task::spawn_blocking(installed_appx_names).await
        .map_err(|error| format!("读取 Windows 应用列表失败：{error}"))?;
    let items = catalog.apps.into_iter().map(|rule| {
        let installed = rule.app_id.iter().any(|id| {
            let id = id.to_ascii_lowercase();
            installed_names.iter().any(|name| name == &id || name.contains(&id))
        }) || known_desktop_app_installed(&rule.friendly_name);
        WindowsAppEntry {
            id: rule.app_id.first().cloned().unwrap_or_else(|| rule.friendly_name.clone()),
            app_ids: rule.app_id,
            name: rule.friendly_name,
            description: rule.description,
            recommendation: rule.recommendation,
            removal_method: rule.removal_method,
            installed,
            selected_by_default: rule.selected_by_default,
        }
    }).collect::<Vec<_>>();
    let installed_count = items.iter().filter(|item| item.installed).count();
    Ok(WindowsAppCatalogResult { total: items.len(), items, installed_count, source_version: catalog.version })
}

/// 通过 PowerShell Get-AppxPackage + Remove-AppxPackage 卸载 UWP/MSIX 包
#[cfg(windows)]
async fn remove_appx_package(name: &str) -> Result<std::process::Output, String> {
    // 转义单引号：PowerShell 字符串里 ' 需要变成 ''
    let safe_name = name.replace('\'', "''");
    let script = format!(
        "$pkg = Get-AppxPackage -Name '*{safe_name}*' -ErrorAction SilentlyContinue; \
         if ($pkg) {{ \
             $pkg | ForEach-Object {{ Remove-AppxPackage -Package $_.PackageFullName -ErrorAction Stop }}; \
             Write-Output 'OK'; \
         }} else {{ \
             Write-Error 'AppxPackage not found'; \
             exit 1; \
         }}"
    );
    tokio::task::spawn_blocking(move || {
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    })
    .await
    .map_err(|e| format!("执行 PowerShell 失败: {e}"))?
    .map_err(|e| format!("启动 PowerShell 失败: {e}"))
}

#[cfg(not(windows))]
async fn remove_appx_package(_name: &str) -> Result<std::process::Output, String> {
    Err("仅 Windows 支持".to_string())
}

#[cfg(windows)]
async fn run_winget(args: Vec<String>) -> Result<std::process::Output, String> {
    tokio::task::spawn_blocking(move || {
        std::process::Command::new("winget")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    })
    .await
    .map_err(|e| format!("执行 WinGet 失败: {e}"))?
    .map_err(|e| format!("启动 WinGet 失败: {e}"))
}

#[cfg(not(windows))]
async fn run_winget(_args: Vec<String>) -> Result<std::process::Output, String> {
    Err("winget 仅在 Windows 上可用".to_string())
}

#[cfg(windows)]
fn expand_uninstall_environment(command: &str) -> String {
    let mut result = String::with_capacity(command.len());
    let mut cursor = 0;
    while let Some(open_offset) = command[cursor..].find('%') {
        let open = cursor + open_offset;
        result.push_str(&command[cursor..open]);
        let Some(close_offset) = command[open + 1..].find('%') else {
            result.push_str(&command[open..]);
            return result;
        };
        let close = open + 1 + close_offset;
        let key = &command[open + 1..close];
        if let Some(value) = std::env::var_os(key) {
            result.push_str(&value.to_string_lossy());
        } else {
            result.push_str(&command[open..=close]);
        }
        cursor = close + 1;
    }
    result.push_str(&command[cursor..]);
    result
}

#[cfg(windows)]
fn split_windows_command_line(command: &str) -> Result<Vec<String>, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GetLastError, LocalFree, HLOCAL};
    use windows::Win32::UI::Shell::CommandLineToArgvW;

    let wide = std::ffi::OsStr::new(command)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut argc = 0;
    let argv = unsafe { CommandLineToArgvW(PCWSTR(wide.as_ptr()), &mut argc) };
    if argv.is_null() || argc <= 0 {
        return Err(format!("无法解析卸载命令：{}", unsafe { GetLastError().0 }));
    }
    let parsed = (|| {
        let values = unsafe { std::slice::from_raw_parts(argv, argc as usize) };
        values
            .iter()
            .map(|value| unsafe { value.to_string() }.map_err(|_| "卸载命令包含无效字符".to_string()))
            .collect::<Result<Vec<_>, _>>()
    })();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(argv.cast())));
    }
    parsed
}

#[cfg(windows)]
fn normalize_msi_uninstall_args(args: &mut [String]) {
    for argument in args {
        if argument.get(..2).is_some_and(|prefix| prefix.eq_ignore_ascii_case("/i")) {
            argument.replace_range(..2, "/X");
        }
    }
}

#[cfg(windows)]
async fn run_registry_uninstaller(
    command: String,
    uninstall_kind: String,
) -> Result<std::process::Output, String> {
    let expanded = expand_uninstall_environment(command.trim());
    let mut parts = split_windows_command_line(&expanded)?;
    if parts.is_empty() || parts[0].trim().is_empty() {
        return Err("卸载命令为空".to_string());
    }
    let program = parts.remove(0);
    if uninstall_kind == "msi" {
        normalize_msi_uninstall_args(&mut parts);
    }
    tokio::task::spawn_blocking(move || {
        std::process::Command::new(&program)
            .args(parts)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    })
    .await
    .map_err(|error| format!("卸载程序执行失败：{error}"))?
    .map_err(|error| format!("无法启动卸载程序：{error}"))
}

fn uninstall_exit_succeeded(exit_code: Option<i32>) -> bool {
    matches!(exit_code, Some(0 | 1641 | 3010))
}

/// 流式执行 winget，逐行回调 stdout（兼容 \r 进度条刷新），返回 (exit_status, stderr_text)
#[cfg(windows)]
async fn run_winget_streaming<F>(
    args: Vec<String>,
    mut on_line: F,
) -> Result<(std::process::ExitStatus, String), String>
where
    F: FnMut(&str) + Send + 'static,
{
    use std::io::{BufRead, BufReader, Read};
    tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("winget");
        cmd.args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("启动 WinGet 失败: {e}"))?;
        let stdout = child.stdout.take().ok_or("stdout pipe 失败")?;
        let stderr = child.stderr.take();

        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            // winget 进度条用 \r 刷新，一行内可能含多段进度
            for segment in line.split('\r') {
                let seg = segment.trim();
                if !seg.is_empty() {
                    on_line(seg);
                }
            }
        }

        let mut stderr_text = String::new();
        if let Some(mut s) = stderr {
            let _ = s.read_to_string(&mut stderr_text);
        }
        let status = child.wait().map_err(|e| format!("等待失败: {e}"))?;
        Ok((status, stderr_text))
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

#[tauri::command]
pub async fn system_remove_windows_app(
    state: State<'_, SystemState>,
    id: String,
    risk_acknowledged: bool,
) -> Result<UpgradeResult, String> {
    let catalog = win11debloat::windows_app_catalog()?;
    let rule = catalog.apps.into_iter().find(|rule| rule.app_id.first() == Some(&id))
        .ok_or_else(|| "该应用不在 Mona 固定卸载目录中".to_string())?;
    if rule.recommendation == "unsafe" && !risk_acknowledged {
        return Err("高风险 Windows 应用需要明确确认后才能卸载".into());
    }
    let package_id = rule.app_id.first().cloned().ok_or("应用目录缺少固定 ID")?;
    let name = rule.friendly_name.clone();
    let mut success = false;
    let mut exit_code = None;
    let mut messages = Vec::new();
    if rule.removal_method.eq_ignore_ascii_case("Appx") {
        for app_id in &rule.app_id {
            match remove_appx_package(app_id).await {
                Ok(output) => {
                    let message = command_message(&output.stdout, &output.stderr);
                    if output.status.success() { success = true; }
                    exit_code = output.status.code();
                    if !message.trim().is_empty() { messages.push(message); }
                }
                Err(error) => messages.push(error),
            }
        }
    } else {
        for app_id in &rule.app_id {
            let output = run_winget(vec![
                "uninstall".into(), "--id".into(), app_id.clone(), "--exact".into(),
                "--accept-source-agreements".into(), "--disable-interactivity".into(),
            ]).await?;
            exit_code = output.status.code();
            let message = command_message(&output.stdout, &output.stderr);
            if !message.trim().is_empty() { messages.push(message); }
            if output.status.success() { success = true; break; }
        }
    }
    let message = if messages.is_empty() {
        if success { "卸载完成" } else { "Windows 未返回可用的卸载结果" }.into()
    } else { messages.join("；") };
    persist_operation(&state, &package_id, &name, "uninstall", success, exit_code, &message);
    Ok(UpgradeResult { success, message, exit_code, residuals: vec![] })
}

#[tauri::command]
pub async fn system_upgrade_software(
    app: AppHandle,
    state: State<'_, SystemState>,
    id: String,
    name: String,
) -> Result<UpgradeResult, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, state, id, name);
        return Err("winget 仅在 Windows 上可用".to_string());
    }
    #[cfg(windows)]
    {
        let args = vec![
            "upgrade".to_string(),
            "--id".to_string(),
            id.clone(),
            "-e".to_string(),
            "--silent".to_string(),
            "--accept-source-agreements".to_string(),
            "--accept-package-agreements".to_string(),
            "--disable-interactivity".to_string(),
        ];
        let _ = app.emit(
            "software-upgrade-progress",
            UpgradeProgress {
                id: id.clone(),
                line: "正在更新".to_string(),
                status: "running".to_string(),
            },
        );

        let app_for_stream = app.clone();
        let id_for_stream = id.clone();
        let last_line = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let last_line_clone = last_line.clone();
        let (status, stderr_text) = match run_winget_streaming(args, move |line: &str| {
            *last_line_clone.lock().unwrap() = line.to_string();
            let _ = app_for_stream.emit(
                "software-upgrade-progress",
                UpgradeProgress {
                    id: id_for_stream.clone(),
                    line: line.to_string(),
                    status: "running".to_string(),
                },
            );
        })
        .await
        {
            Ok(v) => v,
            Err(error) => {
                persist_operation(&state, &id, &name, "upgrade", false, None, &error);
                let _ = app.emit(
                    "software-upgrade-progress",
                    UpgradeProgress {
                        id: id.clone(),
                        line: error.clone(),
                        status: "failed".to_string(),
                    },
                );
                return Ok(UpgradeResult {
                    success: false,
                    message: error,
                    exit_code: None,
                    residuals: vec![],
                });
            }
        };
        let success = status.success();
        let exit_code = status.code();
        let stderr_clean = strip_ansi(&stderr_text);
        let stdout_last = strip_ansi(&last_line.lock().unwrap().clone());
        let detail = if !stderr_clean.trim().is_empty() {
            stderr_clean.trim().to_string()
        } else {
            stdout_last.trim().to_string()
        };
        let message = if detail.is_empty() {
            if success { "更新完成" } else { "WinGet 更新失败" }.to_string()
        } else {
            detail
        };
        persist_operation(&state, &id, &name, "upgrade", success, exit_code, &message);
        let _ = app.emit(
            "software-upgrade-progress",
            UpgradeProgress {
                id,
                line: message.clone(),
                status: if success { "done" } else { "failed" }.to_string(),
            },
        );
        Ok(UpgradeResult {
            success,
            message,
            exit_code,
            residuals: vec![],
        })
    }
}

#[tauri::command]
pub async fn system_uninstall_software(
    app: AppHandle,
    state: State<'_, SystemState>,
    id: Option<String>,
    name: String,
    install_location: Option<String>,
) -> Result<UpgradeResult, String> {
    #[cfg(not(windows))]
    {
        let _ = (app, state, id, name, install_location);
        return Err("winget 仅在 Windows 上可用".to_string());
    }
    #[cfg(windows)]
    {
        let installed = tokio::task::spawn_blocking(read_installed_software)
            .await
            .map_err(|error| format!("读取卸载信息失败：{error}"))?;
        let selected = if let Some(id) = id.as_deref() {
            installed.into_iter().find(|software| software.id == id)
        } else {
            let mut matches = installed
                .into_iter()
                .filter(|software| software.name == name);
            let selected = matches.next();
            if matches.next().is_some() { None } else { selected }
        }
        .ok_or_else(|| "找不到该软件的卸载信息，请刷新列表后重试".to_string())?;
        if !selected.can_uninstall {
            return Err("该软件没有提供可用的卸载方式".to_string());
        }
        let package_id = selected.id.clone();
        let display_name = selected.name.clone();
        let _ = install_location;
        let residual_install_location = (!selected.install_location.trim().is_empty())
            .then(|| selected.install_location.clone());
        let (product_aliases, vendor_alias) = residual_aliases(
            &selected.name,
            residual_install_location.as_deref().map(Path::new),
        );
        let system_identity = super::software_system_residuals::SoftwareIdentity {
            install_location: selected.install_location.clone(),
            product_aliases,
            vendor_alias,
            uninstall_registry_hive: Some(selected.uninstall_registry_hive.clone()),
            uninstall_registry_path: Some(selected.uninstall_registry_path.clone()),
        };
        let residual_publisher = selected.publisher.clone();
        let residual_registry_key = Some(selected.uninstall_registry_path.clone());
        let uninstall_commands = registry_uninstall_commands(
            &selected.quiet_uninstall_command,
            &selected.uninstall_command,
        );
        let _ = app.emit(
            "software-uninstall-progress",
            UpgradeProgress {
                id: package_id.clone(),
                line: "正在卸载".to_string(),
                status: "running".to_string(),
            },
        );

        let mut success = false;
        let mut exit_code = None;
        let mut direct_details = Vec::new();
        for (index, command) in uninstall_commands.into_iter().enumerate() {
            if index > 0 {
                let _ = app.emit(
                    "software-uninstall-progress",
                    UpgradeProgress {
                        id: package_id.clone(),
                        line: "正在尝试软件提供的备用卸载程序".to_string(),
                        status: "running".to_string(),
                    },
                );
            }
            match run_registry_uninstaller(command, selected.uninstall_kind.clone()).await {
                Ok(output) => {
                    exit_code = output.status.code();
                    let command_success = uninstall_exit_succeeded(exit_code);
                    let command_detail = command_message(&output.stdout, &output.stderr);
                    if command_success {
                        success = true;
                        direct_details.clear();
                        if !command_detail.trim().is_empty() {
                            direct_details.push(command_detail);
                        }
                        break;
                    }
                    if !command_detail.trim().is_empty() {
                        direct_details.push(command_detail);
                    }
                }
                Err(error) => direct_details.push(error),
            }
        }
        let direct_detail = direct_details.join("\n");
        let mut detail = if success {
            "卸载完成".to_string()
        } else {
            direct_detail.clone()
        };

        if !success {
            let _ = app.emit(
                "software-uninstall-progress",
                UpgradeProgress {
                    id: package_id.clone(),
                    line: "正在尝试备用卸载方式".to_string(),
                    status: "running".to_string(),
                },
            );
            let fallback = run_winget(vec![
                "uninstall".to_string(),
                "--name".to_string(),
                display_name.clone(),
                "--exact".to_string(),
                "--accept-source-agreements".to_string(),
                "--disable-interactivity".to_string(),
            ])
            .await;
            match fallback {
                Ok(output) => {
                    exit_code = output.status.code();
                    success = uninstall_exit_succeeded(exit_code);
                    let fallback_detail = hide_internal_store_name(&command_message(
                        &output.stdout,
                        &output.stderr,
                    ));
                    if success {
                        detail = "卸载完成".to_string();
                    } else if !fallback_detail.trim().is_empty() {
                        detail = if direct_detail.trim().is_empty() {
                            fallback_detail
                        } else {
                            format!("{direct_detail}\n备用卸载方式：{fallback_detail}")
                        };
                    }
                }
                Err(error) => {
                    detail = if direct_detail.trim().is_empty() {
                        error
                    } else {
                        format!("{direct_detail}\n备用卸载方式：{error}")
                    };
                }
            }
        }
        let mut message = if detail.is_empty() {
            if success { "卸载完成" } else { "卸载失败" }.to_string()
        } else {
            detail
        };
        if success {
            let verify_id = package_id.clone();
            let still_installed = tokio::task::spawn_blocking(move || {
                read_installed_software()
                    .into_iter()
                    .any(|software| software.id == verify_id)
            })
            .await
            .unwrap_or(true);
            if still_installed {
                success = false;
                message = "卸载程序已结束，但软件仍在已安装列表中，请刷新后重试".to_string();
            }
        }
        persist_operation(
            &state,
            &package_id,
            &display_name,
            "uninstall",
            success,
            exit_code,
            &message,
        );
        let residual_software_id = package_id.clone();
        let residuals = if success {
            tokio::task::spawn_blocking(move || {
                let mut candidates = scan_residual_candidates(
                    &residual_software_id,
                    &display_name,
                    &residual_publisher,
                    residual_install_location,
                    residual_registry_key,
                );
                append_system_residuals(
                    &residual_software_id,
                    &mut candidates,
                    super::software_system_residuals::scan_system_residuals(&system_identity),
                );
                candidates
            })
            .await
            .unwrap_or_default()
        } else {
            vec![]
        };
        let _ = app.emit(
            "software-uninstall-progress",
            UpgradeProgress {
                id: package_id,
                line: message.clone(),
                status: if success { "done" } else { "failed" }.to_string(),
            },
        );
        Ok(UpgradeResult {
            success,
            message,
            exit_code,
            residuals,
        })
    }
}

#[tauri::command]
pub async fn system_delete_software_residuals(
    state: State<'_, SystemState>,
    ids: Vec<String>,
    confirmed: bool,
) -> Result<ResidualDeleteResult, String> {
    if !confirmed {
        return Err("删除残留项需要明确确认".to_string());
    }
    if ids.is_empty() {
        return Err("请先选择要删除的残留项".to_string());
    }
    if ids.len() > 100 || ids.iter().any(|id| id.trim().is_empty()) {
        return Err("残留项请求无效".to_string());
    }
    let result = tokio::task::spawn_blocking(move || delete_authorized_residuals(ids))
        .await
        .map_err(|error| format!("删除残留项失败：{error}"))?;
    let message = if result.failures.is_empty() {
        format!(
            "已清理 {} 项残留，释放 {} 字节",
            result.deleted_ids.len(),
            result.freed_bytes
        )
    } else {
        format!(
            "已清理 {} 项，{} 项失败，释放 {} 字节",
            result.deleted_ids.len(),
            result.failures.len(),
            result.freed_bytes
        )
    };
    persist_operation(
        &state,
        "software-residuals",
        "软件残留",
        "residual_cleanup",
        result.failures.is_empty(),
        None,
        &message,
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{
        build_store_install_args, hide_internal_store_name, init_software_tables,
        is_safe_name_component, parse_winget_search_list, parse_winget_upgrade_list,
        record_software_operation, unresolved_failure_count,
    };
    use rusqlite::Connection;

    #[test]
    fn parses_utf8_winget_rows_without_using_byte_columns() {
        let output = r#"
Name                    Id                         Version       Available     Source
------------------------------------------------------------------------------------
微信开发者工具          Tencent.WeChat.DevTools   1.06.2504030   1.06.2505010  winget
Google Chrome           Google.Chrome.EXE          138.0.7204.97 138.0.7204.101 winget
2 upgrades available.
"#;

        let entries = parse_winget_upgrade_list(output);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "微信开发者工具");
        assert_eq!(entries[0].id, "Tencent.WeChat.DevTools");
        assert_eq!(entries[0].current_version, "1.06.2504030");
        assert_eq!(entries[0].next_version, "1.06.2505010");
    }

    #[test]
    fn parses_store_search_rows_with_stable_fields() {
        let output = r#"
Name                         Id                         Version       Source
----------------------------------------------------------------------------
微信                         Tencent.WeChat              3.9.12        winget
Visual Studio Code           Microsoft.VisualStudioCode 1.101.0       winget
Microsoft Store              9WZDNCRFJBMP                 Unknown       msstore
Firefox                      Mozilla.Firefox              142.0
WeChat                       Tencent.WeChat.DevTools        3.9.12.57    Tag: 微信
2 packages found.
"#;

        let entries = parse_winget_search_list(output);

        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].id, "Tencent.WeChat");
        assert_eq!(entries[0].name, "微信");
        assert_eq!(entries[0].version, "3.9.12");
        assert_eq!(entries[0].source, "winget");
        assert_eq!(entries[1].id, "Microsoft.VisualStudioCode");
        assert_eq!(entries[2].id, "Mozilla.Firefox");
        assert_eq!(entries[2].source, "winget");
        assert_eq!(entries[3].id, "Tencent.WeChat.DevTools");
        assert_eq!(entries[3].name, "WeChat");
        assert_eq!(entries[3].version, "3.9.12.57");
    }

    #[test]
    fn install_args_keep_id_as_one_argument_and_force_safe_options() {
        let id = "Vendor.App & unexpected";
        let args = build_store_install_args(id).unwrap();

        assert_eq!(args[2], id);
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--source" && pair[1] == "winget"));
        assert!(args.contains(&"--exact".to_string()));
        assert!(args.contains(&"--silent".to_string()));
        assert!(args.contains(&"--accept-source-agreements".to_string()));
        assert!(args.contains(&"--accept-package-agreements".to_string()));
        assert!(args.contains(&"--disable-interactivity".to_string()));
    }

    #[test]
    fn user_visible_install_text_hides_internal_executor_name() {
        let message = hide_internal_store_name("WinGet failed: winget unavailable");
        assert!(!message.to_ascii_lowercase().contains("winget"));
        assert!(message.contains("安装服务"));
    }

    #[test]
    fn later_success_resolves_the_previous_software_failure() {
        let conn = Connection::open_in_memory().unwrap();
        init_software_tables(&conn).unwrap();
        record_software_operation(
            &conn,
            1,
            "Google.Chrome.EXE",
            "Google Chrome",
            "upgrade",
            false,
            Some(1),
            "upgrade failed",
        )
        .unwrap();
        assert_eq!(unresolved_failure_count(&conn).unwrap(), 1);

        record_software_operation(
            &conn,
            2,
            "Google.Chrome.EXE",
            "Google Chrome",
            "upgrade",
            true,
            Some(0),
            "upgrade completed",
        )
        .unwrap();
        assert_eq!(unresolved_failure_count(&conn).unwrap(), 0);
    }

    #[test]
    fn residual_scan_only_accepts_a_single_safe_directory_name() {
        assert!(is_safe_name_component("Google Chrome"));
        assert!(!is_safe_name_component(".."));
        assert!(!is_safe_name_component("Vendor\\Product"));
        assert!(!is_safe_name_component("C:\\"));
    }

    #[test]
    fn residual_scan_uses_display_install_and_vendor_folder_aliases() {
        let install = std::path::Path::new(
            r"C:\Program Files (x86)\Lenovo\LeAppStore",
        );
        let (products, vendor) = super::residual_aliases("联想应用商店", Some(install));
        assert_eq!(products, vec!["联想应用商店", "LeAppStore"]);
        assert_eq!(vendor.as_deref(), Some("Lenovo"));
    }

    #[test]
    fn classifies_registry_uninstall_methods() {
        assert_eq!(
            super::classify_uninstall_kind(
                false,
                r#""C:\Program Files (x86)\Lenovo\LeAppStore\StoreUninstaller.exe""#,
                r#""C:\Program Files (x86)\Lenovo\LeAppStore\StoreUninstaller.exe" /SLIENT"#,
            ),
            "desktop"
        );
        assert_eq!(
            super::classify_uninstall_kind(false, "MsiExec.exe /I{PRODUCT-CODE}", ""),
            "msi"
        );
        assert_eq!(super::classify_uninstall_kind(false, "", ""), "unavailable");
    }

    #[test]
    fn prefers_the_registered_quiet_uninstaller_then_the_normal_command() {
        let commands = super::registry_uninstall_commands(
            r#""C:\Program Files (x86)\Lenovo\LeAppStore\StoreUninstaller.exe" /SLIENT"#,
            r#""C:\Program Files (x86)\Lenovo\LeAppStore\StoreUninstaller.exe""#,
        );
        assert_eq!(commands.len(), 2);
        assert!(commands[0].ends_with(" /SLIENT"));
        assert!(!commands[1].ends_with(" /SLIENT"));
    }

    #[cfg(windows)]
    #[test]
    fn parses_quoted_registry_command_without_losing_the_executable_path() {
        let parts = super::split_windows_command_line(
            r#""C:\Program Files (x86)\Lenovo\LeAppStore\StoreUninstaller.exe" /SLIENT"#,
        )
        .unwrap();
        assert_eq!(
            parts,
            vec![
                r#"C:\Program Files (x86)\Lenovo\LeAppStore\StoreUninstaller.exe"#,
                "/SLIENT"
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn converts_msi_install_maintenance_to_uninstall() {
        let mut args = vec!["/I{PRODUCT-CODE}".to_string(), "/qn".to_string()];
        super::normalize_msi_uninstall_args(&mut args);
        assert_eq!(args[0], "/X{PRODUCT-CODE}");
    }

    #[test]
    fn treats_reboot_required_uninstall_codes_as_success() {
        assert!(super::uninstall_exit_succeeded(Some(0)));
        assert!(super::uninstall_exit_succeeded(Some(1641)));
        assert!(super::uninstall_exit_succeeded(Some(3010)));
        assert!(!super::uninstall_exit_succeeded(Some(1)));
    }

    #[test]
    fn deletes_only_a_backend_authorized_residual_directory() {
        let root = tempfile::tempdir().unwrap();
        let residual = root.path().join("ApplicationResidual");
        std::fs::create_dir(&residual).unwrap();
        std::fs::write(residual.join("cache.bin"), b"residual").unwrap();
        let canonical = residual.canonicalize().unwrap();
        let id = super::authorize_residual("test-software", &canonical, 8, true).unwrap();

        let result = super::delete_authorized_residuals(vec![id.clone()]);

        assert_eq!(result.deleted_ids, vec![id]);
        assert!(result.failures.is_empty());
        assert!(!residual.exists());
    }

    #[test]
    fn rejects_a_residual_id_that_was_not_issued_by_the_backend() {
        let result = super::delete_authorized_residuals(vec!["not-authorized".to_string()]);
        assert!(result.deleted_ids.is_empty());
        assert_eq!(result.failures.len(), 1);
        assert!(result.failures[0].message.contains("过期"));
    }

    #[cfg(windows)]
    #[test]
    fn converts_extended_windows_paths_for_elevated_cleanup() {
        assert_eq!(
            super::powershell_residual_path(std::path::Path::new(
                r"\\?\C:\Program Files (x86)\Lenovo\LeAppStore"
            )),
            r"C:\Program Files (x86)\Lenovo\LeAppStore"
        );
    }
}
