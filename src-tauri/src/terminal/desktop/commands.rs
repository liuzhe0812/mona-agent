use std::sync::Arc;

use crate::terminal::config::ConnectionConfig;
use crate::terminal::credential_store;
use crate::terminal::error::TerminalError;
use crate::terminal::session::{Session, SessionHandle, SessionStatus, SessionType};
use crate::terminal::ssh::client::SshClient;
use crate::terminal::TerminalState;
use tauri::{AppHandle, State};

use super::types::*;

fn format_bytes(bytes: u64, decimals: u32) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    let k = 1024u64;
    let dm = if decimals < 1 { 0 } else { decimals };
    let sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
    let i = ((bytes as f64).ln() / (k as f64).ln()) as usize;
    let i = i.min(sizes.len() - 1);
    let size = (bytes as f64) / (k.pow(i as u32) as f64);
    format!("{:.1$} {2}", size, dm as usize, sizes[i])
}

fn safe_parse_int(val: &str) -> i64 {
    val.trim().parse().unwrap_or(0)
}

fn safe_parse_float(val: &str) -> f64 {
    val.trim().parse().unwrap_or(0.0)
}

async fn get_desktop_client(
    state: &State<'_, TerminalState>,
    session_id: &str,
) -> Result<Arc<SshClient>, String> {
    let handle = state
        .manager
        .get_handle(session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()).to_string())?;
    match handle {
        SessionHandle::Desktop(client) | SessionHandle::Ssh(client) => Ok(client),
        _ => Err("Not a desktop session".into()),
    }
}

async fn exec_command(client: &SshClient, cmd: &str) -> Result<String, String> {
    let result = client.exec_command(cmd).await.map_err(|e| e.to_string())?;
    if result.stdout.is_empty() && !result.stderr.is_empty() {
        Ok(result.stderr)
    } else {
        Ok(result.stdout)
    }
}

async fn safe_exec(client: &SshClient, cmd: &str) -> String {
    exec_command(client, cmd).await.unwrap_or_default()
}

#[tauri::command]
pub async fn desktop_connect(
    state: State<'_, TerminalState>,
    config: ConnectionConfig,
) -> Result<String, String> {
    let config = ConnectionConfig {
        auth: credential_store::restore_credential(
            &config.auth,
            &config.host,
            config.port,
            &config.username,
        )
        .map_err(|e| e)?,
        ..config
    };

    let session_id = uuid::Uuid::new_v4().to_string();

    let client = SshClient::connect(
        &config.host,
        config.port,
        &config.username,
        &config.auth,
        state.known_hosts.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;

    let session = Session {
        id: session_id.clone(),
        config_id: config.id.clone(),
        session_type: SessionType::Desktop,
        status: SessionStatus::Connected,
        target_label: format!("{}@{}:{}", config.username, config.host, config.port),
        created_at: chrono::Utc::now(),
    };

    state
        .manager
        .create(session, SessionHandle::Desktop(Arc::new(client)))
        .await
        .map_err(|e| e.to_string())?;

    Ok(session_id)
}

#[tauri::command]
pub async fn desktop_disconnect(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    match handle {
        SessionHandle::Desktop(client) => {
            client.disconnect().await.map_err(|e| e.to_string())?;
        }
        _ => return Err("Not a desktop session".into()),
    }

    state
        .manager
        .update_status(&session_id, SessionStatus::Disconnected)
        .await
        .map_err(|e| e.to_string())?;
    state.manager.remove(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn desktop_exec(
    state: State<'_, TerminalState>,
    session_id: String,
    command: String,
) -> Result<String, String> {
    let client = get_desktop_client(&state, &session_id).await?;
    exec_command(&client, &command).await
}

#[tauri::command]
pub async fn desktop_list_files(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<DesktopFileListResult, String> {
    let client = get_desktop_client(&state, &session_id).await?;

    let cmd = if path == "/" || path.is_empty() {
        r#"ls -la --time-style=long-iso /"#.to_string()
    } else {
        format!(r#"ls -la --time-style=long-iso '{}'"#, path)
    };

    let output = exec_command(&client, &cmd).await?;

    let mut files = Vec::new();
    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 8 {
            continue;
        }

        let permissions = parts[0];
        let is_dir = permissions.starts_with('d');
        let is_symlink = permissions.starts_with('l');
        let size = safe_parse_int(parts[4]) as u64;

        let (name, link_target) = if is_symlink {
            if let Some(arrow_pos) = parts.iter().position(|&p| p == "->") {
                let name_parts = if arrow_pos > 7 {
                    &parts[7..arrow_pos]
                } else {
                    &parts[7..7]
                };
                let target_parts = &parts[arrow_pos + 1..];
                (name_parts.join(" "), Some(target_parts.join(" ")))
            } else {
                (parts[7..].join(" "), None)
            }
        } else {
            (parts[7..].join(" "), None)
        };

        if name == "." || name == ".." {
            continue;
        }

        let file_path = if path == "/" {
            format!("/{}", name)
        } else {
            format!("{}/{}", path, name)
        };

        let file_type = if is_dir {
            "folder".to_string()
        } else if is_symlink {
            if let Some(ref target) = link_target {
                if !target.contains('.') || target.ends_with('/') {
                    "folder".to_string()
                } else {
                    "file".to_string()
                }
            } else {
                "file".to_string()
            }
        } else {
            "file".to_string()
        };

        files.push(DesktopFileItem {
            name: name.clone(),
            file_type,
            size: format_bytes(size, 2),
            raw_size: size,
            modified: format!("{} {}", parts[5], parts[6]),
            path: file_path,
            mode: permissions.chars().skip(1).collect(),
            owner: parts[2].to_string(),
            is_symlink,
        });
    }

    files.sort_by(|a, b| {
        if a.file_type == b.file_type {
            a.name.cmp(&b.name)
        } else if a.file_type == "folder" {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(DesktopFileListResult {
        path: path.clone(),
        files,
    })
}

#[tauri::command]
pub async fn desktop_get_file_content(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<DesktopFileContentResult, String> {
    let client = get_desktop_client(&state, &session_id).await?;
    let cmd = format!("cat '{}'", path);
    let content = exec_command(&client, &cmd).await?;
    Ok(DesktopFileContentResult { content })
}

#[tauri::command]
pub async fn desktop_save_file_content(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let client = get_desktop_client(&state, &session_id).await?;
    let escaped_content = content.replace('\\', "\\\\").replace("'", "'\"'\"'");
    let cmd = format!("echo '{}' > '{}'", escaped_content, path);
    exec_command(&client, &cmd).await?;
    Ok(())
}

#[tauri::command]
pub async fn desktop_get_system_info(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<DesktopSystemInfo, String> {
    let client = get_desktop_client(&state, &session_id).await?;

    let snapshot_cmd = concat!(
        "cat /proc/loadavg && echo '===SEP===' && ",
        "cat /proc/cpuinfo | grep -E 'model name|cpu MHz' | head -2 && echo '===SEP===' && ",
        "nproc && echo '===SEP===' && ",
        "free -b && echo '===SEP===' && ",
        "df -B1 --output=source,fstype,size,used,avail,pcent,target -x tmpfs -x devtmpfs"
    );
    let snapshot_data = safe_exec(&client, snapshot_cmd).await;

    let (disk_io_first, net_io_first, cpu_stat_first) = tokio::join!(
        safe_exec(&client, "cat /proc/diskstats"),
        safe_exec(&client, "cat /proc/net/dev"),
        safe_exec(&client, "cat /proc/stat | head -1")
    );

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    let (disk_io_second, net_io_second, cpu_stat_second, proc_info, pidstat_output) = tokio::join!(
        safe_exec(&client, "cat /proc/diskstats"),
        safe_exec(&client, "cat /proc/net/dev"),
        safe_exec(&client, "cat /proc/stat | head -1"),
        safe_exec(
            &client,
            "ps -eo pid,stat,%cpu,%mem,comm --sort=-%cpu | head -101"
        ),
        safe_exec(&client, "pidstat -d 1 1")
    );

    let snapshot_parts: Vec<&str> = snapshot_data.split("===SEP===\n").collect();
    let loadavg_info = snapshot_parts.get(0).unwrap_or(&"").to_string();
    let cpu_info = snapshot_parts.get(1).unwrap_or(&"").to_string();
    let cores_str = snapshot_parts.get(2).unwrap_or(&"1").to_string();
    let mem_info = snapshot_parts.get(3).unwrap_or(&"").to_string();
    let disk_info = snapshot_parts.get(4).unwrap_or(&"").to_string();

    let mut process_disk_io: std::collections::HashMap<u32, String> =
        std::collections::HashMap::new();
    if !pidstat_output.is_empty() {
        let lines: Vec<&str> = pidstat_output.split('\n').collect();
        let mut headers: Vec<&str> = Vec::new();
        let mut header_found = false;

        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("Average:") {
                continue;
            }

            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if !header_found {
                if parts.contains(&"PID")
                    && (parts.contains(&"kB_rd/s") || parts.contains(&"kB_read/s"))
                {
                    headers = parts;
                    header_found = true;
                }
                continue;
            }

            let pid_idx = headers.iter().position(|&h| h == "PID");
            let rd_idx = headers
                .iter()
                .position(|&h| h == "kB_rd/s")
                .or_else(|| headers.iter().position(|&h| h == "kB_read/s"));
            let wr_idx = headers
                .iter()
                .position(|&h| h == "kB_wr/s")
                .or_else(|| headers.iter().position(|&h| h == "kB_write/s"));

            if let (Some(pid_i), Some(rd_i), Some(wr_i)) = (pid_idx, rd_idx, wr_idx) {
                if let Some(pid_str) = parts.get(pid_i) {
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        let rd_rate = parts
                            .get(rd_i)
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        let wr_rate = parts
                            .get(wr_i)
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        if rd_rate > 0.0 || wr_rate > 0.0 {
                            let total_rate_bytes = (rd_rate + wr_rate) * 1024.0;
                            process_disk_io.insert(
                                pid,
                                format!("{}/s", format_bytes(total_rate_bytes as u64, 2)),
                            );
                        }
                    }
                }
            }
        }
    }

    let mut load1 = 0.0;
    let mut load5 = 0.0;
    let mut load15 = 0.0;
    let loadavg_parts: Vec<&str> = loadavg_info.split_whitespace().collect();
    if loadavg_parts.len() >= 3 {
        load1 = loadavg_parts[0].parse().unwrap_or(0.0);
        load5 = loadavg_parts[1].parse().unwrap_or(0.0);
        load15 = loadavg_parts[2].parse().unwrap_or(0.0);
    }

    let mut load_user = 0.0;
    let mut load_system = 0.0;
    let mut current_load = 0.0;

    fn parse_cpu_stat(stat_line: &str) -> Option<Vec<u64>> {
        let parts: Vec<&str> = stat_line.split_whitespace().collect();
        if parts.is_empty() || parts[0] != "cpu" {
            return None;
        }
        Some(
            parts
                .iter()
                .skip(1)
                .map(|s| s.parse().unwrap_or(0))
                .collect(),
        )
    }

    if let (Some(first_vals), Some(second_vals)) = (
        parse_cpu_stat(&cpu_stat_first),
        parse_cpu_stat(&cpu_stat_second),
    ) {
        if first_vals.len() >= 4 && second_vals.len() >= 4 {
            let user_diff = second_vals[0].saturating_sub(first_vals[0]);
            let nice_diff = second_vals
                .get(1)
                .unwrap_or(&0)
                .saturating_sub(*first_vals.get(1).unwrap_or(&0));
            let system_diff = second_vals[2].saturating_sub(first_vals[2]);
            let idle_diff = second_vals[3].saturating_sub(first_vals[3]);
            let iowait_diff = second_vals
                .get(4)
                .unwrap_or(&0)
                .saturating_sub(*first_vals.get(4).unwrap_or(&0));
            let irq_diff = second_vals
                .get(5)
                .unwrap_or(&0)
                .saturating_sub(*first_vals.get(5).unwrap_or(&0));
            let softirq_diff = second_vals
                .get(6)
                .unwrap_or(&0)
                .saturating_sub(*first_vals.get(6).unwrap_or(&0));
            let steal_diff = second_vals
                .get(7)
                .unwrap_or(&0)
                .saturating_sub(*first_vals.get(7).unwrap_or(&0));

            let total = user_diff
                + nice_diff
                + system_diff
                + idle_diff
                + iowait_diff
                + irq_diff
                + softirq_diff
                + steal_diff;
            if total > 0 {
                load_user = ((user_diff + nice_diff) as f64 / total as f64) * 100.0;
                load_system = (system_diff as f64 / total as f64) * 100.0;
                current_load = load_user + load_system;
            }
        }
    }

    let cpu_brand = cpu_info
        .lines()
        .find(|l| l.contains("model name"))
        .and_then(|l| l.split(':').nth(1))
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| "Unknown CPU".to_string());

    let cpu_speed_mhz = cpu_info
        .lines()
        .find(|l| l.contains("cpu MHz"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0.0);
    let cpu_speed_ghz = cpu_speed_mhz / 1000.0;

    let cores = cores_str.trim().parse().unwrap_or(1);

    let mut mem_total = 0u64;
    let mut mem_used = 0u64;
    let mut mem_free = 0u64;
    let mut mem_buffcache = 0u64;
    let mut mem_available = 0u64;

    for line in mem_info.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        if parts[0] == "Mem:" {
            if parts.len() >= 2 {
                mem_total = safe_parse_int(parts[1]) as u64;
            }
            if parts.len() >= 3 {
                mem_used = safe_parse_int(parts[2]) as u64;
            }
            if parts.len() >= 4 {
                mem_free = safe_parse_int(parts[3]) as u64;
            }
            if parts.len() >= 6 {
                mem_buffcache = safe_parse_int(parts[5]) as u64;
            }
            if parts.len() >= 7 {
                mem_available = safe_parse_int(parts[6]) as u64;
            }
        }
    }

    let mem_used_percent = if mem_total > 0 {
        ((mem_used as f64 / mem_total as f64) * 100.0 * 100.0).round() / 100.0
    } else {
        0.0
    };

    let mut disks = Vec::new();
    let mut r_io_total = 0u64;
    let mut w_io_total = 0u64;

    let mut mount_usage: Vec<(String, String, u64, u64, u64, String)> = Vec::new();
    for line in disk_info.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 7 {
            let source = parts[0].to_string();
            if !source.starts_with("/dev/") {
                continue;
            }
            let mount = parts[6].to_string();
            if mount.starts_with("/sys") || mount.starts_with("/proc") {
                continue;
            }
            mount_usage.push((
                source,
                parts[1].to_string(),
                safe_parse_int(parts[2]) as u64,
                safe_parse_int(parts[3]) as u64,
                safe_parse_int(parts[4]) as u64,
                mount,
            ));
        }
    }

    let mut disk_io_first_map: std::collections::HashMap<String, (u64, u64, u64)> =
        std::collections::HashMap::new();
    let mut disk_io_second_map: std::collections::HashMap<String, (u64, u64, u64)> =
        std::collections::HashMap::new();
    let mut total_io_ms_first: u64 = 0;
    let mut total_io_ms_second: u64 = 0;

    fn is_physical_disk(name: &str) -> bool {
        if name.starts_with("sd")
            || name.starts_with("vd")
            || name.starts_with("xvd")
            || name.starts_with("hd")
        {
            let suffix = &name[2..];
            return suffix
                .chars()
                .all(|c| c.is_ascii_alphabetic() && c.is_ascii_lowercase());
        }
        if name.starts_with("nvme") {
            return name.contains('n') && !name.contains('p');
        }
        if name.starts_with("mmcblk") {
            let suffix = &name[6..];
            return suffix.chars().next().map_or(false, |c| c.is_ascii_digit());
        }
        if name.starts_with("md") || name.starts_with("dm-") {
            return true;
        }
        false
    }

    for line in disk_io_first.lines() {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.len() >= 13 {
            let name = parts[2];
            if name.starts_with("loop") || name.starts_with("ram") {
                continue;
            }
            let is_physical = is_physical_disk(name);

            if is_physical {
                let r_sect = safe_parse_int(parts[5]) as u64;
                let w_sect = safe_parse_int(parts[9]) as u64;
                let io_ms = safe_parse_int(parts[12]) as u64;
                let r_bytes = r_sect * 512;
                let w_bytes = w_sect * 512;
                disk_io_first_map.insert(name.to_string(), (r_bytes, w_bytes, io_ms));
                total_io_ms_first += io_ms;
            }
        }
    }

    for line in disk_io_second.lines() {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.len() >= 13 {
            let name = parts[2];
            if name.starts_with("loop") || name.starts_with("ram") {
                continue;
            }
            let is_physical = is_physical_disk(name);

            if is_physical {
                let r_sect = safe_parse_int(parts[5]) as u64;
                let w_sect = safe_parse_int(parts[9]) as u64;
                let io_ms = safe_parse_int(parts[12]) as u64;
                let r_bytes = r_sect * 512;
                let w_bytes = w_sect * 512;
                disk_io_second_map.insert(name.to_string(), (r_bytes, w_bytes, io_ms));
                total_io_ms_second += io_ms;

                if let Some((first_r, first_w, _)) = disk_io_first_map.get(name) {
                    let r_diff = r_bytes.saturating_sub(*first_r);
                    let w_diff = w_bytes.saturating_sub(*first_w);
                    r_io_total += r_diff;
                    w_io_total += w_diff;
                }
            }
        }
    }

    let mut disk_busy_map: std::collections::HashMap<String, f64> =
        std::collections::HashMap::new();
    for (name, (_, _, io_ms_second)) in &disk_io_second_map {
        if let Some((_, _, io_ms_first)) = disk_io_first_map.get(name) {
            let io_ms_diff = io_ms_second.saturating_sub(*io_ms_first);
            let busy = (io_ms_diff as f64 / 5.0).min(100.0);
            disk_busy_map.insert(name.clone(), busy);
        }
    }

    let r_io_sec = r_io_total as f64 * 2.0;
    let w_io_sec = w_io_total as f64 * 2.0;

    let io_ms_diff = total_io_ms_second.saturating_sub(total_io_ms_first);
    let mut busy_percent = (io_ms_diff as f64 / 5.0).min(100.0);

    let io_rate = r_io_sec + w_io_sec;
    if busy_percent < 1.0 && io_rate > 0.0 {
        let rate_busy = (io_rate / 52428800.0 * 100.0).min(100.0);
        if rate_busy > busy_percent {
            busy_percent = rate_busy;
        }
    }

    for (name, (r_bytes, w_bytes, _io_ms)) in disk_io_second_map {
        let device_path = format!("/dev/{}", name);
        let usage: Vec<_> = mount_usage
            .iter()
            .filter(|(source, _, _, _, _, _)| {
                source == &device_path
                    || source.starts_with(&format!("{}p", device_path))
                    || (source.starts_with(&device_path)
                        && source[device_path.len()..]
                            .chars()
                            .next()
                            .map_or(false, |c| c.is_ascii_digit()))
            })
            .collect();

        let total_size = usage.iter().map(|(_, _, size, _, _, _)| size).sum::<u64>();
        let total_used = usage.iter().map(|(_, _, _, used, _, _)| used).sum::<u64>();
        let total_avail = usage
            .iter()
            .map(|(_, _, _, _, avail, _)| avail)
            .sum::<u64>();
        let mounts = usage
            .iter()
            .map(|(_, _, _, _, _, mount)| mount.clone())
            .collect::<Vec<_>>()
            .join(", ");

        let use_percent = if total_size > 0 {
            (total_used as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };

        let disk_r_sec = if let Some((first_r, _, _)) = disk_io_first_map.get(&name) {
            let r_diff = r_bytes.saturating_sub(*first_r);
            r_diff as f64
        } else {
            0.0
        };
        let disk_w_sec = if let Some((_, first_w, _)) = disk_io_first_map.get(&name) {
            let w_diff = w_bytes.saturating_sub(*first_w);
            w_diff as f64
        } else {
            0.0
        };

        let disk_busy = *disk_busy_map.get(&name).unwrap_or(&0.0);

        disks.push(DesktopDiskInfo {
            fs: name.clone(),
            disk_type: "disk".to_string(),
            size: total_size,
            used: total_used,
            available: total_avail,
            mount: if mounts.is_empty() {
                "Unmounted".to_string()
            } else {
                mounts
            },
            use_percent,
            r_io_sec: disk_r_sec,
            w_io_sec: disk_w_sec,
            t_io_sec: disk_r_sec + disk_w_sec,
            busy_percent: disk_busy,
        });
    }

    let mut net_io_first_map: std::collections::HashMap<String, (u64, u64)> =
        std::collections::HashMap::new();

    for line in net_io_first.lines().skip(2) {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.len() >= 10 {
            let iface = parts[0].trim_end_matches(':');
            if iface == "lo" {
                continue;
            }
            let rx = safe_parse_int(parts[1]) as u64;
            let tx = safe_parse_int(parts[9]) as u64;
            net_io_first_map.insert(iface.to_string(), (rx, tx));
        }
    }

    let mut networks = Vec::new();
    for line in net_io_second.lines().skip(2) {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.len() >= 10 {
            let iface = parts[0].trim_end_matches(':');
            if iface == "lo" {
                continue;
            }
            let rx = safe_parse_int(parts[1]) as u64;
            let tx = safe_parse_int(parts[9]) as u64;

            let (rx_sec, tx_sec) = if let Some((first_rx, first_tx)) = net_io_first_map.get(iface) {
                let rx_diff = rx.saturating_sub(*first_rx);
                let tx_diff = tx.saturating_sub(*first_tx);
                (rx_diff as f64, tx_diff as f64)
            } else {
                (0.0, 0.0)
            };

            networks.push(DesktopNetworkInfo {
                iface: iface.to_string(),
                rx_bytes: rx,
                tx_bytes: tx,
                rx_sec,
                tx_sec,
            });
        }
    }

    let mut processes = Vec::new();
    for line in proc_info.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }

        let pid = safe_parse_int(parts[0]) as u32;
        if pid == 0 && parts[0] != "0" {
            continue;
        }

        let state_char = parts[1].chars().next().unwrap_or('S');
        let state = match state_char {
            'R' => "R".to_string(),
            'S' => "S".to_string(),
            'D' => "D".to_string(),
            'Z' => "Z".to_string(),
            'T' => "T".to_string(),
            't' => "T".to_string(),
            'I' => "I".to_string(),
            _ => "S".to_string(),
        };

        let cpu = parts[2].parse().unwrap_or(0.0);
        let mem = parts[3].parse().unwrap_or(0.0);
        let name = parts[4..].join(" ");

        processes.push(DesktopProcess {
            pid,
            name: if name.is_empty() {
                "unknown".to_string()
            } else {
                name
            },
            state: state.clone(),
            cpu,
            mem,
            disk: process_disk_io
                .get(&pid)
                .cloned()
                .unwrap_or_else(|| "0 B/s".to_string()),
        });

        if processes.len() >= 100 {
            break;
        }
    }

    let running_count = processes.iter().filter(|p| p.state == "R").count();

    Ok(DesktopSystemInfo {
        cpu: DesktopCpuInfo {
            brand: cpu_brand,
            speed: cpu_speed_ghz,
            cores,
            physical_cores: cores,
            load: current_load,
            load1,
            load5,
            load15,
            load_user,
            load_system,
        },
        memory: DesktopMemoryInfo {
            total: mem_total,
            used: mem_used,
            free: mem_free,
            available: mem_available,
            buffcache: mem_buffcache,
            used_percent: mem_used_percent,
        },
        disk: disks,
        disk_io: DesktopDiskIOInfo {
            r_io: r_io_total,
            w_io: w_io_total,
            t_io: r_io_total + w_io_total,
            r_io_sec,
            w_io_sec,
            t_io_sec: r_io_sec + w_io_sec,
            busy_percent,
        },
        network: networks,
        processes: DesktopProcessInfo {
            all: processes.len(),
            running: running_count,
            list: processes,
        },
    })
}

#[tauri::command]
pub async fn desktop_get_processes(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<Vec<DesktopProcess>, String> {
    let client = get_desktop_client(&state, &session_id).await?;

    let cmd = "ps aux --sort=-%cpu | head -50";
    let output = exec_command(&client, cmd).await?;

    let mut processes = Vec::new();

    for line in output.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 11 {
            continue;
        }

        let pid = safe_parse_int(parts[1]) as u32;
        if pid == 0 && parts[1] != "0" {
            continue;
        }

        let state_char = parts[7].chars().next().unwrap_or('S');
        let state = match state_char {
            'R' => "R".to_string(),
            'S' => "S".to_string(),
            'D' => "D".to_string(),
            'Z' => "Z".to_string(),
            'T' => "T".to_string(),
            't' => "T".to_string(),
            'I' => "I".to_string(),
            _ => "S".to_string(),
        };

        let cpu = safe_parse_float(parts[2]);
        let mem = safe_parse_float(parts[3]);
        let name = parts[10..].join(" ");

        processes.push(DesktopProcess {
            pid,
            name: if name.is_empty() {
                "unknown".to_string()
            } else {
                name
            },
            state,
            cpu,
            mem,
            disk: "0 B/s".to_string(),
        });

        if processes.len() >= 50 {
            break;
        }
    }

    Ok(processes)
}

#[tauri::command]
pub async fn desktop_start_terminal(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    terminal_session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let client = get_desktop_client(&state, &session_id).await?;
    client
        .start_shell(app_handle, None, terminal_session_id, cols, rows)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn desktop_send_terminal_input(
    state: State<'_, TerminalState>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    let client = get_desktop_client(&state, &session_id).await?;
    client
        .write(input.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn desktop_resize_terminal(
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let client = get_desktop_client(&state, &session_id).await?;
    client.resize(cols, rows).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn desktop_get_disks(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<Vec<DesktopDiskInfo>, String> {
    let client = get_desktop_client(&state, &session_id).await?;

    let cmd = "df -B1 --output=source,fstype,size,used,avail,pcent,target -x tmpfs -x devtmpfs";
    let output = exec_command(&client, cmd).await?;

    let mut disks = Vec::new();
    for line in output.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 7 {
            continue;
        }
        let source = parts[0].to_string();
        if !source.starts_with("/dev/") {
            continue;
        }
        let mount = parts[6].to_string();
        if mount.starts_with("/sys") || mount.starts_with("/proc") {
            continue;
        }

        let size = safe_parse_int(parts[2]) as u64;
        let used = safe_parse_int(parts[3]) as u64;
        let available = safe_parse_int(parts[4]) as u64;
        let use_percent_str = parts[5].trim_end_matches('%');
        let use_percent = safe_parse_float(use_percent_str);

        let fs_name = source.strip_prefix("/dev/").unwrap_or(&source).to_string();

        disks.push(DesktopDiskInfo {
            fs: fs_name,
            disk_type: parts[1].to_string(),
            size,
            used,
            available,
            mount,
            use_percent,
            r_io_sec: 0.0,
            w_io_sec: 0.0,
            t_io_sec: 0.0,
            busy_percent: 0.0,
        });
    }

    Ok(disks)
}
