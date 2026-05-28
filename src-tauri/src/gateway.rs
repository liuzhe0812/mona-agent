use std::sync::Mutex;

use crate::python;
use crate::settings::AppSettings;

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

    pub fn start(&self, settings: &AppSettings) -> Result<u16, String> {
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

        let python_exe = if python::is_python_initialized() {
            python::python_executable()
        } else if let Some(sys_python) = python::find_system_python() {
            log::info!("Using system Python: {:?}", sys_python);
            sys_python
        } else {
            python::initialize_python()?;
            python::python_executable()
        };

        let port = find_available_port(settings.gateway_port)?;

        let mut cmd = std::process::Command::new(&python_exe);
        cmd.args(["-m", "mona", "gateway", "--port", &port.to_string()]);

        if let Some(ref config_path) = settings.config_path {
            cmd.args(["--config", config_path]);
        }

        cmd.env("PYTHONUNBUFFERED", "1");

        let project_root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap_or_else(|| {
                std::path::Path::new(".")
            });
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
            log::info!(
                "Dev mode detected: PYTHONPATH set to {:?}",
                project_root
            );
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
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .status();
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

    #[allow(dead_code)]
    pub fn port(&self) -> Option<u16> {
        let guard = self.process.lock().ok()?;
        guard.as_ref().map(|p| p.port)
    }
}

fn find_available_port(start_port: u16) -> Result<u16, String> {
    for port in start_port..=(start_port + 5) {
        if is_port_available(port) {
            return Ok(port);
        }
        log::info!("Port {} is in use, trying next", port);
    }
    Err(format!(
        "No available port in range {}-{}",
        start_port,
        start_port + 5
    ))
}

fn is_port_available(port: u16) -> bool {
    use std::net::TcpListener;
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub async fn wait_for_gateway(port: u16, timeout_secs: u64) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{}/health", port);
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_secs(timeout_secs);

    loop {
        if start.elapsed() > timeout {
            return Err(format!(
                "Gateway did not start within {}s on port {}",
                timeout_secs, port
            ));
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
