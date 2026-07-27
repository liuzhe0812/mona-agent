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
pub mod repair;
pub mod defender;

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
        assert!(!cleanup_is_allowed("trash"));
        assert!(!cleanup_is_allowed("updates"));
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageScanResult {
    pub disks: Vec<StorageDiskInfo>,
    pub directories: Vec<DirectorySize>,
    pub cleanup_items: Vec<CleanupItem>,
    pub file_types: Vec<FileTypeSize>,
    pub total_scanned_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCleanupResult {
    pub freed_gb: f64,
    pub cleaned_ids: Vec<String>,
    pub failures: Vec<String>,
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

fn dir_size_with_types(path: &Path, type_bytes: &mut HashMap<&'static str, u64>) -> (u64, u64) {
    let mut total = 0u64;
    let mut count = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                if let Ok(meta) = entry.metadata() {
                    let size = meta.len();
                    total += size;
                    count += 1;
                    *type_bytes.entry(file_type_category(&entry.path())).or_default() += size;
                }
            }
        }
    }
    (total, count)
}

fn cleanup_is_allowed(id: &str) -> bool {
    matches!(id, "temp" | "chrome" | "edge")
}

/// 计算清理项大小
fn scan_cleanup_items() -> Vec<CleanupItem> {
    let mut items = Vec::new();
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
            cleanable: false,
            recommended: false,
            reason: "请使用 Windows 回收站确认后清空".to_string(),
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
            cleanable: false,
            recommended: false,
            reason: "交由 Windows 存储感知清理".to_string(),
        });
    }

    // 浏览器缓存
    let local_app = std::env::var("LOCALAPPDATA").unwrap_or_default();
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
    let mut type_bytes = HashMap::new();

    for target in &scan_targets {
        dir_count += 1;
        let _ = app.emit(
            "storage-scan-progress",
            ScanProgress {
                current_path: target.to_string_lossy().to_string(),
                scanned_dirs: dir_count,
                elapsed_secs: start.elapsed().as_secs_f64(),
            },
        );
        let (size, count) = dir_size_with_types(target, &mut type_bytes);
        total_scanned += size;
        directories.push(DirectorySize {
            path: target.to_string_lossy().to_string(),
            size_gb: size as f64 / 1_073_741_824.0,
            file_count: count,
        });
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

    StorageScanResult {
        disks,
        directories,
        cleanup_items,
        file_types,
        total_scanned_gb: total_scanned as f64 / 1_073_741_824.0,
    }
}

#[tauri::command]
pub async fn scan_storage(app: AppHandle) -> Result<StorageScanResult, String> {
    tokio::task::spawn_blocking(move || scan_storage_inner(app))
        .await
        .map_err(|error| format!("存储扫描任务失败: {error}"))
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
        _ => None,
    }
}

fn clear_directory_contents(path: &Path) -> Result<u64, String> {
    let before = dir_size(path).0;
    let entries = fs::read_dir(path).map_err(|error| format!("{}: {error}", path.display()))?;
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
    Ok(before.saturating_sub(dir_size(path).0))
}

#[tauri::command]
pub async fn clean_storage(
    state: State<'_, SystemState>,
    ids: Vec<String>,
) -> Result<StorageCleanupResult, String> {
    if ids.iter().any(|id| !cleanup_is_allowed(id)) {
        return Err("包含不允许由 Mona 直接删除的清理项".to_string());
    }
    let (freed, cleaned_ids, failures) = tokio::task::spawn_blocking(move || {
        let mut freed = 0u64;
        let mut cleaned_ids = Vec::new();
        let mut failures = Vec::new();
        for id in ids {
            let Some(path) = cleanup_path(&id) else {
                failures.push(format!("{id}: 路径不可用"));
                continue;
            };
            if !path.exists() {
                cleaned_ids.push(id);
                continue;
            }
            match clear_directory_contents(&path) {
                Ok(bytes) => {
                    freed += bytes;
                    cleaned_ids.push(id);
                }
                Err(error) => failures.push(error),
            }
        }
        (freed, cleaned_ids, failures)
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
    })
}
