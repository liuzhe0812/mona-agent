use std::io::Write;
use std::sync::Mutex;

use crate::python;
use crate::settings::{self, AppSettings};

pub struct GatewayProcess {
    child: Option<std::process::Child>,
    port: u16,
}

pub struct GatewayManager {
    process: Mutex<Option<GatewayProcess>>,
}

impl GatewayManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
        }
    }

    pub fn start(&self, settings: &AppSettings, app_handle: &tauri::AppHandle) -> Result<u16, String> {
        let mut guard = self.process.lock().map_err(|e| format!("Lock error: {}", e))?;

        if let Some(ref mut proc) = *guard {
            if let Some(ref mut child) = proc.child {
                if let Ok(status) = child.try_wait() {
                    if status.is_none() {
                        return Ok(proc.port);
                    }
                }
            }
        }

        let port = find_available_port(settings.gateway_port)?;

        let mut cmd;

        if cfg!(debug_assertions) {
            // Dev mode: system Python only
            let sys_python = python::find_system_python()
                .ok_or_else(|| "System Python not found. Install Python for dev mode.".to_string())?;
            log::info!("Dev mode: using system Python: {:?}", sys_python);
            if !sys_python.exists() {
                return Err(format!("System Python not found at {:?}", sys_python));
            }
            cmd = std::process::Command::new(&sys_python);
            cmd.args(["-m", "mona", "gateway", "--port", &port.to_string()]);

            if let Some(ref config_path) = settings.config_path {
                cmd.args(["--config", config_path]);
            }

            cmd.env("PYTHONUNBUFFERED", "1");
            cmd.env("PYTHONUTF8", "1");

            // Set PYTHONPATH if source tree exists
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    let project_root = exe_dir.parent().unwrap_or(exe_dir);
                    let mona_pkg_dir = project_root.join("mona");
                    if mona_pkg_dir.is_dir() {
                        let sep = if cfg!(windows) { ";" } else { ":" };
                        let existing = std::env::var("PYTHONPATH").unwrap_or_default();
                        let new_path = if existing.is_empty() {
                            project_root.display().to_string()
                        } else {
                            format!("{}{}{}", project_root.display(), sep, existing)
                        };
                        cmd.env("PYTHONPATH", &new_path);
                        log::info!("Dev mode: PYTHONPATH set to {:?}", project_root);
                    }
                }
            }
        } else {
            // Release mode: packaged gateway exe only
            let exe_path = python::deploy_gateway(app_handle)?;
            log::info!("Using packaged gateway: {:?}", exe_path);
            if !exe_path.exists() {
                return Err(format!("Gateway executable not found at {:?}", exe_path));
            }
            cmd = std::process::Command::new(&exe_path);
            cmd.args(["gateway", "--port", &port.to_string()]);

            if let Some(ref config_path) = settings.config_path {
                cmd.args(["--config", config_path]);
            }

            // Environment isolation for release mode: strip harmful Python env vars
            // that may leak from Conda/Anaconda/user site-packages and cause import conflicts.
            strip_harmful_python_env(&mut cmd);
            cmd.env("PYTHONUNBUFFERED", "1");
            cmd.env("PYTHONUTF8", "1");
            cmd.env("PYTHONIOENCODING", "utf-8");
            cmd.env("PYTHONNOUSERSITE", "1");
            cmd.env("NO_COLOR", "1");
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        if let Some(log_file) = open_gateway_log(port) {
            match log_file.try_clone() {
                Ok(stderr_file) => {
                    cmd.stdout(std::process::Stdio::from(log_file));
                    cmd.stderr(std::process::Stdio::from(stderr_file));
                }
                Err(e) => {
                    log::warn!("Failed to clone gateway log file: {}", e);
                    cmd.stdout(std::process::Stdio::from(log_file));
                }
            }
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start gateway: {}", e))?;

        log::info!("Gateway started on port {} (PID: {:?})", port, child.id());

        *guard = Some(GatewayProcess {
            child: Some(child),
            port,
        });

        Ok(port)
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|e| format!("Lock error: {}", e))?;

        if let Some(ref mut proc) = *guard {
            if let Some(ref mut child) = proc.child {
                #[cfg(windows)]
                {
                    let pid = child.id();
                    let mut kill_cmd = std::process::Command::new("taskkill");
                    kill_cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
                    use std::os::windows::process::CommandExt;
                    kill_cmd.creation_flags(0x08000000);
                    let _ = kill_cmd.status();
                }
                #[cfg(not(windows))]
                {
                    let pid = child.id();
                    unsafe {
                        libc::kill(pid as i32, libc::SIGTERM);
                    }
                }
                let _ = child.wait();
            }
        }

        *guard = None;
        log::info!("Gateway stopped");
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        let guard = self.process.lock();
        match guard {
            Ok(mut g) => {
                if let Some(ref mut proc) = *g {
                    if let Some(ref mut child) = proc.child {
                        match child.try_wait() {
                            Ok(None) => return true,
                            _ => return false,
                        }
                    }
                }
                false
            }
            Err(_) => false,
        }
    }

    pub fn exit_message(&self) -> Option<String> {
        let mut guard = self.process.lock().ok()?;
        let proc = guard.as_mut()?;
        let child = proc.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                let log_tail = read_log_tail(20);
                let mut msg = format!(
                    "Gateway process exited before becoming ready ({status}). See log: {}",
                    gateway_log_path().display()
                );
                if !log_tail.is_empty() {
                    msg.push_str(&format!("\n\nRecent log:\n{}", log_tail));
                }
                Some(msg)
            }
            Ok(None) => None,
            Err(e) => Some(format!(
                "Failed to inspect gateway process: {e}. See log: {}",
                gateway_log_path().display()
            )),
        }
    }

    #[allow(dead_code)]
    pub fn port(&self) -> Option<u16> {
        let guard = self.process.lock().ok()?;
        guard.as_ref().map(|p| p.port)
    }
}

fn gateway_log_path() -> std::path::PathBuf {
    settings::app_data_dir().join("logs").join("gateway.log")
}

fn open_gateway_log(port: u16) -> Option<std::fs::File> {
    const MAX_GATEWAY_LOG_BYTES: u64 = 5 * 1024 * 1024;

    let path = gateway_log_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("Failed to create gateway log dir {:?}: {}", parent, e);
            return None;
        }
    }

    if std::fs::metadata(&path)
        .map(|meta| meta.len() > MAX_GATEWAY_LOG_BYTES)
        .unwrap_or(false)
    {
        let old_path = path.with_extension("log.old");
        let _ = std::fs::remove_file(&old_path);
        if let Err(e) = std::fs::rename(&path, &old_path) {
            log::warn!("Failed to rotate gateway log {:?}: {}", path, e);
        }
    }

    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) => {
            log::warn!("Failed to open gateway log {:?}: {}", path, e);
            return None;
        }
    };

    let _ = writeln!(
        file,
        "\n=== gateway start {:?} port {} ===",
        std::time::SystemTime::now(),
        port
    );
    Some(file)
}

fn find_available_port(start_port: u16) -> Result<u16, String> {
    for port in start_port..=(start_port + 5) {
        if is_port_available(port) {
            return Ok(port);
        }
        log::info!("Port {} is in use, trying next", port);
    }

    // All ports in range are occupied — wait briefly for the start port to free up
    log::info!(
        "All ports {}-{} in use, waiting up to 10s for port {} to become available",
        start_port,
        start_port + 5,
        start_port
    );
    let wait_start = std::time::Instant::now();
    let wait_deadline = std::time::Duration::from_secs(10);
    loop {
        if is_port_available(start_port) {
            log::info!("Port {} became available after waiting", start_port);
            return Ok(start_port);
        }
        if wait_start.elapsed() > wait_deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    Err(format!(
        "No available port in range {}-{}. Another program may be using these ports.",
        start_port,
        start_port + 5
    ))
}

fn is_port_available(port: u16) -> bool {
    use std::net::TcpListener;
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Strip environment variables that can interfere with the packaged gateway.
/// Conda/Anaconda/user site-packages may inject conflicting packages
/// (e.g. a different pydantic version) that crash the gateway at import time.
fn strip_harmful_python_env(cmd: &mut std::process::Command) {
    for var in [
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "VIRTUAL_ENV",
        "CONDA_PREFIX",
        "CONDA_DEFAULT_ENV",
        "CONDA_SHLVL",
        "CONDA_PYTHON_EXE",
        "CONDA_PROMPT_MODIFIER",
        "PIP_TARGET",
        "PIP_PREFIX",
        "PIP_USER",
        "PIP_REQUIRE_VIRTUALENV",
    ] {
        cmd.env_remove(var);
    }
}

/// Read the last N lines of the gateway log file for error diagnostics.
fn read_log_tail(max_lines: usize) -> String {
    let path = gateway_log_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let lines: Vec<&str> = content.lines().rev().take(max_lines).collect();
    let mut result = lines.into_iter().rev().collect::<Vec<&str>>().join("\n");
    // Truncate to avoid excessively long error messages
    const MAX_TAIL_BYTES: usize = 4096;
    if result.len() > MAX_TAIL_BYTES {
        result = result[result.len() - MAX_TAIL_BYTES..].to_string();
    }
    result
}

pub async fn wait_for_gateway<F>(
    port: u16,
    timeout_secs: u64,
    mut gateway_exit_message: F,
) -> Result<(), String>
where
    F: FnMut() -> Option<String>,
{
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| format!("Failed to create gateway health client: {}", e))?;
    let url = format!("http://127.0.0.1:{}/health", port);
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_secs);

    loop {
        if let Some(message) = gateway_exit_message() {
            return Err(message);
        }

        if start.elapsed() > timeout {
            let log_tail = read_log_tail(20);
            let mut msg = format!(
                "Gateway did not start within {}s on port {}. See log: {}",
                timeout_secs,
                port,
                gateway_log_path().display()
            );
            if !log_tail.is_empty() {
                msg.push_str(&format!("\n\nRecent log:\n{}", log_tail));
            }
            return Err(msg);
        }

        match client.get(&url).timeout(std::time::Duration::from_secs(2)).send().await {
            Ok(resp) if resp.status().is_success() => {
                log::info!("Gateway is ready on port {}", port);
                return Ok(());
            }
            _ => {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    }
}
