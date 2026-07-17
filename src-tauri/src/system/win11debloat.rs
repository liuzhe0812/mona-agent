use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub const UPSTREAM_COMMIT: &str = "de817399e65005b573e1868d4b519a3a9495a233";

const FEATURES_JSON: &str = include_str!("win11debloat/Features.json");
const APPS_JSON: &str = include_str!("win11debloat/Apps.json");
const REGISTRY_FILES_JSON: &str = include_str!("win11debloat/RegistryFiles.json");
const BLANK_START_MENU_BASE64: &str = include_str!("win11debloat/BlankStartMenu.txt");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct FeatureCatalog {
    pub version: String,
    pub categories: Vec<FeatureCategory>,
    pub ui_groups: Vec<FeatureGroup>,
    pub features: Vec<Feature>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct FeatureCategory {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct FeatureGroup {
    pub group_id: String,
    pub label: String,
    #[serde(default)]
    pub tool_tip: String,
    pub category: String,
    #[serde(default)]
    pub values: Vec<FeatureGroupValue>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct FeatureGroupValue {
    pub label: String,
    #[serde(default)]
    pub feature_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Feature {
    pub feature_id: String,
    pub label: String,
    #[serde(default)]
    pub tool_tip: String,
    pub category: Option<String>,
    pub registry_key: Option<String>,
    pub apply_text: String,
    pub undo_label: Option<String>,
    pub apply_undo_text: Option<String>,
    pub registry_undo_key: Option<String>,
    pub min_version: Option<u32>,
    pub max_version: Option<u32>,
    #[serde(default)]
    pub requires_reboot: bool,
    #[serde(default)]
    pub disable_when_applied: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct AppCatalog {
    pub version: String,
    pub presets: Vec<AppPreset>,
    pub apps: Vec<AppRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct AppPreset {
    pub name: String,
    pub app_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct AppRule {
    pub friendly_name: String,
    #[serde(deserialize_with = "deserialize_app_ids")]
    pub app_id: Vec<String>,
    pub description: String,
    pub selected_by_default: bool,
    pub recommendation: String,
    pub removal_method: String,
}

fn deserialize_app_ids<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany { One(String), Many(Vec<String>) }
    Ok(match OneOrMany::deserialize(deserializer)? {
        OneOrMany::One(value) => vec![value],
        OneOrMany::Many(values) => values,
    })
}

pub fn configuration_catalog() -> Result<FeatureCatalog, String> {
    serde_json::from_str(FEATURES_JSON).map_err(|error| format!("解析 Windows 设置目录失败：{error}"))
}

pub fn windows_app_catalog() -> Result<AppCatalog, String> {
    serde_json::from_str(APPS_JSON).map_err(|error| format!("解析 Windows 应用目录失败：{error}"))
}

fn registry_files() -> Result<HashMap<String, String>, String> {
    serde_json::from_str(REGISTRY_FILES_JSON).map_err(|error| format!("解析注册表规则失败：{error}"))
}

pub fn category_label(category: &str) -> &'static str {
    match category {
        "Privacy & Suggested Content" => "隐私与建议内容",
        "System" => "系统",
        "Start Menu & Search" => "开始菜单与搜索",
        "AI" => "AI 功能",
        "Windows Update" => "Windows 更新",
        "Taskbar" => "任务栏",
        "Appearance" => "外观",
        "File Explorer" => "文件资源管理器",
        "Gaming" => "游戏",
        "Multi-tasking" => "多任务",
        "Optional Windows Features" => "可选 Windows 功能",
        _ => "其他",
    }
}

pub fn feature_risk(feature_id: &str) -> &'static str {
    match feature_id {
        "ClearStart" | "ClearStartAllUsers" | "DisableWidgets"
        | "DisableBitlockerAutoEncryption" | "DisableStoreSearchSuggestions"
        | "EnableWindowsSandbox" | "EnableWindowsSubsystemForLinux" => "high",
        "DisableTelemetry" | "DisableNotifications" | "DisableLocationServices"
        | "DisableFindMyDevice" | "DisableCopilot" | "DisableRecall"
        | "DisableClickToDo" | "DisableAISvcAutoStart" | "DisableStartAllApps"
        | "DisableSettingsHome" | "DisableFastStartup" | "DisableModernStandbyNetworking"
        | "DisableUpdateASAP" | "PreventUpdateAutoReboot" | "DisableDeliveryOptimization"
        | "RevertContextMenu" => "medium",
        _ => "low",
    }
}

pub fn feature_group_map(catalog: &FeatureCatalog) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for group in &catalog.ui_groups {
        for value in &group.values {
            for id in &value.feature_ids {
                result.insert(id.clone(), group.group_id.clone());
            }
        }
    }
    result
}

pub fn windows_build_number() -> u32 {
    #[cfg(windows)]
    {
        use windows_registry::LOCAL_MACHINE;
        return LOCAL_MACHINE
            .open("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
            .ok()
            .and_then(|key| key.get_string("CurrentBuildNumber").ok())
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
    }
    #[cfg(not(windows))]
    { 0 }
}

pub fn feature_is_compatible(feature: &Feature, build: u32) -> bool {
    if build == 0 { return cfg!(windows); }
    feature.min_version.is_none_or(|minimum| build >= minimum)
        && feature.max_version.is_none_or(|maximum| build <= maximum)
}

fn registry_content(file_name: &str, undo: bool) -> Result<String, String> {
    let files = registry_files()?;
    let find = |name: &str| files.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, content)| content.clone());
    if undo {
        let undo_path = format!("Undo/{file_name}");
        if let Some(content) = find(&undo_path) { return Ok(content); }
    }
    find(file_name).ok_or_else(|| format!("内置注册表规则不存在：{file_name}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RegOperation {
    DeleteKey { key: String },
    DeleteValue { key: String, name: String },
    SetValue { key: String, name: String, kind: RegKind, data: Vec<u8> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegKind { Dword, Qword, String, ExpandString, MultiString, Binary }

fn unescape_reg_string(value: &str) -> String {
    let mut result = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() { result.push(next); }
        } else { result.push(ch); }
    }
    result
}

fn utf16_bytes(value: &str, final_nulls: usize) -> Vec<u8> {
    value.encode_utf16().chain(std::iter::repeat_n(0, final_nulls))
        .flat_map(u16::to_le_bytes).collect()
}

fn parse_hex_bytes(value: &str) -> Option<Vec<u8>> {
    value.split(',').filter(|part| !part.trim().is_empty())
        .map(|part| u8::from_str_radix(part.trim(), 16).ok()).collect()
}

fn logical_reg_lines(content: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut pending = String::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with("Windows Registry") { continue; }
        pending.push_str(line.trim_end_matches('\\'));
        if line.ends_with('\\') { continue; }
        lines.push(std::mem::take(&mut pending));
    }
    if !pending.is_empty() { lines.push(pending); }
    lines
}

fn parse_reg_operations(content: &str) -> Vec<RegOperation> {
    let mut result = Vec::new();
    let mut current_key = String::new();
    for line in logical_reg_lines(content) {
        if line.starts_with('[') && line.ends_with(']') {
            let key = &line[1..line.len() - 1];
            if let Some(deleted) = key.strip_prefix('-') {
                result.push(RegOperation::DeleteKey { key: deleted.to_string() });
                current_key.clear();
            } else { current_key = key.to_string(); }
            continue;
        }
        if current_key.is_empty() { continue; }
        let Some((raw_name, raw_data)) = line.split_once('=') else { continue };
        let name = if raw_name == "@" { String::new() }
            else { unescape_reg_string(raw_name.trim_matches('"')) };
        if raw_data == "-" {
            result.push(RegOperation::DeleteValue { key: current_key.clone(), name });
            continue;
        }
        let parsed = if let Some(value) = raw_data.strip_prefix("dword:") {
            u32::from_str_radix(value, 16).ok().map(|number| (RegKind::Dword, number.to_le_bytes().to_vec()))
        } else if raw_data.starts_with('"') && raw_data.ends_with('"') {
            Some((RegKind::String, utf16_bytes(&unescape_reg_string(raw_data.trim_matches('"')), 1)))
        } else if let Some(value) = raw_data.strip_prefix("hex(b):") {
            parse_hex_bytes(value).map(|bytes| (RegKind::Qword, bytes))
        } else if let Some(value) = raw_data.strip_prefix("hex(2):") {
            parse_hex_bytes(value).map(|bytes| (RegKind::ExpandString, bytes))
        } else if let Some(value) = raw_data.strip_prefix("hex(7):") {
            parse_hex_bytes(value).map(|bytes| (RegKind::MultiString, bytes))
        } else if let Some(value) = raw_data.strip_prefix("hex:") {
            parse_hex_bytes(value).map(|bytes| (RegKind::Binary, bytes))
        } else { None };
        if let Some((kind, data)) = parsed {
            result.push(RegOperation::SetValue { key: current_key.clone(), name, kind, data });
        }
    }
    result
}

#[cfg(windows)]
fn split_registry_path(path: &str) -> Option<(&windows_registry::Key, &str)> {
    use windows_registry::{CLASSES_ROOT, CURRENT_USER, LOCAL_MACHINE, USERS};
    let (hive, subkey) = path.split_once('\\')?;
    let root = match hive {
        "HKEY_CLASSES_ROOT" => CLASSES_ROOT,
        "HKEY_CURRENT_USER" => CURRENT_USER,
        "HKEY_LOCAL_MACHINE" => LOCAL_MACHINE,
        "HKEY_USERS" => USERS,
        _ => return None,
    };
    Some((root, subkey))
}

#[cfg(windows)]
fn registry_operation_matches(operation: &RegOperation) -> bool {
    use windows_registry::Type;
    let (path, name) = match operation {
        RegOperation::DeleteKey { key } => {
            let Some((root, subkey)) = split_registry_path(key) else { return false };
            return root.open(subkey).is_err();
        }
        RegOperation::DeleteValue { key, name } | RegOperation::SetValue { key, name, .. } => (key, name),
    };
    let Some((root, subkey)) = split_registry_path(path) else { return false };
    let Ok(key) = root.open(subkey) else {
        return matches!(operation, RegOperation::DeleteValue { .. });
    };
    match operation {
        RegOperation::DeleteValue { .. } => key.get_value(name).is_err(),
        RegOperation::SetValue { kind, data, .. } => key.get_value(name).is_ok_and(|actual| {
            let expected_type = match kind {
                RegKind::Dword => Type::U32,
                RegKind::Qword => Type::U64,
                RegKind::String => Type::String,
                RegKind::ExpandString => Type::ExpandString,
                RegKind::MultiString => Type::MultiString,
                RegKind::Binary => Type::Bytes,
            };
            actual.ty() == expected_type && actual.as_ref() == data.as_slice()
        }),
        RegOperation::DeleteKey { .. } => false,
    }
}

#[cfg(not(windows))]
fn registry_operation_matches(_operation: &RegOperation) -> bool { false }

pub fn feature_applied(feature: &Feature) -> Option<bool> {
    let file = feature.registry_key.as_deref()?;
    let content = registry_content(file, false).ok()?;
    let operations = parse_reg_operations(&content);
    if operations.is_empty() { return None; }
    Some(operations.iter().all(registry_operation_matches))
}

pub fn feature_requires_administrator(feature: &Feature) -> bool {
    if matches!(feature.feature_id.as_str(), "ClearStartAllUsers" | "DisableWidgets" | "EnableWindowsSandbox" | "EnableWindowsSubsystemForLinux") {
        return true;
    }
    let Some(file) = feature.registry_key.as_deref() else { return false };
    registry_content(file, false).is_ok_and(|content| registry_requires_administrator(&content))
}

fn registry_requires_administrator(content: &str) -> bool {
    content.contains("HKEY_LOCAL_MACHINE") || content.contains("HKEY_USERS") || content.contains("HKEY_CLASSES_ROOT")
}

pub fn feature_can_restore(feature: &Feature) -> bool {
    feature.registry_undo_key.is_some()
        || matches!(feature.feature_id.as_str(), "ClearStart" | "ClearStartAllUsers" | "DisableStoreSearchSuggestions" | "EnableWindowsSandbox" | "EnableWindowsSubsystemForLinux")
}

fn temp_reg_path(feature_id: &str, mode: &str) -> PathBuf {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    std::env::temp_dir().join(format!("mona-{feature_id}-{mode}-{nonce}.reg"))
}

fn write_utf16_reg(path: &Path, content: &str) -> Result<(), String> {
    let mut bytes = vec![0xff, 0xfe];
    bytes.extend(content.encode_utf16().flat_map(u16::to_le_bytes));
    fs::write(path, bytes).map_err(|error| format!("准备注册表变更失败：{error}"))
}

#[cfg(windows)]
fn run_hidden(program: &str, args: &[&str]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let output = Command::new(program).args(args).creation_flags(CREATE_NO_WINDOW).output()
        .map_err(|error| format!("启动 Windows 工具失败：{error}"))?;
    let text = super::decode_windows_output(&output.stdout).trim().to_string();
    let error = super::decode_windows_output(&output.stderr).trim().to_string();
    if output.status.success() { Ok(if text.is_empty() { "操作已完成".into() } else { text }) }
    else { Err(if !error.is_empty() { error } else if !text.is_empty() { text } else { format!("Windows 工具返回错误码 {}", output.status.code().unwrap_or(-1)) }) }
}

#[cfg(not(windows))]
fn run_hidden(_program: &str, _args: &[&str]) -> Result<String, String> { Err("系统优化仅支持 Windows".into()) }

fn powershell_parameters(script: &str) -> String {
    use base64::Engine;
    let bytes = script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
    format!("-NoProfile -NonInteractive -EncodedCommand {}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(windows)]
fn run_elevated_powershell(script: &str, timeout_ms: u32) -> Result<String, String> {
    super::run_elevated("powershell.exe", &powershell_parameters(script), timeout_ms)?;
    Ok("操作已完成".into())
}

#[cfg(not(windows))]
fn run_elevated_powershell(_script: &str, _timeout_ms: u32) -> Result<String, String> { Err("系统优化仅支持 Windows".into()) }

fn telemetry_task_script(reg_path: &Path, mode: &str) -> String {
    let action = if mode == "restore" { "/Enable" } else { "/Disable" };
    let tasks = [
        "\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser",
        "\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser Exp",
        "\\Microsoft\\Windows\\Application Experience\\ProgramDataUpdater",
        "\\Microsoft\\Windows\\Application Experience\\StartupAppTask",
        "\\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator",
        "\\Microsoft\\Windows\\Customer Experience Improvement Program\\UsbCeip",
        "\\Microsoft\\Windows\\DiskDiagnostic\\Microsoft-Windows-DiskDiagnosticDataCollector",
        "\\Microsoft\\Windows\\Autochk\\Proxy",
    ].into_iter().map(|task| format!("'{}'", task.replace('\'', "''"))).collect::<Vec<_>>().join(",");
    let path = reg_path.to_string_lossy().replace('\'', "''");
    format!("& reg.exe import '{path}'; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}; $tasks=@({tasks}); foreach($task in $tasks) {{ & schtasks.exe /Query /TN $task 2>$null | Out-Null; if($LASTEXITCODE -eq 0) {{ & schtasks.exe /Change /TN $task {action} | Out-Null; if($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }} }} }}")
}

fn import_registry(feature: &Feature, mode: &str) -> Result<String, String> {
    let file = if mode == "restore" {
        feature.registry_undo_key.as_deref().ok_or("此配置没有自动恢复规则")?
    } else {
        feature.registry_key.as_deref().ok_or("此配置不是注册表项目")?
    };
    let content = registry_content(file, mode == "restore")?;
    let path = temp_reg_path(&feature.feature_id, mode);
    write_utf16_reg(&path, &content)?;
    let result = if feature.feature_id == "DisableTelemetry" {
        run_elevated_powershell(&telemetry_task_script(&path, mode), 600_000)
    } else if registry_requires_administrator(&content) {
        #[cfg(windows)]
        { super::run_elevated("reg.exe", &format!("import \"{}\"", path.to_string_lossy()), 120_000).map(|_| "操作已完成".into()) }
        #[cfg(not(windows))]
        { Err("系统优化仅支持 Windows".into()) }
    } else {
        run_hidden("reg.exe", &["import", path.to_string_lossy().as_ref()])
    };
    let _ = fs::remove_file(path);
    result
}

fn optional_feature(feature_id: &str, mode: &str) -> Result<String, String> {
    let action = if mode == "restore" { "/Disable-Feature" } else { "/Enable-Feature" };
    let mut names = match feature_id {
        "EnableWindowsSandbox" => vec!["Containers-DisposableClientVM"],
        "EnableWindowsSubsystemForLinux" => vec!["VirtualMachinePlatform", "Microsoft-Windows-Subsystem-Linux"],
        _ => return Err("未知的 Windows 可选功能".into()),
    };
    if mode == "restore" { names.reverse(); }
    let commands = names.into_iter().map(|name| format!("& dism.exe /Online {action} /FeatureName:{name} /NoRestart /English; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }}")).collect::<Vec<_>>().join("; ");
    run_elevated_powershell(&commands, 600_000)?;
    Ok("Windows 可选功能变更已完成".into())
}

fn start_menu_path_for(profile: &Path) -> PathBuf {
    profile.join("AppData/Local/Packages/Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy/LocalState/start2.bin")
}

fn clear_start_menu_file(path: &Path) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(BLANK_START_MENU_BASE64.trim())
        .map_err(|error| format!("读取开始菜单模板失败：{error}"))?;
    let parent = path.parent().ok_or("开始菜单路径无效")?;
    fs::create_dir_all(parent).map_err(|error| format!("创建开始菜单目录失败：{error}"))?;
    if path.exists() {
        let backup = parent.join(format!("Mona-StartBackup-{}.bak", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()));
        fs::copy(path, backup).map_err(|error| format!("备份开始菜单失败：{error}"))?;
    }
    fs::write(path, bytes).map_err(|error| format!("更新开始菜单失败：{error}"))
}

fn latest_start_backup(path: &Path) -> Option<PathBuf> {
    let parent = path.parent()?;
    fs::read_dir(parent).ok()?.flatten().map(|entry| entry.path())
        .filter(|file| file.file_name().is_some_and(|name| name.to_string_lossy().starts_with("Mona-StartBackup-")))
        .max()
}

fn restore_start_menu_file(path: &Path) -> Result<(), String> {
    let backup = latest_start_backup(path).ok_or("没有找到 Mona 创建的开始菜单备份")?;
    fs::copy(backup, path).map(|_| ()).map_err(|error| format!("恢复开始菜单失败：{error}"))
}

fn current_profile() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE").map(PathBuf::from).ok_or("无法确定当前用户目录".into())
}

fn all_users_start_menu_script(restore: bool) -> String {
    let action = if restore {
        r#"$backup=Get-ChildItem -LiteralPath $directory -Filter 'Mona-StartBackup-*.bak' -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1;if($backup){Copy-Item -LiteralPath $backup.FullName -Destination $target -Force -ErrorAction Stop;$changed++}"#.to_string()
    } else {
        r#"if(-not (Test-Path -LiteralPath $directory)){New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop | Out-Null};if(Test-Path -LiteralPath $target){$backup=Join-Path $directory ('Mona-StartBackup-{0}.bak' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds());Copy-Item -LiteralPath $target -Destination $backup -Force -ErrorAction Stop};[IO.File]::WriteAllBytes($target,[Convert]::FromBase64String('__TEMPLATE__'));$changed++"#
            .replace("__TEMPLATE__", BLANK_START_MENU_BASE64.trim())
    };
    r#"$ErrorActionPreference='Stop';$relative='AppData\Local\Packages\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\LocalState';$paths=@(Get-ChildItem -Path (Join-Path $env:SystemDrive "Users\*\$relative") -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object FullName);$default=Join-Path $env:SystemDrive "Users\Default\$relative";if(__INCLUDE_DEFAULT__ -or (Test-Path -LiteralPath $default)){$paths+=,$default};$changed=0;foreach($directory in @($paths | Sort-Object -Unique)){$target=Join-Path $directory 'start2.bin';__ACTION__};if($changed -eq 0){throw 'No start menu configuration could be changed'}"#
        .replace("__INCLUDE_DEFAULT__", if restore { "$false" } else { "$true" })
        .replace("__ACTION__", &action)
}

fn change_start_menu(all_users: bool, restore: bool) -> Result<String, String> {
    if all_users {
        run_elevated_powershell(&all_users_start_menu_script(restore), 120_000)?;
        return Ok(if restore {
            "已从 Mona 备份恢复所有可用用户的开始菜单".into()
        } else {
            "已清理所有现有用户及新用户的开始菜单固定项".into()
        });
    }
    let profiles = vec![current_profile()?];
    let mut changed = 0usize;
    for profile in profiles {
        let path = start_menu_path_for(&profile);
        let result = if restore { restore_start_menu_file(&path) } else { clear_start_menu_file(&path) };
        if result.is_ok() { changed += 1; }
    }
    if changed == 0 { Err("没有找到可处理的开始菜单配置".into()) }
    else { Ok(format!("已处理 {changed} 个用户的开始菜单")) }
}

fn store_database_path() -> Result<PathBuf, String> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
        .map(|root| root.join("Packages/Microsoft.WindowsStore_8wekyb3d8bbwe/LocalState/store.db"))
        .ok_or("无法确定当前用户应用目录".into())
}

fn change_store_search_suggestions(restore: bool) -> Result<String, String> {
    let path = store_database_path()?;
    if restore {
        if !path.exists() { return Ok("Microsoft Store 搜索建议已是默认状态".into()); }
        run_hidden("icacls.exe", &[path.to_string_lossy().as_ref(), "/remove:d", "*S-1-1-0", "/C"])?;
        Ok("已恢复 Microsoft Store 搜索建议访问权限".into())
    } else {
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|error| format!("创建 Store 数据目录失败：{error}"))?; }
        if !path.exists() { fs::write(&path, []).map_err(|error| format!("创建 Store 数据文件失败：{error}"))?; }
        run_hidden("icacls.exe", &[path.to_string_lossy().as_ref(), "/deny", "*S-1-1-0:(F)", "/C"])?;
        Ok("已关闭 Microsoft Store 搜索建议".into())
    }
}

fn remove_appx_packages(ids: &[&str]) -> Result<String, String> {
    let allow = ids.iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(",");
    let script = format!("@({allow}) | ForEach-Object {{ Get-AppxPackage -Name $_ -ErrorAction SilentlyContinue | Remove-AppxPackage -ErrorAction Stop }}");
    run_hidden("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", &script])?;
    Ok("相关 Windows 应用已移除".into())
}

fn disable_widgets() -> Result<String, String> {
    remove_appx_packages(&["Microsoft.StartExperiencesApp", "MicrosoftWindows.Client.WebExperience", "Microsoft.WidgetsPlatformRuntime"])
}

fn apply_post_effects(feature_id: &str, mode: &str) -> Result<(), String> {
    match (feature_id, mode) {
        ("DisableBing", "recommended") => { remove_appx_packages(&["Microsoft.BingSearch"])?; }
        ("DisableCopilot", "recommended") => { remove_appx_packages(&["Microsoft.Copilot", "XP9CXNGPPJ97XX"])?; }
        _ => {}
    }
    Ok(())
}

pub fn is_supported_change(catalog: &FeatureCatalog, feature_id: &str, mode: &str) -> bool {
    if !matches!(mode, "recommended" | "restore") { return false; }
    catalog.features.iter().find(|feature| feature.feature_id == feature_id && feature.category.is_some())
        .is_some_and(|feature| mode == "recommended" || feature_can_restore(feature))
}

pub fn apply_feature(feature: &Feature, mode: &str) -> Result<String, String> {
    let detail = match feature.feature_id.as_str() {
        "EnableWindowsSandbox" | "EnableWindowsSubsystemForLinux" => optional_feature(&feature.feature_id, mode),
        "ClearStart" => change_start_menu(false, mode == "restore"),
        "ClearStartAllUsers" => change_start_menu(true, mode == "restore"),
        "DisableStoreSearchSuggestions" => change_store_search_suggestions(mode == "restore"),
        "DisableWidgets" if mode == "recommended" => disable_widgets(),
        "DisableWidgets" => Err("Widgets 卸载后需要从 Microsoft Store 手动恢复".into()),
        _ => import_registry(feature, mode),
    }?;
    apply_post_effects(&feature.feature_id, mode)?;
    Ok(detail)
}

pub fn validate_catalog() -> Result<(), String> {
    let catalog = configuration_catalog()?;
    let apps = windows_app_catalog()?;
    let categories = catalog.categories.iter().map(|item| &item.name).collect::<HashSet<_>>();
    let features = catalog.features.iter().map(|item| &item.feature_id).collect::<HashSet<_>>();
    let app_ids = apps.apps.iter().flat_map(|item| item.app_id.iter()).collect::<HashSet<_>>();
    if categories.len() != 12 || catalog.ui_groups.len() != 9 || catalog.features.iter().filter(|item| item.category.is_some()).count() != 93 {
        return Err("Win11Debloat 设置目录数量不符合固定快照".into());
    }
    if features.len() != catalog.features.len() || apps.apps.len() != 141 || apps.presets.len() != 2 || app_ids.is_empty() {
        return Err("Win11Debloat 应用目录数量或 ID 不符合固定快照".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_pinned_catalogs() {
        validate_catalog().unwrap();
        let registry = registry_files().unwrap();
        assert!(registry.values().all(|content| content.starts_with("Windows Registry Editor")));
        for feature in configuration_catalog().unwrap().features {
            if let Some(file) = feature.registry_key { registry_content(&file, false).unwrap(); }
            if let Some(file) = feature.registry_undo_key { registry_content(&file, true).unwrap(); }
        }
        let apps = windows_app_catalog().unwrap();
        assert_eq!(apps.apps.iter().filter(|item| item.recommendation == "safe").count(), 86);
        assert_eq!(apps.apps.iter().filter(|item| item.recommendation == "optional").count(), 48);
        assert_eq!(apps.apps.iter().filter(|item| item.recommendation == "unsafe").count(), 7);
    }

    #[test]
    fn parses_registry_operations_without_accepting_arbitrary_input() {
        let content = "Windows Registry Editor Version 5.00\n[HKEY_CURRENT_USER\\Software\\Mona]\n\"Flag\"=dword:00000001\n\"Old\"=-";
        let operations = parse_reg_operations(content);
        assert_eq!(operations.len(), 2);
        assert!(matches!(&operations[0], RegOperation::SetValue { name, kind: RegKind::Dword, .. } if name == "Flag"));
        assert!(matches!(&operations[1], RegOperation::DeleteValue { name, .. } if name == "Old"));
    }

    #[test]
    fn all_users_start_menu_change_is_elevated_and_fails_loudly() {
        let apply = all_users_start_menu_script(false);
        assert!(apply.contains("Mona-StartBackup-"));
        assert!(apply.contains("WriteAllBytes"));
        assert!(apply.contains("if($changed -eq 0){throw"));

        let restore = all_users_start_menu_script(true);
        assert!(restore.contains("Mona-StartBackup-*.bak"));
        assert!(restore.contains("Copy-Item"));
        assert!(restore.contains("if($changed -eq 0){throw"));
    }
}
