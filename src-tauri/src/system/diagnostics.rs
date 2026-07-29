use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use super::{performance, uac, win11debloat, windows_update, SystemState};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationAudit {
    pub items: Vec<ConfigurationAuditItem>,
    pub categories: Vec<ConfigurationCategory>,
    pub groups: Vec<ConfigurationGroup>,
    pub windows_build: u32,
    pub source_version: String,
    pub source_commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationCategory {
    pub id: String,
    pub label: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationGroup {
    pub id: String,
    pub category: String,
    pub label: String,
    pub description: String,
    pub values: Vec<ConfigurationGroupValue>,
    pub active_feature_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationGroupValue {
    pub label: String,
    pub feature_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationAuditItem {
    pub id: String,
    pub category: String,
    pub title: String,
    pub description: String,
    pub current_value: String,
    pub recommended_value: String,
    pub status: String,
    pub risk: String,
    pub impact: String,
    pub reversible: bool,
    pub requires_restart: bool,
    pub requires_administrator: bool,
    pub can_apply: bool,
    pub can_restore: bool,
    pub note: String,
    pub group_id: Option<String>,
    pub min_version: Option<u32>,
    pub max_version: Option<u32>,
    pub operation_kind: String,
    pub source_title: String,
    pub disable_when_applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigurationActionResult {
    pub item_id: String,
    pub success: bool,
    pub detail: String,
    pub requires_restart: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCheck {
    pub id: String,
    pub status: String,
    pub summary: String,
    pub detail: String,
}

fn configuration_catalog() -> Result<win11debloat::FeatureCatalog, String> {
    win11debloat::configuration_catalog()
}

fn configuration_audit() -> Result<ConfigurationAudit, String> {
    let catalog = configuration_catalog()?;
    let build = win11debloat::windows_build_number();
    let group_map = win11debloat::feature_group_map(&catalog);
    let items = catalog.features.iter().filter(|feature| feature.category.is_some()).map(|feature| {
        let category = win11debloat::category_label(feature.category.as_deref().unwrap_or("Other")).to_string();
        let compatible = win11debloat::feature_is_compatible(feature, build);
        let applied = compatible.then(|| win11debloat::feature_applied(feature)).flatten();
        let reversible = win11debloat::feature_can_restore(feature);
        let status = if !compatible { "unavailable" } else { match applied { Some(true) => "configured", Some(false) => "available", None => "unknown" } };
        let current_value = match status {
            "configured" => "当前设置已生效",
            "available" => "当前未应用此设置",
            "unavailable" => "当前 Windows 版本不适用",
            _ => "无法可靠判定当前状态",
        };
        let operation_kind = if feature.registry_key.is_some() { "registry" }
            else if matches!(feature.feature_id.as_str(), "EnableWindowsSandbox" | "EnableWindowsSubsystemForLinux") { "optionalFeature" }
            else { "action" };
        let version_note = match (feature.min_version, feature.max_version) {
            (Some(min), Some(max)) => format!("适用于 Windows build {min}–{max}"),
            (Some(min), None) => format!("需要 Windows build {min} 或更高版本"),
            (None, Some(max)) => format!("适用于 Windows build {max} 或更低版本"),
            _ => "适用于受支持的 Windows 10/11 版本".to_string(),
        };
        ConfigurationAuditItem {
            id: feature.feature_id.clone(),
            category,
            title: feature.label.clone(),
            description: if feature.tool_tip.is_empty() { feature.label.clone() } else { feature.tool_tip.clone() },
            current_value: current_value.into(),
            recommended_value: feature.apply_text.clone(),
            status: status.into(),
            risk: win11debloat::feature_risk(&feature.feature_id).into(),
            impact: if feature.tool_tip.is_empty() { feature.apply_text.clone() } else { feature.tool_tip.clone() },
            reversible,
            requires_restart: feature.requires_reboot,
            requires_administrator: win11debloat::feature_requires_administrator(feature),
            can_apply: compatible,
            can_restore: compatible && reversible,
            note: format!("{version_note}。来源：Win11Debloat 固定规则。"),
            group_id: group_map.get(&feature.feature_id).cloned(),
            min_version: feature.min_version,
            max_version: feature.max_version,
            operation_kind: operation_kind.into(),
            source_title: feature.label.clone(),
            disable_when_applied: feature.disable_when_applied,
        }
    }).collect::<Vec<_>>();
    let statuses = items.iter().map(|item| (item.id.as_str(), item.status.as_str())).collect::<std::collections::HashMap<_, _>>();
    let groups: Vec<ConfigurationGroup> = catalog.ui_groups.iter().map(|group| {
        let active_feature_id = group.values.iter().find(|value| {
            value.feature_ids.iter().all(|id| statuses.get(id.as_str()) == Some(&"configured"))
        }).and_then(|value| value.feature_ids.first()).cloned();
        ConfigurationGroup {
            id: group.group_id.clone(),
            category: win11debloat::category_label(&group.category).into(),
            label: group.label.clone(),
            description: group.tool_tip.clone(),
            values: group.values.iter().map(|value| ConfigurationGroupValue {
                label: value.label.clone(),
                feature_ids: value.feature_ids.clone(),
            }).collect(),
            active_feature_id,
        }
    }).collect();
    let categories: Vec<ConfigurationCategory> = catalog.categories.iter().map(|category| ConfigurationCategory {
        id: category.name.clone(),
        label: win11debloat::category_label(&category.name).into(),
        count: items.iter().filter(|item| item.category == win11debloat::category_label(&category.name)).count(),
    }).collect();
    let mut all_items = items;
    let performance_items = performance::catalog_items().into_iter().map(|item| ConfigurationAuditItem {
        id: item.id,
        category: "性能与响应".into(),
        title: item.label.clone(),
        description: item.description.clone(),
        current_value: item.current_detail.clone(),
        recommended_value: "应用推荐设置".into(),
        status: if item.is_applied { "configured" } else { "available" }.into(),
        risk: item.risk,
        impact: item.description.clone(),
        reversible: item.can_restore,
        requires_restart: item.requires_reboot,
        requires_administrator: item.requires_administrator,
        can_apply: true,
        can_restore: item.can_restore,
        note: "适用于受支持的 Windows 10/11 版本。来源：Mona 性能微调。".into(),
        group_id: None,
        min_version: None,
        max_version: None,
        operation_kind: "registry".into(),
        source_title: item.label,
        disable_when_applied: false,
    }).collect::<Vec<_>>();
    let performance_count = performance_items.len();
    all_items.extend(performance_items);
    let uac_items = uac::catalog_items();
    let uac_count = uac_items.len();
    all_items.extend(uac_items);
    let wu_items = windows_update::catalog_items();
    let wu_count = wu_items.len();
    all_items.extend(wu_items);
    let mut all_categories = categories;
    // 性能与响应：catalog 没有，新增分类
    all_categories.push(ConfigurationCategory {
        id: "Performance".into(),
        label: "性能与响应".into(),
        count: performance_count,
    });
    // 安全与防护：catalog 没有，新增分类
    all_categories.push(ConfigurationCategory {
        id: "Security".into(),
        label: "安全与防护".into(),
        count: uac_count,
    });
    // Windows 更新：catalog 已有该分类，累加计数
    if let Some(existing) = all_categories.iter_mut().find(|category| category.label == "Windows 更新") {
        existing.count += wu_count;
    } else {
        all_categories.push(ConfigurationCategory {
            id: "WindowsUpdate".into(),
            label: "Windows 更新".into(),
            count: wu_count,
        });
    }
    let mut all_groups = groups;
    all_groups.push(uac::catalog_group());
    all_groups.push(windows_update::catalog_group());
    Ok(ConfigurationAudit {
        items: all_items,
        categories: all_categories,
        groups: all_groups,
        windows_build: build,
        source_version: catalog.version,
        source_commit: win11debloat::UPSTREAM_COMMIT.into(),
    })
}

#[tauri::command]
pub async fn system_get_configuration_audit() -> Result<ConfigurationAudit, String> {
    configuration_audit()
}

fn is_supported_change(item_id: &str, mode: &str) -> bool {
    if matches!(item_id, "SvchostSplitDisable" | "DisableHPET" | "UnlockCpuCores") {
        return matches!(mode, "recommended" | "restore");
    }
    if matches!(item_id, "UacDefaultSecureDesktop" | "UacNoSecureDesktop" | "UacDisabled") {
        return matches!(mode, "recommended" | "restore");
    }
    if matches!(item_id, "WuAutoDefault" | "WuNotifyOnly" | "WuDisabled") {
        return matches!(mode, "recommended" | "restore");
    }
    configuration_catalog().is_ok_and(|catalog| win11debloat::is_supported_change(&catalog, item_id, mode))
}

fn now_ts() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

fn diagnostic_check(id: &str, status: &str, summary: impl Into<String>, detail: impl Into<String>) -> DiagnosticCheck {
    DiagnosticCheck {
        id: id.to_string(),
        status: status.to_string(),
        summary: summary.into(),
        detail: detail.into(),
    }
}

fn compact_output(value: &str) -> String {
    let mut compact = value.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(40)
        .collect::<Vec<_>>()
        .join("\n");
    if compact.chars().count() > 4_000 {
        compact = compact.chars().take(4_000).collect::<String>() + "\n…";
    }
    compact
}

#[cfg(windows)]
fn run_readonly_command(program: &str, args: &[&str]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("启动本机检查失败：{error}"))?;
    let stdout = super::decode_windows_output(&output.stdout);
    let stderr = super::decode_windows_output(&output.stderr);
    let combined = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if output.status.success() {
        Ok(compact_output(&combined))
    } else {
        Err(if combined.is_empty() {
            format!("本机检查返回退出码 {}", output.status.code().unwrap_or(-1))
        } else {
            compact_output(&combined)
        })
    }
}

#[cfg(not(windows))]
fn run_readonly_command(_program: &str, _args: &[&str]) -> Result<String, String> {
    Err("仅支持 Windows".into())
}

#[cfg(windows)]
fn machine_key_exists(path: &str) -> bool {
    use windows_registry::LOCAL_MACHINE;
    LOCAL_MACHINE.open(path).is_ok()
}

#[cfg(not(windows))]
fn machine_key_exists(_path: &str) -> bool { false }

#[cfg(windows)]
fn machine_value_exists(path: &str, name: &str) -> bool {
    use windows_registry::LOCAL_MACHINE;
    LOCAL_MACHINE.open(path).and_then(|key| key.get_value(name)).is_ok()
}

#[cfg(not(windows))]
fn machine_value_exists(_path: &str, _name: &str) -> bool { false }

#[tauri::command]
pub async fn system_check_pending_reboot() -> Result<DiagnosticCheck, String> {
    let component_reboot = machine_key_exists("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending");
    let update_reboot = machine_key_exists("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired");
    let rename_pending = machine_value_exists("SYSTEM\\CurrentControlSet\\Control\\Session Manager", "PendingFileRenameOperations");
    let sources = [
        (component_reboot, "组件服务"),
        (update_reboot, "Windows 更新"),
        (rename_pending, "待处理文件重命名"),
    ].into_iter().filter_map(|(active, label)| active.then_some(label)).collect::<Vec<_>>();
    Ok(if sources.is_empty() {
        diagnostic_check("pending_reboot", "clear", "未检测到待重启标记", "已检查 Windows 更新、组件服务和待处理文件重命名标记。")
    } else {
        diagnostic_check("pending_reboot", "attention", "检测到待重启状态", format!("来源：{}。保存工作并重启后再复查相关问题。", sources.join("、")))
    })
}

#[tauri::command]
pub async fn system_check_component_health() -> Result<DiagnosticCheck, String> {
    let result = tokio::task::spawn_blocking(|| run_readonly_command("DISM.exe", &["/Online", "/Cleanup-Image", "/CheckHealth"]))
        .await.map_err(|error| format!("组件存储检查中断：{error}"));
    Ok(match result {
        Ok(Ok(detail)) => diagnostic_check("component_health", "collected", "组件存储检查已完成", detail),
        Ok(Err(error)) => diagnostic_check("component_health", "unavailable", "无法完成组件存储检查", error),
        Err(error) => diagnostic_check("component_health", "unavailable", "无法完成组件存储检查", error),
    })
}

#[tauri::command]
pub async fn system_check_driver_issues() -> Result<DiagnosticCheck, String> {
    let result = tokio::task::spawn_blocking(|| run_readonly_command(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", "@(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object { $_.Status -ne 'OK' }).Count"],
    )).await.map_err(|error| format!("设备检查中断：{error}"));
    Ok(match result {
        Ok(Ok(detail)) => match detail.trim().parse::<usize>() {
            Ok(0) => diagnostic_check("driver_issues", "clear", "未发现报告异常的即插即用设备", "Get-PnpDevice 返回 0 个 Status 非 OK 的在用设备。"),
            Ok(count) => diagnostic_check("driver_issues", "attention", format!("发现 {count} 个报告异常的设备"), "请在设备管理器中确认设备名称和错误码；Mona 不会自动更新或卸载驱动。"),
            Err(_) => diagnostic_check("driver_issues", "collected", "设备状态已读取", detail),
        },
        Ok(Err(error)) => diagnostic_check("driver_issues", "unavailable", "无法读取设备状态", error),
        Err(error) => diagnostic_check("driver_issues", "unavailable", "无法读取设备状态", error),
    })
}

#[tauri::command]
pub async fn system_check_power_events() -> Result<DiagnosticCheck, String> {
    let result = tokio::task::spawn_blocking(|| {
        let last_wake = run_readonly_command("powercfg", &["/lastwake"])?;
        let wake_timers = run_readonly_command("powercfg", &["/waketimers"])?;
        Ok::<String, String>(format!("最近唤醒来源：\n{last_wake}\n\n唤醒计时器：\n{wake_timers}"))
    }).await.map_err(|error| format!("电源检查中断：{error}"));
    Ok(match result {
        Ok(Ok(detail)) => diagnostic_check("power_events", "collected", "已收集最近唤醒来源与唤醒计时器", compact_output(&detail)),
        Ok(Err(error)) => diagnostic_check("power_events", "unavailable", "无法读取电源事件", error),
        Err(error) => diagnostic_check("power_events", "unavailable", "无法读取电源事件", error),
    })
}

#[tauri::command]
pub async fn system_check_network_configuration() -> Result<DiagnosticCheck, String> {
    let result = tokio::task::spawn_blocking(|| run_readonly_command(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", "$p=Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop; if ($p.ProxyEnable -eq 1) { 'enabled' } else { 'disabled' }; if ($p.ProxyServer) { 'server-configured' } else { 'server-not-configured' }"],
    )).await.map_err(|error| format!("网络配置检查中断：{error}"));
    Ok(match result {
        Ok(Ok(detail)) => {
            let lines = detail.lines().collect::<Vec<_>>();
            let proxy_enabled = lines.first().is_some_and(|line| *line == "enabled");
            let summary = if proxy_enabled { "检测到当前用户启用代理" } else { "当前用户未启用代理" };
            diagnostic_check("network_configuration", "collected", summary, format!("用户代理状态：{}。", detail.replace('\n', "；")))
        }
        Ok(Err(error)) => diagnostic_check("network_configuration", "unavailable", "无法读取网络代理配置", error),
        Err(error) => diagnostic_check("network_configuration", "unavailable", "无法读取网络代理配置", error),
    })
}

#[tauri::command]
pub async fn system_check_recovery_status() -> Result<DiagnosticCheck, String> {
    let result = tokio::task::spawn_blocking(|| {
        let recovery = run_readonly_command("reagentc.exe", &["/info"])?;
        let bitlocker = run_readonly_command("manage-bde.exe", &["-status", "C:"])?;
        Ok::<String, String>(format!("Windows 恢复环境：\n{recovery}\n\nBitLocker 状态：\n{bitlocker}"))
    }).await.map_err(|error| format!("恢复状态检查中断：{error}"));
    Ok(match result {
        Ok(Ok(detail)) => diagnostic_check("recovery_status", "collected", "已收集 Windows 恢复与磁盘保护状态", compact_output(&detail)),
        Ok(Err(error)) => diagnostic_check("recovery_status", "unavailable", "无法读取恢复或磁盘保护状态", error),
        Err(error) => diagnostic_check("recovery_status", "unavailable", "无法读取恢复或磁盘保护状态", error),
    })
}

fn record_configuration_operation(
    state: &State<'_, SystemState>,
    item_id: &str,
    mode: &str,
    success: bool,
    detail: &str,
) -> Result<(), String> {
    let inner = state.0.lock().map_err(|error| format!("State lock: {error}"))?;
    inner.db.execute_batch(
        "CREATE TABLE IF NOT EXISTS configuration_operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            mode TEXT NOT NULL,
            success INTEGER NOT NULL,
            detail TEXT NOT NULL
        );",
    ).map_err(|error| format!("初始化配置记录失败：{error}"))?;
    inner.db.execute(
        "INSERT INTO configuration_operations (ts, item_id, mode, success, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![now_ts(), item_id, mode, success, detail],
    ).map_err(|error| format!("保存配置记录失败：{error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn system_apply_configuration_item(
    state: State<'_, SystemState>,
    item_id: String,
    mode: String,
) -> Result<ConfigurationActionResult, String> {
    if !is_supported_change(&item_id, &mode) {
        return Err("不支持的系统优化操作".into());
    }

    if matches!(item_id.as_str(), "SvchostSplitDisable" | "DisableHPET" | "UnlockCpuCores") {
        let item_id_for_task = item_id.clone();
        let mode_for_task = mode.clone();
        let result = tokio::task::spawn_blocking(move || performance::apply_performance(&item_id_for_task, &mode_for_task))
            .await.map_err(|error| format!("系统优化任务中断：{error}"))?;
        return match result {
            Ok((detail, requires_restart)) => {
                record_configuration_operation(&state, &item_id, &mode, true, &detail)?;
                Ok(ConfigurationActionResult { item_id, success: true, detail, requires_restart })
            }
            Err(error) => {
                let _ = record_configuration_operation(&state, &item_id, &mode, false, &error);
                Err(error)
            }
        };
    }

    if matches!(item_id.as_str(), "UacDefaultSecureDesktop" | "UacNoSecureDesktop" | "UacDisabled") {
        let item_id_for_task = item_id.clone();
        let result = tokio::task::spawn_blocking(move || uac::apply_uac(&item_id_for_task))
            .await.map_err(|error| format!("系统优化任务中断：{error}"))?;
        return match result {
            Ok((detail, requires_restart)) => {
                record_configuration_operation(&state, &item_id, &mode, true, &detail)?;
                Ok(ConfigurationActionResult { item_id, success: true, detail, requires_restart })
            }
            Err(error) => {
                let _ = record_configuration_operation(&state, &item_id, &mode, false, &error);
                Err(error)
            }
        };
    }

    if matches!(item_id.as_str(), "WuAutoDefault" | "WuNotifyOnly" | "WuDisabled") {
        let item_id_for_task = item_id.clone();
        let result = tokio::task::spawn_blocking(move || windows_update::apply_windows_update(&item_id_for_task))
            .await.map_err(|error| format!("系统优化任务中断：{error}"))?;
        return match result {
            Ok((detail, requires_restart)) => {
                record_configuration_operation(&state, &item_id, &mode, true, &detail)?;
                Ok(ConfigurationActionResult { item_id, success: true, detail, requires_restart })
            }
            Err(error) => {
                let _ = record_configuration_operation(&state, &item_id, &mode, false, &error);
                Err(error)
            }
        };
    }

    let catalog = configuration_catalog()?;
    let feature = catalog.features.into_iter().find(|feature| feature.feature_id == item_id)
        .ok_or_else(|| "系统优化项目不存在".to_string())?;
    let requires_restart = feature.requires_reboot;
    let feature_for_task = feature.clone();
    let mode_for_task = mode.clone();
    let result = tokio::task::spawn_blocking(move || win11debloat::apply_feature(&feature_for_task, &mode_for_task))
        .await.map_err(|error| format!("系统优化任务中断：{error}"))?;

    match result {
        Ok(detail) => {
            record_configuration_operation(&state, &item_id, &mode, true, &detail)?;
            Ok(ConfigurationActionResult { item_id, success: true, detail, requires_restart })
        }
        Err(error) => {
            let _ = record_configuration_operation(&state, &item_id, &mode, false, &error);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{configuration_catalog, is_supported_change};

    #[test]
    fn exposes_the_complete_pinned_win11debloat_catalog() {
        let catalog = configuration_catalog().expect("catalog should parse");
        assert_eq!(catalog.categories.len(), 12);
        assert_eq!(catalog.ui_groups.len(), 9);
        assert_eq!(catalog.features.iter().filter(|item| item.category.is_some()).count(), 93);
        let mut ids = catalog.features.iter().map(|item| item.feature_id.as_str()).collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), catalog.features.len());
    }

    #[test]
    fn only_allows_known_configuration_items_and_modes() {
        assert!(is_supported_change("DisableTelemetry", "recommended"));
        assert!(is_supported_change("DisableFastStartup", "restore"));
        assert!(!is_supported_change("DisableWidgets", "restore"));
        assert!(!is_supported_change("DisableTelemetry", "disable"));
        assert!(!is_supported_change("arbitrary_registry_path", "recommended"));
    }
}
