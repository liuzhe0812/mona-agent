// 软件管理：注册表读取已安装列表、winget 检测和执行，以及可确认的残留候选扫描。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

use super::SystemState;

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
    pub path: String,
    pub size_bytes: u64,
    pub category: String,
    pub requires_confirmation: bool,
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

fn add_residual_candidate(
    path: PathBuf,
    category: &str,
    protected_roots: &[PathBuf],
    seen: &mut std::collections::HashSet<String>,
    candidates: &mut Vec<ResidualCandidate>,
) {
    if !path.is_dir() {
        return;
    }
    let canonical = match path.canonicalize() {
        Ok(path) => path,
        Err(_) => return,
    };
    if canonical.parent().is_none()
        || protected_roots.iter().any(|root| root == &canonical)
    {
        return;
    }
    let key = canonical.to_string_lossy().to_lowercase();
    if !seen.insert(key) {
        return;
    }
    let (size_bytes, _) = super::dir_size(&canonical);
    candidates.push(ResidualCandidate {
        path: canonical.to_string_lossy().to_string(),
        size_bytes,
        category: category.to_string(),
        requires_confirmation: true,
    });
}

fn scan_residual_candidates(
    name: &str,
    install_location: Option<String>,
) -> Vec<ResidualCandidate> {
    let app_data_roots: Vec<PathBuf> = ["LOCALAPPDATA", "APPDATA", "PROGRAMDATA"]
        .into_iter()
        .filter_map(|key| std::env::var_os(key).map(PathBuf::from))
        .collect();
    let mut protected_roots = app_data_roots.clone();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "SystemRoot"] {
        if let Some(path) = std::env::var_os(key).map(PathBuf::from) {
            if let Ok(path) = path.canonicalize() {
                protected_roots.push(path);
            }
        }
    }
    protected_roots = protected_roots
        .into_iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect();

    let mut seen = std::collections::HashSet::new();
    let mut candidates = Vec::new();
    if let Some(path) = install_location
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
    {
        add_residual_candidate(
            path,
            "原安装目录",
            &protected_roots,
            &mut seen,
            &mut candidates,
        );
    }
    if is_safe_name_component(name) {
        for root in app_data_roots {
            add_residual_candidate(
                root.join(name.trim()),
                "应用数据",
                &protected_roots,
                &mut seen,
                &mut candidates,
            );
        }
    }
    candidates
}

fn command_message(stdout: &[u8], stderr: &[u8]) -> String {
    let stderr = strip_ansi(&String::from_utf8_lossy(stderr));
    let stdout = strip_ansi(&String::from_utf8_lossy(stdout));
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
        eprintln!("software operation history: state lock failed");
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
        eprintln!("software operation history: {error}");
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
        let name_key = name.to_lowercase();
        if !seen.insert(name_key) {
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
        entries.push(InstalledSoftware {
            id: subkey_name,
            name,
            publisher,
            version,
            install_date,
            software_type: stype.to_string(),
            estimated_size_bytes,
            install_location,
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
                let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
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

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
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

        let output = match run_winget(args).await {
            Ok(output) => output,
            Err(error) => {
                persist_operation(&state, &id, &name, "upgrade", false, None, &error);
                return Ok(UpgradeResult {
                    success: false,
                    message: error,
                    exit_code: None,
                    residuals: vec![],
                });
            }
        };
        let success = output.status.success();
        let exit_code = output.status.code();
        let detail = command_message(&output.stdout, &output.stderr);
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
        let package_id = id.clone().unwrap_or_else(|| name.clone());
        let args = vec![
            "uninstall".to_string(),
            if id.is_some() { "--id" } else { "--name" }.to_string(),
            id.unwrap_or_else(|| name.clone()),
            "--exact".to_string(),
            "--accept-source-agreements".to_string(),
            "--disable-interactivity".to_string(),
        ];
        let _ = app.emit(
            "software-uninstall-progress",
            UpgradeProgress {
                id: package_id.clone(),
                line: "正在卸载".to_string(),
                status: "running".to_string(),
            },
        );

        let output = match run_winget(args).await {
            Ok(output) => output,
            Err(error) => {
                persist_operation(
                    &state,
                    &package_id,
                    &name,
                    "uninstall",
                    false,
                    None,
                    &error,
                );
                return Ok(UpgradeResult {
                    success: false,
                    message: error,
                    exit_code: None,
                    residuals: vec![],
                });
            }
        };
        let success = output.status.success();
        let exit_code = output.status.code();
        let detail = command_message(&output.stdout, &output.stderr);
        let message = if detail.is_empty() {
            if success { "卸载完成" } else { "WinGet 卸载失败" }.to_string()
        } else {
            detail
        };
        persist_operation(
            &state,
            &package_id,
            &name,
            "uninstall",
            success,
            exit_code,
            &message,
        );
        let residuals = if success {
            tokio::task::spawn_blocking(move || scan_residual_candidates(&name, install_location))
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

#[cfg(test)]
mod tests {
    use super::{
        init_software_tables, is_safe_name_component, parse_winget_upgrade_list,
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
}
