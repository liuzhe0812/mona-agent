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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
        bytes_per_second, cleanup_is_allowed, cleanup_path, decode_windows_output, file_type_category,
        history_window_secs, is_thumbcache_file, normalize_scan_drive, refresh_readings, sample,
        scan_directory_tree, trash_path_check, whole_machine_cpu_percent, Connection, Disks, Inner, Networks,
        ScanProgressEmitter, System, HISTORY_WINDOW_SECS,
    };
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::Instant;

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
        assert!(cleanup_is_allowed("dxshader"));
        assert!(cleanup_is_allowed("thumbcache"));
        // windows_old 仅检测提示，不允许 Mona 直接删除
        assert!(!cleanup_is_allowed("windows_old"));
        assert!(!cleanup_is_allowed("custom-path"));
    }

    #[test]
    fn thumbcache_file_filter_only_matches_db_files() {
        assert!(is_thumbcache_file("thumbcache_96.db"));
        assert!(is_thumbcache_file("thumbcache_idx.db"));
        assert!(!is_thumbcache_file("thumbcache_96.db-journal"));
        assert!(!is_thumbcache_file("iconcache_96.db"));
        assert!(!is_thumbcache_file("thumbcache_96.tmp"));
    }

    #[test]
    fn cleanup_path_resolves_new_candidate_ids() {
        // dxshader / thumbcache 依赖 LOCALAPPDATA；windows_old 无路径（仅提示）
        if std::env::var_os("LOCALAPPDATA").is_some() {
            assert!(cleanup_path("dxshader").is_some());
            assert!(cleanup_path("thumbcache").is_some());
        }
        assert!(cleanup_path("windows_old").is_none());
    }

    #[test]
    fn trash_path_check_rejects_system_directories() {
        assert!(trash_path_check(Path::new("C:\\Windows\\System32\\kernel32.dll")).is_err());
        assert!(trash_path_check(Path::new("c:\\program files\\app\\big.bin")).is_err());
        assert!(trash_path_check(Path::new("C:/Program Files (x86)/app/big.iso")).is_err());
    }

    #[test]
    fn trash_path_check_rejects_missing_paths_and_directories() {
        assert!(trash_path_check(Path::new("D:\\mona-definitely-not-exist-98765\\big.bin")).is_err());
        // 存在的目录必须拒绝（仅允许文件）
        assert!(trash_path_check(&std::env::temp_dir()).is_err());
    }

    #[test]
    fn trash_path_check_accepts_regular_file() {
        let file = std::env::temp_dir().join(format!("mona-trash-check-{}.tmp", std::process::id()));
        std::fs::write(&file, b"x").expect("write temp file");
        let result = trash_path_check(&file);
        let _ = std::fs::remove_file(&file);
        assert_eq!(result.ok(), Some(1));
    }

    #[test]
    fn overview_reads_do_not_write_samples() {
        // 查询/采样分离：refresh_readings（system_get_overview 路径）不得写库，
        // 历史折线密度只由后台 10s sampler（sample）决定
        let mut inner = Inner {
            sys: System::new(),
            disks: Disks::new_with_refreshed_list(),
            networks: Networks::new_with_refreshed_list(),
            last_net_rx: 0,
            last_net_tx: 0,
            last_ts: Instant::now(),
            db: Connection::open_in_memory().expect("in-memory db"),
            scan_cancel: Arc::new(AtomicBool::new(false)),
        };
        inner
            .db
            .execute_batch(
                "CREATE TABLE system_samples (ts INTEGER PRIMARY KEY, cpu_usage REAL NOT NULL, mem_usage REAL NOT NULL, net_total_mbps REAL NOT NULL, net_up_mbps REAL NOT NULL, net_down_mbps REAL NOT NULL);",
            )
            .expect("create samples table");

        let row_count = |inner: &Inner| -> i64 {
            inner
                .db
                .query_row("SELECT COUNT(*) FROM system_samples", [], |r| r.get(0))
                .expect("count samples")
        };

        let _ = refresh_readings(&mut inner);
        assert_eq!(row_count(&inner), 0);

        sample(&mut inner).expect("sample writes one row");
        assert_eq!(row_count(&inner), 1);
    }

    #[test]
    fn normalize_scan_drive_accepts_common_spellings() {
        // 默认回退系统盘（CI/开发机均为 C:）
        assert_eq!(normalize_scan_drive(None).expect("default"), "C:");
        assert_eq!(normalize_scan_drive(Some("d".to_string())).expect("d"), "D:");
        assert_eq!(normalize_scan_drive(Some("D:".to_string())).expect("D:"), "D:");
        assert_eq!(normalize_scan_drive(Some("e:\\".to_string())).expect("e:\\"), "E:");
        assert!(normalize_scan_drive(Some("1:".to_string())).is_err());
    }

    #[test]
    fn tree_scan_is_deterministic_across_runs() {
        // 并行扫描的合并正确性建立在单树扫描确定性之上：同一目录两次扫描结果必须一致
        let root = std::env::temp_dir().join(format!("mona-scan-determinism-{}", std::process::id()));
        let sub_a = root.join("alpha");
        let sub_b = root.join("beta").join("nested");
        std::fs::create_dir_all(&sub_a).expect("create alpha");
        std::fs::create_dir_all(&sub_b).expect("create beta");
        std::fs::write(sub_a.join("a.bin"), vec![0u8; 1024]).expect("write a");
        std::fs::write(sub_b.join("b.bin"), vec![0u8; 2048]).expect("write b");

        let scan = || {
            let cancel = AtomicBool::new(false);
            let emitter = ScanProgressEmitter::noop();
            let mut dirs = 0u64;
            let mut types = HashMap::new();
            let mut top = Vec::new();
            let mut ext = HashMap::new();
            scan_directory_tree(
                &root, 0, &cancel, &emitter, &mut dirs, &mut types, &mut top, &mut ext,
            )
        };
        let first = scan();
        let second = scan();
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(first.size_bytes, 1024 + 2048);
        assert_eq!(first.file_count, 2);
        assert_eq!(first.size_bytes, second.size_bytes);
        assert_eq!(first.file_count, second.file_count);
    }

    #[test]
    fn cancel_token_short_circuits_tree_scan() {
        let root = std::env::temp_dir().join(format!("mona-scan-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::write(root.join("a.bin"), vec![0u8; 512]).expect("write");

        let cancel = AtomicBool::new(true); // 预置取消令牌
        let emitter = ScanProgressEmitter::noop();
        let mut dirs = 0u64;
        let mut types = HashMap::new();
        let mut top = Vec::new();
        let mut ext = HashMap::new();
        let node = scan_directory_tree(
            &root, 0, &cancel, &emitter, &mut dirs, &mut types, &mut top, &mut ext,
        );
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(node.size_bytes, 0);
        assert_eq!(node.file_count, 0);
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
    scan_cancel: Arc<AtomicBool>,
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
            scan_cancel: Arc::new(AtomicBool::new(false)),
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

/// 刷新 sysinfo 读数并计算瞬时指标（不写 SQLite）
/// 供 system_get_overview 等查询路径使用，避免前端轮询污染历史折线密度
fn refresh_readings(inner: &mut Inner) -> SampleMetrics {
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

    SampleMetrics {
        cpu_usage: avg_usage,
        mem_usage,
        up_mbps,
        down_mbps,
        elapsed_secs: elapsed,
    }
}

/// 后台采样：刷新读数 + 写入 SQLite + 清理过期样本（仅 10s sampler 调用）
fn sample(inner: &mut Inner) -> Result<SampleMetrics, String> {
    let metrics = refresh_readings(inner);
    let net_total = metrics.up_mbps + metrics.down_mbps;

    let ts = now_ts();
    inner
        .db
        .execute(
            "INSERT OR REPLACE INTO system_samples (ts, cpu_usage, mem_usage, net_total_mbps, net_up_mbps, net_down_mbps) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![ts, metrics.cpu_usage, metrics.mem_usage, net_total, metrics.up_mbps, metrics.down_mbps],
        )
        .map_err(|e| format!("Failed to insert sample: {}", e))?;
    // 过期数据置换：删除超过 60 分钟窗口的旧记录
    let cutoff = ts - HISTORY_WINDOW_SECS;
    inner
        .db
        .execute("DELETE FROM system_samples WHERE ts < ?1", params![cutoff])
        .map_err(|e| format!("Failed to prune stale samples: {}", e))?;
    Ok(metrics)
}

#[tauri::command]
pub async fn system_get_overview(state: State<'_, SystemState>) -> Result<SystemOverview, String> {
    let mut inner = state.0.lock().map_err(|e| format!("State lock: {}", e))?;
    let metrics = refresh_readings(&mut inner);

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
    /// 可移动盘（U 盘等），磁盘选择器中过滤
    pub is_removable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySize {
    pub path: String,
    pub size_gb: f64,
    /// 字节级精确大小，仅扫描内部累加（消除 GB 浮点往返误差），不序列化
    #[serde(skip)]
    pub size_bytes: u64,
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
    /// 用户取消导致的提前结束（结果为部分数据）
    #[serde(default)]
    pub cancelled: bool,
}

/// 并行扫描共享的进度发射器：聚合各线程目录计数，按 500 目录 + 200ms 节流 emit
struct ScanProgressEmitter {
    on_progress: Box<dyn Fn(&Path, u64) + Send + Sync>,
    dirs: AtomicU64,
    last_emit: Mutex<Instant>,
}

impl ScanProgressEmitter {
    fn new(on_progress: impl Fn(&Path, u64) + Send + Sync + 'static) -> Self {
        Self {
            on_progress: Box::new(on_progress),
            dirs: AtomicU64::new(0),
            last_emit: Mutex::new(Instant::now()),
        }
    }

    #[cfg(test)]
    fn noop() -> Self {
        Self::new(|_, _| {})
    }

    /// 每扫描完一个目录调用一次；返回最新的全局目录计数
    fn dir_scanned(&self, current_path: &Path) -> u64 {
        let dirs = self.dirs.fetch_add(1, Ordering::Relaxed) + 1;
        if dirs % 500 == 0 {
            let mut last = self.last_emit.lock().unwrap();
            if last.elapsed() >= Duration::from_millis(200) {
                *last = Instant::now();
                (self.on_progress)(current_path, dirs);
            }
        }
        dirs
    }

    fn total_dirs(&self) -> u64 {
        self.dirs.load(Ordering::Relaxed)
    }
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
    cancel: &AtomicBool,
    emitter: &ScanProgressEmitter,
    type_bytes: &mut HashMap<&'static str, u64>,
    top_files: &mut Vec<TopFileInfo>,
    extension_stats: &mut HashMap<String, (u64, u64)>,
) -> (u64, u64, u64) {
    if cancel.load(Ordering::Relaxed) { return (0, 0, 0); }
    let mut total = 0u64;
    let mut file_count = 0u64;
    let mut dir_count = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if cancel.load(Ordering::Relaxed) { break; }
        dir_count += 1;
        emitter.dir_scanned(&dir);
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if cancel.load(Ordering::Relaxed) { break; }
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_symlink() { continue; }
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
    cancel: &AtomicBool,
    emitter: &ScanProgressEmitter,
    dir_counter: &mut u64,
    type_bytes: &mut HashMap<&'static str, u64>,
    top_files: &mut Vec<TopFileInfo>,
    extension_stats: &mut HashMap<String, (u64, u64)>,
) -> DirectorySize {
    if cancel.load(Ordering::Relaxed) {
        return DirectorySize {
            path: path.to_string_lossy().to_string(),
            size_gb: 0.0,
            size_bytes: 0,
            file_count: 0,
            children: Vec::new(),
        };
    }

    *dir_counter += 1;
    emitter.dir_scanned(path);
    let mut total = 0u64;
    let mut file_count = 0u64;
    let mut children: Vec<DirectorySize> = Vec::new();

    let Ok(entries) = fs::read_dir(path) else {
        return DirectorySize {
            path: path.to_string_lossy().to_string(),
            size_gb: 0.0,
            size_bytes: 0,
            file_count: 0,
            children: Vec::new(),
        };
    };

    let can_recurse = depth < MAX_TREE_DEPTH;

    for entry in entries.flatten() {
        if cancel.load(Ordering::Relaxed) { break; }
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_symlink() { continue; }

        if file_type.is_dir() {
            let child_path = entry.path();
            let child = if can_recurse {
                scan_directory_tree(&child_path, depth + 1, cancel, emitter, dir_counter, type_bytes, top_files, extension_stats)
            } else {
                // 达到深度上限：用迭代版只算大小，不展开
                let mut tmp_type: HashMap<&'static str, u64> = HashMap::new();
                let (size, files, _dirs) = scan_directory_for_insights(
                    &child_path, cancel, emitter, &mut tmp_type, top_files, extension_stats,
                );
                *dir_counter += _dirs;
                for (k, v) in tmp_type { *type_bytes.entry(k).or_default() += v; }
                DirectorySize {
                    path: child_path.to_string_lossy().to_string(),
                    size_gb: size as f64 / 1_073_741_824.0,
                    size_bytes: size,
                    file_count: files,
                    children: Vec::new(),
                }
            };
            total += child.size_bytes;
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
        size_bytes: total,
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
            // 家目录与子路径平铺会重复计数：子路径单独列出，家目录改为「家目录其他」
            paths.push(("AppData\\Local".to_string(), home.join("AppData\\Local")));
            paths.push(("AppData\\Roaming".to_string(), home.join("AppData\\Roaming")));
            paths.push(("桌面".to_string(), home.join("Desktop")));
            paths.push(("下载".to_string(), home.join("Downloads")));
        }
        paths.push(("ProgramData".to_string(), PathBuf::from("C:\\ProgramData")));
        paths
    };

    let mut listed_home_bytes = 0u64;
    for (label, path) in hotspot_paths {
        if let Some(node) = find_node_in_tree(directories, &path) {
            // 只有家目录下的子路径才计入「家目录其他」的扣减
            if user_profile.as_ref().is_some_and(|home| path.starts_with(home)) {
                listed_home_bytes += node.size_bytes;
            }
            // 复制节点但清空 children（热点卡片只展示大小，不需要嵌套）
            hotspots.push(DirectorySize {
                path: format!("{} · {}", label, node.path),
                size_gb: node.size_gb,
                size_bytes: node.size_bytes,
                file_count: node.file_count,
                children: Vec::new(),
            });
        }
    }

    // 「家目录其他」= 家目录总大小 − 已列出子路径大小之和，避免与子路径重复
    if let Some(home) = &user_profile {
        if let Some(home_node) = find_node_in_tree(directories, home) {
            let other_bytes = home_node.size_bytes.saturating_sub(listed_home_bytes);
            if other_bytes > 0 {
                hotspots.push(DirectorySize {
                    path: format!("家目录其他 · {}", home_node.path),
                    size_gb: other_bytes as f64 / 1_073_741_824.0,
                    size_bytes: other_bytes,
                    file_count: 0,
                    children: Vec::new(),
                });
            }
        }
    }
    hotspots
}

fn cleanup_is_allowed(id: &str) -> bool {
    matches!(
        id,
        "temp" | "chrome" | "edge" | "trash" | "updates" | "wer" | "delivery_optimization" | "dxshader" | "thumbcache"
    )
}

/// 资源管理器缩略图缓存目录（%LOCALAPPDATA%\Microsoft\Windows\Explorer）
fn thumbcache_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("Microsoft\\Windows\\Explorer"))
}

fn is_thumbcache_file(name: &str) -> bool {
    name.starts_with("thumbcache_") && name.ends_with(".db")
}

/// 缩略图缓存总大小（目录内仅 thumbcache_*.db，其余文件不属于清理范围）
fn thumbcache_bytes(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| {
                    entry.file_name().to_str().map(is_thumbcache_file).unwrap_or(false)
                })
                .filter_map(|entry| entry.metadata().ok())
                .map(|meta| meta.len())
                .sum()
        })
        .unwrap_or(0)
}

/// 停止 Windows Update 服务（清理更新下载缓存前置步骤，需管理员授权）
#[cfg(windows)]
fn stop_windows_update_service() -> Result<(), String> {
    run_elevated("net.exe", "stop wuauserv", 60_000)
}

#[cfg(not(windows))]
fn stop_windows_update_service() -> Result<(), String> {
    Err("仅支持 Windows".into())
}

/// 恢复 Windows Update 服务（尽力而为，失败不阻断清理结果）
#[cfg(windows)]
fn start_windows_update_service() {
    let _ = run_elevated("net.exe", "start wuauserv", 60_000);
}

#[cfg(not(windows))]
fn start_windows_update_service() {}

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

        // DirectX Shader Cache
        let dxshader = PathBuf::from(&local_app).join("D3DSCache");
        if dxshader.exists() {
            let (size, _) = dir_size(&dxshader);
            items.push(CleanupItem {
                id: "dxshader".to_string(),
                name: "DirectX 着色器缓存".to_string(),
                size_gb: size as f64 / 1_073_741_824.0,
                path: dxshader.to_string_lossy().to_string(),
                cleanable: true,
                recommended: true,
                reason: "显卡驱动会按需重新生成着色器缓存".to_string(),
            });
        }

        // 资源管理器缩略图缓存（仅 thumbcache_*.db）
        if let Some(dir) = thumbcache_dir() {
            if dir.exists() {
                let size = thumbcache_bytes(&dir);
                items.push(CleanupItem {
                    id: "thumbcache".to_string(),
                    name: "缩略图缓存".to_string(),
                    size_gb: size as f64 / 1_073_741_824.0,
                    path: dir.to_string_lossy().to_string(),
                    cleanable: true,
                    recommended: true,
                    reason: "删除后资源管理器会重建缩略图，建议清理后重启资源管理器".to_string(),
                });
            }
        }
    }

    // Windows.old：仅检测提示，不提供 Mona 内删除（系统存储感知处理更安全）
    let windows_old = PathBuf::from("C:\\Windows.old");
    if windows_old.exists() {
        let (size, _) = dir_size(&windows_old);
        if size >= 1_073_741_824 {
            items.push(CleanupItem {
                id: "windows_old".to_string(),
                name: "Windows.old（旧系统文件）".to_string(),
                size_gb: size as f64 / 1_073_741_824.0,
                path: windows_old.to_string_lossy().to_string(),
                cleanable: false,
                recommended: false,
                reason: "建议通过系统「存储感知」清理：设置 → 系统 → 存储 → 临时文件".to_string(),
            });
        }
    }
    items
}

/// 规范化扫描盘符：接受 "D" / "D:" / "D:\\" / "d:/" 等写法，统一为 "D:" 形式。
/// None 时回退系统盘（SystemDrive 环境变量，通常为 "C:"）。
fn normalize_scan_drive(drive: Option<String>) -> Result<String, String> {
    let raw = match drive {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string()),
    };
    let letter = raw.chars().next().unwrap_or('C').to_ascii_uppercase();
    if !letter.is_ascii_uppercase() {
        return Err(format!("无效盘符：{raw}"));
    }
    Ok(format!("{letter}:"))
}

fn scan_storage_inner(app: AppHandle, cancel: Arc<AtomicBool>, drive: Option<String>) -> Result<StorageScanResult, String> {
    let start = Instant::now();
    let scanned_drive = normalize_scan_drive(drive)?;
    let is_system_drive = scanned_drive == "C:";

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
                is_removable: d.is_removable(),
            }
        })
        .collect();

    let drive_root = PathBuf::from(format!("{scanned_drive}\\"));
    if !drive_root.exists() {
        return Err(format!("磁盘 {scanned_drive} 不存在或不可访问"));
    }

    // 扫描目标目录：系统盘为根下的关键目录；其他盘扫根目录全部顶层子目录
    // （跳过回收站/卷信息等系统保留目录，避免无权限目录产出 0 字节块）
    let scan_targets: Vec<PathBuf> = if is_system_drive {
        let mut targets = Vec::new();
        for name in ["Windows", "Users", "Program Files", "Program Files (x86)", "ProgramData"] {
            let p = drive_root.join(name);
            if p.exists() {
                targets.push(p);
            }
        }
        targets
    } else {
        let reserved = ["$RECYCLE.BIN", "System Volume Information"];
        fs::read_dir(&drive_root)
            .map_err(|e| format!("读取 {scanned_drive} 根目录失败: {e}"))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| !reserved.iter().any(|r| name.eq_ignore_ascii_case(r)))
                    .unwrap_or(false)
            })
            .collect()
    };

    // 每次扫描开始前复位取消令牌
    cancel.store(false, Ordering::Relaxed);

    let emitter = ScanProgressEmitter::new({
        let app = app.clone();
        move |path, dirs| {
            let _ = app.emit(
                "storage-scan-progress",
                ScanProgress {
                    current_path: path.to_string_lossy().to_string(),
                    scanned_dirs: dirs,
                    elapsed_secs: start.elapsed().as_secs_f64(),
                },
            );
        }
    });

    let mut directories = Vec::new();
    let mut total_scanned = 0u64;
    let mut total_files = 0u64;
    let mut type_bytes: HashMap<&'static str, u64> = HashMap::new();
    let mut top_files: Vec<TopFileInfo> = Vec::new();
    let mut extension_stats: HashMap<String, (u64, u64)> = HashMap::new();

    // 并行扫描顶层目录（目录间无共享状态，各自收集后合并）
    let results: Vec<_> = std::thread::scope(|s| {
        scan_targets
            .iter()
            .map(|target| {
                let cancel = &cancel;
                let emitter = &emitter;
                s.spawn(move || {
                    let mut local_dirs = 0u64;
                    let mut local_types = HashMap::new();
                    let mut local_top = Vec::new();
                    let mut local_ext = HashMap::new();
                    let node = scan_directory_tree(
                        target,
                        0,
                        cancel,
                        emitter,
                        &mut local_dirs,
                        &mut local_types,
                        &mut local_top,
                        &mut local_ext,
                    );
                    (node, local_dirs, local_types, local_top, local_ext)
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().expect("扫描线程 panic"))
            .collect()
    });

    for (node, _local_dirs, local_types, local_top, local_ext) in results {
        total_scanned += node.size_bytes;
        total_files += node.file_count;
        for (k, v) in local_types {
            *type_bytes.entry(k).or_default() += v;
        }
        top_files.extend(local_top);
        for (k, v) in local_ext {
            let entry = extension_stats.entry(k).or_insert((0, 0));
            entry.0 += v.0;
            entry.1 += v.1;
        }
        directories.push(node);
    }
    let dir_count = emitter.total_dirs();

    // 按大小降序
    directories.sort_by(|a, b| b.size_gb.partial_cmp(&a.size_gb).unwrap_or(std::cmp::Ordering::Equal));

    // 清理项与热点路径均为系统盘口径，非系统盘扫描跳过
    let cleanup_items = if is_system_drive {
        let _ = app.emit(
            "storage-scan-progress",
            ScanProgress {
                current_path: "正在扫描清理项...".to_string(),
                scanned_dirs: dir_count,
                elapsed_secs: start.elapsed().as_secs_f64(),
            },
        );
        scan_cleanup_items()
    } else {
        Vec::new()
    };
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
    let cancelled = cancel.load(Ordering::Relaxed);
    let scan_summary = ScanSummary {
        total_files,
        total_dirs: dir_count,
        scan_duration_secs: start.elapsed().as_secs_f64(),
        scanned_disk: scanned_drive.clone(),
        cancelled,
    };
    let hotspots = if is_system_drive {
        extract_hotspots(&directories)
    } else {
        Vec::new()
    };

    Ok(StorageScanResult {
        disks,
        directories,
        cleanup_items,
        file_types,
        total_scanned_gb: total_scanned as f64 / 1_073_741_824.0,
        top_files,
        scan_summary: Some(scan_summary),
        extension_buckets,
        hotspots,
    })
}

#[tauri::command]
pub async fn scan_storage(
    app: AppHandle,
    state: State<'_, SystemState>,
    drive: Option<String>,
) -> Result<StorageScanResult, String> {
    let cancel = state
        .0
        .lock()
        .map_err(|e| format!("State lock: {}", e))?
        .scan_cancel
        .clone();
    tokio::task::spawn_blocking(move || scan_storage_inner(app, cancel, drive))
        .await
        .map_err(|error| format!("存储扫描任务失败: {error}"))?
}

#[tauri::command]
pub fn cancel_storage_scan(state: State<'_, SystemState>) -> Result<(), String> {
    let inner = state.0.lock().map_err(|e| format!("State lock: {}", e))?;
    inner.scan_cancel.store(true, Ordering::Relaxed);
    Ok(())
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
            .args(["/select,", &path])
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
        "dxshader" => std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|root| root.join("D3DSCache")),
        "thumbcache" => thumbcache_dir(),
        // trash 走 PowerShell，windows_old 仅提示不清理，不走目录删除路径
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

    // Windows 更新缓存：先停 wuauserv 释放文件占用，清理后恢复服务（无管理员权限时放弃该项）
    let update_service_stopped = if id == "updates" {
        match stop_windows_update_service() {
            Ok(()) => true,
            Err(error) => return Err(format!("无法停止 Windows Update 服务（需管理员权限）：{error}")),
        }
    } else {
        false
    };

    // 缩略图缓存只删除 thumbcache_*.db，其余文件不属于清理范围
    let before = if id == "thumbcache" { thumbcache_bytes(&path) } else { dir_size(&path).0 };
    let entries = fs::read_dir(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if id == "thumbcache" {
            let is_target = entry_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(is_thumbcache_file)
                .unwrap_or(false);
            if !is_target {
                continue;
            }
        }
        let result = if file_type.is_symlink() {
            continue;
        } else if file_type.is_dir() {
            if id == "thumbcache" {
                continue;
            }
            fs::remove_dir_all(&entry_path)
        } else {
            fs::remove_file(&entry_path)
        };
        if let Err(error) = result {
            log::warn!("storage cleanup skipped {}: {error}", entry_path.display());
        }
    }
    let after = if id == "thumbcache" { thumbcache_bytes(&path) } else { dir_size(&path).0 };

    if update_service_stopped {
        start_windows_update_service();
    }

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

// ===== 大文件移至回收站（存储价值闭环 P0） =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTrashItem {
    pub path: String,
    pub size_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTrashFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTrashResult {
    pub trashed: Vec<StorageTrashItem>,
    pub failures: Vec<StorageTrashFailure>,
    pub freed_gb: f64,
}

/// 大文件删除的系统关键目录前缀（路径小写、统一 \ 分隔后比较）
const TRASH_BLOCKED_PREFIXES: [&str; 3] = [
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
];

/// 校验待回收路径并返回文件大小（纯校验不删除，便于单测）
fn trash_path_check(path: &Path) -> Result<u64, String> {
    let normalized = path.to_string_lossy().replace('/', "\\").to_lowercase();
    if TRASH_BLOCKED_PREFIXES
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
    {
        return Err("系统关键目录下的文件不允许由 Mona 移除".to_string());
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("文件不存在或不可访问: {e}"))?;
    if metadata.file_type().is_symlink() {
        return Err("符号链接不允许移除".to_string());
    }
    if !metadata.is_file() {
        return Err("仅支持移除文件，目录请在资源管理器中处理".to_string());
    }
    Ok(metadata.len())
}

#[tauri::command]
pub async fn system_trash_storage_files(
    state: State<'_, SystemState>,
    paths: Vec<String>,
) -> Result<StorageTrashResult, String> {
    if paths.is_empty() {
        return Err("没有需要移除的文件".to_string());
    }
    if paths.len() > 20 {
        return Err("单次最多移除 20 个文件".to_string());
    }

    let (trashed, failures, freed_bytes) = tokio::task::spawn_blocking(move || {
        let mut trashed: Vec<StorageTrashItem> = Vec::new();
        let mut failures: Vec<StorageTrashFailure> = Vec::new();
        let mut freed_bytes = 0u64;
        for raw in paths {
            let path = PathBuf::from(&raw);
            match trash_path_check(&path) {
                Ok(size) => match trash::delete(&path) {
                    Ok(()) => {
                        freed_bytes += size;
                        trashed.push(StorageTrashItem {
                            path: raw,
                            size_gb: size as f64 / 1_073_741_824.0,
                        });
                    }
                    Err(e) => failures.push(StorageTrashFailure {
                        path: raw,
                        error: e.to_string(),
                    }),
                },
                Err(error) => failures.push(StorageTrashFailure { path: raw, error }),
            }
        }
        (trashed, failures, freed_bytes)
    })
    .await
    .map_err(|error| format!("回收站任务失败: {error}"))?;

    // 写维护历史（category 固定为「清理」，巡检卡 maintained 回流自动生效）
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
        } else if trashed.is_empty() {
            "失败"
        } else {
            "部分成功"
        };
        let title = if trashed.is_empty() {
            "大文件移至回收站".to_string()
        } else {
            format!("将 {} 个大文件移至回收站", trashed.len())
        };
        let detail = if failures.is_empty() {
            "已移至系统回收站，可从回收站恢复".to_string()
        } else {
            failures
                .iter()
                .map(|f| format!("{}: {}", f.path, f.error))
                .collect::<Vec<_>>()
                .join("；")
        };
        let _ = inner.db.execute(
            "INSERT INTO cleanup_operations (ts, title, status, bytes_changed, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![now_ts(), title, status, freed_bytes as i64, detail],
        );
    }

    Ok(StorageTrashResult {
        trashed,
        failures,
        freed_gb: freed_bytes as f64 / 1_073_741_824.0,
    })
}
