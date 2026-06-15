use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::terminal::error::TerminalError;
use crate::terminal::session::SessionHandle;
use crate::terminal::sftp::client::SftpClient;
use crate::terminal::ssh::client::SshClient;
use crate::terminal::TerminalState;

use super::conflict::{check_conflict, ConflictCheck};
use super::project::{ExecResult, FileCheckResult, FileContentResult, ProjectInfo, WriteResult};

const MAX_EDITABLE_SIZE: u64 = 10 * 1024 * 1024; // 10MB

async fn get_ssh_client(
    state: &TerminalState,
    session_id: &str,
) -> Result<Arc<SshClient>, String> {
    let handle = state
        .manager
        .get_handle(session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()).to_string())?;

    match handle {
        SessionHandle::Ssh(client) | SessionHandle::Desktop(client) => Ok(client),
        _ => Err("System monitor only supported for SSH sessions".to_string()),
    }
}

async fn get_sftp_client(
    state: &TerminalState,
    session_id: &str,
) -> Result<Arc<SftpClient>, String> {
    let handle = state
        .manager
        .get_handle(session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()).to_string())?;

    match handle {
        SessionHandle::Sftp(client) => Ok(client),
        SessionHandle::Ssh(ssh_client) | SessionHandle::Desktop(ssh_client) => {
            let sftp_session = ssh_client.open_sftp().await.map_err(|e| e.to_string())?;
            Ok(Arc::new(SftpClient::from_session(
                sftp_session,
                ssh_client.clone(),
            )))
        }
        SessionHandle::Local(_) => Err("Local sessions do not support remote file editing".to_string()),
    }
}

async fn resolve_path(client: &SftpClient, path: &str) -> Result<String, String> {
    if !path.starts_with('~') {
        return Ok(path.to_string());
    }

    // SFTP canonicalize often treats "~" as a literal relative path name
    // (e.g. resolving to /root/~ instead of /root), so we always resolve
    // the home directory via SSH exec and build the path ourselves.
    let ssh = client
        .ssh_client()
        .ok_or("Cannot resolve '~' without SSH exec access")?;
    let result = ssh
        .exec_command("echo $HOME")
        .await
        .map_err(|e| e.to_string())?;
    let home = result.stdout.trim();
    if home.is_empty() {
        return Err("Could not resolve home directory".to_string());
    }
    let rest = &path[1..];
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    if rest.is_empty() {
        Ok(home.to_string())
    } else {
        Ok(format!("{}/{}", home, rest))
    }
}

#[tauri::command]
pub async fn ide_open_project(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<ProjectInfo, String> {
    let client = get_sftp_client(&state, &session_id).await?;
    let resolved = resolve_path(&client, &path).await?;
    let info = client.stat(&resolved).await.map_err(|e| e.to_string())?;
    if info.is_dir {
        let name = std::path::Path::new(&resolved)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "project".to_string());
        Ok(ProjectInfo {
            root_path: resolved,
            name,
        })
    } else {
        Err("Path is not a directory".to_string())
    }
}

#[tauri::command]
pub async fn ide_check_file(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<FileCheckResult, String> {
    let client = get_sftp_client(&state, &session_id).await?;
    let resolved = resolve_path(&client, &path).await?;
    let info = client.stat(&resolved).await.map_err(|e| e.to_string())?;

    if info.is_dir {
        return Ok(FileCheckResult::NotEditable {
            reason: "Is a directory".to_string(),
        });
    }

    let size = info.size.unwrap_or(0);
    let mtime = info.mtime.unwrap_or(0) as u64;

    if size > MAX_EDITABLE_SIZE {
        return Ok(FileCheckResult::TooLarge {
            size,
            limit: MAX_EDITABLE_SIZE,
        });
    }

    // Read the first 8KB to detect binary content.
    let head = client.download(&resolved).await.unwrap_or_default();
    let sample = &head[..head.len().min(8192)];
    if sample.contains(&0u8) {
        return Ok(FileCheckResult::Binary);
    }

    Ok(FileCheckResult::Editable { size, mtime })
}

#[tauri::command]
pub async fn ide_read_file(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<FileContentResult, String> {
    let client = get_sftp_client(&state, &session_id).await?;
    let resolved = resolve_path(&client, &path).await?;
    let info = client.stat(&resolved).await.map_err(|e| e.to_string())?;
    let data = client.download(&resolved).await.map_err(|e| e.to_string())?;
    let content =
        String::from_utf8(data).map_err(|_| "File is not valid UTF-8".to_string())?;
    Ok(FileContentResult {
        content,
        mtime: info.mtime.unwrap_or(0) as u64,
        size: info.size.unwrap_or(0),
    })
}

#[tauri::command]
pub async fn ide_write_file(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
    content: String,
    expect_mtime: u64,
    expect_size: u64,
) -> Result<WriteResult, String> {
    let client = get_sftp_client(&state, &session_id).await?;
    let resolved = resolve_path(&client, &path).await?;

    let latest = client.stat(&resolved).await.map_err(|e| e.to_string())?;
    let latest_mtime = latest.mtime.unwrap_or(0) as u64;
    let latest_size = latest.size.unwrap_or(0);

    match check_conflict(expect_mtime, expect_size, latest_mtime, latest_size) {
        ConflictCheck::ModifiedExternally { .. } => {
            return Err("File modified externally".to_string());
        }
        ConflictCheck::Ok => {}
    }

    client
        .upload(&resolved, content.into_bytes())
        .await
        .map_err(|e| e.to_string())?;

    let after = client.stat(&resolved).await.map_err(|e| e.to_string())?;
    Ok(WriteResult {
        mtime: after.mtime.unwrap_or(0) as u64,
        size: after.size.unwrap_or(0),
    })
}

#[tauri::command]
pub async fn ide_exec_command(
    state: State<'_, TerminalState>,
    session_id: String,
    command: String,
    cwd: Option<String>,
) -> Result<ExecResult, String> {
    let handle = state
        .manager
        .get_handle(&session_id)
        .await
        .ok_or_else(|| TerminalError::SessionNotFound(session_id.clone()).to_string())?;

    let full_command = match cwd {
        Some(dir) => format!("cd {} && {}", shell_escape(&dir), command),
        None => command,
    };

    match handle {
        SessionHandle::Ssh(client) | SessionHandle::Desktop(client) => {
            let output = client
                .exec_command(&full_command)
                .await
                .map_err(|e| e.to_string())?;
            Ok(ExecResult {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: None,
            })
        }
        _ => Err("Exec command only supported for SSH sessions".to_string()),
    }
}

fn shell_escape(input: &str) -> String {
    format!("'{}'", input.replace('\'', "'\"'\"'"))
}

// ------------------------------------------------------------------
// System monitor
// ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCpuInfo {
    pub load: f64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub speed: f64,
    pub cores: i32,
    pub brand: String,
    pub load_user: f64,
    pub load_system: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMemoryInfo {
    pub used: u64,
    pub total: u64,
    pub used_percent: f64,
    pub free: u64,
    pub buffcache: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDiskInfo {
    pub fs: String,
    pub used: u64,
    pub size: u64,
    pub use_percent: f64,
    pub busy_percent: f64,
    pub r_io_sec: u64,
    pub w_io_sec: u64,
    pub disk_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNetworkInfo {
    pub iface: String,
    pub rx_sec: u64,
    pub tx_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProcessInfo {
    pub pid: i32,
    pub name: String,
    pub user: String,
    pub cpu_percent: f64,
    pub mem_percent: f64,
    pub mem_rss: u64,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProcessList {
    pub processes: Vec<RemoteProcessInfo>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProcessCount {
    pub all: i32,
    pub running: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSystemInfo {
    pub cpu: RemoteCpuInfo,
    pub memory: RemoteMemoryInfo,
    pub disk: Vec<RemoteDiskInfo>,
    pub network: Vec<RemoteNetworkInfo>,
    pub processes: RemoteProcessCount,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePortInfo {
    pub protocol: String,
    pub local_addr: String,
    pub local_port: u16,
    pub state: String,
    pub pid: Option<i32>,
    pub process_name: Option<String>,
    pub process_user: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePortsData {
    pub ports: Vec<RemotePortInfo>,
    pub timestamp: u64,
}

#[tauri::command]
pub async fn ide_remote_get_system_info(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<RemoteSystemInfo, String> {
    let client = get_ssh_client(&state, &session_id).await?;

    let cmd = r#"
        echo "===CPU==="
        cat /proc/loadavg | awk '{print $1, $2, $3}'
        nproc
        cat /proc/cpuinfo | grep "model name" | head -1 | cut -d':' -f2 | sed 's/^ *//'
        cat /proc/cpuinfo | grep "cpu MHz" | head -1 | awk '{print $4}'

        echo "===CPU_STAT1==="
        cat /proc/stat | head -1

        echo "===MEMORY==="
        free -b | awk 'NR==2{print $2, $3, $4, $6}'

        echo "===DISK==="
        df -B1 | grep -E '^/dev/' | awk '{print $1, $2, $3, $5}'

        echo "===DISK_IO1==="
        cat /proc/diskstats | awk '/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)[[:space:]]/{print $3, $6, $10, $13}'

        echo "===NET1==="
        cat /proc/net/dev | grep -E 'eth|ens|enp|wlan|wlp' | awk -F: '{print $1, $2}' | awk '{print $1, $2, $10}'

        sleep 1

        echo "===CPU_STAT2==="
        cat /proc/stat | head -1

        echo "===DISK_IO2==="
        cat /proc/diskstats | awk '/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)[[:space:]]/{print $3, $6, $10, $13}'

        echo "===NET2==="
        cat /proc/net/dev | grep -E 'eth|ens|enp|wlan|wlp' | awk -F: '{print $1, $2}' | awk '{print $1, $2, $10}'

        echo "===PROCS==="
        ps aux | wc -l
        ps aux | grep -c "^[R]"
    "#;

    let output = client.exec_command(cmd).await.map_err(|e| e.to_string())?;
    parse_system_info(&output.stdout)
}

fn parse_system_info(output: &str) -> Result<RemoteSystemInfo, String> {
    let mut cpu_load1 = 0.0;
    let mut cpu_load5 = 0.0;
    let mut cpu_load15 = 0.0;
    let mut cpu_cores = 1i32;
    let mut cpu_brand = "Unknown".to_string();
    let mut cpu_speed = 0.0f64;

    let mut cpu_stat1: Vec<u64> = Vec::new();
    let mut cpu_stat2: Vec<u64> = Vec::new();

    let mut mem_total = 0u64;
    let mut mem_used = 0u64;
    let mut mem_free = 0u64;
    let mut mem_buffcache = 0u64;

    let mut proc_all = 0i32;
    let mut proc_running = 0i32;

    let mut net1_data: HashMap<String, (u64, u64)> = HashMap::new();
    let mut net2_data: HashMap<String, (u64, u64)> = HashMap::new();
    let mut disk_io1_data: HashMap<String, (u64, u64, u64)> = HashMap::new();
    let mut disk_io2_data: HashMap<String, (u64, u64, u64)> = HashMap::new();
    let mut disk_basic_info: HashMap<String, (u64, u64, f64)> = HashMap::new();

    let mut current_section = "";

    for line in output.lines() {
        let line = line.trim();

        if line.starts_with("===") && line.ends_with("===") {
            current_section = &line[3..line.len() - 3];
            continue;
        }

        match current_section {
            "CPU" => {
                if cpu_load1 == 0.0 && line.split_whitespace().count() == 3 {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    cpu_load1 = parts[0].parse().unwrap_or(0.0);
                    cpu_load5 = parts[1].parse().unwrap_or(0.0);
                    cpu_load15 = parts[2].parse().unwrap_or(0.0);
                } else if cpu_cores == 1 && line.parse::<i32>().is_ok() {
                    cpu_cores = line.parse().unwrap_or(1);
                } else if cpu_brand == "Unknown"
                    && !line.is_empty()
                    && line.parse::<f64>().is_err()
                {
                    cpu_brand = line.to_string();
                } else if cpu_speed == 0.0 && line.parse::<f64>().is_ok() {
                    cpu_speed = line.parse().unwrap_or(0.0);
                }
            }
            "CPU_STAT1" => {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if !parts.is_empty() && parts[0] == "cpu" {
                    cpu_stat1 = parts.iter().skip(1).map(|s| s.parse().unwrap_or(0)).collect();
                }
            }
            "CPU_STAT2" => {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if !parts.is_empty() && parts[0] == "cpu" {
                    cpu_stat2 = parts.iter().skip(1).map(|s| s.parse().unwrap_or(0)).collect();
                }
            }
            "MEMORY" => {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() == 4 {
                    mem_total = parts[0].parse().unwrap_or(0);
                    mem_used = parts[1].parse().unwrap_or(0);
                    mem_free = parts[2].parse().unwrap_or(0);
                    mem_buffcache = parts[3].parse().unwrap_or(0);
                }
            }
            "DISK" => {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() == 4 {
                    let fs = parts[0].to_string();
                    let size: u64 = parts[1].parse().unwrap_or(0);
                    let used: u64 = parts[2].parse().unwrap_or(0);
                    let use_percent_str = parts[3].trim_end_matches('%');
                    let use_percent = use_percent_str.parse().unwrap_or(0.0);
                    let device_name = fs.trim_start_matches("/dev/").to_string();

                    let base_device = if device_name.starts_with("nvme") {
                        device_name
                            .split('p')
                            .next()
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| device_name.clone())
                    } else {
                        device_name
                            .trim_end_matches(|c: char| c.is_ascii_digit())
                            .to_string()
                    };

                    let entry = disk_basic_info
                        .entry(base_device)
                        .or_insert((0u64, 0u64, 0.0f64));
                    entry.0 += size;
                    entry.1 += used;
                    if use_percent > entry.2 {
                        entry.2 = use_percent;
                    }
                }
            }
            "NET1" => {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() == 3 {
                    let iface = parts[0].to_string();
                    let rx = parts[1].parse().unwrap_or(0);
                    let tx = parts[2].parse().unwrap_or(0);
                    net1_data.insert(iface, (rx, tx));
                }
            }
            "NET2" => {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() == 3 {
                    let iface = parts[0].to_string();
                    let rx = parts[1].parse().unwrap_or(0);
                    let tx = parts[2].parse().unwrap_or(0);
                    net2_data.insert(iface, (rx, tx));
                }
            }
            "DISK_IO1" => {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() == 4 {
                    let device = parts[0].to_string();
                    let reads = parts[1].parse().unwrap_or(0);
                    let writes = parts[2].parse().unwrap_or(0);
                    let io_ms = parts[3].parse().unwrap_or(0);
                    disk_io1_data.insert(device, (reads, writes, io_ms));
                }
            }
            "DISK_IO2" => {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() == 4 {
                    let device = parts[0].to_string();
                    let reads = parts[1].parse().unwrap_or(0);
                    let writes = parts[2].parse().unwrap_or(0);
                    let io_ms = parts[3].parse().unwrap_or(0);
                    disk_io2_data.insert(device, (reads, writes, io_ms));
                }
            }
            "PROCS" => {
                if proc_all == 0 {
                    proc_all = line.parse().unwrap_or(0) as i32 - 1;
                } else if proc_running == 0 {
                    proc_running = line.parse().unwrap_or(0) as i32;
                }
            }
            _ => {}
        }
    }

    let mut networks = Vec::new();
    for (iface, (rx2, tx2)) in net2_data {
        if let Some((rx1, tx1)) = net1_data.get(&iface) {
            networks.push(RemoteNetworkInfo {
                iface: iface.trim().to_string(),
                rx_sec: rx2.saturating_sub(*rx1),
                tx_sec: tx2.saturating_sub(*tx1),
            });
        }
    }

    if networks.is_empty() {
        networks.push(RemoteNetworkInfo {
            iface: "eth0".to_string(),
            rx_sec: 0,
            tx_sec: 0,
        });
    }

    let mut disk_io_rates: HashMap<String, (u64, u64, f64)> = HashMap::new();
    for (device, (reads2, writes2, io_ms2)) in disk_io2_data {
        if let Some((reads1, writes1, io_ms1)) = disk_io1_data.get(&device) {
            let r_sec = reads2.saturating_sub(*reads1);
            let w_sec = writes2.saturating_sub(*writes1);
            let io_ms_diff = io_ms2.saturating_sub(*io_ms1);
            let busy_percent = (io_ms_diff as f64 / 10.0).min(100.0);
            disk_io_rates.insert(device.clone(), (r_sec, w_sec, busy_percent));
        }
    }

    let mut disks = Vec::new();
    for (device_name, (size, used, use_percent)) in disk_basic_info {
        let (r_sectors, w_sectors, busy_percent) = disk_io_rates
            .get(&device_name)
            .copied()
            .unwrap_or((0, 0, 0.0));
        disks.push(RemoteDiskInfo {
            fs: device_name.clone(),
            used,
            size,
            use_percent,
            busy_percent,
            r_io_sec: r_sectors * 512,
            w_io_sec: w_sectors * 512,
            disk_type: if device_name.starts_with("nvme") {
                "SSD".to_string()
            } else {
                "HDD".to_string()
            },
        });
    }

    let mem_used_percent = if mem_total > 0 {
        (mem_used as f64 / mem_total as f64) * 100.0
    } else {
        0.0
    };

    let (cpu_usage, cpu_user, cpu_system) =
        if cpu_stat1.len() >= 4 && cpu_stat2.len() >= 4 {
            let user_diff = cpu_stat2[0].saturating_sub(cpu_stat1[0]);
            let nice_diff = cpu_stat2
                .get(1)
                .unwrap_or(&0)
                .saturating_sub(*cpu_stat1.get(1).unwrap_or(&0));
            let system_diff = cpu_stat2[2].saturating_sub(cpu_stat1[2]);
            let idle_diff = cpu_stat2[3].saturating_sub(cpu_stat1[3]);
            let iowait_diff = cpu_stat2
                .get(4)
                .unwrap_or(&0)
                .saturating_sub(*cpu_stat1.get(4).unwrap_or(&0));
            let irq_diff = cpu_stat2
                .get(5)
                .unwrap_or(&0)
                .saturating_sub(*cpu_stat1.get(5).unwrap_or(&0));
            let softirq_diff = cpu_stat2
                .get(6)
                .unwrap_or(&0)
                .saturating_sub(*cpu_stat1.get(6).unwrap_or(&0));
            let steal_diff = cpu_stat2
                .get(7)
                .unwrap_or(&0)
                .saturating_sub(*cpu_stat1.get(7).unwrap_or(&0));

            let total = user_diff
                + nice_diff
                + system_diff
                + idle_diff
                + iowait_diff
                + irq_diff
                + softirq_diff
                + steal_diff;
            if total > 0 {
                let user_pct = ((user_diff + nice_diff) as f64 / total as f64) * 100.0;
                let system_pct = (system_diff as f64 / total as f64) * 100.0;
                (user_pct + system_pct, user_pct, system_pct)
            } else {
                (0.0, 0.0, 0.0)
            }
        } else {
            (0.0, 0.0, 0.0)
        };

    Ok(RemoteSystemInfo {
        cpu: RemoteCpuInfo {
            load: cpu_usage,
            load1: cpu_load1,
            load5: cpu_load5,
            load15: cpu_load15,
            speed: cpu_speed,
            cores: cpu_cores,
            brand: cpu_brand,
            load_user: cpu_user,
            load_system: cpu_system,
        },
        memory: RemoteMemoryInfo {
            used: mem_used,
            total: mem_total,
            used_percent: mem_used_percent,
            free: mem_free,
            buffcache: mem_buffcache,
        },
        disk: disks,
        network: networks,
        processes: RemoteProcessCount {
            all: proc_all,
            running: proc_running,
        },
    })
}

#[tauri::command]
pub async fn ide_remote_get_ports(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<RemotePortsData, String> {
    let client = get_ssh_client(&state, &session_id).await?;

    let cmd = "sudo ss -tulpn 2>/dev/null || ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null";
    let output = client.exec_command(cmd).await.map_err(|e| e.to_string())?;
    let mut ports = Vec::new();

    for line in output.stdout.lines() {
        let line = line.trim();
        if line.starts_with("Netid") || line.starts_with("Active") || line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 {
            let protocol = parts[0].to_lowercase();
            if protocol != "tcp" && protocol != "udp" {
                continue;
            }

            let state = parts.get(1).unwrap_or(&"").to_string();

            if let Some(&local_addr_port) = parts.get(4) {
                let (local_addr, local_port) = parse_addr_port(local_addr_port);
                let (pid, process_name, process_user) = parse_process_info(line);
                ports.push(RemotePortInfo {
                    protocol,
                    local_addr,
                    local_port,
                    state,
                    pid,
                    process_name,
                    process_user,
                });
            }
        }
    }

    Ok(RemotePortsData {
        ports,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    })
}

fn parse_addr_port(addr_port: &str) -> (String, u16) {
    if let Some(colon_pos) = addr_port.rfind(':') {
        let addr = addr_port[..colon_pos].to_string();
        let port_str = &addr_port[colon_pos + 1..];
        let port = port_str.parse().unwrap_or(0);
        let addr = addr.trim_start_matches('[').trim_end_matches(']');
        (addr.to_string(), port)
    } else {
        (addr_port.to_string(), 0)
    }
}

fn parse_process_info(line: &str) -> (Option<i32>, Option<String>, Option<String>) {
    if let Some(users_start) = line.find("users:") {
        let users_part = &line[users_start..];
        if let Some(name_start) = users_part.find("(\"") {
            let rest = &users_part[name_start + 2..];
            if let Some(name_end) = rest.find("\"") {
                let process_name = rest[..name_end].to_string();
                let rest = &rest[name_end..];
                if let Some(pid_start) = rest.find("pid=") {
                    let pid_str = &rest[pid_start + 4..];
                    let pid_end = pid_str
                        .find(|c: char| !c.is_ascii_digit())
                        .unwrap_or(pid_str.len());
                    if let Ok(pid) = pid_str[..pid_end].parse::<i32>() {
                        return (Some(pid), Some(process_name), None);
                    }
                }
            }
        }
    }
    (None, None, None)
}

#[tauri::command]
pub async fn ide_remote_kill_process(
    state: State<'_, TerminalState>,
    session_id: String,
    pid: u32,
) -> Result<(), String> {
    let client = get_ssh_client(&state, &session_id).await?;
    let cmd = format!("sudo kill -9 {} 2>/dev/null || kill -9 {}", pid, pid);
    client
        .exec_command(&cmd)
        .await
        .map_err(|e| format!("终止进程失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn ide_remote_get_processes(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<RemoteProcessList, String> {
    let client = get_ssh_client(&state, &session_id).await?;

    let cmd = r#"ps -eo pid,comm,user,pcpu,pmem,rss,stat --sort=-pcpu | tail -n +2"#;
    let output = client.exec_command(cmd).await.map_err(|e| e.to_string())?;
    let mut processes = Vec::new();

    for line in output.stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 7 {
            if let Ok(pid) = parts[0].parse::<i32>() {
                processes.push(RemoteProcessInfo {
                    pid,
                    name: parts[1].to_string(),
                    user: parts[2].to_string(),
                    cpu_percent: parts[3].parse().unwrap_or(0.0),
                    mem_percent: parts[4].parse().unwrap_or(0.0),
                    mem_rss: parts[5].parse().unwrap_or(0),
                    state: parts[6].to_string(),
                });
            }
        }
    }

    Ok(RemoteProcessList {
        processes,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn max_editable_size_is_10mb() {
        assert_eq!(super::MAX_EDITABLE_SIZE, 10 * 1024 * 1024);
    }
}
