// UAC（用户账户控制）档位：默认安全桌面 / 无安全桌面 / 禁用。
// 通过 HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System 下的三个值控制：
//   EnableLUA、ConsentPromptBehaviorAdmin、PromptOnSecureDesktop。
// 接入 catalog 审计体系，作为"安全与防护"分组下的互斥档位 group 渲染。

use serde::Serialize;

use super::diagnostics::{ConfigurationAuditItem, ConfigurationGroup, ConfigurationGroupValue};

const UAC_KEY: &str = r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UacLevel {
    DefaultSecureDesktop,
    NoSecureDesktop,
    Disabled,
}

impl UacLevel {
    fn feature_id(self) -> &'static str {
        match self {
            UacLevel::DefaultSecureDesktop => "UacDefaultSecureDesktop",
            UacLevel::NoSecureDesktop => "UacNoSecureDesktop",
            UacLevel::Disabled => "UacDisabled",
        }
    }

    fn label(self) -> &'static str {
        match self {
            UacLevel::DefaultSecureDesktop => "启用 UAC + 安全桌面提示（默认，最安全）",
            UacLevel::NoSecureDesktop => "启用 UAC + 普通桌面提示（兼容性好）",
            UacLevel::Disabled => "禁用 UAC（不推荐）",
        }
    }

    fn risk(self) -> &'static str {
        match self {
            UacLevel::DefaultSecureDesktop => "low",
            UacLevel::NoSecureDesktop => "medium",
            UacLevel::Disabled => "high",
        }
    }

    fn description(self) -> &'static str {
        match self {
            UacLevel::DefaultSecureDesktop => "应用提权时切换到安全桌面（Crtl+Alt+Del 同级）显示同意提示，杜绝普通应用伪造提示窗口。",
            UacLevel::NoSecureDesktop => "保持 UAC 启用，但提权提示在普通桌面显示，切换更快但理论上可被恶意应用模拟。",
            UacLevel::Disabled => "完全关闭 UAC，所有管理员提权静默通过，恶意软件可无提示获取管理员权限。",
        }
    }

    fn enable_lua(self) -> u32 {
        match self {
            UacLevel::DefaultSecureDesktop | UacLevel::NoSecureDesktop => 1,
            UacLevel::Disabled => 0,
        }
    }

    fn consent_prompt_admin(self) -> u32 {
        match self {
            UacLevel::DefaultSecureDesktop | UacLevel::NoSecureDesktop => 5,
            UacLevel::Disabled => 0,
        }
    }

    fn prompt_on_secure_desktop(self) -> u32 {
        match self {
            UacLevel::DefaultSecureDesktop => 1,
            UacLevel::NoSecureDesktop | UacLevel::Disabled => 0,
        }
    }
}

const LEVELS: [UacLevel; 3] = [
    UacLevel::DefaultSecureDesktop,
    UacLevel::NoSecureDesktop,
    UacLevel::Disabled,
];

#[cfg(windows)]
fn read_uac_dword(name: &str) -> Option<u32> {
    use windows_registry::LOCAL_MACHINE;
    let key = LOCAL_MACHINE
        .open(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System")
        .ok()?;
    key.get_u32(name).ok()
}

#[cfg(not(windows))]
fn read_uac_dword(_name: &str) -> Option<u32> { None }

fn current_level() -> UacLevel {
    let enable_lua = read_uac_dword("EnableLUA").unwrap_or(1);
    let consent = read_uac_dword("ConsentPromptBehaviorAdmin").unwrap_or(5);
    let secure = read_uac_dword("PromptOnSecureDesktop").unwrap_or(1);
    for level in LEVELS {
        if level.enable_lua() == enable_lua
            && level.consent_prompt_admin() == consent
            && level.prompt_on_secure_desktop() == secure
        {
            return level;
        }
    }
    // 默认值缺失时按"默认安全桌面"处理
    UacLevel::DefaultSecureDesktop
}

fn current_detail(level: UacLevel) -> String {
    format!(
        "EnableLUA={}，ConsentPromptBehaviorAdmin={}，PromptOnSecureDesktop={}",
        level.enable_lua(),
        level.consent_prompt_admin(),
        level.prompt_on_secure_desktop()
    )
}

pub fn catalog_items() -> Vec<ConfigurationAuditItem> {
    let active = current_level();
    LEVELS.iter().map(|&level| {
        let is_active = level == active;
        ConfigurationAuditItem {
            id: level.feature_id().into(),
            category: "安全与防护".into(),
            title: level.label().into(),
            description: level.description().into(),
            current_value: current_detail(level),
            recommended_value: "应用此档位".into(),
            status: if is_active { "configured" } else { "available" }.into(),
            risk: level.risk().into(),
            impact: level.description().into(),
            reversible: true,
            requires_restart: true,
            requires_administrator: true,
            can_apply: true,
            can_restore: level != UacLevel::DefaultSecureDesktop,
            note: format!("注册表路径：{UAC_KEY}。需要重启后完全生效。来源：Mona 安全配置。"),
            group_id: Some("UacLevel".into()),
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
        id: "UacLevel".into(),
        category: "安全与防护".into(),
        label: "用户账户控制（UAC）提示级别".into(),
        description: "控制应用请求管理员权限时的提示方式".into(),
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

fn apply_level(level: UacLevel) -> Result<String, String> {
    let script = format!(
        r#"$ErrorActionPreference='Stop';
$path='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System';
if(-not (Test-Path $path)){{ New-Item -Path $path -Force | Out-Null }};
Set-ItemProperty -Path $path -Name 'EnableLUA' -Value {enable} -Type DWord -Force;
Set-ItemProperty -Path $path -Name 'ConsentPromptBehaviorAdmin' -Value {consent} -Type DWord -Force;
Set-ItemProperty -Path $path -Name 'PromptOnSecureDesktop' -Value {secure} -Type DWord -Force;
'OK'"#,
        enable = level.enable_lua(),
        consent = level.consent_prompt_admin(),
        secure = level.prompt_on_secure_desktop(),
    );
    run_elevated_powershell(&script, 60_000)?;
    Ok(format!("已切换 UAC 档位：{}（需重启后完全生效）", level.label()))
}

pub fn apply_uac(feature_id: &str) -> Result<(String, bool), String> {
    let level = LEVELS.iter().copied().find(|level| level.feature_id() == feature_id)
        .ok_or_else(|| format!("未知的 UAC 档位：{feature_id}"))?;
    let detail = apply_level(level)?;
    Ok((detail, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_three_levels_with_distinct_feature_ids() {
        let items = catalog_items();
        assert_eq!(items.len(), 3);
        let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
        assert!(ids.contains(&"UacDefaultSecureDesktop"));
        assert!(ids.contains(&"UacNoSecureDesktop"));
        assert!(ids.contains(&"UacDisabled"));
    }

    #[test]
    fn all_items_require_administrator_and_restart() {
        for item in catalog_items() {
            assert!(item.requires_administrator);
            assert!(item.requires_restart);
        }
    }

    #[test]
    fn disabled_level_is_high_risk() {
        let disabled = catalog_items().into_iter()
            .find(|item| item.id == "UacDisabled").unwrap();
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
        assert!(apply_uac("Unknown").is_err());
    }
}
