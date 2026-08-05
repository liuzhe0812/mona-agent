// System module: local OS overview + 60-min history for the System page.
// Replaces mock data with real sysinfo-backed readings.

pub mod software;
pub mod startup;
pub mod maintenance;
pub mod diagnostics;
pub mod win11debloat;
pub mod network;
pub mod performance;
pub mod context_menu;
pub mod process_control;
pub mod defender;
pub mod uac;
pub mod windows_update;

use crate::settings::app_data_dir;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Disks, Networks, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, State};

const SYSTEM_DB_FILE: &str = "system.sqlite3";
const SAMPLE_INTERVAL_SECS: u64 = 10;
const HISTORY_WINDOW_SECS: i64 = 3600;

pub(crate) fn decode_windows_output(bytes: &[u8]) -> String {
    let utf16 = bytes.starts_with(&[0xff, 0xfe])
        || (bytes.len() >= 4
            && bytes.len() % 2 == 0
            && bytes.iter().skip(1).step_by(2).filter(|byte| **byte == 0).count()
                > bytes.len() / 8);
    if utf16 {
        let offset = usize::from(bytes.starts_with(&[0xff, 0xfe])) * 2;
        return String::from_utf16_lossy(
            &bytes[offset..]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>(),
        );
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    encoding_rs::GBK.decode(bytes).0.into_owned()
}

#[cfg(windows)]
pub(crate) fn run_elevated(program: &str, parameters: &str, timeout_ms: u32) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let program = HSTRING::from(program);
    let parameters = HSTRING::from(parameters);
    let mut info = SHELLEXECUTEINFOW::default();
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = windows::core::w!("runas");
    info.lpFile = PCWSTR(program.as_ptr());
    info.lpParameters = PCWSTR(parameters.as_ptr());
    info.nShow = SW_HIDE.0 as i32;

    unsafe {
        ShellExecuteExW(&mut info).map_err(|error| format!("管理员授权被取消或启动失败：{error}"))?;
        let handle: HANDLE = info.hProcess;
        if handle.is_invalid() { return Err("管理员进程未能启动".into()); }
        let wait = WaitForSingleObject(handle, timeout_ms);
        let mut exit_code = 1;
        let _ = GetExitCodeProcess(handle, &mut exit_code);
        let _ = CloseHandle(handle);
        if wait != WAIT_OBJECT_0 { return Err("管理员操作等待超时".into()); }
        if exit_code != 0 { return Err(format!("管理员操作失败，错误码 {exit_code}")); }
    }
    Ok(())
}

fn history_window_secs(window_secs: Option<i64>) -> i64 {
    match window_secs {
        Some(value @ (600 | 1800 | 3600)) => value,
        _ => HISTORY_WINDOW_SECS,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        bytes_per_second, cleanup_is_allowed, decode_windows_output, file_type_category, history_window_secs,
        whole_machine_cpu_percent, HISTORY_WINDOW_SECS,
    };
    use std::path::Path;

    #[test]
    fn only_allows_the_supported_history_windows() {
        assert_eq!(history_window_secs(Some(600)), 600);
        assert_eq!(history_window_secs(Some(1800)), 1800);
        assert_eq!(history_window_secs(Some(3600)), HISTORY_WINDOW_SECS);
        assert_eq!(history_window_secs(Some(900)), HISTORY_WINDOW_SECS);
    }

    #[test]
    fn converts_sample_bytes_to_bytes_per_second() {
        assert_eq!(bytes_per_second(2_000_000, 2.0), 1_000_000.0);
    }

    #[test]
    fn decodes_native_windows_output_without_mojibake() {
        assert_eq!(decode_windows_output("操作已完成".as_bytes()), "操作已完成");
        let (gbk, _, _) = encoding_rs::GBK.encode("拒绝访问");
        assert_eq!(decode_windows_output(&gbk), "拒绝访问");
        let utf16 = [0xff, 0xfe]
            .into_iter()
            .chain("需要管理员权限".encode_utf16().flat_map(u16::to_le_bytes))
            .collect::<Vec<_>>();
        assert_eq!(decode_windows_output(&utf16), "需要管理员权限");
    }

    #[test]
    fn converts_process_cpu_to_whole_machine_percent() {
        assert_eq!(whole_machine_cpu_percent(48.0, 8), 6.0);
        assert_eq!(whole_machine_cpu_percent(240.0, 0), 100.0);
    }

    #[test]
    fn classifies_storage_files_without_a_second_scan() {
        assert_eq!(file_type_category(Path::new("movie.mp4")), "视频");
        assert_eq!(file_type_category(Path::new("photo.PNG")), "图片");
        assert_eq!(file_type_category(Path::new("report.pdf")), "文档");
        assert_eq!(file_type_category(Path::new("tool.exe")), "应用");
        assert_eq!(file_type_category(Path::new("pagefile.sys")), "系统");
        assert_eq!(file_type_category(Path::new("archive.unknown")), "其他");
    }

    #[test]
    fn only_allows_low_risk_cleanup_targets() {
        assert!(cleanup_is_allowed("temp"));
        assert!(cleanup_is_allowed("chrome"));
        assert!(cleanup_is_allowed("edge"));
        assert!(cleanup_is_allowed("trash"));
        assert!(cleanup_is_allowed("updates"));
        assert!(cleanup_is_allowed("wer"));
        assert!(cleanup_is_allowed("delivery_optimization"));
        assert!(!cleanup_is_allowed("custom-path"));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub usage_percent: f32,
    pub frequency_ghz: f64,
    pub core_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub usage_percent: f32,
    pub used_gb: f64,
    pub total_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub drive_letter: String,
    pub usage_percent: f32,
    pub used_gb: f64,
    pub total_gb: f64,
    pub available_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub total_mbps: f64,
    pub upload_mbps: f64,
    pub download_mbps: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_mb: u64,
    pub disk_read_bytes_per_sec: f64,
    pub disk_write_bytes_per_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemOverview {
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub disks: Vec<DiskInfo>,
    pub network: NetworkInfo,
    pub top_processes: Vec<ProcessInfo>,
    pub sample_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplePoint {
    pub ts: i64,
    pub cpu_usage: f32,
    pub mem_usage: f32,
    pub net_total_mbps: f64,
}

pub struct Inner {
    sys: System,
    disks: Disks,
    networks: Networks,
    last_net_rx: u64,
    last_net_tx: u64,
    last_ts: Instant,
    db: Connection,
}

#[derive(Clone)]
pub struct SystemState(pub Arc<Mutex<Inner>>);

fn db_path() -> PathBuf {
    app_data_dir().join(SYSTEM_DB_FILE)
}

fn ensure_db() -> Result<Connection, String> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create system db dir: {}", e))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("Failed to open system db: {}", e))?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS system_samples (
            ts INTEGER PRIMARY KEY,
            cpu_usage REAL NOT NULL,
            mem_usage REAL NOT NULL,
            net_total_mbps REAL NOT NULL,
            net_up_mbps REAL NOT NULL,
            net_down_mbps REAL NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("Failed to init system tables: {}", e))?;
    // 启动时清空，避免脏数据（应用关闭期间的空缺不进入折线）
    conn.execute("DELETE FROM system_samples", [])
        .map_err(|e| format!("Failed to clear stale samples: {}", e))?;
    Ok(conn)
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn total_net_bytes(networks: &Networks) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for (_, data) in networks.list() {
        rx += data.total_received();
        tx += data.total_transmitted();
    }
    (rx, tx)
}

impl SystemState {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_all();
        let disks = Disks::new_with_refreshed_list();
        let networks = Networks::new_with_refreshed_list();
        let (last_net_rx, last_net_tx) = total_net_bytes(&networks);
        let db = ensure_db().expect("Failed to init system db");
        Self(Arc::new(Mutex::new(Inner {
            sys,
            disks,
            networks,
            last_net_rx,
            last_net_tx,
            last_ts: Instant::now(),
            db,
        })))
    }
}

impl Default for SystemState {
    fn default() -> Self {
        Self::new()
    }
}

struct SampleMetrics {
    cpu_usage: f32,
    mem_usage: f32,
    up_mbps: f64,
    down_mbps: f64,
    elapsed_secs: f64,
}

fn bytes_per_second(bytes: u64, elapsed_secs: f64) -> f64 {
    bytes as f64 / elapsed_secs.max(0.1)
}

fn whole_machine_cpu_percent(process_cpu_percent: f32, logical_core_count: usize) -> f32 {
    (process_cpu_percent / logical_core_count.max(1) as f32).clamp(0.0, 100.0)
}

/// 刷新 sysinfo + 计算指标 + 写入 SQLite + 清理过期样本
fn sample(inner: &mut Inner) -> Result<SampleMetrics, String> {
    let now = Instant::now();
    let elapsed = now.duration_since(inner.last_ts).as_secs_f64().max(0.1);

    inner.sys.refresh_cpu_usage();
    inner.sys.refresh_memory();
    inner.sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_disk_usage(),
    );
    inner.disks.refresh(true);
    inner.networks.refresh(true);

    let (cur_rx, cur_tx) = total_net_bytes(&inner.networks);
    let d_rx = cur_rx.saturating_sub(inner.last_net_rx);
    let d_tx = cur_tx.saturating_sub(inner.last_net_tx);
    inner.last_net_rx = cur_rx;
    inner.last_net_tx = cur_tx;
    inner.last_ts = now;

    let cpus = inner.sys.cpus();
    let avg_usage = if !cpus.is_empty() {
        cpus.iter().map(|c| c.cpu_usage()).sum::<f32>() / cpus.len() as f32
    } else {
        0.0
    };
    let total_mem = inner.sys.total_memory();
    let used_mem = inner.sys.used_memory();
    let mem_usage = if total_mem > 0 {
        (used_mem as f64 / total_mem as f64 * 100.0) as f32
    } else {
        0.0
    };
    let up_mbps = (d_tx as f64 * 8.0) / elapsed / 1_000_000.0;
    let down_mbps = (d_rx as f64 * 8.0) / elapsed / 1_000_000.0;
    let net_total = up_mbps + down_mbps;

    let ts = now_ts();
    inner
        .db
        .execute(
            "INSERT OR REPLACE INTO system_samples (ts, cpu_usage, mem_usage, net_total_mbps, net_up_mbps, net_down_mbps) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![ts, avg_usage, mem_usage, net_total, up_mbps, down_mbps],
        )
        .map_err(|e| format!("Failed to insert sample: {}", e))?;
    // 过期数据置换：删除超过 60 分钟窗口的旧记录
    let cutoff = ts - HISTORY_WINDOW_SECS;
    inner
        .db
        .execute("DELETE FROM system_samples WHERE ts < ?1", params![cutoff])
        .map_err(|e| format!("Failed to prune stale samples: {}", e))?;
    Ok(SampleMetrics {
        cpu_usage: avg_usage,
        mem_usage,
        up_mbps,
        down_mbps,
        elapsed_secs: elapsed,
    })
}

#[tauri::command]
pub async fn system_get_overview(state: State<'_, SystemState>) -> Result<SystemOverview, String> {
    let mut inner = state.0.lock().map_err(|e| format!("State lock: {}", e))?;
    let metrics = sample(&mut inner)?;

    let cpus = inner.sys.cpus();
    let avg_freq = if !cpus.is_empty() {
        cpus.iter().map(|c| c.frequency()).sum::<u64>() as f64 / cpus.len() as f64 / 1000.0
    } else {
        0.0
    };
    let core_count = System::physical_core_count().unwrap_or(cpus.len());

    let total_mem = inner.sys.total_memory();
    let used_mem = inner.sys.used_memory();

    let disks: Vec<DiskInfo> = inner
        .disks
        .list()
        .iter()
        .map(|d| {
            let total = d.total_space();
            let available = d.available_space();
            let used = total.saturating_sub(available);
            let usage = if total > 0 {
                (used as f64 / total as f64 * 100.0) as f32
            } else {
                0.0
            };
            DiskInfo {
                drive_letter: d.mount_point().to_string_lossy().to_string(),
                usage_percent: usage,
                used_gb: used as f64 / 1_073_741_824.0,
                total_gb: total as f64 / 1_073_741_824.0,
                available_gb: available as f64 / 1_073_741_824.0,
            }
        })
        .collect();

    let logical_core_count = inner.sys.cpus().len();
    let mut procs: Vec<(&sysinfo::Pid, &sysinfo::Process)> = inner.sys.processes().iter().collect();
    procs.sort_by(|a, b| {
        whole_machine_cpu_percent(b.1.cpu_usage(), logical_core_count)
            .partial_cmp(&whole_machine_cpu_percent(a.1.cpu_usage(), logical_core_count))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let top_processes: Vec<ProcessInfo> = procs
        .iter()
        .take(8)
        .map(|(pid, p)| {
            let disk = p.disk_usage();
            ProcessInfo {
                pid: pid.as_u32(),
                name: p.name().to_string_lossy().to_string(),
                cpu_percent: whole_machine_cpu_percent(p.cpu_usage(), logical_core_count),
                memory_mb: p.memory() / 1024 / 1024,
                disk_read_bytes_per_sec: bytes_per_second(disk.read_bytes, metrics.elapsed_secs),
                disk_write_bytes_per_sec: bytes_per_second(disk.written_bytes, metrics.elapsed_secs),
            }
        })
        .collect();

    let sample_count: usize = inner
        .db
        .query_row("SELECT COUNT(*) FROM system_samples", [], |r| r.get(0))
        .unwrap_or(0);

    Ok(SystemOverview {
        cpu: CpuInfo {
            usage_percent: metrics.cpu_usage,
            frequency_ghz: avg_freq,
            core_count,
        },
        memory: MemoryInfo {
            usage_percent: metrics.mem_usage,
            used_gb: used_mem as f64 / 1_073_741_824.0,
            total_gb: total_mem as f64 / 1_073_741_824.0,
        },
        disks,
        network: NetworkInfo {
            total_mbps: metrics.up_mbps + metrics.down_mbps,
            upload_mbps: metrics.up_mbps,
            download_mbps: metrics.down_mbps,
        },
        top_processes,
        sample_count,
    })
}

#[tauri::command]
pub async fn system_get_history(
    state: State<'_, SystemState>,
    window_secs: Option<i64>,
) -> Result<Vec<SamplePoint>, String> {
    let inner = state.0.lock().map_err(|e| format!("State lock: {}", e))?;
    let cutoff = now_ts() - history_window_secs(window_secs);
    let mut stmt = inner
        .db
        .prepare("SELECT ts, cpu_usage, mem_usage, net_total_mbps FROM system_samples WHERE ts >= ?1 ORDER BY ts ASC")
        .map_err(|e| format!("Failed to prepare history query: {}", e))?;
    let rows: Vec<SamplePoint> = stmt
        .query_map(params![cutoff], |r| {
            Ok(SamplePoint {
                ts: r.get(0)?,
                cpu_usage: r.get(1)?,
                mem_usage: r.get(2)?,
                net_total_mbps: r.get(3)?,
            })
        })
        .map_err(|e| format!("Failed to query history: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// 启动后台采样线程：每 10 秒写入一个样本点，自动置换过期数据
pub fn start_background_sampler(handle: Arc<Mutex<Inner>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(SAMPLE_INTERVAL_SECS));
        if let Ok(mut inner) = handle.lock() {
            let _ = sample(&mut inner);
        }
    });
}

// ===== 存储空间扫描 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDiskInfo {
    pub drive_letter: String,
    pub usage_percent: f32,
    pub used_gb: f64,
    pub total_gb: f64,
    pub available_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySize {
    pub path: String,
    pub size_gb: f64,
    pub file_count: u64,
    /// 嵌套子目录（仅递归扫描时填充，按大小降序）。
    /// 顶层扫描结果中该字段为空数组或省略；下钻时由前端从内存切片。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<DirectorySize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    pub id: String,
    pub name: String,
    pub size_gb: f64,
    pub path: String,
    pub cleanable: bool,
    pub recommended: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTypeSize {
    pub category: String,
    pub size_gb: f64,
}

/// 大文件信息（脱敏：仅目录名 + 扩展名 + 大小 + 修改时间桶，不含完整路径和文件名）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopFileInfo {
    pub extension: String,
    pub parent_dir_name: String,
    pub size_gb: f64,
    pub modified_bucket: String,
    /// 完整文件路径（用于右键菜单"在资源管理器中打开"和"复制路径"）
    pub path: String,
}

/// 扫描统计摘要
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub total_files: u64,
    pub total_dirs: u64,
    pub scan_duration_secs: f64,
    pub scanned_disk: String,
}

/// 按扩展名聚合的大文件桶（用于发送给 AI 做归因，脱敏）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileExtensionBucket {
    pub extension: String,
    pub count: u64,
    pub size_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageScanResult {
    pub disks: Vec<StorageDiskInfo>,
    pub directories: Vec<DirectorySize>,
    pub cleanup_items: Vec<CleanupItem>,
    pub file_types: Vec<FileTypeSize>,
    pub total_scanned_gb: f64,
    #[serde(default)]
    pub top_files: Vec<TopFileInfo>,
    #[serde(default)]
    pub scan_summary: Option<ScanSummary>,
    #[serde(default)]
    pub extension_buckets: Vec<FileExtensionBucket>,
    /// 重点路径占用（AppData/ProgramData/家目录/桌面/下载等），从嵌套树提取
    #[serde(default)]
    pub hotspots: Vec<DirectorySize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupVerification {
    pub id: String,
    pub path: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCleanupResult {
    pub freed_gb: f64,
    pub cleaned_ids: Vec<String>,
    pub failures: Vec<String>,
    #[serde(default)]
    pub verification: Vec<CleanupVerification>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub current_path: String,
    pub scanned_dirs: u64,
    pub elapsed_secs: f64,
}

/// 递归计算目录大小，跳过无权限目录
fn dir_size(path: &Path) -> (u64, u64) {
    let mut total = 0u64;
    let mut count = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        match fs::read_dir(&dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    if let Ok(file_type) = entry.file_type() {
                        if file_type.is_symlink() {
                            continue;
                        } else if file_type.is_dir() {
                            stack.push(entry.path());
                        } else if file_type.is_file() {
                            if let Ok(meta) = entry.metadata() {
                                total += meta.len();
                                count += 1;
                            }
                        }
                    }
                }
            }
            Err(_) => continue,
        }
    }
    (total, count)
}

fn file_type_category(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "webm" | "m4v" => "视频",
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "svg" | "heic" => "图片",
        "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "pdf" | "txt" | "md"
        | "csv" | "rtf" => "文档",
        "exe" | "msi" | "dll" | "appx" | "msix" | "com" => "应用",
        "sys" | "drv" | "cab" | "mui" | "cat" | "manifest" => "系统",
        _ => "其他",
    }
}

const TOP_FILE_THRESHOLD_GB: f64 = 0.5;
const MAX_TOP_FILES: usize = 100;
const MAX_EXTENSION_BUCKETS: usize = 20;

/// 大小桶：将修改时间映射为粗粒度时间段，避免泄露精确时间戳
fn modified_bucket(metadata: &fs::Metadata) -> String {
    let Some(modified) = metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()) else {
        return "unknown".to_string();
    };
    let days = modified.as_secs() / 86_400;
    if days < 30 {
        "30d".to_string()
    } else if days < 90 {
        "90d".to_string()
    } else if days < 180 {
        "180d".to_string()
    } else if days < 365 {
        "1y".to_string()
    } else {
        "old".to_string()
    }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|v| v.to_str())
        .map(|v| v.to_ascii_lowercase())
        .filter(|v| !v.is_empty() && v.len() <= 16)
        .unwrap_or_else(|| "(none)".to_string())
}

fn parent_dir_name(path: &Path) -> String {
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(|n| {
            // 截断避免泄露完整路径，仅保留最末段目录名
            n.chars().take(32).collect::<String>()
        })
        .unwrap_or_else(|| "(root)".to_string())
}

/// 递归扫描目录：累计大小、文件数，同时收集 Top 大文件（脱敏）和扩展名桶
fn scan_directory_for_insights(
    path: &Path,
    type_bytes: &mut HashMap<&'static str, u64>,
    top_files: &mut Vec<TopFileInfo>,
    extension_stats: &mut HashMap<String, (u64, u64)>,
) -> (u64, u64, u64) {
    let mut total = 0u64;
    let mut file_count = 0u64;
    let mut dir_count = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        dir_count += 1;
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                let Ok(meta) = entry.metadata() else { continue };
                let size = meta.len();
                total += size;
                file_count += 1;
                let category = file_type_category(&entry.path());
                *type_bytes.entry(category).or_default() += size;

                let ext = extension_of(&entry.path());
                let entry_stats = extension_stats.entry(ext.clone()).or_insert((0, 0));
                entry_stats.0 += 1;
                entry_stats.1 += size;

                let size_gb = size as f64 / 1_073_741_824.0;
                if size_gb >= TOP_FILE_THRESHOLD_GB {
                    top_files.push(TopFileInfo {
                        extension: ext.clone(),
                        parent_dir_name: parent_dir_name(&entry.path()),
                        size_gb,
                        modified_bucket: modified_bucket(&meta),
                        path: entry.path().to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }
    (total, file_count, dir_count)
}

/// 递归扫描目录并构建嵌套树（WizTree 风格：一次扫描，前端秒下钻）。
/// - `depth` 当前深度（从 0 开始）
/// - `MAX_TREE_DEPTH` 达到此深度后不再展开 children，但仍累加大小
/// - `MIN_SIZE_TO_KEEP_CHILDREN_GB` 小于此阈值的目录剪掉 children，减少内存
const MAX_TREE_DEPTH: usize = 5;
const MIN_SIZE_TO_KEEP_CHILDREN_GB: f64 = 0.05;

fn scan_directory_tree(
    path: &Path,
    depth: usize,
    dir_counter: &mut u64,
    type_bytes: &mut HashMap<&'static str, u64>,
    top_files: &mut Vec<TopFileInfo>,
    extension_stats: &mut HashMap<String, (u64, u64)>,
) -> DirectorySize {
    *dir_counter += 1;
    let mut total = 0u64;
    let mut file_count = 0u64;
    let mut children: Vec<DirectorySize> = Vec::new();

    let Ok(entries) = fs::read_dir(path) else {
        return DirectorySize {
            path: path.to_string_lossy().to_string(),
            size_gb: 0.0,
            file_count: 0,
            children: Vec::new(),
        };
    };

    let can_recurse = depth < MAX_TREE_DEPTH;

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() { continue; }

        if file_type.is_dir() {
            let child_path = entry.path();
            let child = if can_recurse {
                scan_directory_tree(&child_path, depth + 1, dir_counter, type_bytes, top_files, extension_stats)
            } else {
                // 达到深度上限：用迭代版只算大小，不展开
                let mut tmp_type: HashMap<&'static str, u64> = HashMap::new();
                let (size, files, _dirs) = scan_directory_for_insights(
                    &child_path, &mut tmp_type, top_files, extension_stats,
                );
                *dir_counter += _dirs;
                for (k, v) in tmp_type { *type_bytes.entry(k).or_default() += v; }
                DirectorySize {
                    path: child_path.to_string_lossy().to_string(),
                    size_gb: size as f64 / 1_073_741_824.0,
                    file_count: files,
                    children: Vec::new(),
                }
            };
            total += (child.size_gb * 1_073_741_824.0) as u64;
            file_count += child.file_count;
            children.push(child);
        } else if file_type.is_file() {
            let Ok(meta) = entry.metadata() else { continue };
            let size = meta.len();
            total += size;
            file_count += 1;

            let category = file_type_category(&entry.path());
            *type_bytes.entry(category).or_default() += size;

            let ext = extension_of(&entry.path());
            let entry_stats = extension_stats.entry(ext.clone()).or_insert((0, 0));
            entry_stats.0 += 1;
            entry_stats.1 += size;

            let size_gb = size as f64 / 1_073_741_824.0;
            if size_gb >= TOP_FILE_THRESHOLD_GB {
                top_files.push(TopFileInfo {
                    extension: ext.clone(),
                    parent_dir_name: parent_dir_name(&entry.path()),
                    size_gb,
                    modified_bucket: modified_bucket(&meta),
                    path: entry.path().to_string_lossy().into_owned(),
                });
            }
        }
    }

    children.sort_by(|a, b| b.size_gb.partial_cmp(&a.size_gb).unwrap_or(std::cmp::Ordering::Equal));

    let size_gb = total as f64 / 1_073_741_824.0;
    // 小目录剪枝：低于阈值的目录丢弃 children，减少内存和前端渲染压力
    if size_gb < MIN_SIZE_TO_KEEP_CHILDREN_GB {
        children.clear();
    }

    DirectorySize {
        path: path.to_string_lossy().to_string(),
        size_gb,
        file_count,
        children,
    }
}

/// 从 top_files 和 extension_stats 生成最终的扩展名桶（按大小降序）
fn build_extension_buckets(extension_stats: HashMap<String, (u64, u64)>) -> Vec<FileExtensionBucket> {
    let mut buckets: Vec<FileExtensionBucket> = extension_stats
        .into_iter()
        .map(|(ext, (count, bytes))| FileExtensionBucket {
            extension: ext,
            count,
            size_gb: bytes as f64 / 1_073_741_824.0,
        })
        .collect();
    buckets.sort_by(|a, b| b.size_gb.partial_cmp(&a.size_gb).unwrap_or(std::cmp::Ordering::Equal));
    buckets.truncate(MAX_EXTENSION_BUCKETS);
    buckets
}

/// 从 top_files 生成最终的 Top N 大文件列表（按大小降序）
fn build_top_files(mut top_files: Vec<TopFileInfo>) -> Vec<TopFileInfo> {
    top_files.sort_by(|a, b| b.size_gb.partial_cmp(&a.size_gb).unwrap_or(std::cmp::Ordering::Equal));
    top_files.truncate(MAX_TOP_FILES);
    top_files
}

/// 在嵌套树中按完整路径查找节点
fn find_node_in_tree<'a>(nodes: &'a [DirectorySize], target: &Path) -> Option<&'a DirectorySize> {
    for node in nodes {
        let node_path = PathBuf::from(&node.path);
        if node_path == target {
            return Some(node);
        }
        if target.starts_with(&node_path) && !node.children.is_empty() {
            if let Some(found) = find_node_in_tree(&node.children, target) {
                return Some(found);
            }
        }
    }
    None
}

/// 从已扫描的嵌套树提取重点路径占用（不重复扫描磁盘）
fn extract_hotspots(directories: &[DirectorySize]) -> Vec<DirectorySize> {
    let mut hotspots = Vec::new();

    let user_profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let hotspot_paths: Vec<(String, PathBuf)> = {
        let mut paths: Vec<(String, PathBuf)> = Vec::new();
        if let Some(home) = &user_profile {
            paths.push(("用户家目录".to_string(), home.clone()));
            paths.push(("AppData\\Local".to_string(), home.join("AppData\\Local")));
            paths.push(("AppData\\Roaming".to_string(), home.join("AppData\\Roaming")));
            paths.push(("桌面".to_string(), home.join("Desktop")));
            paths.push(("下载".to_string(), home.join("Downloads")));
        }
        paths.push(("ProgramData".to_string(), PathBuf::from("C:\\ProgramData")));
        paths
    };

    for (label, path) in hotspot_paths {
        if let Some(node) = find_node_in_tree(directories, &path) {
            // 复制节点但清空 children（热点卡片只展示大小，不需要嵌套）
            hotspots.push(DirectorySize {
                path: format!("{} · {}", label, node.path),
                size_gb: node.size_gb,
                file_count: node.file_count,
                children: Vec::new(),
            });
        }
    }
    hotspots
}

fn cleanup_is_allowed(id: &str) -> bool {
    matches!(id, "temp" | "chrome" | "edge" | "trash" | "updates" | "wer" | "delivery_optimization")
}

/// 计算清理项大小
fn scan_cleanup_items() -> Vec<CleanupItem> {
    let mut items = Vec::new();
    let local_app = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let temp_dir = std::env::temp_dir();
    let (size, _) = dir_size(&temp_dir);
    items.push(CleanupItem {
        id: "temp".to_string(),
        name: "系统临时文件".to_string(),
        size_gb: size as f64 / 1_073_741_824.0,
        path: temp_dir.to_string_lossy().to_string(),
        cleanable: true,
        recommended: true,
        reason: "应用未占用的临时文件可安全清理".to_string(),
    });

    let recycle_bin = PathBuf::from("C:\\$Recycle.Bin");
    if recycle_bin.exists() {
        let (size, _) = dir_size(&recycle_bin);
        items.push(CleanupItem {
            id: "trash".to_string(),
            name: "回收站".to_string(),
            size_gb: size as f64 / 1_073_741_824.0,
            path: recycle_bin.to_string_lossy().to_string(),
            cleanable: true,
            recommended: true,
            reason: "通过 PowerShell Clear-RecycleBin 清空所有用户的回收站".to_string(),
        });
    }

    let win_update = PathBuf::from("C:\\Windows\\SoftwareDistribution\\Download");
    if win_update.exists() {
        let (size, _) = dir_size(&win_update);
        items.push(CleanupItem {
            id: "updates".to_string(),
            name: "Windows 更新缓存".to_string(),
            size_gb: size as f64 / 1_073_741_824.0,
            path: win_update.to_string_lossy().to_string(),
            cleanable: true,
            recommended: true,
            reason: "已下载的更新安装包，删除后 Windows 会按需重新下载".to_string(),
        });
    }

    // Windows 错误报告（WER）归档
    if !local_app.is_empty() {
        let wer = PathBuf::from(&local_app).join("Microsoft\\Windows\\WER");
        if wer.exists() {
            let (size, _) = dir_size(&wer);
            items.push(CleanupItem {
                id: "wer".to_string(),
                name: "Windows 错误报告".to_string(),
                size_gb: size as f64 / 1_073_741_824.0,
                path: wer.to_string_lossy().to_string(),
                cleanable: true,
                recommended: true,
                reason: "崩溃转储和错误报告归档，应用和 Windows 不会依赖这些文件运行".to_string(),
            });
        }
    }

    // 传递优化缓存（Windows Update 的 P2P 缓存）
    let delivery_opt = PathBuf::from("C:\\Windows\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization");
    if delivery_opt.exists() {
        let (size, _) = dir_size(&delivery_opt);
        items.push(CleanupItem {
            id: "delivery_optimization".to_string(),
            name: "传递优化缓存".to_string(),
            size_gb: size as f64 / 1_073_741_824.0,
            path: delivery_opt.to_string_lossy().to_string(),
            cleanable: true,
            recommended: true,
            reason: "Windows 更新的 P2P 下载缓存，删除后不影响已安装的更新".to_string(),
        });
    }

    // 浏览器缓存
    if !local_app.is_empty() {
        let caches = [
            ("chrome", "Google\\Chrome\\User Data\\Default\\Cache"),
            ("edge", "Microsoft\\Edge\\User Data\\Default\\Cache"),
        ];
        for (id, sub) in caches {
            let p = PathBuf::from(&local_app).join(sub);
            if p.exists() {
                let (size, _) = dir_size(&p);
                items.push(CleanupItem {
                    id: id.to_string(),
                    name: format!("{} 缓存", if id == "chrome" { "Chrome" } else { "Edge" }),
                    size_gb: size as f64 / 1_073_741_824.0,
                    path: p.to_string_lossy().to_string(),
                    cleanable: true,
                    recommended: true,
                    reason: "浏览器会按需重新生成缓存".to_string(),
                });
            }
        }
    }
    items
}

fn scan_storage_inner(app: AppHandle) -> StorageScanResult {
    let start = Instant::now();

    // 磁盘信息（sysinfo 快速获取）
    let disks_list = Disks::new_with_refreshed_list();
    let disks: Vec<StorageDiskInfo> = disks_list
        .list()
        .iter()
        .map(|d| {
            let total = d.total_space();
            let available = d.available_space();
            let used = total.saturating_sub(available);
            let usage = if total > 0 {
                (used as f64 / total as f64 * 100.0) as f32
            } else {
                0.0
            };
            StorageDiskInfo {
                drive_letter: d.mount_point().to_string_lossy().to_string(),
                usage_percent: usage,
                used_gb: used as f64 / 1_073_741_824.0,
                total_gb: total as f64 / 1_073_741_824.0,
                available_gb: available as f64 / 1_073_741_824.0,
            }
        })
        .collect();

    // 扫描目标目录：系统盘根下的关键目录
    let scan_targets: Vec<PathBuf> = {
        let mut targets = Vec::new();
        let c_drive = PathBuf::from("C:\\");
        if c_drive.exists() {
            for name in ["Windows", "Users", "Program Files", "Program Files (x86)", "ProgramData"] {
                let p = c_drive.join(name);
                if p.exists() {
                    targets.push(p);
                }
            }
        }
        targets
    };

    let mut directories = Vec::new();
    let mut total_scanned = 0u64;
    let mut dir_count = 0u64;
    let mut total_files = 0u64;
    let mut type_bytes = HashMap::new();
    let mut top_files: Vec<TopFileInfo> = Vec::new();
    let mut extension_stats: HashMap<String, (u64, u64)> = HashMap::new();

    for target in &scan_targets {
        let _ = app.emit(
            "storage-scan-progress",
            ScanProgress {
                current_path: target.to_string_lossy().to_string(),
                scanned_dirs: dir_count,
                elapsed_secs: start.elapsed().as_secs_f64(),
            },
        );
        let node = scan_directory_tree(target, 0, &mut dir_count, &mut type_bytes, &mut top_files, &mut extension_stats);
        total_scanned += (node.size_gb * 1_073_741_824.0) as u64;
        total_files += node.file_count;
        directories.push(node);
    }

    // 按大小降序
    directories.sort_by(|a, b| b.size_gb.partial_cmp(&a.size_gb).unwrap_or(std::cmp::Ordering::Equal));

    let _ = app.emit(
        "storage-scan-progress",
        ScanProgress {
            current_path: "正在扫描清理项...".to_string(),
            scanned_dirs: dir_count,
            elapsed_secs: start.elapsed().as_secs_f64(),
        },
    );
    let cleanup_items = scan_cleanup_items();
    let file_types = ["应用", "视频", "图片", "文档", "系统", "其他"]
        .into_iter()
        .map(|category| FileTypeSize {
            category: category.to_string(),
            size_gb: type_bytes.get(category).copied().unwrap_or_default() as f64
                / 1_073_741_824.0,
        })
        .collect();

    let extension_buckets = build_extension_buckets(extension_stats);
    let top_files = build_top_files(top_files);
    let scan_summary = ScanSummary {
        total_files,
        total_dirs: dir_count,
        scan_duration_secs: start.elapsed().as_secs_f64(),
        scanned_disk: "C:".to_string(),
    };
    let hotspots = extract_hotspots(&directories);

    StorageScanResult {
        disks,
        directories,
        cleanup_items,
        file_types,
        total_scanned_gb: total_scanned as f64 / 1_073_741_824.0,
        top_files,
        scan_summary: Some(scan_summary),
        extension_buckets,
        hotspots,
    }
}

#[tauri::command]
pub async fn scan_storage(app: AppHandle) -> Result<StorageScanResult, String> {
    tokio::task::spawn_blocking(move || scan_storage_inner(app))
        .await
        .map_err(|error| format!("存储扫描任务失败: {error}"))
}

/// 在 Windows 资源管理器中打开指定目录（绕过 Tauri opener 权限限制）
#[tauri::command]
pub async fn system_open_in_explorer(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let target = PathBuf::from(&path);
        if !target.exists() {
            return Err(format!("路径不存在: {path}"));
        }
        // explorer.exe 直接打开，支持任意路径（包括 C:\Windows、C:\Program Files 等）
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {e}"))?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

/// 在 Windows 资源管理器中选中并显示指定项（绕过 Tauri opener 权限限制）
#[tauri::command]
pub async fn system_reveal_in_explorer(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let target = PathBuf::from(&path);
        if !target.exists() {
            return Err(format!("路径不存在: {path}"));
        }
        // /select,<path> 让资源管理器打开父目录并选中该项
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("打开资源管理器失败: {e}"))?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

fn cleanup_path(id: &str) -> Option<PathBuf> {
    match id {
        "temp" => Some(std::env::temp_dir()),
        "chrome" => std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|root| root.join("Google\\Chrome\\User Data\\Default\\Cache")),
        "edge" => std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|root| root.join("Microsoft\\Edge\\User Data\\Default\\Cache")),
        "updates" => Some(PathBuf::from("C:\\Windows\\SoftwareDistribution\\Download")),
        "wer" => std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|root| root.join("Microsoft\\Windows\\WER")),
        "delivery_optimization" => Some(PathBuf::from(
            "C:\\Windows\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization",
        )),
        // trash 走 PowerShell，不走目录删除路径
        _ => None,
    }
}

/// 清理单个候选目录并返回 before/after 真实测量值
fn clear_directory_with_verification(id: &str) -> Result<CleanupVerification, String> {
    // 回收站走 PowerShell Clear-RecycleBin
    if id == "trash" {
        let recycle_bin = PathBuf::from("C:\\$Recycle.Bin");
        let before = if recycle_bin.exists() { dir_size(&recycle_bin).0 } else { 0 };
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"])
            .output();
        let after = if recycle_bin.exists() { dir_size(&recycle_bin).0 } else { 0 };
        return Ok(CleanupVerification {
            id: id.to_string(),
            path: recycle_bin.to_string_lossy().to_string(),
            before_bytes: before,
            after_bytes: after,
        });
    }

    let Some(path) = cleanup_path(id) else {
        return Err(format!("{id}: 路径不可用"));
    };
    let path_str = path.to_string_lossy().to_string();
    if !path.exists() {
        return Ok(CleanupVerification {
            id: id.to_string(),
            path: path_str,
            before_bytes: 0,
            after_bytes: 0,
        });
    }
    let before = dir_size(&path).0;
    let entries = fs::read_dir(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        let result = if file_type.is_symlink() {
            continue;
        } else if file_type.is_dir() {
            fs::remove_dir_all(&entry_path)
        } else {
            fs::remove_file(&entry_path)
        };
        if let Err(error) = result {
            log::warn!("storage cleanup skipped {}: {error}", entry_path.display());
        }
    }
    let after = dir_size(&path).0;
    Ok(CleanupVerification {
        id: id.to_string(),
        path: path_str,
        before_bytes: before,
        after_bytes: after,
    })
}

#[tauri::command]
pub async fn clean_storage(
    state: State<'_, SystemState>,
    ids: Vec<String>,
) -> Result<StorageCleanupResult, String> {
    if ids.iter().any(|id| !cleanup_is_allowed(id)) {
        return Err("包含不允许由 Mona 直接删除的清理项".to_string());
    }
    let (freed, cleaned_ids, failures, verification) = tokio::task::spawn_blocking(move || {
        let mut freed = 0u64;
        let mut cleaned_ids = Vec::new();
        let mut failures = Vec::new();
        let mut verification: Vec<CleanupVerification> = Vec::new();
        for id in ids {
            match clear_directory_with_verification(&id) {
                Ok(v) => {
                    freed += v.before_bytes.saturating_sub(v.after_bytes);
                    cleaned_ids.push(id);
                    verification.push(v);
                }
                Err(error) => failures.push(error),
            }
        }
        (freed, cleaned_ids, failures, verification)
    })
    .await
    .map_err(|error| format!("清理任务失败: {error}"))?;

    if let Ok(inner) = state.0.lock() {
        let _ = inner.db.execute_batch(
            "CREATE TABLE IF NOT EXISTS cleanup_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                bytes_changed INTEGER NOT NULL,
                detail TEXT NOT NULL
            );",
        );
        let status = if failures.is_empty() {
            "成功"
        } else if cleaned_ids.is_empty() {
            "失败"
        } else {
            "部分成功"
        };
        let detail = if failures.is_empty() {
            "已重新测量清理前后的目录占用".to_string()
        } else {
            failures.join("；")
        };
        let _ = inner.db.execute(
            "INSERT INTO cleanup_operations (ts, title, status, bytes_changed, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![now_ts(), "安全清理缓存与临时文件", status, freed as i64, detail],
        );
    }

    Ok(StorageCleanupResult {
        freed_gb: freed as f64 / 1_073_741_824.0,
        cleaned_ids,
        failures,
        verification,
    })
}
