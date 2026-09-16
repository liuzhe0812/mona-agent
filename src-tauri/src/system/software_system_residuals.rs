use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SystemResidualAction {
    Registry { hive: String, path: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemResidual {
    pub target: String,
    pub kind: String,
    pub category: String,
    pub confidence: String,
    pub recommended: bool,
    pub can_delete: bool,
    pub reason: String,
    pub action: Option<SystemResidualAction>,
}

#[derive(Debug, Clone)]
pub struct SoftwareIdentity {
    pub install_location: String,
    pub product_aliases: Vec<String>,
    pub vendor_alias: Option<String>,
    pub uninstall_registry_hive: Option<String>,
    pub uninstall_registry_path: Option<String>,
}

fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn matches_alias(value: &str, aliases: &[String]) -> bool {
    let value = normalized(value);
    aliases.iter().any(|alias| {
        let alias = normalized(alias);
        alias.chars().count() >= 4 && value.contains(&alias)
    })
}

fn matches_install_location(value: &str, install_location: &str) -> bool {
    if install_location.trim().is_empty() {
        return false;
    }
    let value = value.replace('/', "\\").to_ascii_lowercase();
    let install = install_location
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_ascii_lowercase();
    !install.is_empty() && value.contains(&install)
}

#[cfg(windows)]
fn registry_key_exists(hive: &str, path: &str) -> bool {
    let root = if hive == "HKCU" {
        windows_registry::CURRENT_USER
    } else {
        windows_registry::LOCAL_MACHINE
    };
    root.open(path).is_ok()
}

#[cfg(windows)]
fn scan_registry(identity: &SoftwareIdentity) -> Vec<SystemResidual> {
    let mut results = Vec::new();
    let mut paths = Vec::new();
    for product in &identity.product_aliases {
        paths.push(format!("Software\\{product}"));
        if let Some(vendor) = identity.vendor_alias.as_deref() {
            paths.push(format!("Software\\{vendor}\\{product}"));
        }
    }
    paths.sort_by_key(|path| path.to_ascii_lowercase());
    paths.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    for hive in ["HKCU", "HKLM"] {
        for path in &paths {
            if registry_key_exists(hive, path) {
                results.push(SystemResidual {
                    target: format!("{hive}\\{path}"),
                    kind: "registry".to_string(),
                    category: "注册表".to_string(),
                    confidence: "medium".to_string(),
                    recommended: false,
                    can_delete: true,
                    reason: "注册表键与软件身份对应，可能包含需要保留的设置".to_string(),
                    action: Some(SystemResidualAction::Registry {
                        hive: hive.to_string(),
                        path: path.clone(),
                    }),
                });
            }
        }
    }
    if let (Some(hive), Some(path)) = (
        identity.uninstall_registry_hive.as_deref(),
        identity.uninstall_registry_path.as_deref(),
    ) {
        if registry_key_exists(hive, path) {
            results.push(SystemResidual {
                target: format!("{hive}\\{path}"),
                kind: "registry".to_string(),
                category: "卸载记录".to_string(),
                confidence: "medium".to_string(),
                recommended: false,
                can_delete: false,
                reason: "卸载记录仍存在，可能表示主体未完全卸载，应先重新验证".to_string(),
                action: None,
            });
        }
    }
    results
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ServiceRow {
    name: String,
    display_name: Option<String>,
    path_name: Option<String>,
    service_type: Option<String>,
    #[serde(default)]
    is_driver: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TaskRow {
    task_name: String,
    task_path: Option<String>,
    execute: Option<String>,
    arguments: Option<String>,
}

#[cfg(windows)]
fn powershell_json(script: &str) -> Option<serde_json::Value> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_str(&super::decode_windows_output(&output.stdout)).ok()
}

fn value_rows(value: serde_json::Value) -> Vec<serde_json::Value> {
    match value {
        serde_json::Value::Array(rows) => rows,
        serde_json::Value::Object(_) => vec![value],
        _ => Vec::new(),
    }
}

#[cfg(windows)]
fn scan_services(identity: &SoftwareIdentity) -> Vec<SystemResidual> {
    let script = "$rows=@(); $rows += Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Select-Object Name,DisplayName,PathName,ServiceType,@{Name='IsDriver';Expression={$false}}; $rows += Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue | Select-Object Name,DisplayName,PathName,ServiceType,@{Name='IsDriver';Expression={$true}}; $rows | ConvertTo-Json -Compress";
    let Some(value) = powershell_json(script) else { return Vec::new() };
    value_rows(value)
        .into_iter()
        .filter_map(|value| serde_json::from_value::<ServiceRow>(value).ok())
        .filter_map(|service| {
            let path = service.path_name.unwrap_or_default();
            let display_name = service.display_name.unwrap_or_else(|| service.name.clone());
            let path_match = matches_install_location(&path, &identity.install_location);
            let alias_match = matches_alias(
                &format!("{} {} {}", service.name, display_name, path),
                &identity.product_aliases,
            );
            if !path_match && !alias_match {
                return None;
            }
            let is_driver = service.is_driver
                || service.service_type.unwrap_or_default().to_ascii_lowercase().contains("driver");
            Some(SystemResidual {
                target: display_name,
                kind: if is_driver { "driver" } else { "service" }.to_string(),
                category: if is_driver { "驱动" } else { "系统服务" }.to_string(),
                confidence: if path_match { "high" } else { "medium" }.to_string(),
                recommended: false,
                can_delete: false,
                reason: if path_match {
                    "服务程序位于原安装目录".to_string()
                } else {
                    "服务名称与软件名称匹配，需要人工确认".to_string()
                },
                action: None,
            })
        })
        .collect()
}

#[cfg(windows)]
fn scan_tasks(identity: &SoftwareIdentity) -> Vec<SystemResidual> {
    let script = "Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { $task=$_; $_.Actions | ForEach-Object { [PSCustomObject]@{TaskName=$task.TaskName;TaskPath=$task.TaskPath;Execute=$_.Execute;Arguments=$_.Arguments} } } | ConvertTo-Json -Compress";
    let Some(value) = powershell_json(script) else { return Vec::new() };
    value_rows(value)
        .into_iter()
        .filter_map(|value| serde_json::from_value::<TaskRow>(value).ok())
        .filter_map(|task| {
            let execute = task.execute.unwrap_or_default();
            let arguments = task.arguments.unwrap_or_default();
            let task_path = task.task_path.unwrap_or_else(|| "\\".to_string());
            let action = format!("{execute} {arguments}");
            let path_match = matches_install_location(&action, &identity.install_location);
            let alias_match = matches_alias(
                &format!("{} {} {}", task.task_name, task_path, action),
                &identity.product_aliases,
            );
            if !path_match && !alias_match {
                return None;
            }
            Some(SystemResidual {
                target: format!("{}{}", task_path, task.task_name),
                kind: "scheduled_task".to_string(),
                category: "计划任务".to_string(),
                confidence: if path_match { "high" } else { "medium" }.to_string(),
                recommended: false,
                can_delete: false,
                reason: if path_match {
                    "计划任务执行程序位于原安装目录".to_string()
                } else {
                    "计划任务名称与软件名称匹配，需要人工确认".to_string()
                },
                action: None,
            })
        })
        .collect()
}

#[cfg(windows)]
pub fn scan_system_residuals(identity: &SoftwareIdentity) -> Vec<SystemResidual> {
    let mut results = scan_registry(identity);
    results.extend(scan_services(identity));
    results.extend(scan_tasks(identity));
    results
}

#[cfg(not(windows))]
pub fn scan_system_residuals(_identity: &SoftwareIdentity) -> Vec<SystemResidual> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::{matches_alias, matches_install_location, value_rows};

    #[test]
    fn exact_install_path_is_stronger_than_a_display_name() {
        assert!(matches_install_location(
            r#""C:\Program Files\Vendor\Product\agent.exe" --service"#,
            r"C:\Program Files\Vendor\Product"
        ));
        assert!(!matches_install_location(
            r"C:\Program Files\Other\agent.exe",
            r"C:\Program Files\Vendor\Product"
        ));
    }

    #[test]
    fn ignores_aliases_that_are_too_short_for_system_artifacts() {
        assert!(!matches_alias("QQ update service", &["QQ".to_string()]));
        assert!(matches_alias(
            "Lenovo LeAppStore Update Service",
            &["LeAppStore".to_string()]
        ));
    }

    #[test]
    fn normalizes_single_json_objects_to_rows() {
        let value = serde_json::json!({"Name": "service"});
        assert_eq!(value_rows(value).len(), 1);
    }
}
