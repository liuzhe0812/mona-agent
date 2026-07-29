// Windows 自动更新档位：默认自动 / 仅通知下载安装 / 完全禁用。
// 通过注册表策略控制：
//   HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU
//     NoAutoUpdate        0=自动（默认）  1=禁用自动更新
//     AUOptions           2=通知下载、通知安装   5=自动下载、通知安装（默认）
//   HKLM\SYSTEM\CurrentControlSet\Services\wuauserv
//     Start               3=手动（默认）   4=禁用
// 接入 catalog 审计体系，作为"Windows 更新"分组下的互斥档位 group 渲染。

use serde::Serialize;

use super::diagnostics::{ConfigurationAuditItem, ConfigurationGroup, ConfigurationGroupValue};

const WU_AU_PATH: &str = r"HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU";
const WU_SVC_PATH: &str = r"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\wuauserv";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WuLevel {
    Auto,
    NotifyOnly,
    Disabled,
}

impl WuLevel {
    fn feature_id(self) -> &'static str {
        match self {
            WuLevel::Auto => "WuAutoDefault",
            WuLevel::NotifyOnly => "WuNotifyOnly",
            WuLevel::Disabled => "WuDisabled",
        }
    }

    fn label(self) -> &'static str {
        match self {
            WuLevel::Auto => "自动下载并安装更新（默认，推荐）",
            WuLevel::NotifyOnly => "仅下载更新，由用户手动安装",
            WuLevel::Disabled => "完全禁用 Windows 自动更新（不推荐）",
        }
    }

    fn risk(self) -> &'static str {
        match self {
            WuLevel::Auto => "low",
            WuLevel::NotifyOnly => "low",
            WuLevel::Disabled => "high",
        }
    }

    fn description(self) -> &'static str {
        match self {
            WuLevel::Auto => "Windows 自动下载并安装重要更新与安全补丁，保持系统最新。这是推荐配置。",
            WuLevel::NotifyOnly => "Windows 仍会下载更新，但不会自动安装，由用户在设置中手动触发安装，避免在工作时被打断。",
            WuLevel::Disabled => "完全停止 Windows Update 服务，系统将不再检查、下载或安装任何更新。安全补丁缺失会让系统暴露在已知漏洞风险中。",
        }
    }

    fn no_auto_update(self) -> u32 {
        match self {
            WuLevel::Auto => 0,
            WuLevel::NotifyOnly | WuLevel::Disabled => 1,
        }
    }

    fn au_options(self) -> u32 {
        match self {
            WuLevel::Auto => 5,
            WuLevel::NotifyOnly => 2,
            WuLevel::Disabled => 0,
        }
    }

    fn svc_start(self) -> u32 {
        match self {
            WuLevel::Auto | WuLevel::NotifyOnly => 3,
            WuLevel::Disabled => 4,
        }
    }
}

const LEVELS: [WuLevel; 3] = [WuLevel::Auto, WuLevel::NotifyOnly, WuLevel::Disabled];

#[cfg(windows)]
fn read_policy_dword(path: &str, name: &str) -> Option<u32> {
    use windows_registry::LOCAL_MACHINE;
    // windows_registry 使用相对于 HKLM 的路径
    let relative = path
        .strip_prefix("HKEY_LOCAL_MACHINE\\")
        .or_else(|| path.strip_prefix("HKLM\\"))?;
    LOCAL_MACHINE.open(relative).ok()?.get_u32(name).ok()
}

#[cfg(not(windows))]
fn read_policy_dword(_path: &str, _name: &str) -> Option<u32> { None }

fn current_level() -> WuLevel {
    let no_auto = read_policy_dword(WU_AU_PATH, "NoAutoUpdate").unwrap_or(0);
    let au_opts = read_policy_dword(WU_AU_PATH, "AUOptions").unwrap_or(5);
    let svc = read_policy_dword(WU_SVC_PATH, "Start").unwrap_or(3);
    for level in LEVELS {
        if level.no_auto_update() == no_auto
            && level.au_options() == au_opts
            && level.svc_start() == svc
        {
            return level;
        }
    }
    WuLevel::Auto
}

fn current_detail(level: WuLevel) -> String {
    format!(
        "NoAutoUpdate={}，AUOptions={}，wuauserv.Start={}",
        level.no_auto_update(),
        level.au_options(),
        level.svc_start()
    )
}

pub fn catalog_items() -> Vec<ConfigurationAuditItem> {
    let active = current_level();
    LEVELS.iter().map(|&level| {
        let is_active = level == active;
        ConfigurationAuditItem {
            id: level.feature_id().into(),
            category: "Windows 更新".into(),
            title: level.label().into(),
            description: level.description().into(),
            current_value: current_detail(level),
            recommended_value: "应用此档位".into(),
            status: if is_active { "configured" } else { "available" }.into(),
            risk: level.risk().into(),
            impact: level.description().into(),
            reversible: true,
            requires_restart: false,
            requires_administrator: true,
            can_apply: true,
            can_restore: level != WuLevel::Auto,
            note: format!("注册表路径：{WU_AU_PATH}（更新策略）、{WU_SVC_PATH}（服务启动类型）。来源：Mona 系统配置。"),
            group_id: Some("WuAutoUpdateLevel".into()),
            min_version: None,
            max_version: None,
            operation_kind: "registry".into(),
            source_title: level.label().into(),
            disable_when_applied: false,
        }
    }).collect()
}

pub fn catalog_group() -> ConfigurationGroup {
    let active = current_level();
    ConfigurationGroup {
        id: "WuAutoUpdateLevel".into(),
        category: "Windows 更新".into(),
        label: "Windows 自动更新行为".into(),
        description: "控制 Windows 检查、下载和安装更新的方式".into(),
        values: LEVELS.iter().map(|&level| ConfigurationGroupValue {
            label: level.label().into(),
            feature_ids: vec![level.feature_id().into()],
        }).collect(),
        active_feature_id: Some(active.feature_id().into()),
    }
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

fn apply_level(level: WuLevel) -> Result<String, String> {
    let script = format!(
        r#"$ErrorActionPreference='Stop';
$au='HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU';
$wu='HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate';
$svc='HKLM:\SYSTEM\CurrentControlSet\Services\wuauserv';
if(-not (Test-Path $wu)){{ New-Item -Path $wu -Force | Out-Null }};
if(-not (Test-Path $au)){{ New-Item -Path $au -Force | Out-Null }};
Set-ItemProperty -Path $au -Name 'NoAutoUpdate' -Value {no_auto} -Type DWord -Force;
Set-ItemProperty -Path $au -Name 'AUOptions' -Value {au_opts} -Type DWord -Force;
Set-ItemProperty -Path $svc -Name 'Start' -Value {svc_start} -Type DWord -Force;
if({svc_start} -eq 4){{
  try{{ Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue }}catch{{}};
}} else {{
  try{{ Set-Service -Name wuauserv -StartupType Manual -ErrorAction SilentlyContinue }}catch{{}};
}};
'OK'"#,
        no_auto = level.no_auto_update(),
        au_opts = level.au_options(),
        svc_start = level.svc_start(),
    );
    run_elevated_powershell(&script, 60_000)?;
    Ok(format!("已切换 Windows 更新档位：{}", level.label()))
}

pub fn apply_windows_update(feature_id: &str) -> Result<(String, bool), String> {
    let level = LEVELS.iter().copied().find(|level| level.feature_id() == feature_id)
        .ok_or_else(|| format!("未知的 Windows 更新档位：{feature_id}"))?;
    let detail = apply_level(level)?;
    Ok((detail, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_three_levels_with_distinct_feature_ids() {
        let items = catalog_items();
        assert_eq!(items.len(), 3);
        let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
        assert!(ids.contains(&"WuAutoDefault"));
        assert!(ids.contains(&"WuNotifyOnly"));
        assert!(ids.contains(&"WuDisabled"));
    }

    #[test]
    fn all_items_require_administrator() {
        for item in catalog_items() {
            assert!(item.requires_administrator);
        }
    }

    #[test]
    fn disabled_level_is_high_risk() {
        let disabled = catalog_items().into_iter()
            .find(|item| item.id == "WuDisabled").unwrap();
        assert_eq!(disabled.risk, "high");
    }

    #[test]
    fn group_has_three_values_and_active_feature() {
        let group = catalog_group();
        assert_eq!(group.values.len(), 3);
        assert!(group.active_feature_id.is_some());
    }

    #[test]
    fn apply_rejects_unknown_feature() {
        assert!(apply_windows_update("Unknown").is_err());
    }
}
