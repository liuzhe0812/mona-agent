// 性能微调：svchost 进程拆分 / HPET 禁用 / CPU 核心解锁。
// 独立于 win11debloat 上游快照，复用 run_elevated 机制。

use serde::{Deserialize, Serialize};
use tauri::State;

use super::SystemState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceItem {
    pub id: String,
    pub label: String,
    pub description: String,
    pub category: String,
    pub risk: String,
    pub requires_reboot: bool,
    pub requires_administrator: bool,
    pub can_restore: bool,
    pub is_applied: bool,
    pub current_detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceActionResult {
    pub item_id: String,
    pub success: bool,
    pub detail: String,
    pub requires_restart: bool,
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn run_elevated_powershell(script: &str, timeout_ms: u32) -> Result<(), String> {
    use base64::Engine;
    let bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let params = format!("-NoProfile -NonInteractive -EncodedCommand {encoded}");
    super::run_elevated("powershell.exe", &params, timeout_ms)
}

#[cfg(not(windows))]
fn run_elevated_powershell(_script: &str, _timeout_ms: u32) -> Result<(), String> {
    Err("仅支持 Windows".into())
}

#[cfg(windows)]
fn read_registry_dword(path: &str, name: &str) -> Option<u32> {
    use windows_registry::LOCAL_MACHINE;
    let (hive, subkey) = path.split_once('\\')?;
    let root = match hive {
        "HKEY_LOCAL_MACHINE" => LOCAL_MACHINE,
        _ => return None,
    };
    let key = root.open(subkey).ok()?;
    key.get_u32(name).ok()
}

#[cfg(not(windows))]
fn read_registry_dword(_path: &str, _name: &str) -> Option<u32> { None }

#[cfg(windows)]
fn run_bcdedit(args: &str) -> Result<(), String> {
    super::run_elevated("bcdedit.exe", args, 30_000)
}

#[cfg(not(windows))]
fn run_bcdedit(_args: &str) -> Result<(), String> { Err("仅支持 Windows".into()) }

fn record_event(state: &State<'_, SystemState>, title: &str, status: &str, detail: &str) {
    if let Ok(inner) = state.0.lock() {
        let _ = inner.db.execute_batch(
            "CREATE TABLE IF NOT EXISTS performance_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                title TEXT NOT NULL,
                mode TEXT NOT NULL,
                success INTEGER NOT NULL,
                detail TEXT NOT NULL
            );",
        );
        let success = if status == "成功" { 1 } else { 0 };
        let _ = inner.db.execute(
            "INSERT INTO performance_operations (ts, title, mode, success, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![now_ts(), title, "performance", success, detail],
        );
    }
}

fn total_ram_gb() -> u32 {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    (sys.total_memory() / (1024 * 1024 * 1024)) as u32
}

fn check_svchost_split() -> (bool, String) {
    match read_registry_dword(
        r"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control",
        "SvcHostSplitDiscriminator",
    ) {
        Some(value) if value > 0 => (true, format!("已启用（拆分数 = {value}）")),
        _ => (false, "未启用".into()),
    }
}

fn check_hpet() -> (bool, String) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let output = Command::new("bcdedit")
            .args(["/enum", "{current}"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match output {
            Ok(output) => {
                let text = super::decode_windows_output(&output.stdout);
                let has_hpet = text
                    .lines()
                    .any(|line| line.trim().eq_ignore_ascii_case("useplatformclock              Yes"));
                if has_hpet {
                    (true, "HPET 已启用（useplatformclock = Yes）".into())
                } else {
                    (false, "HPET 未启用".into())
                }
            }
            Err(_) => (false, "无法读取 bcdedit 状态".into()),
        }
    }
    #[cfg(not(windows))]
    { (false, "仅支持 Windows".into()) }
}

fn check_cpu_unlock() -> (bool, String) {
    match read_registry_dword(
        r"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Power",
        "EnergyEstimationEnabled",
    ) {
        Some(1) => (false, "CPU 核心未受限".into()),
        Some(0) => (true, "CPU 核心已解锁".into()),
        _ => (false, "默认状态".into()),
    }
}

fn catalog_items() -> Vec<PerformanceItem> {
    let (svchost_applied, svchost_detail) = check_svchost_split();
    let (hpet_applied, hpet_detail) = check_hpet();
    let (cpu_applied, cpu_detail) = check_cpu_unlock();
    vec![
        PerformanceItem {
            id: "SvchostSplitDisable".into(),
            label: "禁用 svchost 进程拆分".into(),
            description: "减少 svchost.exe 进程数，降低内存占用。对低配机器有效。".into(),
            category: "性能".into(),
            risk: "low".into(),
            requires_reboot: false,
            requires_administrator: true,
            can_restore: true,
            is_applied: svchost_applied,
            current_detail: svchost_detail,
        },
        PerformanceItem {
            id: "DisableHPET".into(),
            label: "禁用 HPET（高精度事件计时器）".into(),
            description: "游戏场景可降低延迟。部分老硬件可能不稳定。".into(),
            category: "性能".into(),
            risk: "medium".into(),
            requires_reboot: true,
            requires_administrator: true,
            can_restore: true,
            is_applied: hpet_applied,
            current_detail: hpet_detail,
        },
        PerformanceItem {
            id: "UnlockCpuCores".into(),
            label: "解锁 CPU 核心限制".into(),
            description: "移除系统对 CPU 核心使用的限制，释放全部性能。".into(),
            category: "性能".into(),
            risk: "low".into(),
            requires_reboot: true,
            requires_administrator: true,
            can_restore: true,
            is_applied: cpu_applied,
            current_detail: cpu_detail,
        },
    ]
}

fn apply_svchost_split(mode: &str) -> Result<String, String> {
    if mode == "restore" {
        let script = "Remove-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control' -Name 'SvcHostSplitDiscriminator' -ErrorAction SilentlyContinue; 'OK'";
        run_elevated_powershell(script, 30_000)?;
        Ok("已恢复 svchost 进程拆分（系统默认）".into())
    } else {
        let ram_gb = total_ram_gb().max(1);
        let script = format!(
            "Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control' -Name 'SvcHostSplitDiscriminator' -Value {ram_gb} -Type DWord -Force; 'OK'"
        );
        run_elevated_powershell(&script, 30_000)?;
        Ok(format!("已设置 svchost 拆分数为 {ram_gb}（对应内存 GB）"))
    }
}

fn apply_hpet(mode: &str) -> Result<String, String> {
    if mode == "restore" {
        run_bcdedit("/setvalueuseplatformclock HighPrecisionEventTimer")?;
        Ok("已启用 HPET（需重启生效）".into())
    } else {
        run_bcdedit("/deletevalue useplatformclock")?;
        Ok("已禁用 HPET（需重启生效）".into())
    }
}

fn apply_cpu_unlock(mode: &str) -> Result<String, String> {
    let (value, label) = if mode == "restore" {
        (1u32, "已恢复 CPU 核心限制为默认".to_string())
    } else {
        (0u32, "已解锁 CPU 核心限制".to_string())
    };
    let script = format!(
        "$path='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power'; if(-not (Test-Path $path)){{ New-Item -Path $path -Force | Out-Null }}; Set-ItemProperty -Path $path -Name 'EnergyEstimationEnabled' -Value {value} -Type DWord -Force; 'OK'"
    );
    run_elevated_powershell(&script, 30_000)?;
    Ok(label)
}

#[tauri::command]
pub async fn system_list_performance_items() -> Result<Vec<PerformanceItem>, String> {
    let items = tokio::task::spawn_blocking(catalog_items)
        .await
        .map_err(|error| format!("性能项读取失败：{error}"))?;
    Ok(items)
}

#[tauri::command]
pub async fn system_apply_performance_item(
    state: State<'_, SystemState>,
    item_id: String,
    mode: String,
) -> Result<PerformanceActionResult, String> {
    if !matches!(mode.as_str(), "recommended" | "restore") {
        return Err("无效的操作模式".into());
    }

    let item_id_for_task = item_id.clone();
    let mode_for_task = mode.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(String, bool), String> {
        match item_id_for_task.as_str() {
            "SvchostSplitDisable" => Ok((apply_svchost_split(&mode_for_task)?, false)),
            "DisableHPET" => Ok((apply_hpet(&mode_for_task)?, true)),
            "UnlockCpuCores" => Ok((apply_cpu_unlock(&mode_for_task)?, true)),
            _ => Err(format!("未知的性能项：{item_id_for_task}")),
        }
    })
    .await
    .map_err(|error| format!("性能操作失败：{error}"))?;

    let success = result.is_ok();
    let (detail, requires_restart) = result.clone().map_or_else(|e| (e, false), |(d, r)| (d, r));
    let label = catalog_items()
        .into_iter()
        .find(|item| item.id == item_id)
        .map(|item| item.label)
        .unwrap_or_else(|| item_id.clone());
    let title = format!("{} {}", if mode == "restore" { "恢复" } else { "应用" } , label);
    let status = if success { "成功" } else { "失败" };
    record_event(&state, &title, status, &detail);

    if success {
        Ok(PerformanceActionResult {
            item_id,
            success: true,
            detail,
            requires_restart,
        })
    } else {
        Err(detail)
    }
}

#[cfg(test)]
mod tests {
    use super::{catalog_items, check_cpu_unlock, check_hpet, check_svchost_split};

    #[test]
    fn catalog_has_three_items_with_correct_ids() {
        let items = catalog_items();
        assert_eq!(items.len(), 3);
        let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
        assert!(ids.contains(&"SvchostSplitDisable".into()));
        assert!(ids.contains(&"DisableHPET".into()));
        assert!(ids.contains(&"UnlockCpuCores".into()));
    }

    #[test]
    fn all_items_require_administrator() {
        for item in catalog_items() {
            assert!(item.requires_administrator, "{} should require admin", item.id);
            assert!(item.can_restore, "{} should be restorable", item.id);
        }
    }

    #[test]
    fn hpet_requires_reboot() {
        let hpet = catalog_items().into_iter().find(|item| item.id == "DisableHPET").unwrap();
        assert!(hpet.requires_reboot);
    }

    #[test]
    fn svchost_does_not_require_reboot() {
        let svchost = catalog_items().into_iter().find(|item| item.id == "SvchostSplitDisable").unwrap();
        assert!(!svchost.requires_reboot);
    }

    #[test]
    fn check_functions_return_tuples_without_panicking() {
        let _ = check_svchost_split();
        let _ = check_hpet();
        let _ = check_cpu_unlock();
    }
}
