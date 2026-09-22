use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};

use encoding_rs::GBK;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

use crate::terminal::error::TerminalError;

const SCROLL_BUFFER_CAPACITY: usize = 5000;

pub struct ScrollBuffer {
    data: StdMutex<Vec<String>>,
}

impl ScrollBuffer {
    pub fn new() -> Self {
        Self {
            data: StdMutex::new(Vec::with_capacity(SCROLL_BUFFER_CAPACITY)),
        }
    }

    pub fn push(&self, chunk: String) {
        let mut data = self.data.lock().unwrap();
        data.push(chunk);
        if data.len() > SCROLL_BUFFER_CAPACITY {
            let drain_count = data.len() - SCROLL_BUFFER_CAPACITY;
            data.drain(0..drain_count);
        }
    }

    pub fn get_all(&self) -> String {
        let data = self.data.lock().unwrap();
        data.join("")
    }
}

pub struct LocalShell {
    master: Arc<StdMutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<StdMutex<Box<dyn Write + Send>>>,
    child: Arc<StdMutex<Box<dyn Child + Send + Sync>>>,
    scroll_buffer: Arc<ScrollBuffer>,
}

fn detect_shell() -> (&'static str, bool) {
    if cfg!(windows) {
        let pwsh = which_exists("pwsh.exe");
        let powershell = which_exists("powershell.exe");
        if pwsh {
            return ("pwsh.exe", true);
        }
        if powershell {
            return ("powershell.exe", true);
        }
        return ("cmd.exe", false);
    }
    if which_exists("/bin/zsh") {
        return ("/bin/zsh", true);
    }
    if which_exists("/bin/bash") {
        return ("/bin/bash", true);
    }
    ("/bin/sh", true)
}

#[cfg(windows)]
fn which_exists(cmd: &str) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("where")
        .arg(cmd)
        .creation_flags(0x08000000)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn which_exists(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn decode_pty_output(raw: &[u8]) -> String {
    if !cfg!(windows) {
        return String::from_utf8_lossy(raw).to_string();
    }

    if raw.is_empty() {
        return String::new();
    }

    if std::str::from_utf8(raw).is_ok() {
        return String::from_utf8_lossy(raw).to_string();
    }

    let last_valid = find_last_utf8_boundary(raw);
    let (head, tail) = raw.split_at(last_valid);

    let head_str = if head.is_empty() {
        String::new()
    } else if std::str::from_utf8(head).is_ok() {
        String::from_utf8_lossy(head).to_string()
    } else {
        let (decoded, _, _) = GBK.decode(head);
        decoded.to_string()
    };

    let tail_str = {
        let (decoded, _, _) = GBK.decode(tail);
        decoded.to_string()
    };

    format!("{}{}", head_str, tail_str)
}

fn find_last_utf8_boundary(data: &[u8]) -> usize {
    let len = data.len();
    if len == 0 {
        return 0;
    }
    let mut i = len;
    while i > 0 {
        i -= 1;
        let byte = data[i];
        if byte & 0xC0 != 0x80 {
            let expected_len = if byte & 0x80 == 0 {
                1
            } else if byte & 0xE0 == 0xC0 {
                2
            } else if byte & 0xF0 == 0xE0 {
                3
            } else if byte & 0xF8 == 0xF0 {
                4
            } else {
                1
            };
            if len - i >= expected_len {
                return len;
            }
            return i;
        }
    }
    0
}

impl LocalShell {
    pub fn spawn(
        app_handle: AppHandle,
        session_id: String,
        cols: u16,
        rows: u16,
        cwd: Option<&Path>,
    ) -> Result<Self, TerminalError> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                log::error!("Failed to open PTY: {}", e);
                TerminalError::ShellSpawn(format!("openpty failed: {}", e))
            })?;

        let (shell, utf8_mode) = detect_shell();
        log::debug!(
            "Spawning local shell: {} (utf8={}), session={}",
            shell, utf8_mode, session_id
        );

        let mut cmd = CommandBuilder::new(shell);
        if let Some(path) = cwd {
            cmd.cwd(path);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        if cfg!(windows) && utf8_mode {
            cmd.env("PYTHONIOENCODING", "utf-8");
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| {
                log::error!("Failed to spawn shell command: {}", e);
                TerminalError::ShellSpawn(format!("spawn_command failed: {}", e))
            })?;

        let child = Arc::new(StdMutex::new(child));

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;

        let master = Arc::new(StdMutex::new(pair.master));
        let writer = Arc::new(StdMutex::new(writer));
        let scroll_buffer = Arc::new(ScrollBuffer::new());

        let handle = app_handle.clone();
        let sid = session_id.clone();
        let sb = scroll_buffer.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            log::debug!("PTY reader thread started for session {}", sid);
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        log::debug!("PTY reader: shell exited for session {}", sid);
                        let msg = "\r\n[Shell exited]\r\n".to_string();
                        sb.push(msg.clone());
                        let payload = serde_json::json!({
                            "sessionId": sid,
                            "data": msg,
                        });
                        let _ = handle.emit("terminal-output", payload);
                        break;
                    }
                    Ok(n) => {
                        let raw = &buf[..n];
                        let output = decode_pty_output(raw);
                        sb.push(output.clone());
                        let payload = serde_json::json!({
                            "sessionId": sid,
                            "data": output,
                        });
                        let _ = handle.emit("terminal-output", payload);
                    }
                    Err(e) => {
                        log::error!("PTY reader error for session {}: {}", sid, e);
                        break;
                    }
                }
            }
        });

        Ok(Self {
            master,
            writer,
            child,
            scroll_buffer,
        })
    }

    pub fn kill(&self) -> Result<(), TerminalError> {
        let mut child = self
            .child
            .lock()
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;
        child.kill().map_err(|e| TerminalError::ShellSpawn(e.to_string()))
    }

    pub fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;
        writer
            .write_all(data)
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;
        writer
            .flush()
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let master = self
            .master
            .lock()
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::ShellSpawn(e.to_string()))?;
        Ok(())
    }

    pub fn get_buffer(&self) -> String {
        self.scroll_buffer.get_all()
    }
}

impl Drop for LocalShell {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}
