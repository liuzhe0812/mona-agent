use std::io::Write;
use std::sync::Mutex;

use crate::python;
use crate::settings::{self, AppSettings};

pub struct GatewayProcess {
    child: Option<std::process::Child>,
    port: u16,
    ws_port: u16,
    /// true 表示复用一个已在外部运行的 gateway（本进程未 spawn 它）。
    /// 此时 `child` 为 None，stop 时通过 POST /shutdown 关闭。
    external: bool,
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

    pub fn start(
        &self,
        settings: &AppSettings,
        app_handle: Option<&tauri::AppHandle>,
    ) -> Result<u16, String> {
        let mut guard = self.process.lock().map_err(|e| format!("Lock error: {}", e))?;
        let ws_port = settings::read_mona_ws_port();

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
                // 复用中的外部 gateway 仍健康：继续复用。
                return Ok(proc.port);
            }
        }

        let (port, external) = if cfg!(debug_assertions) {
            // A normal dev start owns a fresh source runtime. Avoid the costly
            // image-wide taskkill unless one of its ports is actually occupied,
            // and never reuse an external process whose code may be stale.
            if !is_port_available(settings.gateway_port) || !is_port_available(ws_port) {
                #[cfg(windows)]
                python::kill_stale_gateway_processes();
                for _ in 0..20 {
                    if is_port_available(settings.gateway_port) && is_port_available(ws_port) {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
            if !is_port_available(settings.gateway_port) || !is_port_available(ws_port) {
                return Err(format!(
                    "Dev Gateway 端口 {} / {} 已被占用。请关闭残留的 Mona 运行时后重试。",
                    settings.gateway_port, ws_port
                ));
            }
            (settings.gateway_port, false)
        } else {
            // Release builds may reuse an already-running compatible runtime.
            probe_gateway_port(settings.gateway_port, ws_port)?
        };

        if external {
            log::info!(
                "Reusing existing gateway on port {} (started by another process)",
                port
            );
            *guard = Some(GatewayProcess {
                child: None,
                port,
                ws_port,
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
            cmd.args(["-m", "mona", "gateway", "--port", &port.to_string()]);

            if let Some(ref config_path) = settings.config_path {
                cmd.args(["--config", config_path]);
            }

            cmd.env("PYTHONUNBUFFERED", "1");
            cmd.env("PYTHONUTF8", "1");

            // 把 Rust 侧 app_data_dir 传给 Python，用于定位 email.sqlite3 等
            // Rust 写在 app_data_dir()、Python 默认在 ~/.mona 找，路径不一致会导致
            // email_intel.db 抛 "邮件数据库不存在"。
            cmd.env("MONA_APP_DATA_DIR", settings::app_data_dir());
            cmd.env("MONA_ENABLE_WESTOCK", "1");

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
            // Release mode: packaged gateway exe only
            let app_handle = app_handle
                .ok_or_else(|| "Release Gateway startup requires an app handle".to_string())?;
            let exe_path = python::deploy_gateway(app_handle)?;
            log::debug!("Using packaged gateway: {:?}", exe_path);
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

            // 同 dev 模式：把 Rust 侧 app_data_dir 传给 Python
            cmd.env("MONA_APP_DATA_DIR", settings::app_data_dir());
            cmd.env("MONA_ENABLE_WESTOCK", "1");
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
            ws_port,
            external: false,
        });

        Ok(port)
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|e| format!("Lock error: {}", e))?;

        if let Some(ref mut proc) = *guard {
            if proc.external {
                // 复用的外部 gateway：通过 HTTP /shutdown 优雅关闭，
                // 让其主循环走 finally 清理（flush session、关 MCP 等）。
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
        log::info!("Gateway stopped");
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        let guard = self.process.lock();
        match guard {
            Ok(mut g) => {
                if let Some(ref mut proc) = *g {
                    if proc.external {
                        // 外部 gateway 不归本进程管，乐观认为仍在运行；
                        // 启动时 wait_for_gateway 已经验证过一次健康状态。
                        return true;
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
        // 外部 gateway 的进程生命周期不归本进程管，无法探测其退出状态。
        if proc.external {
            return None;
        }
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

}

pub(crate) fn gateway_log_path() -> std::path::PathBuf {
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

/// 探测目标端口，返回 (port, external)。
///
/// - 端口可绑定：`(port, false)`，调用方需 spawn 新 gateway。
/// - 端口被兼容的 Gateway HTTP 与 WebUI 会话服务共同占用：复用。
/// - 端口被占且不是 gateway：报错。
fn probe_gateway_port(start_port: u16, ws_port: u16) -> Result<(u16, bool), String> {
    if is_port_available(start_port) {
        if is_port_available(ws_port) {
            return Ok((start_port, false));
        }
        return Err(format!(
            "WebUI 会话端口 {} 已被占用。请关闭残留的 Mona 运行时或释放端口后重试。",
            ws_port
        ));
    }
    if http_gateway_compatible(start_port) && http_websocket_compatible(ws_port) {
        return Ok((start_port, true));
    }
    Err(format!(
        "Gateway 端口 {} / {} 被不兼容的进程占用。请关闭残留的 Mona 运行时或释放端口后重试。",
        start_port, ws_port
    ))
}

fn is_port_available(port: u16) -> bool {
    use std::net::TcpListener;
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn http_gateway_compatible(port: u16) -> bool {
    http_request(port, "GET", "/health")
        .map_or(false, |response| health_response_compatible(&response, "mona-gateway", "agent-http-v1"))
}

fn http_websocket_compatible(port: u16) -> bool {
    http_request(port, "GET", "/health")
        .map_or(false, |response| health_response_compatible(&response, "mona-websocket", "sessions-v1"))
}

fn health_response_compatible(response: &str, service: &str, capability: &str) -> bool {
    let status_ok = response
        .lines()
        .next()
        .map_or(false, |line| line.contains(" 200 "));
    if !status_ok {
        return false;
    }
    let body = response.split_once("\r\n\r\n").map_or("", |(_, body)| body);
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    payload.get("status").and_then(|value| value.as_str()) == Some("ok")
        && payload.get("service").and_then(|value| value.as_str()) == Some(service)
        && payload
            .get("capabilities")
            .and_then(|value| value.as_array())
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(capability)))
}

/// 同步 POST /shutdown，通知外部 gateway 优雅退出。
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

/// 判断当前复用中的外部 gateway 是否仍健康。
fn proc_is_alive(proc: &GatewayProcess) -> bool {
    if !proc.external {
        return false;
    }
    http_gateway_compatible(proc.port) && http_websocket_compatible(proc.ws_port)
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
pub(crate) fn read_log_tail(max_lines: usize) -> String {
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

/// Read the gateway log for display in the error UI.
/// Returns the log file path and the last `max_lines` lines (uncapped in size).
#[tauri::command]
pub async fn read_gateway_log(max_lines: Option<usize>) -> Result<serde_json::Value, String> {
    let max_lines = max_lines.unwrap_or(200).max(1);
    let path = gateway_log_path();
    let path_str = path.display().to_string();
    let exists = path.exists();

    let content = if exists {
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read gateway log: {}", e))?
    } else {
        String::new()
    };

    let tail: String = if content.is_empty() {
        String::new()
    } else {
        let lines: Vec<&str> = content.lines().rev().take(max_lines).collect();
        lines.into_iter().rev().collect::<Vec<&str>>().join("\n")
    };

    Ok(serde_json::json!({
        "path": path_str,
        "exists": exists,
        "tail": tail,
    }))
}

pub async fn wait_for_gateway<F>(
    port: u16,
    ws_port: u16,
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
    let gateway_url = format!("http://127.0.0.1:{}/health", port);
    let websocket_url = format!("http://127.0.0.1:{}/health", ws_port);
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_secs);

    loop {
        if let Some(message) = gateway_exit_message() {
            return Err(message);
        }

        if start.elapsed() > timeout {
            let log_tail = read_log_tail(20);
            let mut msg = format!(
                "Gateway did not start within {}s on ports {} / {}. See log: {}",
                timeout_secs,
                port,
                ws_port,
                gateway_log_path().display()
            );
            if !log_tail.is_empty() {
                msg.push_str(&format!("\n\nRecent log:\n{}", log_tail));
            }
            return Err(msg);
        }

        if endpoint_compatible(&client, &gateway_url, "mona-gateway", "agent-http-v1").await
            && endpoint_compatible(&client, &websocket_url, "mona-websocket", "sessions-v1").await
        {
            log::info!("Gateway is ready on ports {} / {}", port, ws_port);
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

async fn endpoint_compatible(
    client: &reqwest::Client,
    url: &str,
    service: &str,
    capability: &str,
) -> bool {
    let Ok(response) = client
        .get(url)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(payload) = response.json::<serde_json::Value>().await else {
        return false;
    };
    payload.get("status").and_then(|value| value.as_str()) == Some("ok")
        && payload.get("service").and_then(|value| value.as_str()) == Some(service)
        && payload
            .get("capabilities")
            .and_then(|value| value.as_array())
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(capability)))
}

#[cfg(test)]
mod readiness_tests {
    use super::health_response_compatible;

    #[test]
    fn gateway_health_requires_identity_and_capability() {
        let response = "HTTP/1.1 200 OK\r\n\r\n{\"status\": \"ok\", \"service\": \"mona-gateway\", \"capabilities\": [\"agent-http-v1\"]}";
        assert!(health_response_compatible(response, "mona-gateway", "agent-http-v1"));
        assert!(!health_response_compatible(
            "HTTP/1.1 200 OK\r\n\r\n{\"status\": \"ok\"}",
            "mona-gateway",
            "agent-http-v1",
        ));
    }

    #[test]
    fn websocket_health_rejects_static_html() {
        let response = "HTTP/1.1 200 OK\r\n\r\n<!doctype html><title>Mona</title>";
        assert!(!health_response_compatible(
            response,
            "mona-websocket",
            "sessions-v1",
        ));
    }
}
