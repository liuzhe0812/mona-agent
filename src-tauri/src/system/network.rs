// 网络优化套件：DNS 一键切换 / DNS 缓存刷新 / HOSTS 编辑器。
// DNS 切换通过 PowerShell Set-DnsClientServerAddress 对所有在线物理适配器生效，提权执行。
// HOSTS 编辑在写回前自动备份到同目录 .mona-backup-<ts>.bak，用 # Mona-Block 标记区分 Mona 创建的屏蔽条目。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use super::SystemState;

const HOSTS_MARKER: &str = "# Mona-Block";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsPreset {
    pub id: String,
    pub label: String,
    pub primary_v4: Option<String>,
    pub secondary_v4: Option<String>,
    pub primary_v6: Option<String>,
    pub secondary_v6: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsAdapterStatus {
    pub alias: String,
    pub servers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsStatusResult {
    pub adapters: Vec<DnsAdapterStatus>,
    pub active_servers: Vec<String>,
    pub active_preset_id: Option<String>,
    pub presets: Vec<DnsPreset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsApplyResult {
    pub applied_adapters: Vec<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsEntry {
    pub ip: String,
    pub domains: Vec<String>,
    pub blocked: bool,
    pub mona_managed: bool,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsListResult {
    pub entries: Vec<HostsEntry>,
    pub backup_files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsEditRequest {
    #[serde(default)]
    pub add: Vec<HostsPair>,
    #[serde(default)]
    pub remove: Vec<String>,
    #[serde(default)]
    pub block: Vec<String>,
    #[serde(default)]
    pub unblock: Vec<String>,
    #[serde(default)]
    pub include_www: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsPair {
    pub ip: String,
    pub domain: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostsEditResult {
    pub added: usize,
    pub removed: usize,
    pub blocked: usize,
    pub unblocked: usize,
    pub backup_path: Option<String>,
    pub detail: String,
}

pub fn dns_presets() -> Vec<DnsPreset> {
    vec![
        DnsPreset {
            id: "cloudflare".into(),
            label: "Cloudflare".into(),
            primary_v4: Some("1.1.1.1".into()),
            secondary_v4: Some("1.0.0.1".into()),
            primary_v6: Some("2606:4700:4700::1111".into()),
            secondary_v6: Some("2606:4700:4700::1001".into()),
        },
        DnsPreset {
            id: "google".into(),
            label: "Google".into(),
            primary_v4: Some("8.8.8.8".into()),
            secondary_v4: Some("8.8.4.4".into()),
            primary_v6: Some("2001:4860:4860::8888".into()),
            secondary_v6: Some("2001:4860:4860::8844".into()),
        },
        DnsPreset {
            id: "quad9".into(),
            label: "Quad9".into(),
            primary_v4: Some("9.9.9.9".into()),
            secondary_v4: Some("149.112.112.112".into()),
            primary_v6: Some("2620:fe::fe".into()),
            secondary_v6: Some("2620:fe::9".into()),
        },
        DnsPreset {
            id: "opendns".into(),
            label: "OpenDNS".into(),
            primary_v4: Some("208.67.222.222".into()),
            secondary_v4: Some("208.67.220.220".into()),
            primary_v6: Some("2620:119:35::35".into()),
            secondary_v6: Some("2620:119:53::53".into()),
        },
        DnsPreset {
            id: "adguard".into(),
            label: "Adguard".into(),
            primary_v4: Some("94.140.14.14".into()),
            secondary_v4: Some("94.140.15.15".into()),
            primary_v6: Some("2a10:50c0::ad1:ff".into()),
            secondary_v6: Some("2a10:50c0::ad2:ff".into()),
        },
        DnsPreset {
            id: "cleanbrowsing".into(),
            label: "CleanBrowsing".into(),
            primary_v4: Some("185.228.168.9".into()),
            secondary_v4: Some("185.228.169.9".into()),
            primary_v6: Some("2a0d:2a00:1::2".into()),
            secondary_v6: Some("2a0d:2a00:2::2".into()),
        },
        DnsPreset {
            id: "alternatedns".into(),
            label: "Alternate DNS".into(),
            primary_v4: Some("76.76.19.19".into()),
            secondary_v4: Some("76.223.122.150".into()),
            primary_v6: None,
            secondary_v6: None,
        },
    ]
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn hosts_path() -> PathBuf {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    PathBuf::from(system_root)
        .join("System32")
        .join("drivers")
        .join("etc")
        .join("hosts")
}

#[cfg(windows)]
fn run_elevated_powershell(script: &str, timeout_ms: u32) -> Result<(), String> {
    use base64::Engine;
    let bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let params = format!("-NoProfile -NonInteractive -EncodedCommand {encoded}");
    super::run_elevated("powershell.exe", &params, timeout_ms)
}

#[cfg(not(windows))]
fn run_elevated_powershell(_script: &str, _timeout_ms: u32) -> Result<(), String> {
    Err("仅支持 Windows".into())
}

/// 执行提权 PowerShell 脚本，并通过临时文件回传结果字符串。
/// 约定：脚本成功时把结果写入 $env:TEMP\mona-net-result.txt；失败时退出码非零。
fn run_elevated_powershell_capture(script: &str, timeout_ms: u32) -> Result<String, String> {
    let result_file = std::env::temp_dir().join("mona-net-result.txt");
    let _ = fs::remove_file(&result_file);
    run_elevated_powershell(script, timeout_ms)?;
    match fs::read_to_string(&result_file) {
        Ok(content) => Ok(content.trim().to_string()),
        Err(_) => Ok(String::new()),
    }
}

fn map_dns_error(error: &str) -> String {
    if error.contains("错误码 2") {
        "没有处于连接状态的物理网络适配器".into()
    } else if error.contains("错误码 3") {
        "没有适配器成功设置 DNS（可能权限不足或适配器不支持）".into()
    } else if error.contains("授权被取消") {
        "已取消管理员授权".into()
    } else {
        error.to_string()
    }
}

fn record_network_event(state: &State<'_, SystemState>, title: &str, status: &str, detail: &str) {
    if let Ok(inner) = state.0.lock() {
        let _ = inner.db.execute_batch(
            "CREATE TABLE IF NOT EXISTS network_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                title TEXT NOT NULL,
                mode TEXT NOT NULL,
                success INTEGER NOT NULL,
                detail TEXT NOT NULL
            );",
        );
        let success = if status == "成功" { 1 } else { 0 };
        let _ = inner.db.execute(
            "INSERT INTO network_operations (ts, title, mode, success, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![now_ts(), title, "network", success, detail],
        );
    }
}

// ===== DNS =====

fn preset_servers(preset: &DnsPreset, include_v6: bool) -> Vec<String> {
    let mut servers = Vec::new();
    if let Some(v4) = &preset.primary_v4 {
        servers.push(v4.clone());
    }
    if let Some(v4) = &preset.secondary_v4 {
        servers.push(v4.clone());
    }
    if include_v6 {
        if let Some(v6) = &preset.primary_v6 {
            servers.push(v6.clone());
        }
        if let Some(v6) = &preset.secondary_v6 {
            servers.push(v6.clone());
        }
    }
    servers
}

fn match_preset(active: &[String], presets: &[DnsPreset]) -> Option<String> {
    let normalized: Vec<String> = active.iter().map(|s| s.to_lowercase()).collect();
    for preset in presets {
        let v4_only = preset_servers(preset, false);
        let with_v6 = preset_servers(preset, true);
        let v4_norm: Vec<String> = v4_only.iter().map(|s| s.to_lowercase()).collect();
        let v6_norm: Vec<String> = with_v6.iter().map(|s| s.to_lowercase()).collect();
        if normalized == v4_norm || normalized == v6_norm {
            return Some(preset.id.clone());
        }
    }
    None
}

#[cfg(windows)]
fn read_dns_status_inner() -> Result<(Vec<DnsAdapterStatus>, Vec<String>), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = "Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses.Count -gt 0 } | ForEach-Object { $_.InterfaceAlias + '|' + ($_.ServerAddresses -join ',') }";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("读取 DNS 状态失败：{error}"))?;
    let stdout = super::decode_windows_output(&output.stdout);
    let mut adapters = Vec::new();
    let mut all_servers = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if let Some((alias, servers_str)) = line.split_once('|') {
            let servers: Vec<String> = servers_str
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !servers.is_empty() {
                for s in &servers {
                    if !all_servers.contains(s) {
                        all_servers.push(s.clone());
                    }
                }
                adapters.push(DnsAdapterStatus {
                    alias: alias.trim().to_string(),
                    servers,
                });
            }
        }
    }
    Ok((adapters, all_servers))
}

#[cfg(not(windows))]
fn read_dns_status_inner() -> Result<(Vec<DnsAdapterStatus>, Vec<String>), String> {
    Err("仅支持 Windows".into())
}

#[tauri::command]
pub async fn system_list_dns_presets() -> Result<Vec<DnsPreset>, String> {
    Ok(dns_presets())
}

#[tauri::command]
pub async fn system_get_dns_status() -> Result<DnsStatusResult, String> {
    let presets = dns_presets();
    let result = tokio::task::spawn_blocking(read_dns_status_inner)
        .await
        .map_err(|error| format!("DNS 状态任务失败：{error}"))?;
    let (adapters, active_servers) = result?;
    let active_preset_id = match_preset(&active_servers, &presets);
    Ok(DnsStatusResult {
        adapters,
        active_preset_id,
        active_servers,
        presets,
    })
}

#[tauri::command]
pub async fn system_set_dns(
    state: State<'_, SystemState>,
    preset_id: Option<String>,
    custom_v4: Option<Vec<String>>,
) -> Result<DnsApplyResult, String> {
    let servers: Vec<String> = if let Some(id) = preset_id {
        let preset = dns_presets()
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("未知 DNS 预设：{id}"))?;
        preset_servers(&preset, false)
    } else if let Some(v4) = custom_v4 {
        v4
    } else {
        return Err("必须提供 presetId 或 customV4".into());
    };
    if servers.is_empty() {
        return Err("DNS 服务器列表为空".into());
    }

    let servers_ps = servers
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "$adapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object {{ $_.Status -eq 'Up' }}; if (-not $adapters) {{ exit 2 }}; $names = @(); foreach ($a in $adapters) {{ try {{ Set-DnsClientServerAddress -InterfaceAlias $a.Name -ServerAddresses @({servers_ps}) -ErrorAction Stop; $names += $a.Name }} catch {{}} }}; if ($names.Count -eq 0) {{ exit 3 }}; ($names -join '|') | Out-File -FilePath $env:TEMP\\mona-net-result.txt -Encoding utf8 -Force"
    );

    let result = tokio::task::spawn_blocking(move || run_elevated_powershell_capture(&script, 60_000))
        .await
        .map_err(|error| format!("DNS 设置任务失败：{error}"))?;

    let (applied, detail, status) = match result {
        Ok(msg) => {
            let names: Vec<String> = msg.split('|').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            let detail = if names.is_empty() { "已设置 DNS".into() } else { format!("已对 {} 个适配器设置 DNS：{}", names.len(), names.join("、")) };
            (names, detail, "成功")
        }
        Err(error) => (Vec::new(), map_dns_error(&error), "失败"),
    };

    let title = format!("切换 DNS 为 {}", servers.join(" / "));
    record_network_event(&state, &title, status, &detail);

    if status == "成功" {
        Ok(DnsApplyResult { applied_adapters: applied, detail })
    } else {
        Err(detail)
    }
}

#[tauri::command]
pub async fn system_reset_dns(state: State<'_, SystemState>) -> Result<DnsApplyResult, String> {
    let script = "$adapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' }; if (-not $adapters) { exit 2 }; $names = @(); foreach ($a in $adapters) { try { Set-DnsClientServerAddress -InterfaceAlias $a.Name -ResetServerAddresses -ErrorAction Stop; $names += $a.Name } catch {} }; if ($names.Count -eq 0) { exit 3 }; ($names -join '|') | Out-File -FilePath $env:TEMP\\mona-net-result.txt -Encoding utf8 -Force";

    let result = tokio::task::spawn_blocking(move || run_elevated_powershell_capture(script, 60_000))
        .await
        .map_err(|error| format!("DNS 重置任务失败：{error}"))?;

    let (applied, detail, status) = match result {
        Ok(msg) => {
            let names: Vec<String> = msg.split('|').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            let detail = if names.is_empty() { "已重置 DNS".into() } else { format!("已重置 {} 个适配器的 DNS（恢复 DHCP）", names.len()) };
            (names, detail, "成功")
        }
        Err(error) => (Vec::new(), map_dns_error(&error), "失败"),
    };

    let title = "重置 DNS 为 DHCP 自动获取".to_string();
    record_network_event(&state, &title, status, &detail);

    if status == "成功" {
        Ok(DnsApplyResult { applied_adapters: applied, detail })
    } else {
        Err(detail)
    }
}

// ===== HOSTS 编辑器 =====

fn parse_hosts_line(raw: &str) -> Option<HostsEntry> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let (content_part, mona_managed) = if let Some(idx) = trimmed.find(HOSTS_MARKER) {
        (trimmed[..idx].trim_end(), true)
    } else {
        (trimmed, false)
    };
    let mut parts = content_part.split_whitespace();
    let ip = parts.next()?.to_string();
    let domains: Vec<String> = parts.map(|s| s.to_string()).collect();
    if ip.is_empty() || domains.is_empty() {
        return None;
    }
    let blocked = ip == "0.0.0.0"
        || (ip == "127.0.0.1" && !domains.iter().any(|d| d.eq_ignore_ascii_case("localhost")));
    Some(HostsEntry {
        ip,
        domains,
        blocked,
        mona_managed,
        raw: raw.to_string(),
    })
}

fn parse_hosts_content(content: &str) -> Vec<HostsEntry> {
    content
        .lines()
        .filter_map(parse_hosts_line)
        .collect()
}

fn expand_domain(domain: &str, include_www: bool) -> Vec<String> {
    if include_www && !domain.starts_with("www.") {
        vec![domain.to_string(), format!("www.{domain}")]
    } else {
        vec![domain.to_string()]
    }
}

fn build_hosts_block(domain: &str, include_www: bool) -> String {
    let domains = expand_domain(domain, include_www);
    format!("0.0.0.0  {}  {HOSTS_MARKER}", domains.join(" "))
}

fn build_hosts_add(ip: &str, domain: &str, include_www: bool) -> String {
    let domains = expand_domain(domain, include_www);
    format!("{ip}  {}", domains.join(" "))
}

fn apply_hosts_edit(content: &str, request: &HostsEditRequest) -> (String, HostsEditResult) {
    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
    let mut added = 0usize;
    let mut removed = 0usize;
    let mut blocked = 0usize;
    let mut unblocked = 0usize;

    // remove: 删除包含该域名的条目行（非 block 行）
    for domain in &request.remove {
        let target = domain.to_lowercase();
        lines.retain(|line| {
            if let Some(entry) = parse_hosts_line(line) {
                if !entry.blocked && entry.domains.iter().any(|d| d.to_lowercase() == target) {
                    removed += 1;
                    return false;
                }
            }
            true
        });
    }

    // unblock: 删除包含该域名的 block 行（Mona 创建的）
    for domain in &request.unblock {
        let target = domain.to_lowercase();
        let targets: Vec<String> = expand_domain(domain, request.include_www)
            .into_iter()
            .map(|d| d.to_lowercase())
            .collect();
        lines.retain(|line| {
            if let Some(entry) = parse_hosts_line(line) {
                if entry.blocked && entry.mona_managed
                    && entry.domains.iter().any(|d| targets.contains(&d.to_lowercase()))
                {
                    unblocked += 1;
                    return false;
                }
            }
            true
        });
    }

    // block: 追加 block 行（如果不存在）
    for domain in &request.block {
        let targets: Vec<String> = expand_domain(domain, request.include_www)
            .into_iter()
            .map(|d| d.to_lowercase())
            .collect();
        let already = lines.iter().any(|line| {
            parse_hosts_line(line).is_some_and(|entry| {
                entry.blocked
                    && entry.mona_managed
                    && entry.domains.iter().any(|d| targets.contains(&d.to_lowercase()))
            })
        });
        if !already {
            lines.push(build_hosts_block(domain, request.include_www));
            blocked += 1;
        }
    }

    // add: 追加普通条目（如果不存在）
    for pair in &request.add {
        let target = pair.domain.to_lowercase();
        let already = lines.iter().any(|line| {
            parse_hosts_line(line).is_some_and(|entry| {
                !entry.blocked && entry.domains.iter().any(|d| d.to_lowercase() == target)
            })
        });
        if !already {
            lines.push(build_hosts_add(&pair.ip, &pair.domain, request.include_www));
            added += 1;
        }
    }

    let mut new_content = lines.join("\n");
    if !new_content.is_empty() && !content.ends_with('\n') {
        new_content.push('\n');
    } else if !new_content.ends_with('\n') {
        new_content.push('\n');
    }

    let detail = if added == 0 && removed == 0 && blocked == 0 && unblocked == 0 {
        "没有需要变更的条目".to_string()
    } else {
        format!("新增 {added}、删除 {removed}、屏蔽 {blocked}、解除屏蔽 {unblocked}")
    };

    (
        new_content,
        HostsEditResult {
            added,
            removed,
            blocked,
            unblocked,
            backup_path: None,
            detail,
        },
    )
}

fn list_hosts_backups(hosts_file: &PathBuf) -> Vec<String> {
    let parent = hosts_file.parent();
    let Some(dir) = parent else { return Vec::new() };
    let prefix = "hosts.mona-backup-";
    let mut backups = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(prefix) && name.ends_with(".bak") {
                backups.push(entry.path().to_string_lossy().to_string());
            }
        }
    }
    backups.sort();
    backups.reverse();
    backups
}

#[tauri::command]
pub async fn system_list_hosts_entries() -> Result<HostsListResult, String> {
    let path = hosts_path();
    let result = tokio::task::spawn_blocking(move || {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("读取 HOSTS 文件失败：{error}"))?;
        let entries = parse_hosts_content(&content);
        let backups = list_hosts_backups(&path);
        Ok::<_, String>((entries, backups))
    })
    .await
    .map_err(|error| format!("HOSTS 读取任务失败：{error}"))?;
    let (entries, backup_files) = result?;
    Ok(HostsListResult { entries, backup_files })
}

#[tauri::command]
pub async fn system_edit_hosts(
    state: State<'_, SystemState>,
    request: HostsEditRequest,
) -> Result<HostsEditResult, String> {
    let path = hosts_path();
    let result = tokio::task::spawn_blocking(move || {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("读取 HOSTS 文件失败：{error}"))?;
        let (new_content, mut result) = apply_hosts_edit(&content, &request);

        if result.added == 0 && result.removed == 0 && result.blocked == 0 && result.unblocked == 0 {
            result.detail = "没有需要变更的条目".into();
            return Ok::<_, String>(result);
        }

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup_name = format!("hosts.mona-backup-{timestamp}.bak");
        let backup_path = path.with_file_name(backup_name);

        // 提权写回：先备份，再 Set-Content
        use base64::Engine;
        let path_str = path.to_string_lossy().replace('\'', "''");
        let backup_str = backup_path.to_string_lossy().replace('\'', "''");
        let content_b64 = base64::engine::general_purpose::STANDARD.encode(new_content.as_bytes());
        let script = format!(
            "try {{ Copy-Item -LiteralPath '{path_str}' -Destination '{backup_str}' -Force -ErrorAction Stop; [System.IO.File]::WriteAllText('{path_str}', [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{content_b64}')), [System.Text.Encoding]::UTF8); 'OK' }} catch {{ $_.Exception.Message }}",
        );

        let write_result = run_elevated_powershell(&script, 30_000);
        match write_result {
            Ok(_) => {
                result.backup_path = Some(backup_path.to_string_lossy().to_string());
                Ok(result)
            }
            Err(error) => Err(format!("写回 HOSTS 失败：{error}")),
        }
    })
    .await
    .map_err(|error| format!("HOSTS 编辑任务失败：{error}"))?;

    match result {
        Ok(result) => {
            let status = if result.detail.contains("失败") { "失败" } else { "成功" };
            let title = format!(
                "编辑 HOSTS（{}）",
                result.detail
            );
            record_network_event(&state, &title, status, &result.detail);
            Ok(result)
        }
        Err(error) => {
            record_network_event(&state, "编辑 HOSTS", "失败", &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn system_restore_hosts_backup(
    state: State<'_, SystemState>,
    backup_path: String,
) -> Result<HostsEditResult, String> {
    let hosts = hosts_path();
    let result = tokio::task::spawn_blocking(move || {
        let backup = PathBuf::from(&backup_path);
        if !backup.exists() {
            return Err(format!("备份文件不存在：{backup_path}"));
        }
        let path_str = hosts.to_string_lossy().replace('\'', "''");
        let backup_str = backup.to_string_lossy().replace('\'', "''");
        let script = format!(
            "try {{ Copy-Item -LiteralPath '{backup_str}' -Destination '{path_str}' -Force -ErrorAction Stop; 'OK' }} catch {{ $_.Exception.Message }}",
        );
        match run_elevated_powershell(&script, 30_000) {
            Ok(_) => Ok::<_, String>(HostsEditResult {
                added: 0,
                removed: 0,
                blocked: 0,
                unblocked: 0,
                backup_path: Some(backup_path.clone()),
                detail: format!("已从备份恢复 HOSTS：{backup_path}"),
            }),
            Err(error) => Err(format!("恢复 HOSTS 备份失败：{error}")),
        }
    })
    .await
    .map_err(|error| format!("HOSTS 恢复任务失败：{error}"))?;

    match result {
        Ok(result) => {
            record_network_event(&state, "恢复 HOSTS 备份", "成功", &result.detail);
            Ok(result)
        }
        Err(error) => {
            record_network_event(&state, "恢复 HOSTS 备份", "失败", &error);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_hosts_edit, dns_presets, expand_domain, match_preset, parse_hosts_content,
        parse_hosts_line, preset_servers, HostsEditRequest, HostsPair, HOSTS_MARKER,
    };

    #[test]
    fn dns_presets_have_unique_ids_and_at_least_one_v4() {
        let presets = dns_presets();
        assert!(presets.len() >= 5);
        let mut ids: Vec<String> = presets.iter().map(|p| p.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), presets.len());
        for preset in &presets {
            assert!(preset.primary_v4.is_some(), "preset {} missing v4", preset.id);
        }
    }

    #[test]
    fn matches_cloudflare_preset_case_insensitively() {
        let presets = dns_presets();
        let active = vec!["1.1.1.1".to_string(), "1.0.0.1".to_string()];
        assert_eq!(match_preset(&active, &presets), Some("cloudflare".into()));
        let active_upper = vec!["1.1.1.1".to_uppercase(), "1.0.0.1".to_uppercase()];
        assert_eq!(match_preset(&active_upper, &presets), Some("cloudflare".into()));
    }

    #[test]
    fn returns_none_for_custom_dns() {
        let presets = dns_presets();
        let active = vec!["8.8.8.8".to_string(), "1.1.1.1".to_string()];
        assert_eq!(match_preset(&active, &presets), None);
    }

    #[test]
    fn preset_servers_skips_v6_when_disabled() {
        let presets = dns_presets();
        let cloudflare = presets.iter().find(|p| p.id == "cloudflare").unwrap();
        let v4_only = preset_servers(cloudflare, false);
        assert_eq!(v4_only, vec!["1.1.1.1", "1.0.0.1"]);
        let with_v6 = preset_servers(cloudflare, true);
        assert_eq!(with_v6.len(), 4);
    }

    #[test]
    fn skips_comment_and_blank_lines_when_parsing_hosts() {
        let content = "# comment line\n\n127.0.0.1  localhost\n0.0.0.0  ads.example.com  # Mona-Block\n";
        let entries = parse_hosts_content(content);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].ip, "127.0.0.1");
        assert!(!entries[0].blocked);
        assert!(!entries[0].mona_managed);
        assert_eq!(entries[1].ip, "0.0.0.0");
        assert!(entries[1].blocked);
        assert!(entries[1].mona_managed);
    }

    #[test]
    fn parse_hosts_line_returns_none_for_empty_or_comment() {
        assert!(parse_hosts_line("").is_none());
        assert!(parse_hosts_line("# pure comment").is_none());
        assert!(parse_hosts_line("   ").is_none());
    }

    #[test]
    fn expands_domain_with_www_prefix() {
        let no_www = expand_domain("example.com", false);
        assert_eq!(no_www, vec!["example.com"]);
        let with_www = expand_domain("example.com", true);
        assert_eq!(with_www, vec!["example.com", "www.example.com"]);
        let already_www = expand_domain("www.example.com", true);
        assert_eq!(already_www, vec!["www.example.com"]);
    }

    #[test]
    fn block_adds_mona_marker_line() {
        let content = "127.0.0.1  localhost\n";
        let request = HostsEditRequest {
            add: vec![],
            remove: vec![],
            block: vec!["ads.example.com".into()],
            unblock: vec![],
            include_www: true,
        };
        let (new_content, result) = apply_hosts_edit(content, &request);
        assert_eq!(result.blocked, 1);
        assert!(new_content.contains("0.0.0.0  ads.example.com www.ads.example.com"));
        assert!(new_content.contains(HOSTS_MARKER));
    }

    #[test]
    fn block_is_idempotent() {
        let content = format!("0.0.0.0  ads.example.com  {HOSTS_MARKER}\n");
        let request = HostsEditRequest {
            add: vec![],
            remove: vec![],
            block: vec!["ads.example.com".into()],
            unblock: vec![],
            include_www: false,
        };
        let (_, result) = apply_hosts_edit(&content, &request);
        assert_eq!(result.blocked, 0);
    }

    #[test]
    fn unblock_removes_matching_mona_line() {
        let content = format!("0.0.0.0  ads.example.com  {HOSTS_MARKER}\n127.0.0.1  localhost\n");
        let request = HostsEditRequest {
            add: vec![],
            remove: vec![],
            block: vec![],
            unblock: vec!["ads.example.com".into()],
            include_www: false,
        };
        let (new_content, result) = apply_hosts_edit(&content, &request);
        assert_eq!(result.unblocked, 1);
        assert!(!new_content.contains("ads.example.com"));
        assert!(new_content.contains("localhost"));
    }

    #[test]
    fn add_inserts_new_entry_without_duplicating() {
        let content = "127.0.0.1  localhost\n";
        let request = HostsEditRequest {
            add: vec![HostsPair { ip: "192.168.1.5".into(), domain: "test.local".into() }],
            remove: vec![],
            block: vec![],
            unblock: vec![],
            include_www: false,
        };
        let (new_content, result) = apply_hosts_edit(content, &request);
        assert_eq!(result.added, 1);
        assert!(new_content.contains("192.168.1.5  test.local"));
        // 再次添加不会重复
        let (_, result2) = apply_hosts_edit(&new_content, &request);
        assert_eq!(result2.added, 0);
    }

    #[test]
    fn remove_deletes_non_blocked_matching_line() {
        let content = "192.168.1.5  test.local\n127.0.0.1  localhost\n";
        let request = HostsEditRequest {
            add: vec![],
            remove: vec!["test.local".into()],
            block: vec![],
            unblock: vec![],
            include_www: false,
        };
        let (new_content, result) = apply_hosts_edit(content, &request);
        assert_eq!(result.removed, 1);
        assert!(!new_content.contains("test.local"));
        assert!(new_content.contains("localhost"));
    }

    #[test]
    fn empty_request_makes_no_changes() {
        let content = "127.0.0.1  localhost\n";
        let request = HostsEditRequest {
            add: vec![],
            remove: vec![],
            block: vec![],
            unblock: vec![],
            include_www: false,
        };
        let (_, result) = apply_hosts_edit(content, &request);
        assert_eq!(result.added + result.removed + result.blocked + result.unblocked, 0);
        assert!(result.detail.contains("没有需要变更"));
    }
}
