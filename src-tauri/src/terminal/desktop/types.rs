use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopSystemInfo {
    pub cpu: DesktopCpuInfo,
    pub memory: DesktopMemoryInfo,
    pub disk: Vec<DesktopDiskInfo>,
    pub disk_io: DesktopDiskIOInfo,
    pub network: Vec<DesktopNetworkInfo>,
    pub processes: DesktopProcessInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopCpuInfo {
    pub brand: String,
    pub speed: f64,
    pub cores: u32,
    pub physical_cores: u32,
    pub load: f64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub load_user: f64,
    pub load_system: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopMemoryInfo {
    pub total: u64,
    pub used: u64,
    pub free: u64,
    pub available: u64,
    pub buffcache: u64,
    pub used_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopDiskInfo {
    pub fs: String,
    #[serde(rename = "type")]
    pub disk_type: String,
    pub size: u64,
    pub used: u64,
    pub available: u64,
    pub mount: String,
    pub use_percent: f64,
    pub r_io_sec: f64,
    pub w_io_sec: f64,
    pub t_io_sec: f64,
    pub busy_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopDiskIOInfo {
    pub r_io: u64,
    pub w_io: u64,
    pub t_io: u64,
    pub r_io_sec: f64,
    pub w_io_sec: f64,
    pub t_io_sec: f64,
    pub busy_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopNetworkInfo {
    pub iface: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_sec: f64,
    pub tx_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopProcessInfo {
    pub all: usize,
    pub running: usize,
    pub list: Vec<DesktopProcess>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopProcess {
    pub pid: u32,
    pub name: String,
    pub state: String,
    pub cpu: f64,
    pub mem: f64,
    pub disk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopFileItem {
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: String,
    pub size: String,
    #[serde(rename = "rawSize")]
    pub raw_size: u64,
    pub modified: String,
    pub path: String,
    pub mode: String,
    pub owner: String,
    #[serde(rename = "isSymlink")]
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopFileListResult {
    pub path: String,
    pub files: Vec<DesktopFileItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopFileContentResult {
    pub content: String,
}
