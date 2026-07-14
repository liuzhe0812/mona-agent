// 启动项管理：扫描注册表 Run/RunOnce、启动文件夹；
// 启用/禁用通过 StartupApproved 注册表项切换（与任务管理器同款机制，不删原项）。
// 启动耗时通过 PowerShell 读取 Microsoft-Windows-Diagnostics-Performance Event ID 100。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

use super::SystemState;

#[cfg(test)]
mod tests {
    use super::{parse_registry_startup_id, parse_scheduled_task_line};

    #[test]
    fn parses_the_complete_registry_key_and_value_name() {
        let parsed = parse_registry_startup_id(
            "reg:HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\WeChat",
        )
        .unwrap();
        assert_eq!(parsed.0, "HKCU");
        assert_eq!(parsed.1, "Software\\Microsoft\\Windows\\CurrentVersion\\Run");
        assert_eq!(parsed.2, "WeChat");
    }

    #[test]
    fn parses_a_logon_scheduled_task() {
        let item = parse_scheduled_task_line(
            "\\Vendor\\\tUpdateHelper\tReady\tC:\\Updater\\update.exe\t--silent",
        )
        .unwrap();
        assert_eq!(item.name, "UpdateHelper");
        assert_eq!(item.source, "计划任务");
        assert_eq!(item.command, "C:\\Updater\\update.exe --silent");
        assert!(item.enabled);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupItem {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub source: String,
    pub scope: String,
    pub command: String,
    pub target_path: String,
    pub added: Option<String>,
    pub enabled: bool,
    pub signed: bool,
    pub first_seen_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupListResult {
    pub items: Vec<StartupItem>,
    pub total: usize,
    pub enabled_count: usize,
    pub disabled_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootDurationPoint {
    pub ts: i64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootHistoryResult {
    pub points: Vec<BootDurationPoint>,
    pub last_duration_ms: Option<u64>,
    pub last_delta_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupChangeRecord {
    pub ts: i64,
    pub item_id: String,
    pub item_name: String,
    pub action: String,
}

fn now_ts() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn format_iso(ts: i64) -> String {
    use chrono::{DateTime, Utc};
    let dt: DateTime<Utc> = DateTime::<Utc>::from_timestamp(ts, 0).unwrap_or_default();
    dt.format("%Y/%m/%d").to_string()
}

fn parse_registry_startup_id(id: &str) -> Result<(String, String, String), String> {
    let raw = id.strip_prefix("reg:").ok_or_else(|| "id 格式错误".to_string())?;
    let (root, rest) = raw.split_once('\\').ok_or_else(|| "无法解析注册表根键".to_string())?;
    let (subpath, value_name) = rest.rsplit_once('\\').ok_or_else(|| "无法解析启动项名称".to_string())?;
    if root.is_empty() || subpath.is_empty() || value_name.is_empty() {
        return Err("启动项 id 不完整".to_string());
    }
    Ok((root.to_string(), subpath.to_string(), value_name.to_string()))
}

fn parse_scheduled_task_line(line: &str) -> Option<StartupItem> {
    let mut fields = line.splitn(5, '\t');
    let task_path = fields.next()?.trim();
    let name = fields.next()?.trim();
    let state = fields.next()?.trim();
    let execute = fields.next()?.trim();
    let arguments = fields.next().unwrap_or_default().trim();
    if task_path.is_empty() || name.is_empty() || execute.is_empty() {
        return None;
    }
    let command = if arguments.is_empty() { execute.to_string() } else { format!("{execute} {arguments}") };
    Some(StartupItem {
        id: format!("task:{task_path}|{name}"),
        name: name.to_string(),
        publisher: String::new(),
        source: "计划任务".to_string(),
        scope: "machine".to_string(),
        command,
        target_path: execute.trim_matches('"').to_string(),
        added: None,
        enabled: !state.eq_ignore_ascii_case("Disabled"),
        signed: false,
        first_seen_at: None,
    })
}

#[cfg(windows)]
fn read_scheduled_tasks() -> Vec<StartupItem> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = r#"Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { @($_.Triggers | Where-Object { $_.CimClass.CimClassName -in @('MSFT_TaskBootTrigger','MSFT_TaskLogonTrigger') }).Count -gt 0 } | ForEach-Object { $a = @($_.Actions | Where-Object { $_.Execute } | Select-Object -First 1); if ($a.Count -gt 0) { @($_.TaskPath,$_.TaskName,$_.State,$a[0].Execute,$a[0].Arguments) -join "`t" } }"#;
    let Ok(output) = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_scheduled_task_line)
        .collect()
}

#[cfg(windows)]
fn read_startup_approved(scope: &str) -> std::collections::HashMap<String, bool> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};
    let mut map = std::collections::HashMap::new();
    let paths: Vec<(&str, &str)> = if scope == "user" {
        vec![
            ("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run"),
            ("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32"),
            ("HKCU", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder"),
        ]
    } else {
        vec![
            ("HKLM", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run"),
            ("HKLM", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32"),
            ("HKLM", "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder"),
        ]
    };
    for (root, path) in paths {
        let key = if root == "HKCU" {
            CURRENT_USER.open(path)
        } else {
            LOCAL_MACHINE.open(path)
        };
        if let Ok(key) = key {
            if let Ok(iter) = key.values() {
                for (name, value) in iter {
                    let bytes: &[u8] = value.as_ref();
                    if bytes.len() >= 4 {
                        let enabled = bytes[0] == 0x02 || bytes[0] == 0x03 || bytes[0] == 0x06;
                        map.entry(name).or_insert(enabled);
                    }
                }
            }
        }
    }
    map
}

#[cfg(windows)]
fn read_reg_run(
    root: &str,
    subpath: &str,
    scope: &str,
    source: &str,
    approved: &std::collections::HashMap<String, bool>,
    out: &mut Vec<StartupItem>,
) {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};
    let key = if root == "HKCU" {
        CURRENT_USER.open(subpath)
    } else {
        LOCAL_MACHINE.open(subpath)
    };
    let key = match key {
        Ok(k) => k,
        Err(_) => return,
    };
    if let Ok(iter) = key.values() {
        for (name_str, value) in iter {
            let command: String = String::try_from(value).unwrap_or_default();
            if command.is_empty() {
                continue;
            }
            let enabled = approved.get(&name_str).copied().unwrap_or(true);
            let target_path = extract_exe_path(&command);
            out.push(StartupItem {
                id: format!("reg:{}\\{}\\{}", root, subpath, name_str),
                name: name_str,
                publisher: String::new(),
                source: source.to_string(),
                scope: scope.to_string(),
                command,
                target_path,
                added: None,
                enabled,
                signed: false,
                first_seen_at: None,
            });
        }
    }
}

#[cfg(windows)]
fn read_startup_folder(
    scope: &str,
    dir: PathBuf,
    approved: &std::collections::HashMap<String, bool>,
) -> Vec<StartupItem> {
    let mut out = Vec::new();
    if !dir.exists() {
        return out;
    }
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("lnk") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let enabled = approved.get(&name).copied().unwrap_or(true);
        let target_path = resolve_lnk_target(&path)
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        let added = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| format_iso(d.as_secs() as i64));
        out.push(StartupItem {
            id: format!("folder:{}\\{}", scope, path.to_string_lossy()),
            name,
            publisher: String::new(),
            source: "启动文件夹".to_string(),
            scope: scope.to_string(),
            command: path.to_string_lossy().to_string(),
            target_path,
            added,
            enabled,
            signed: false,
            first_seen_at: None,
        });
    }
    out
}

#[cfg(windows)]
fn resolve_lnk_target(lnk_path: &PathBuf) -> Option<String> {
    use std::process::Command;
    let escaped = lnk_path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$sh = New-Object -ComObject WScript.Shell; $sc = $sh.CreateShortcut('{}'); Write-Output $sc.TargetPath",
        escaped
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(windows)]
fn extract_exe_path(command: &str) -> String {
    let trimmed = command.trim();
    if trimmed.starts_with('"') {
        trimmed[1..]
            .find('"')
            .map(|i| trimmed[1..1 + i].to_string())
            .unwrap_or_else(|| trimmed.to_string())
    } else {
        trimmed
            .split_whitespace()
            .next()
            .map(|s| s.to_string())
            .unwrap_or_else(|| trimmed.to_string())
    }
    .replace("\"", "")
}

/// 批量查询文件签名和发布者。一次 PowerShell 调用处理所有路径，避免逐个查询太慢。
#[cfg(windows)]
fn batch_query_signatures(paths: &[String]) -> std::collections::HashMap<String, (bool, String)> {
    use std::process::Command;
    let mut map = std::collections::HashMap::new();
    if paths.is_empty() {
        return map;
    }
    let unique: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        paths
            .iter()
            .filter(|p| {
                !p.is_empty() && PathBuf::from(p).exists() && seen.insert((*p).clone())
            })
            .cloned()
            .collect()
    };
    if unique.is_empty() {
        for p in paths {
            map.insert(p.clone(), (false, "未签名".to_string()));
        }
        return map;
    }
    let path_array = unique
        .iter()
        .map(|p| format!("'{}'", p.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "$paths = @({}); foreach ($p in $paths) {{ try {{ $s = Get-AuthenticodeSignature -FilePath $p -ErrorAction Stop; $pub = ''; if ($s.SignerCertificate) {{ $pub = ($s.SignerCertificate.Subject -replace '.*CN=([^,]+).*', '$1') }}; if ($pub -eq '') {{ $pub = '未签名' }}; $valid = if ($s.Status -eq 'Valid') {{ '1' }} else {{ '0' }}; Write-Output ($p + '|' + $valid + '|' + $pub) }} catch {{ Write-Output ($p + '|0|未知') }} }}",
        path_array
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output();
    if let Ok(o) = output {
        let stdout = String::from_utf8_lossy(&o.stdout);
        for line in stdout.lines() {
            if let Some((path, rest)) = line.split_once('|') {
                let mut parts = rest.splitn(2, '|');
                let valid = parts.next().unwrap_or("0") == "1";
                let publisher = parts.next().unwrap_or("未知").to_string();
                map.insert(path.to_string(), (valid, publisher));
            }
        }
    }
    for p in paths {
        if !map.contains_key(p) {
            map.insert(p.clone(), (false, "未知".to_string()));
        }
    }
    map
}

#[cfg(windows)]
fn scan_startup_items() -> Vec<StartupItem> {
    let mut items = Vec::new();

    let user_approved = read_startup_approved("user");
    let machine_approved = read_startup_approved("machine");

    // HKCU Run
    read_reg_run(
        "HKCU",
        "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "user",
        "注册表",
        &user_approved,
        &mut items,
    );
    // HKLM Run
    read_reg_run(
        "HKLM",
        "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "machine",
        "注册表",
        &machine_approved,
        &mut items,
    );
    // WOW6432Node（32位兼容层）
    read_reg_run(
        "HKLM",
        "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run",
        "machine",
        "注册表",
        &machine_approved,
        &mut items,
    );

    // 启动文件夹
    if let Some(appdata) = dirs::data_dir() {
        let user_startup = appdata.join("Microsoft\\Windows\\Start Menu\\Programs\\Startup");
        items.extend(read_startup_folder("user", user_startup, &user_approved));
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        let common_startup = PathBuf::from(program_data)
            .join("Microsoft\\Windows\\Start Menu\\Programs\\Startup");
        items.extend(read_startup_folder("machine", common_startup, &machine_approved));
    }
    items.extend(read_scheduled_tasks());

    // 批量查询签名和发布者
    let paths: Vec<String> = items.iter().map(|i| i.target_path.clone()).collect();
    let sig_map = batch_query_signatures(&paths);
    for item in &mut items {
        if let Some((signed, publisher)) = sig_map.get(&item.target_path) {
            item.signed = *signed;
            item.publisher = publisher.clone();
        } else {
            item.publisher = "未知".to_string();
        }
    }

    items
}

#[cfg(windows)]
fn write_startup_approved(item: &StartupItem, enabled: bool) -> Result<(), String> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE, Type};

    if item.source == "计划任务" {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let raw = item.id.strip_prefix("task:").ok_or_else(|| "计划任务 id 格式错误".to_string())?;
        let (task_path, task_name) = raw.split_once('|').ok_or_else(|| "无法解析计划任务 id".to_string())?;
        let command = if enabled { "Enable-ScheduledTask" } else { "Disable-ScheduledTask" };
        let script = format!("Get-ScheduledTask -TaskPath $env:MONA_TASK_PATH -TaskName $env:MONA_TASK_NAME -ErrorAction Stop | {command} -ErrorAction Stop | Out-Null");
        let output = Command::new("powershell")
            .env("MONA_TASK_PATH", task_path)
            .env("MONA_TASK_NAME", task_name)
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("执行计划任务操作失败：{error}"))?;
        if output.status.success() {
            return Ok(());
        }
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let (root, approved_path, value_name) = if item.source == "注册表" {
        let (root, subpath, value_name) = parse_registry_startup_id(&item.id)?;
        let suffix = if subpath.contains("\\WOW6432Node\\") {
            "Run32"
        } else {
            "Run"
        };
        let approved = format!(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\{}",
            suffix
        );
        (root, approved, value_name)
    } else if item.source == "启动文件夹" {
        let parts: Vec<&str> = item.id.splitn(3, '\\').collect();
        if parts.len() < 3 {
            return Err("无法解析启动项 id".to_string());
        }
        let scope = parts[1];
        let file_name = parts[2].rsplit('\\').next().unwrap_or("");
        let value_name = file_name.trim_end_matches(".lnk").to_string();
        let approved =
            "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder"
                .to_string();
        (scope.to_string(), approved, value_name)
    } else {
        return Err(format!("暂不支持的来源：{}", item.source));
    };

    let key = if root == "user" || root == "HKCU" {
        CURRENT_USER.create(&approved_path)
    } else {
        LOCAL_MACHINE.create(&approved_path)
    }
    .map_err(|e| format!("打开 StartupApproved 失败：{}", e))?;

    // 12 字节项，首字节标识状态：0x02=启用，0x00=禁用
    let mut data = vec![0u8; 12];
    data[0] = if enabled { 0x02 } else { 0x00 };
    key.set_bytes(&value_name, Type::Bytes, &data)
        .map_err(|e| format!("写入 StartupApproved 失败：{}", e))?;
    Ok(())
}

#[cfg(windows)]
fn read_boot_durations(limit: usize) -> Vec<BootDurationPoint> {
    use std::process::Command;
    let script = format!(
        "$events = Get-WinEvent -FilterHashtable @{{LogName='Microsoft-Windows-Diagnostics-Performance'; Id=100}} -MaxEvents {} -ErrorAction SilentlyContinue; $results = @(); foreach ($e in $events) {{ $dur = if ($e.Properties.Count -gt 1) {{ [math]::Round($e.Properties[1].Value) }} else {{ 0 }}; $results += [PSCustomObject]@{{ Time = $e.TimeCreated; Duration = $dur }} }}; $results | Sort-Object Time | ForEach-Object {{ Write-Output ($_.Time.ToString('O') + '|' + $_.Duration) }}",
        limit
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output();
    let mut points = Vec::new();
    if let Ok(o) = output {
        let stdout = String::from_utf8_lossy(&o.stdout);
        for line in stdout.lines() {
            if let Some((ts_str, dur_str)) = line.split_once('|') {
                if let (Ok(dt), Ok(d)) = (
                    chrono::DateTime::parse_from_rfc3339(ts_str),
                    dur_str.parse::<u64>(),
                ) {
                    points.push(BootDurationPoint {
                        ts: dt.timestamp(),
                        duration_ms: d,
                    });
                }
            }
        }
        points.sort_by_key(|p| p.ts);
        if points.len() > limit {
            points = points.split_off(points.len() - limit);
        }
    }
    points
}

#[cfg(not(windows))]
fn scan_startup_items() -> Vec<StartupItem> {
    Vec::new()
}

#[cfg(not(windows))]
fn write_startup_approved(_item: &StartupItem, _enabled: bool) -> Result<(), String> {
    Err("仅支持 Windows".to_string())
}

#[cfg(not(windows))]
fn read_boot_durations(_limit: usize) -> Vec<BootDurationPoint> {
    Vec::new()
}

#[tauri::command]
pub async fn system_list_startup_items(
    state: State<'_, SystemState>,
) -> Result<StartupListResult, String> {
    let mut items = tokio::task::spawn_blocking(scan_startup_items)
        .await
        .map_err(|error| format!("扫描启动项失败：{error}"))?;

    // 记录首次发现时间（first_seen_at），用 SQLite 快照表持久化
    {
        let inner = state.0.lock().map_err(|e| format!("State lock: {}", e))?;
        inner
            .db
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS startup_seen (id TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL);",
            )
            .map_err(|e| format!("Failed to init startup_seen: {}", e))?;

        let now = now_ts();
        for item in &mut items {
            let existing: Option<i64> = inner
                .db
                .query_row(
                    "SELECT first_seen_at FROM startup_seen WHERE id = ?1",
                    rusqlite::params![item.id],
                    |r| r.get(0),
                )
                .ok();
            match existing {
                Some(ts) => {
                    item.first_seen_at = Some(ts);
                    if item.added.is_none() {
                        item.added = Some(format_iso(ts));
                    }
                }
                None => {
                    let _ = inner.db.execute(
                        "INSERT OR REPLACE INTO startup_seen (id, first_seen_at) VALUES (?1, ?2)",
                        rusqlite::params![item.id, now],
                    );
                    item.first_seen_at = Some(now);
                    if item.added.is_none() {
                        item.added = Some(format_iso(now));
                    }
                }
            }
        }
    }

    let enabled_count = items.iter().filter(|i| i.enabled).count();
    Ok(StartupListResult {
        total: items.len(),
        enabled_count,
        disabled_count: items.len() - enabled_count,
        items,
    })
}

#[tauri::command]
pub async fn system_toggle_startup_item(
    state: State<'_, SystemState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let items = tokio::task::spawn_blocking(scan_startup_items)
        .await
        .map_err(|error| format!("扫描启动项失败：{error}"))?;
    let item = items
        .into_iter()
        .find(|i| i.id == id)
        .ok_or_else(|| format!("未找到启动项：{}", id))?;

    write_startup_approved(&item, enabled)?;

    let now = now_ts();
    let title = format!(
        "{} {} 启动项",
        if enabled { "恢复" } else { "禁用" },
        item.name
    );
    let inner = state.0.lock().map_err(|e| format!("State lock: {}", e))?;
    let _ = inner.db.execute_batch(
        "CREATE TABLE IF NOT EXISTS startup_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, item_id TEXT NOT NULL, item_name TEXT NOT NULL, action TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS maintenance_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL);",
    );
    let _ = inner.db.execute(
        "INSERT INTO startup_changes (ts, item_id, item_name, action) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![now, item.id, item.name, if enabled { "enable" } else { "disable" }],
    );
    let _ = inner.db.execute(
        "INSERT INTO maintenance_events (ts, title, source, status) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![now, title, "用户操作", "成功"],
    );
    Ok(())
}

#[tauri::command]
pub async fn system_batch_toggle_startup_items(
    state: State<'_, SystemState>,
    ids: Vec<String>,
    enabled: bool,
) -> Result<usize, String> {
    let mut success = 0usize;
    for id in &ids {
        if system_toggle_startup_item(state.clone(), id.clone(), enabled)
            .await
            .is_ok()
        {
            success += 1;
        }
    }
    Ok(success)
}

#[tauri::command]
pub async fn system_get_boot_history() -> Result<BootHistoryResult, String> {
    let points = tokio::task::spawn_blocking(|| read_boot_durations(7))
        .await
        .map_err(|error| format!("读取启动耗时失败：{error}"))?;
    let last = points.last();
    let prev = if points.len() >= 2 {
        Some(&points[points.len() - 2])
    } else {
        None
    };
    Ok(BootHistoryResult {
        last_duration_ms: last.map(|p| p.duration_ms),
        last_delta_ms: match (last, prev) {
            (Some(l), Some(p)) => Some(l.duration_ms as i64 - p.duration_ms as i64),
            _ => None,
        },
        points,
    })
}

#[tauri::command]
pub async fn system_get_startup_changes(
    state: State<'_, SystemState>,
) -> Result<Vec<StartupChangeRecord>, String> {
    let inner = state.0.lock().map_err(|e| format!("State lock: {}", e))?;
    let _ = inner.db.execute(
        "CREATE TABLE IF NOT EXISTS startup_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, item_id TEXT NOT NULL, item_name TEXT NOT NULL, action TEXT NOT NULL)",
        [],
    );
    let mut stmt = inner
        .db
        .prepare("SELECT ts, item_id, item_name, action FROM startup_changes ORDER BY ts DESC LIMIT 20")
        .map_err(|e| format!("Failed to prepare: {}", e))?;
    let rows: Vec<StartupChangeRecord> = stmt
        .query_map([], |r| {
            Ok(StartupChangeRecord {
                ts: r.get(0)?,
                item_id: r.get(1)?,
                item_name: r.get(2)?,
                action: r.get(3)?,
            })
        })
        .map_err(|e| format!("Failed to query: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}
