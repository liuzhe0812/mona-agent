// 注册表修复模式：修复被恶意软件/策略禁用的系统组件。
// 区别于 win11debloat 的"优化"，这里是"修复"——恢复系统默认值。

use serde::{Deserialize, Serialize};
use tauri::State;

use super::SystemState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairItem {
    pub id: String,
    pub label: String,
    pub description: String,
    pub is_broken: bool,
    pub risk: String,
    pub requires_administrator: bool,
    pub can_repair: bool,
    pub current_detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairResult {
    pub item_id: String,
    pub success: bool,
    pub detail: String,
    pub requires_restart: bool,
}

fn now_ts() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(windows)]
fn read_registry_value(hive_str: &str, path: &str, name: &str) -> Option<u32> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};
    let root = match hive_str {
        "HKLM" => LOCAL_MACHINE,
        "HKCU" => CURRENT_USER,
        _ => return None,
    };
    let key = root.open(path).ok()?;
    key.get_u32(name).ok()
}

#[cfg(not(windows))]
fn read_registry_value(_hive: &str, _path: &str, _name: &str) -> Option<u32> { None }

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
fn run_current_user_powershell(script: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("启动 PowerShell 失败：{e}"))?;
    if output.status.success() { Ok(()) }
    else {
        let stderr = super::decode_windows_output(&output.stderr).trim().to_string();
        Err(if !stderr.is_empty() { stderr } else { "PowerShell 执行失败".into() })
    }
}

#[cfg(not(windows))]
fn run_current_user_powershell(_script: &str) -> Result<(), String> { Err("仅支持 Windows".into()) }

fn record_event(state: &State<'_, SystemState>, title: &str, status: &str, detail: &str) {
    if let Ok(inner) = state.0.lock() {
        let _ = inner.db.execute_batch(
            "CREATE TABLE IF NOT EXISTS repair_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
                title TEXT NOT NULL, mode TEXT NOT NULL, success INTEGER NOT NULL, detail TEXT NOT NULL
            );",
        );
        let success = if status == "成功" { 1 } else { 0 };
        let _ = inner.db.execute(
            "INSERT INTO repair_operations (ts, title, mode, success, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![now_ts(), title, "repair", success, detail],
        );
    }
}

fn check_defender_service() -> (bool, String) {
    match read_registry_value("HKLM", r"SYSTEM\CurrentControlSet\Services\WinDefend", "Start") {
        Some(2) => (false, "Defender 服务正常运行".into()),
        Some(4) => (true, "Defender 服务已被禁用".into()),
        Some(v) => (true, format!("Defender 服务启动类型异常（{v}）")),
        None => (false, "无法读取 Defender 服务状态".into()),
    }
}

fn check_uac() -> (bool, String) {
    match read_registry_value("HKLM", r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "EnableLUA") {
        Some(1) => (false, "UAC 已启用".into()),
        Some(0) => (true, "UAC 已被禁用".into()),
        None => (false, "无法读取 UAC 状态".into()),
        _ => (true, "UAC 状态异常".into()),
    }
}

fn check_registry_editor() -> (bool, String) {
    match read_registry_value("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Policies\System", "DisableRegistryTools") {
        Some(0) | None => (false, "注册表编辑器可用".into()),
        Some(1) => (true, "注册表编辑器已被禁用".into()),
        _ => (false, "注册表编辑器可用".into()),
    }
}

fn check_task_manager() -> (bool, String) {
    match read_registry_value("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Policies\System", "DisableTaskMgr") {
        Some(0) | None => (false, "任务管理器可用".into()),
        Some(1) => (true, "任务管理器已被禁用".into()),
        _ => (false, "任务管理器可用".into()),
    }
}

fn check_cmd() -> (bool, String) {
    match read_registry_value("HKCU", r"Software\Policies\Microsoft\Windows\System", "DisableCMD") {
        Some(0) | None => (false, "命令提示符可用".into()),
        Some(1) => (true, "命令提示符已被禁用".into()),
        _ => (false, "命令提示符可用".into()),
    }
}

fn repair_defender_service() -> Result<String, String> {
    let script = "Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\WinDefend' -Name 'Start' -Value 2 -Type DWord -Force; Start-Service -Name WinDefend -ErrorAction SilentlyContinue; 'OK'";
    run_elevated_powershell(script, 30_000)?;
    Ok("已恢复 Defender 服务为自动启动（需重启）".into())
}

fn repair_uac() -> Result<String, String> {
    let script = "Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name 'EnableLUA' -Value 1 -Type DWord -Force; 'OK'";
    run_elevated_powershell(script, 30_000)?;
    Ok("已恢复 UAC（需重启）".into())
}

fn repair_registry_editor() -> Result<String, String> {
    let script = "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name 'DisableRegistryTools' -ErrorAction SilentlyContinue; 'OK'";
    run_current_user_powershell(script)?;
    Ok("已恢复注册表编辑器访问".into())
}

fn repair_task_manager() -> Result<String, String> {
    let script = "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name 'DisableTaskMgr' -ErrorAction SilentlyContinue; 'OK'";
    run_current_user_powershell(script)?;
    Ok("已恢复任务管理器访问".into())
}

fn repair_cmd() -> Result<String, String> {
    let script = "Remove-ItemProperty -Path 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\System' -Name 'DisableCMD' -ErrorAction SilentlyContinue; 'OK'";
    run_current_user_powershell(script)?;
    Ok("已恢复命令提示符访问".into())
}

fn catalog_items() -> Vec<RepairItem> {
    let (defender_broken, defender_detail) = check_defender_service();
    let (uac_broken, uac_detail) = check_uac();
    let (reg_broken, reg_detail) = check_registry_editor();
    let (task_broken, task_detail) = check_task_manager();
    let (cmd_broken, cmd_detail) = check_cmd();
    vec![
        RepairItem { id: "DefenderService".into(), label: "Windows Defender 服务".into(), description: "修复被禁用的 Defender 实时保护服务。".into(), is_broken: defender_broken, risk: "low".into(), requires_administrator: true, can_repair: true, current_detail: defender_detail },
        RepairItem { id: "UAC".into(), label: "用户账户控制（UAC）".into(), description: "恢复被禁用的 UAC 弹窗确认。".into(), is_broken: uac_broken, risk: "low".into(), requires_administrator: true, can_repair: true, current_detail: uac_detail },
        RepairItem { id: "RegistryEditor".into(), label: "注册表编辑器".into(), description: "恢复被策略禁用的 regedit 访问。".into(), is_broken: reg_broken, risk: "low".into(), requires_administrator: false, can_repair: true, current_detail: reg_detail },
        RepairItem { id: "TaskManager".into(), label: "任务管理器".into(), description: "恢复被策略禁用的任务管理器。".into(), is_broken: task_broken, risk: "low".into(), requires_administrator: false, can_repair: true, current_detail: task_detail },
        RepairItem { id: "CommandPrompt".into(), label: "命令提示符".into(), description: "恢复被策略禁用的 cmd.exe。".into(), is_broken: cmd_broken, risk: "low".into(), requires_administrator: false, can_repair: true, current_detail: cmd_detail },
    ]
}

#[tauri::command]
pub async fn system_check_system_integrity() -> Result<Vec<RepairItem>, String> {
    let items = tokio::task::spawn_blocking(catalog_items).await.map_err(|e| format!("检查失败：{e}"))?;
    Ok(items)
}

#[tauri::command]
pub async fn system_repair_item(state: State<'_, SystemState>, item_id: String) -> Result<RepairResult, String> {
    let item_id_for_task = item_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(String, bool), String> {
        match item_id_for_task.as_str() {
            "DefenderService" => Ok((repair_defender_service()?, true)),
            "UAC" => Ok((repair_uac()?, true)),
            "RegistryEditor" => Ok((repair_registry_editor()?, false)),
            "TaskManager" => Ok((repair_task_manager()?, false)),
            "CommandPrompt" => Ok((repair_cmd()?, false)),
            _ => Err(format!("未知的修复项：{item_id_for_task}")),
        }
    })
    .await
    .map_err(|e| format!("修复失败：{e}"))?;

    let (detail, requires_restart) = match result {
        Ok((d, r)) => (d, r),
        Err(e) => {
            let label = catalog_items().into_iter().find(|i| i.id == item_id).map(|i| i.label).unwrap_or(item_id.clone());
            record_event(&state, &format!("修复 {label}"), "失败", &e);
            return Err(e);
        }
    };

    let label = catalog_items().into_iter().find(|i| i.id == item_id).map(|i| i.label).unwrap_or(item_id.clone());
    record_event(&state, &format!("修复 {label}"), "成功", &detail);
    Ok(RepairResult { item_id, success: true, detail, requires_restart })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_five_items() {
        let items = catalog_items();
        assert_eq!(items.len(), 5);
    }

    #[test]
    fn all_items_can_repair() {
        for item in catalog_items() {
            assert!(item.can_repair, "{} should be repairable", item.id);
        }
    }

    #[test]
    fn defender_and_uac_require_admin() {
        let items = catalog_items();
        let defender = items.iter().find(|i| i.id == "DefenderService").unwrap();
        let uac = items.iter().find(|i| i.id == "UAC").unwrap();
        assert!(defender.requires_administrator);
        assert!(uac.requires_administrator);
    }

    #[test]
    fn registry_editor_does_not_require_admin() {
        let items = catalog_items();
        let reg = items.iter().find(|i| i.id == "RegistryEditor").unwrap();
        assert!(!reg.requires_administrator);
    }
}
