use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub(crate) struct BackendChild {
    child: Child,
    #[cfg(windows)]
    _job: ProcessJob,
}

impl BackendChild {
    #[cfg(windows)]
    pub(crate) fn kill(&mut self) -> std::io::Result<()> {
        unsafe { windows::Win32::System::JobObjects::TerminateJobObject(self._job.0, 1) }
            .map_err(|error| std::io::Error::other(error.to_string()))
    }
}

impl std::ops::Deref for BackendChild {
    type Target = Child;

    fn deref(&self) -> &Child {
        &self.child
    }
}

impl std::ops::DerefMut for BackendChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

pub(crate) fn spawn(cmd: &mut Command) -> Result<BackendChild, String> {
    #[cfg(windows)]
    let job = ProcessJob::new()?;
    cmd.stdin(Stdio::piped()).env("MONA_DESKTOP_PROCESS", "1");
    let child = cmd.spawn().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let mut child = child;
    #[cfg(windows)]
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(BackendChild {
        child,
        #[cfg(windows)]
        _job: job,
    })
}

#[cfg(windows)]
struct ProcessJob(windows::Win32::Foundation::HANDLE);

// The handle is exclusively owned and never inherited by the child.
#[cfg(windows)]
unsafe impl Send for ProcessJob {}

#[cfg(windows)]
impl ProcessJob {
    fn new() -> Result<Self, String> {
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let job = Self(
            unsafe { CreateJobObjectW(None, None) }
                .map_err(|error| format!("Failed to create backend process job: {error}"))?,
        );
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        }
        .map_err(|error| format!("Failed to supervise backend process job: {error}"))?;
        Ok(job)
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        unsafe { AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle())) }.map_err(
            |error| {
                format!(
                    "Failed to supervise backend process {}: {error}",
                    child.id()
                )
            },
        )
    }
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            if let Err(error) = windows::Win32::Foundation::CloseHandle(self.0) {
                log::error!("Failed to close backend process job: {error}");
            }
        }
    }
}

pub(crate) fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub(crate) fn health_response_identifies(response: &str, service: &str) -> bool {
    health_payload(response).is_some_and(|payload| {
        payload.get("service").and_then(|value| value.as_str()) == Some(service)
    })
}

pub(crate) fn health_response_compatible(response: &str, service: &str, capability: &str) -> bool {
    response
        .lines()
        .next()
        .is_some_and(|line| line.contains(" 200 "))
        && health_payload(response).is_some_and(|payload| {
            payload.get("status").and_then(|value| value.as_str()) == Some("ok")
                && payload.get("service").and_then(|value| value.as_str()) == Some(service)
                && payload
                    .get("capabilities")
                    .and_then(|value| value.as_array())
                    .is_some_and(|values| {
                        values
                            .iter()
                            .any(|value| value.as_str() == Some(capability))
                    })
        })
}

fn health_payload(response: &str) -> Option<serde_json::Value> {
    let (_, body) = response.split_once("\r\n\r\n")?;
    serde_json::from_str(body).ok()
}

/// Reuse only a fully compatible release runtime; replace an identified Mona runtime.
pub(crate) fn prepare_ports(
    ports: &[(u16, &str, &str)],
    allow_reuse: bool,
) -> Result<bool, String> {
    let occupied: Vec<_> = ports
        .iter()
        .filter(|(port, _, _)| !is_port_available(*port))
        .collect();
    if occupied.is_empty() {
        return Ok(false);
    }
    let responses: Vec<_> = occupied
        .iter()
        .map(|(port, _, _)| http_request(*port, "GET", "/health"))
        .collect();
    if allow_reuse
        && occupied.len() == ports.len()
        && occupied
            .iter()
            .zip(&responses)
            .all(|((_, service, capability), response)| {
                response.as_deref().is_some_and(|response| {
                    health_response_compatible(response, service, capability)
                        && health_payload(response).is_some_and(|payload| {
                            payload.get("version").and_then(|value| value.as_str())
                                == Some(env!("CARGO_PKG_VERSION"))
                        })
                })
            })
    {
        return Ok(true);
    }
    let owners = port_processes(ports.iter().map(|(port, _, _)| *port));
    if occupied
        .iter()
        .zip(&responses)
        .any(|((port, service, _), response)| {
            response
                .as_deref()
                .is_some_and(|response| !health_response_identifies(response, service))
                && !verified_owner(&owners, *port)
        })
    {
        log::error!("Backend ports {ports:?} include a non-Mona service");
        return Err("后台服务无法启动，通信地址已被其他程序占用。请关闭占用程序后重试。".into());
    }
    let shutdown_port = occupied
        .iter()
        .zip(&responses)
        .find_map(|((port, service, _), response)| {
            response
                .as_deref()
                .filter(|response| health_response_identifies(response, service))
                .map(|_| *port)
        })
        .or_else(|| {
            occupied
                .iter()
                .find(|(port, _, _)| verified_owner(&owners, *port))
                .map(|(port, _, _)| *port)
        });
    let Some(shutdown_port) = shutdown_port else {
        if ports.iter().all(|(port, _, _)| is_port_available(*port)) {
            return Ok(false);
        }
        log::error!(
            "Backend ports {:?} are occupied by an unidentified process",
            ports.iter().map(|(port, _, _)| port).collect::<Vec<_>>()
        );
        return Err("后台服务无法启动，通信地址已被其他程序占用。请关闭占用程序后重试。".into());
    };
    log::info!("Stopping previous Mona backend on port {shutdown_port} before startup");
    stop(
        shutdown_port,
        &ports.iter().map(|(port, _, _)| *port).collect::<Vec<_>>(),
    )?;
    Ok(false)
}

pub(crate) fn stop(shutdown_port: u16, ports: &[u16]) -> Result<(), String> {
    if ports.iter().all(|port| is_port_available(*port)) {
        return Ok(());
    }
    let owners = port_processes(ports.iter().copied());
    if !verified_owner(&owners, shutdown_port)
        && !http_request(shutdown_port, "GET", "/health").is_some_and(|response| {
            ["mona-gateway", "mona-services", "mona-websocket"]
                .iter()
                .any(|service| health_response_identifies(&response, service))
        })
    {
        log::error!("Refusing to stop unidentified backend on port {shutdown_port}");
        return Err("后台服务的通信地址已被其他程序占用。请关闭占用程序后重试。".into());
    }
    let _ = http_request(shutdown_port, "POST", "/shutdown");
    if wait_for_ports(ports, Duration::from_secs(10)) {
        return Ok(());
    }
    for process in owners
        .processes()
        .values()
        .filter(|process| is_mona_backend(process))
    {
        if ports
            .iter()
            .any(|port| port_owner(*port) == Some(process.pid()))
        {
            log::warn!(
                "Previous Mona backend {} did not shut down; terminating the verified port owner",
                process.pid()
            );
            if let Err(error) = terminate(process) {
                log::error!("Failed to terminate previous Mona backend: {error}");
            }
        }
    }
    if wait_for_ports(ports, Duration::from_secs(2)) {
        return Ok(());
    }
    log::error!("Mona backend did not release ports {ports:?} after shutdown");
    Err("后台服务暂时无法恢复，请稍后重试或查看错误日志。".into())
}

pub(crate) fn terminate(process: &sysinfo::Process) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{CloseHandle, FILETIME};
        use windows::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_TERMINATE,
        };
        let handle = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                process.pid().as_u32(),
            )
        }
        .map_err(|error| format!("Could not open backend {}: {error}", process.pid()))?;
        let result = (|| {
            let (mut created, mut exited, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
                .map_err(|error| {
                format!(
                    "Could not verify backend {} lifetime: {error}",
                    process.pid()
                )
            })?;
            let ticks =
                (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
            let started = ticks / 10_000_000 - 11_644_473_600;
            if started != process.start_time() {
                return Err(format!(
                    "Backend PID {} belongs to a different process lifetime",
                    process.pid()
                ));
            }
            unsafe { TerminateProcess(handle, 1) }
                .map_err(|error| format!("Could not terminate backend {}: {error}", process.pid()))
        })();
        unsafe {
            if let Err(error) = CloseHandle(handle) {
                log::error!(
                    "Failed to close backend {} process handle: {error}",
                    process.pid()
                );
            }
        }
        result
    }
    #[cfg(not(windows))]
    {
        let mut current = sysinfo::System::new();
        current.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[process.pid()]), true);
        if current.process(process.pid()).is_some_and(|current| {
            current.start_time() == process.start_time()
                && current.exe() == process.exe()
                && current.kill()
        }) {
            Ok(())
        } else {
            Err(format!(
                "Could not verify or terminate backend {}",
                process.pid()
            ))
        }
    }
}

fn wait_for_ports(ports: &[u16], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if ports.iter().all(|port| is_port_available(*port)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn port_processes(ports: impl Iterator<Item = u16>) -> sysinfo::System {
    let mut pids: Vec<_> = ports.filter_map(port_owner).collect();
    pids.sort_unstable();
    pids.dedup();
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&pids),
        true,
        sysinfo::ProcessRefreshKind::nothing()
            .with_exe(sysinfo::UpdateKind::Always)
            .with_cmd(sysinfo::UpdateKind::Always),
    );
    system
}

fn verified_owner(system: &sysinfo::System, port: u16) -> bool {
    port_owner(port)
        .and_then(|pid| system.process(pid))
        .is_some_and(is_mona_backend)
}

fn is_mona_backend(process: &sysinfo::Process) -> bool {
    let Some(name) = process
        .exe()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    let is_role = |argument: &std::ffi::OsString| argument == "gateway" || argument == "services";
    if name == "mona-gateway.exe" || name == "mona-gateway" {
        return process.cmd().get(1).is_some_and(is_role);
    }
    name.starts_with("python")
        && process
            .cmd()
            .windows(3)
            .any(|args| args[0] == "-m" && args[1] == "mona" && is_role(&args[2]))
}

#[cfg(windows)]
fn port_owner(port: u16) -> Option<sysinfo::Pid> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    let mut size = 0;
    unsafe {
        GetExtendedTcpTable(None, &mut size, false, 2, TCP_TABLE_OWNER_PID_LISTENER, 0);
    }
    if size < 4 {
        return None;
    }
    let mut table = vec![0u8; size as usize];
    if unsafe {
        GetExtendedTcpTable(
            Some(table.as_mut_ptr().cast()),
            &mut size,
            false,
            2,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    } != 0
    {
        return None;
    }
    let count = u32::from_ne_bytes(table.get(..4)?.try_into().ok()?) as usize;
    let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
    for index in 0..count {
        let bytes = table.get(4 + index * row_size..4 + (index + 1) * row_size)?;
        let row = unsafe {
            bytes
                .as_ptr()
                .cast::<MIB_TCPROW_OWNER_PID>()
                .read_unaligned()
        };
        if u16::from_be(row.dwLocalPort as u16) == port
            && (row.dwLocalAddr == 0 || row.dwLocalAddr == u32::from_ne_bytes([127, 0, 0, 1]))
        {
            return Some(sysinfo::Pid::from_u32(row.dwOwningPid));
        }
    }
    None
}

#[cfg(not(windows))]
fn port_owner(port: u16) -> Option<sysinfo::Pid> {
    let output = Command::new("lsof")
        .args(["-nP", "-t", &format!("-i4TCP:{port}"), "-sTCP:LISTEN"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .next()?
        .parse::<u32>()
        .ok()
        .map(sysinfo::Pid::from_u32)
}

pub(crate) fn http_request(port: u16, method: &str, path: &str) -> Option<String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(1)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    String::from_utf8(buf).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    struct HealthServer {
        port: u16,
        stopped: Arc<AtomicBool>,
        requests: Arc<Mutex<Vec<String>>>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl HealthServer {
        fn start(payload: serde_json::Value, stopped: Arc<AtomicBool>) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            listener.set_nonblocking(true).unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let server_stopped = stopped.clone();
            let server_requests = requests.clone();
            let thread = std::thread::spawn(move || {
                while !server_stopped.load(Ordering::SeqCst) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = Vec::new();
                    let mut byte = [0];
                    while !request.ends_with(b"\r\n\r\n") {
                        if stream.read(&mut byte).unwrap_or(0) == 0 {
                            break;
                        }
                        request.push(byte[0]);
                    }
                    let request = String::from_utf8(request).unwrap();
                    let request_line = request.lines().next().unwrap_or("").to_owned();
                    server_requests.lock().unwrap().push(request_line.clone());
                    let body = payload.to_string();
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .unwrap();
                    if request_line == "POST /shutdown HTTP/1.1" {
                        server_stopped.store(true, Ordering::SeqCst);
                    }
                }
            });
            Self {
                port,
                stopped,
                requests,
                thread: Some(thread),
            }
        }

        fn was_shutdown(&self) -> bool {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .any(|line| line.starts_with("POST /shutdown "))
        }
    }

    impl Drop for HealthServer {
        fn drop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
            self.thread.take().unwrap().join().unwrap();
        }
    }

    fn health(service: &str, capability: &str) -> serde_json::Value {
        serde_json::json!({"status": "ok", "service": service, "capabilities": [capability], "version": env!("CARGO_PKG_VERSION")})
    }

    fn gateway_pair() -> (HealthServer, HealthServer) {
        let stopped = Arc::new(AtomicBool::new(false));
        (
            HealthServer::start(health("mona-gateway", "agent-http-v1"), stopped.clone()),
            HealthServer::start(health("mona-websocket", "webui-runtime-token-v1"), stopped),
        )
    }

    #[test]
    fn free_ports_start_a_new_backend() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(
            prepare_ports(&[(port, "mona-services", "stock-vibe-v1")], true),
            Ok(false)
        );
    }

    #[test]
    fn dev_shutdown_releases_both_gateway_ports() {
        let (gateway, websocket) = gateway_pair();
        assert_eq!(
            prepare_ports(
                &[
                    (gateway.port, "mona-gateway", "agent-http-v1"),
                    (websocket.port, "mona-websocket", "webui-runtime-token-v1")
                ],
                false
            ),
            Ok(false)
        );
        assert!(gateway.was_shutdown());
        assert!(is_port_available(gateway.port));
        assert!(is_port_available(websocket.port));
    }

    #[test]
    fn release_reuses_a_compatible_background_gateway() {
        let (gateway, websocket) = gateway_pair();
        assert_eq!(
            prepare_ports(
                &[
                    (gateway.port, "mona-gateway", "agent-http-v1"),
                    (websocket.port, "mona-websocket", "webui-runtime-token-v1")
                ],
                true
            ),
            Ok(true)
        );
        assert!(!gateway.was_shutdown());
        assert!(!websocket.was_shutdown());
    }

    #[test]
    fn release_replaces_legacy_version_and_incompatible_mona_services() {
        for field in ["version", "capabilities"] {
            let mut payload = health("mona-services", "stock-vibe-v1");
            payload.as_object_mut().unwrap().remove(field);
            let services = HealthServer::start(payload, Arc::new(AtomicBool::new(false)));
            assert_eq!(
                prepare_ports(&[(services.port, "mona-services", "stock-vibe-v1")], true),
                Ok(false)
            );
            assert!(services.was_shutdown());
        }
        let mut payload = health("mona-services", "stock-vibe-v1");
        payload["version"] = serde_json::json!("0.0.0");
        let services = HealthServer::start(payload, Arc::new(AtomicBool::new(false)));
        assert_eq!(
            prepare_ports(&[(services.port, "mona-services", "stock-vibe-v1")], true),
            Ok(false)
        );
        assert!(services.was_shutdown());
    }

    #[test]
    fn release_restarts_gateway_when_websocket_is_missing() {
        let gateway = HealthServer::start(
            health("mona-gateway", "agent-http-v1"),
            Arc::new(AtomicBool::new(false)),
        );
        let websocket = HealthServer::start(
            health("mona-websocket", "webui-runtime-token-v1"),
            Arc::new(AtomicBool::new(false)),
        );
        let websocket_port = websocket.port;
        drop(websocket);
        assert!(is_port_available(websocket_port));
        assert_eq!(
            prepare_ports(
                &[
                    (gateway.port, "mona-gateway", "agent-http-v1"),
                    (websocket_port, "mona-websocket", "webui-runtime-token-v1")
                ],
                true
            ),
            Ok(false)
        );
        assert!(gateway.was_shutdown());
    }

    #[test]
    fn other_healthy_software_is_never_shutdown() {
        let server = HealthServer::start(
            serde_json::json!({"status": "ok"}),
            Arc::new(AtomicBool::new(false)),
        );
        for allow_reuse in [false, true] {
            assert!(
                prepare_ports(&[(server.port, "mona-services", "stock-vibe-v1")], allow_reuse).is_err()
            );
        }
        assert!(stop(server.port, &[server.port]).is_err());
        assert!(!server.was_shutdown());
        assert!(!is_port_available(server.port));
    }

    #[test]
    fn foreign_websocket_port_does_not_shutdown_a_healthy_gateway() {
        let gateway = HealthServer::start(
            health("mona-gateway", "agent-http-v1"),
            Arc::new(AtomicBool::new(false)),
        );
        let websocket = HealthServer::start(
            serde_json::json!({"service": "another-app", "status": "ok"}),
            Arc::new(AtomicBool::new(false)),
        );
        assert!(prepare_ports(
            &[
                (gateway.port, "mona-gateway", "agent-http-v1"),
                (websocket.port, "mona-websocket", "webui-runtime-token-v1")
            ],
            false
        )
        .is_err());
        assert!(!gateway.was_shutdown());
        assert!(!websocket.was_shutdown());
    }

    #[cfg(windows)]
    #[test]
    fn legacy_gateway_ignoring_shutdown_is_recovered_by_its_port_owner() {
        let root = tempfile::tempdir().unwrap();
        let package = root.path().join("mona");
        std::fs::create_dir(&package).unwrap();
        std::fs::write(package.join("__init__.py"), "").unwrap();
        std::fs::write(package.join("__main__.py"), r#"
import json, socket, threading, time
from pathlib import Path
listeners = []
for service, capability in [('mona-gateway', 'agent-http-v1'), ('mona-websocket', 'webui-runtime-token-v1')]:
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    listeners.append(listener)
    def serve(listener=listener, service=service, capability=capability):
        while True:
            connection, _ = listener.accept()
            with connection:
                request = b''
                while b'\r\n\r\n' not in request:
                    chunk = connection.recv(4096)
                    if not chunk: break
                    request += chunk
                body = json.dumps({'status': 'ok', 'service': service, 'capabilities': [capability]}).encode()
                connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)
                # Emulate the legacy CLI whose other tasks outlive /shutdown.
    threading.Thread(target=serve, daemon=True).start()
Path('ports.json').write_text(json.dumps([listener.getsockname()[1] for listener in listeners]))
while True: time.sleep(1)
"#).unwrap();
        let mut child = Command::new("python")
            .args(["-m", "mona", "gateway"])
            .current_dir(root.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut ports = Vec::<u16>::new();
        while Instant::now() < deadline {
            if let Ok(text) = std::fs::read_to_string(root.path().join("ports.json")) {
                if let Ok(values) = serde_json::from_str(&text) {
                    ports = values;
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if ports.len() != 2 {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Legacy backend did not bind both ports");
        }
        let result = prepare_ports(
            &[
                (ports[0], "mona-gateway", "agent-http-v1"),
                (ports[1], "mona-websocket", "webui-runtime-token-v1"),
            ],
            true,
        );
        let released = ports.iter().all(|port| is_port_available(*port));
        let exited = child.try_wait().unwrap().is_some();
        if !exited {
            let _ = child.kill();
        }
        let _ = child.wait();
        assert_eq!(result, Ok(false));
        assert!(
            released && exited,
            "Only the verified legacy backend should be terminated"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "subprocess fixture for the forced desktop termination test"]
    fn job_fixture() {
        let role = std::env::var("MONA_TEST_JOB_ROLE").unwrap();
        let root = std::path::PathBuf::from(std::env::var_os("MONA_TEST_JOB_ROOT").unwrap());
        let executable = std::env::current_exe().unwrap();
        let mut command = Command::new(executable);
        command.args([
            "--ignored",
            "--exact",
            "backend_process::tests::job_fixture",
            "--nocapture",
        ]);
        command
            .env("MONA_TEST_JOB_ROOT", &root)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if role == "owner" {
            command.env("MONA_TEST_JOB_ROLE", "child");
            let _child = spawn(&mut command).unwrap();
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        if role == "child" {
            command.env("MONA_TEST_JOB_ROLE", "grandchild");
            let _grandchild = command.spawn().unwrap();
        }
        std::fs::write(
            root.join(format!("{role}.json")),
            serde_json::json!({"pid": std::process::id(), "port": port}).to_string(),
        )
        .unwrap();
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    #[cfg(windows)]
    #[test]
    fn forced_desktop_exit_releases_child_and_descendant_ports() {
        let root = tempfile::tempdir().unwrap();
        let mut owner = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "backend_process::tests::job_fixture",
                "--nocapture",
            ])
            .env("MONA_TEST_JOB_ROLE", "owner")
            .env("MONA_TEST_JOB_ROOT", root.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut records = Vec::new();
        while Instant::now() < deadline {
            records = ["child", "grandchild"]
                .iter()
                .filter_map(|role| {
                    serde_json::from_str::<serde_json::Value>(
                        &std::fs::read_to_string(root.path().join(format!("{role}.json"))).ok()?,
                    )
                    .ok()
                })
                .collect();
            if records.len() == 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let ports: Vec<_> = records
            .iter()
            .map(|record| record["port"].as_u64().unwrap() as u16)
            .collect();
        let were_alive = ports.len() == 2 && ports.iter().all(|port| !is_port_available(*port));
        owner.kill().unwrap(); // Terminate only the desktop owner, without /T.
        owner.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && ports.iter().any(|port| !is_port_available(*port)) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            were_alive,
            "Child and descendant must both be listening before owner termination"
        );
        assert!(
            ports.iter().all(|port| is_port_available(*port)),
            "Job Object must release every child port on forced owner exit"
        );
    }
}
