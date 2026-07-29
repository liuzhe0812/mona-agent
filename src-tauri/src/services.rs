use std::io::Write;
use std::sync::Mutex;

use crate::python;
use crate::settings::{self, AppSettings};

pub struct ServicesProcess {
    child: Option<std::process::Child>,
    port: u16,
    /// true 表示复用一个已在外部运行的 services（本进程未 spawn 它）。
    /// 此时 `child` 为 None，stop 时通过 POST /shutdown 关闭。
    external: bool,
}

pub struct ServicesManager {
    process: Mutex<Option<ServicesProcess>>,
}

impl ServicesManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
        }
    }

    pub fn start(&self, settings: &AppSettings, app_handle: &tauri::AppHandle) -> Result<u16, String> {
        let mut guard = self.process.lock().map_err(|e| format!("Lock error: {}", e))?;

        if let Some(ref mut proc) = *guard {
            // 已有自己 spawn 的子进程且活着：直接复用。
            if !proc.external {
                if let Some(ref mut child) = proc.child {
                    if let Ok(status) = child.try_wait() {
                        if status.is_none() {
                            return Ok(proc.port);
                        }
                    }
                }
            } else if proc_is_alive(proc) {
                // 复用中的外部 services 仍健康：继续复用。
                return Ok(proc.port);
            }
        }

        // 探测目标端口：可用则启动新进程；被一个健康 services 占用则复用。
        let (port, external) = probe_services_port(settings.services_port)?;

        if external {
            log::info!(
                "Reusing existing services on port {} (started by another process)",
                port
            );
            *guard = Some(ServicesProcess {
                child: None,
                port,
                external: true,
            });
            return Ok(port);
        }

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
            cmd.args(["-m", "mona", "services", "--port", &port.to_string()]);

            if let Some(ref config_path) = settings.config_path {
                cmd.args(["--config", config_path]);
            }

            cmd.env("PYTHONUNBUFFERED", "1");
            cmd.env("PYTHONUTF8", "1");

            // 同 gateway：把 Rust 侧 app_data_dir 传给 Python，用于定位 email.sqlite3 等
            cmd.env("MONA_APP_DATA_DIR", settings::app_data_dir());

            // Set PYTHONPATH if source tree exists.
            // Dev exe lives at <repo>/src-tauri/target/debug/mona.exe, so we
            // walk up from exe_dir until we find a sibling `mona/` package dir.
            if let Ok(exe_path) = std::env::current_exe() {
                let mut cursor = exe_path.parent().map(|p| p.to_path_buf());
                while let Some(dir) = cursor {
                    let mona_pkg_dir = dir.join("mona");
                    if mona_pkg_dir.is_dir() && mona_pkg_dir.join("api").join("server.py").exists() {
                        let sep = if cfg!(windows) { ";" } else { ":" };
                        let existing = std::env::var("PYTHONPATH").unwrap_or_default();
                        let new_path = if existing.is_empty() {
                            dir.display().to_string()
                        } else {
                            format!("{}{}{}", dir.display(), sep, existing)
                        };
                        cmd.env("PYTHONPATH", &new_path);
                        log::debug!("Dev mode: PYTHONPATH set to {:?}", dir);
                        break;
                    }
                    cursor = dir.parent().map(|p| p.to_path_buf());
                }
            }
        } else {
            // Release mode: packaged exe only (same binary as gateway, `services` subcommand)
            let exe_path = python::deploy_gateway(app_handle)?;
            log::debug!("Using packaged services exe: {:?}", exe_path);
            if !exe_path.exists() {
                return Err(format!("Services executable not found at {:?}", exe_path));
            }
            cmd = std::process::Command::new(&exe_path);
            cmd.args(["services", "--port", &port.to_string()]);

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

            // 同 dev 模式：把 Rust 侧 app_data_dir 传给 Python
            cmd.env("MONA_APP_DATA_DIR", settings::app_data_dir());
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        if let Some(log_file) = open_services_log(port) {
            match log_file.try_clone() {
                Ok(stderr_file) => {
                    cmd.stdout(std::process::Stdio::from(log_file));
                    cmd.stderr(std::process::Stdio::from(stderr_file));
                }
                Err(e) => {
                    log::warn!("Failed to clone services log file: {}", e);
                    cmd.stdout(std::process::Stdio::from(log_file));
                }
            }
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("Failed to start services: {}", e))?;

        log::info!("Services started on port {} (PID: {:?})", port, child.id());

        *guard = Some(ServicesProcess {
            child: Some(child),
            port,
            external: false,
        });

        Ok(port)
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|e| format!("Lock error: {}", e))?;

        if let Some(ref mut proc) = *guard {
            if proc.external {
                // 复用的外部 services：通过 HTTP /shutdown 优雅关闭。
                http_post_shutdown(proc.port);
            } else if let Some(ref mut child) = proc.child {
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
        log::info!("Services stopped");
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        let guard = self.process.lock();
        match guard {
            Ok(mut g) => {
                if let Some(ref mut proc) = *g {
                    if proc.external {
                        // 外部 services 不归本进程管，复用已有健康检查判断
                        return proc_is_alive(proc);
                    }
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
        // 外部 services 的进程生命周期不归本进程管，无法探测其退出状态。
        if proc.external {
            return None;
        }
        let child = proc.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                let log_tail = read_log_tail(20);
                let mut msg = format!(
                    "Services process exited before becoming ready ({status}). See log: {}",
                    services_log_path().display()
                );
                if !log_tail.is_empty() {
                    msg.push_str(&format!("\n\nRecent log:\n{}", log_tail));
                }
                Some(msg)
            }
            Ok(None) => None,
            Err(e) => Some(format!(
                "Failed to inspect services process: {e}. See log: {}",
                services_log_path().display()
            )),
        }
    }

}

pub(crate) fn services_log_path() -> std::path::PathBuf {
    settings::app_data_dir().join("logs").join("services.log")
}

fn open_services_log(port: u16) -> Option<std::fs::File> {
    const MAX_SERVICES_LOG_BYTES: u64 = 5 * 1024 * 1024;

    let path = services_log_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("Failed to create services log dir {:?}: {}", parent, e);
            return None;
        }
    }

    if std::fs::metadata(&path)
        .map(|meta| meta.len() > MAX_SERVICES_LOG_BYTES)
        .unwrap_or(false)
    {
        let old_path = path.with_extension("log.old");
        let _ = std::fs::remove_file(&old_path);
        if let Err(e) = std::fs::rename(&path, &old_path) {
            log::warn!("Failed to rotate services log {:?}: {}", path, e);
        }
    }

    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) => {
            log::warn!("Failed to open services log {:?}: {}", path, e);
            return None;
        }
    };

    let _ = writeln!(
        file,
        "\n=== services start {:?} port {} ===",
        std::time::SystemTime::now(),
        port
    );
    Some(file)
}

/// 探测目标端口，返回 (port, external)。
///
/// - 端口可绑定：`(port, false)`，调用方需 spawn 新 services。
/// - 端口被占但跑着一个健康 services（GET /health 返回 200）：`(port, true)`，调用方复用。
/// - 端口被占且不是 services：报错。
fn probe_services_port(start_port: u16) -> Result<(u16, bool), String> {
    if is_port_available(start_port) {
        return Ok((start_port, false));
    }
    // 端口被占：判断占用者是不是一个可用的 Mona services。
    if http_health_ok(start_port) {
        return Ok((start_port, true));
    }
    Err(format!(
        "Services port {} is already in use by a non-services process. \
         Free the port or change the services port in settings.",
        start_port
    ))
}

fn is_port_available(port: u16) -> bool {
    use std::net::TcpListener;
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// 同步 GET /health，判断端口上是否跑着 Mona services。
fn http_health_ok(port: u16) -> bool {
    http_request(port, "GET", "/health").map_or(false, |body| {
        // 响应体应包含 {"status":"ok"}；只做宽松包含判断以兼容空白差异。
        body.contains("\"ok\"") || body.contains("ok")
    })
}

/// 同步 POST /shutdown，通知外部 services 优雅退出。
fn http_post_shutdown(port: u16) {
    let _ = http_request(port, "POST", "/shutdown");
}

/// 用 std::net 同步发一个无 body 的 HTTP 请求，返回响应体字符串（失败返回 None）。
/// 仅用于 127.0.0.1 本地探测，不处理代理/重定向/HTTPS。
fn http_request(port: u16, method: &str, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = format!("127.0.0.1:{}", port);
    let Ok(socket_addr) = addr.parse() else {
        return None;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(1)) else {
        return None;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let request = format!(
        "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        method, path, port
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }
    let mut buf = Vec::with_capacity(512);
    if stream.read_to_end(&mut buf).is_err() {
        // 即使读不全，只要写出了请求也算成功（shutdown 场景不关心响应）。
        if method == "POST" {
            return Some(String::new());
        }
        return None;
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// 判断当前复用中的外部 services 是否仍健康。
fn proc_is_alive(proc: &ServicesProcess) -> bool {
    if !proc.external {
        return false;
    }
    http_health_ok(proc.port)
}

/// Strip environment variables that can interfere with the packaged services.
/// Conda/Anaconda/user site-packages may inject conflicting packages
/// (e.g. a different pydantic version) that crash the services at import time.
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

/// Read the last N lines of the services log file for error diagnostics.
pub(crate) fn read_log_tail(max_lines: usize) -> String {
    let path = services_log_path();
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

pub async fn wait_for_services<F>(
    port: u16,
    timeout_secs: u64,
    mut services_exit_message: F,
) -> Result<(), String>
where
    F: FnMut() -> Option<String>,
{
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| format!("Failed to create services health client: {}", e))?;
    let url = format!("http://127.0.0.1:{}/health", port);
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_secs);

    loop {
        if let Some(message) = services_exit_message() {
            return Err(message);
        }

        if start.elapsed() > timeout {
            let log_tail = read_log_tail(20);
            let mut msg = format!(
                "Services did not start within {}s on port {}. See log: {}",
                timeout_secs,
                port,
                services_log_path().display()
            );
            if !log_tail.is_empty() {
                msg.push_str(&format!("\n\nRecent log:\n{}", log_tail));
            }
            return Err(msg);
        }

        match client.get(&url).timeout(std::time::Duration::from_secs(2)).send().await {
            Ok(resp) if resp.status().is_success() => {
                log::info!("Services is ready on port {}", port);
                return Ok(());
            }
            _ => {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        }
    }
}
