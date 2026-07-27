// 进程黑名单（IFEO 劫持 + Mona-Block 标记）+ 文件锁句柄查询。
// 通过 IFEO 的 Debugger 值阻止 exe 运行，用 /*Mona-Block*/ 标记区分 Mona 创建的规则。

use serde::{Deserialize, Serialize};
use tauri::State;

use super::SystemState;

const MONA_BLOCK_MARKER: &str = "/*Mona-Block*/";
const SYSTEM_PROCESSES: &[&str] = &[
    "explorer.exe", "svchost.exe", "csrss.exe", "winlogon.exe", "lsass.exe",
    "smss.exe", "services.exe", "wininit.exe", "dwm.exe", "taskmgr.exe",
    "cmd.exe", "powershell.exe", "conhost.exe", "regedit.exe",
    "System", "Idle", "Registry",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedProcess {
    pub exe_name: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockResult {
    pub exe_name: String,
    pub success: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLockHolder {
    pub pid: u32,
    pub name: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLockResult {
    pub holders: Vec<FileLockHolder>,
    pub detail: String,
}

fn now_ts() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(windows)]
fn run_elevated_powershell(script: &str, timeout_ms: u32) -> Result<(), String> {
    use base64::Engine;
    let bytes = script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    super::run_elevated("powershell.exe", &format!("-NoProfile -NonInteractive -EncodedCommand {encoded}"), timeout_ms)
}

#[cfg(not(windows))]
fn run_elevated_powershell(_script: &str, _timeout_ms: u32) -> Result<(), String> { Err("仅支持 Windows".into()) }

#[cfg(windows)]
fn run_hidden_powershell(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("启动 PowerShell 失败：{e}"))?;
    let stdout = super::decode_windows_output(&output.stdout).trim().to_string();
    let stderr = super::decode_windows_output(&output.stderr).trim().to_string();
    if output.status.success() { Ok(stdout) }
    else { Err(if !stderr.is_empty() { stderr } else if !stdout.is_empty() { stdout } else { "PowerShell 执行失败".into() }) }
}

#[cfg(not(windows))]
fn run_hidden_powershell(_script: &str) -> Result<String, String> { Err("仅支持 Windows".into()) }

fn record_event(state: &State<'_, SystemState>, title: &str, status: &str, detail: &str) {
    if let Ok(inner) = state.0.lock() {
        let _ = inner.db.execute_batch(
            "CREATE TABLE IF NOT EXISTS process_control_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
                title TEXT NOT NULL, mode TEXT NOT NULL, success INTEGER NOT NULL, detail TEXT NOT NULL
            );",
        );
        let success = if status == "成功" { 1 } else { 0 };
        let _ = inner.db.execute(
            "INSERT INTO process_control_operations (ts, title, mode, success, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![now_ts(), title, "process", success, detail],
        );
    }
}

pub fn is_system_process(exe_name: &str) -> bool {
    let lower = exe_name.to_lowercase();
    let lower = lower.trim_end_matches(".exe");
    SYSTEM_PROCESSES.iter().any(|p| {
        let p = p.trim_end_matches(".exe");
        p.eq_ignore_ascii_case(lower)
    }) || SYSTEM_PROCESSES.iter().any(|p| p.eq_ignore_ascii_case(&exe_name))
}

#[cfg(windows)]
fn ifeo_base_path() -> &'static str {
    r"HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options"
}

#[cfg(windows)]
fn read_blocked_processes_inner() -> Result<Vec<BlockedProcess>, String> {
    let script = format!(
        "$base='{ifeo}'; $results=@(); Get-ChildItem -Path $base -ErrorAction SilentlyContinue | ForEach-Object {{ $dbg = (Get-ItemProperty -Path (\"{ifeo}\\\"+$_.Name.Split('\\')[-1]) -Name 'Debugger' -ErrorAction SilentlyContinue).Debugger; if($dbg -and $dbg -like '*{marker}*'){{ $results += ($_.Name.Split('\\')[-1]) }} }}; $results -join '|'",
        ifeo = ifeo_base_path(),
        marker = MONA_BLOCK_MARKER
    );
    let output = run_hidden_powershell(&script).unwrap_or_default();
    let names: Vec<BlockedProcess> = output.split('|')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|name| BlockedProcess { exe_name: name, added_at: 0 })
        .collect();
    Ok(names)
}

#[cfg(not(windows))]
fn read_blocked_processes_inner() -> Result<Vec<BlockedProcess>, String> { Ok(vec![]) }

#[tauri::command]
pub async fn system_list_blocked_processes() -> Result<Vec<BlockedProcess>, String> {
    tokio::task::spawn_blocking(read_blocked_processes_inner)
        .await
        .map_err(|e| format!("读取进程黑名单失败：{e}"))?
}

#[tauri::command]
pub async fn system_block_process(state: State<'_, SystemState>, exe_name: String) -> Result<BlockResult, String> {
    let clean_name = exe_name.trim().to_string();
    if clean_name.is_empty() {
        return Err("进程名不能为空".into());
    }
    if is_system_process(&clean_name) {
        return Err(format!("不允许阻止系统关键进程：{clean_name}"));
    }

    let name_for_script = clean_name.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let key_name = if name_for_script.to_lowercase().ends_with(".exe") {
            name_for_script.clone()
        } else {
            format!("{name_for_script}.exe")
        };
        let script = format!(
            "$path='{ifeo}\\{key_name}'; if(-not (Test-Path $path)){{ New-Item -Path $path -Force | Out-Null }}; Set-ItemProperty -Path $path -Name 'Debugger' -Value '\"C:\\Windows\\System32\\systray.exe\" {marker}' -Type String -Force; 'OK'",
            ifeo = ifeo_base_path(),
            marker = MONA_BLOCK_MARKER
        );
        run_elevated_powershell(&script, 30_000)?;
        Ok(format!("已阻止 {key_name} 启动"))
    })
    .await
    .map_err(|e| format!("阻止进程失败：{e}"))?;

    let (success, detail) = match result {
        Ok(d) => (true, d),
        Err(ref e) => (false, e.clone()),
    };
    let status = if success { "成功" } else { "失败" };
    record_event(&state, &format!("阻止进程 {clean_name}"), status, &detail);

    if success {
        Ok(BlockResult { exe_name: clean_name, success, detail })
    } else {
        Err(detail)
    }
}

#[tauri::command]
pub async fn system_unblock_process(state: State<'_, SystemState>, exe_name: String) -> Result<BlockResult, String> {
    let clean_name = exe_name.trim().to_string();
    let name_for_script = clean_name.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let key_name = if name_for_script.to_lowercase().ends_with(".exe") {
            name_for_script.clone()
        } else {
            format!("{name_for_script}.exe")
        };
        let script = format!(
            "$path='{ifeo}\\{key_name}'; if(Test-Path $path){{ $dbg=(Get-ItemProperty -Path $path -Name 'Debugger' -ErrorAction SilentlyContinue).Debugger; if($dbg -and $dbg -like '*{marker}*'){{ Remove-Item -Path $path -Recurse -Force -ErrorAction Stop }} }}; 'OK'",
            ifeo = ifeo_base_path(),
            marker = MONA_BLOCK_MARKER
        );
        run_elevated_powershell(&script, 30_000)?;
        Ok(format!("已解除阻止 {key_name}"))
    })
    .await
    .map_err(|e| format!("解除阻止失败：{e}"))?;

    let (success, detail) = match result {
        Ok(d) => (true, d),
        Err(ref e) => (false, e.clone()),
    };
    let status = if success { "成功" } else { "失败" };
    record_event(&state, &format!("解除阻止进程 {clean_name}"), status, &detail);

    if success {
        Ok(BlockResult { exe_name: clean_name, success, detail })
    } else {
        Err(detail)
    }
}

#[tauri::command]
pub async fn system_find_file_locks(file_path: String) -> Result<FileLockResult, String> {
    if file_path.trim().is_empty() {
        return Err("文件路径不能为空".into());
    }
    let path = file_path.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<FileLockHolder>, String> {
        let path_norm = path.replace('\'', "''");
        let script = format!(
            "$target='{path_norm}'; $targetFull=(Resolve-Path -LiteralPath $target -ErrorAction SilentlyContinue).Path; if(-not $targetFull){{ $targetFull=$target }}; $holders=@(); Get-Process -ErrorAction SilentlyContinue | ForEach-Object {{ $proc=$_; try {{ $_.Modules | Where-Object {{ $_.FileName -like \"$targetFull*\" -or $_.FileName -eq $targetFull }} | Select-Object -First 1 | ForEach-Object {{ $holders += [PSCustomObject]@{{Pid=$proc.Id;Name=$proc.ProcessName;Path=$_.FileName}} }} }} catch {{}} }}; $holders | ForEach-Object {{ \"$($_.Pid)|$($_.Name)|$($_.Path)\" }}",
        );
        let output = run_hidden_powershell(&script).unwrap_or_default();
        let holders = output.lines().filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, '|').collect();
            if parts.len() >= 2 {
                let pid: u32 = parts[0].parse().ok()?;
                Some(FileLockHolder {
                    pid,
                    name: parts[1].to_string(),
                    path: parts.get(2).map(|s| s.to_string()),
                })
            } else {
                None
            }
        }).collect();
        Ok(holders)
    })
    .await
    .map_err(|e| format!("查询文件锁失败：{e}"))?;

    match result {
        Ok(holders) => {
            let detail = if holders.is_empty() {
                "没有找到占用该文件的进程".into()
            } else {
                format!("找到 {} 个占用进程", holders.len())
            };
            Ok(FileLockResult { holders, detail })
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn system_terminate_lock_holder(state: State<'_, SystemState>, pid: u32) -> Result<String, String> {
    let pid_str = pid.to_string();
    let result = tokio::task::spawn_blocking(move || {
        run_hidden_powershell(&format!("Stop-Process -Id {pid_str} -Force -ErrorAction Stop; 'OK'"))
    })
    .await
    .map_err(|e| format!("终止进程失败：{e}"))?;

    let (success, detail) = match result {
        Ok(_) => (true, format!("已终止进程 PID={pid}")),
        Err(ref e) => (false, e.clone()),
    };
    let status = if success { "成功" } else { "失败" };
    record_event(&state, &format!("终止进程 PID={pid}"), status, &detail);

    if success { Ok(detail) } else { Err(detail) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_processes_are_blocked_from_blacklist() {
        assert!(is_system_process("explorer.exe"));
        assert!(is_system_process("explorer"));
        assert!(is_system_process("svchost.exe"));
        assert!(is_system_process("csrss.exe"));
        assert!(!is_system_process("notepad.exe"));
        assert!(!is_system_process("chrome.exe"));
    }

    #[test]
    fn case_insensitive_system_process_check() {
        assert!(is_system_process("EXPLORER.EXE"));
        assert!(is_system_process("Explorer"));
        assert!(is_system_process("Cmd.exe"));
    }

    #[test]
    fn mona_block_marker_is_defined() {
        assert_eq!(MONA_BLOCK_MARKER, "/*Mona-Block*/");
    }
}
