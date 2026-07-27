// 禁用/启用 Windows Defender 实时保护。
// 注册表策略 + Set-MpPreference，含第三方杀毒软件检测。

use serde::{Deserialize, Serialize};
use tauri::State;

use super::SystemState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefenderStatus {
    pub realtime_enabled: bool,
    pub is_managed_by_policy: bool,
    pub can_control: bool,
    pub third_party_av: Vec<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefenderActionResult {
    pub success: bool,
    pub detail: String,
    pub requires_restart: bool,
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
            "CREATE TABLE IF NOT EXISTS defender_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
                title TEXT NOT NULL, mode TEXT NOT NULL, success INTEGER NOT NULL, detail TEXT NOT NULL
            );",
        );
        let success = if status == "成功" { 1 } else { 0 };
        let _ = inner.db.execute(
            "INSERT INTO defender_operations (ts, title, mode, success, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![now_ts(), title, "defender", success, detail],
        );
    }
}

fn read_defender_status_inner() -> DefenderStatus {
    #[cfg(windows)]
    {
        let script = r#"try { $s = Get-MpComputerStatus -ErrorAction Stop; $realtime = $s.RealTimeProtectionEnabled; $policy = $s.AntivirusSignatureUpdateAged -and $s.QuickScanAge -gt 30; $av = @(); try { $av = Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop | Where-Object { $_.displayName -notlike '*Windows Defender*' -and $_.displayName -notlike '*Defender*' } | Select-Object -ExpandProperty displayName } catch {}; "$realtime|$policy|$($av -join ',')" } catch { 'false|false|' }"#;
        let output = run_hidden_powershell(script).unwrap_or_default();
        let parts: Vec<&str> = output.splitn(3, '|').collect();
        let realtime = parts.first().map(|s| s.eq_ignore_ascii_case("true")).unwrap_or(false);
        let policy_managed = parts.get(1).map(|s| s.eq_ignore_ascii_case("true")).unwrap_or(false);
        let third_party: Vec<String> = parts.get(2)
            .map(|s| s.split(',').map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect())
            .unwrap_or_default();

        let can_control = !third_party.is_empty() || true;
        let detail = if realtime {
            "Defender 实时保护已启用".to_string()
        } else {
            "Defender 实时保护已禁用".to_string()
        };
        if !third_party.is_empty() {
            return DefenderStatus {
                realtime_enabled: realtime,
                is_managed_by_policy: policy_managed,
                can_control,
                third_party_av: third_party.clone(),
                detail: format!("{detail}（检测到第三方杀毒软件：{}）", third_party.join("、")),
            };
        }
        DefenderStatus { realtime_enabled: realtime, is_managed_by_policy: policy_managed, can_control, third_party_av: third_party, detail }
    }
    #[cfg(not(windows))]
    {
        DefenderStatus { realtime_enabled: false, is_managed_by_policy: false, can_control: false, third_party_av: vec![], detail: "仅支持 Windows".into() }
    }
}

#[tauri::command]
pub async fn system_get_defender_status() -> Result<DefenderStatus, String> {
    let status = tokio::task::spawn_blocking(read_defender_status_inner)
        .await
        .map_err(|e| format!("读取 Defender 状态失败：{e}"))?;
    Ok(status)
}

fn disable_defender_inner() -> Result<String, String> {
    let script = r#"
$ErrorActionPreference='Stop'
$path='HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\Real-Time Protection'
if(-not (Test-Path $path)){ New-Item -Path $path -Force | Out-Null }
Set-ItemProperty -Path $path -Name 'DisableBehaviorMonitoring' -Value 1 -Type DWord -Force
Set-ItemProperty -Path $path -Name 'DisableOnAccessProtection' -Value 1 -Type DWord -Force
Set-ItemProperty -Path $path -Name 'DisableScanOnRealtimeEnable' -Value 1 -Type DWord -Force
$avPath='HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender'
if(-not (Test-Path $avPath)){ New-Item -Path $avPath -Force | Out-Null }
Set-ItemProperty -Path $avPath -Name 'DisableAntiSpyware' -Value 1 -Type DWord -Force
try { Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue } catch {}
'OK'
"#;
    run_elevated_powershell(script, 60_000)?;
    Ok("已禁用 Defender 实时保护（可能需要重启或安全模式才能完全生效）".into())
}

fn enable_defender_inner() -> Result<String, String> {
    let script = r#"
$ErrorActionPreference='Stop'
$path='HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\Real-Time Protection'
if(Test-Path $path){
    Remove-ItemProperty -Path $path -Name 'DisableBehaviorMonitoring' -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $path -Name 'DisableOnAccessProtection' -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $path -Name 'DisableScanOnRealtimeEnable' -ErrorAction SilentlyContinue
}
$avPath='HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender'
if(Test-Path $avPath){ Remove-ItemProperty -Path $avPath -Name 'DisableAntiSpyware' -ErrorAction SilentlyContinue }
try { Set-MpPreference -DisableRealtimeMonitoring $false -ErrorAction SilentlyContinue } catch {}
'OK'
"#;
    run_elevated_powershell(script, 60_000)?;
    Ok("已启用 Defender 实时保护（建议重启以确保生效）".into())
}

#[tauri::command]
pub async fn system_disable_defender(state: State<'_, SystemState>) -> Result<DefenderActionResult, String> {
    let result = tokio::task::spawn_blocking(disable_defender_inner)
        .await
        .map_err(|e| format!("禁用 Defender 失败：{e}"))?;

    let (success, detail) = match result {
        Ok(d) => (true, d),
        Err(ref e) => (false, e.clone()),
    };
    let status = if success { "成功" } else { "失败" };
    record_event(&state, "禁用 Defender 实时保护", status, &detail);

    if success {
        Ok(DefenderActionResult { success, detail, requires_restart: true })
    } else {
        Err(detail)
    }
}

#[tauri::command]
pub async fn system_enable_defender(state: State<'_, SystemState>) -> Result<DefenderActionResult, String> {
    let result = tokio::task::spawn_blocking(enable_defender_inner)
        .await
        .map_err(|e| format!("启用 Defender 失败：{e}"))?;

    let (success, detail) = match result {
        Ok(d) => (true, d),
        Err(ref e) => (false, e.clone()),
    };
    let status = if success { "成功" } else { "失败" };
    record_event(&state, "启用 Defender 实时保护", status, &detail);

    if success {
        Ok(DefenderActionResult { success, detail, requires_restart: true })
    } else {
        Err(detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_status_returns_result_without_panicking() {
        let _ = read_defender_status_inner();
    }
}
