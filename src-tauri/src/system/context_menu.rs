// 右键菜单集成：取得所有权 / 在此处打开 CMD / 复制为路径。
// 纯注册表操作，可逆，复用 run_elevated。

use serde::{Deserialize, Serialize};
use tauri::State;

use super::SystemState;

const MONA_MARKER: &str = "Mona-ContextMenu";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuItem {
    pub id: String,
    pub label: String,
    pub description: String,
    pub risk: String,
    pub is_applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuActionResult {
    pub item_id: String,
    pub success: bool,
    pub detail: String,
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
    let bytes = script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    super::run_elevated("powershell.exe", &format!("-NoProfile -NonInteractive -EncodedCommand {encoded}"), timeout_ms)
}

#[cfg(not(windows))]
fn run_elevated_powershell(_script: &str, _timeout_ms: u32) -> Result<(), String> { Err("仅支持 Windows".into()) }

#[cfg(windows)]
fn key_exists(path: &str) -> bool {
    use windows_registry::{CLASSES_ROOT, LOCAL_MACHINE};
    let (hive, subkey) = match path.split_once('\\') {
        Some(pair) => pair,
        None => return false,
    };
    let root = match hive {
        "HKEY_CLASSES_ROOT" => CLASSES_ROOT,
        "HKEY_LOCAL_MACHINE" => LOCAL_MACHINE,
        _ => return false,
    };
    root.open(subkey).is_ok()
}

#[cfg(not(windows))]
fn key_exists(_path: &str) -> bool { false }

fn record_event(state: &State<'_, SystemState>, title: &str, status: &str, detail: &str) {
    if let Ok(inner) = state.0.lock() {
        let _ = inner.db.execute_batch(
            "CREATE TABLE IF NOT EXISTS context_menu_operations (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
                title TEXT NOT NULL, mode TEXT NOT NULL, success INTEGER NOT NULL, detail TEXT NOT NULL
            );",
        );
        let success = if status == "成功" { 1 } else { 0 };
        let _ = inner.db.execute(
            "INSERT INTO context_menu_operations (ts, title, mode, success, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![now_ts(), title, "context_menu", success, detail],
        );
    }
}

fn take_ownership_paths() -> Vec<&'static str> {
    vec![
        r"HKEY_CLASSES_ROOT\*\shell\MonaTakeOwnership",
        r"HKEY_CLASSES_ROOT\Directory\shell\MonaTakeOwnership",
        r"HKEY_CLASSES_ROOT\Directory\Background\shell\MonaTakeOwnership",
    ]
}

fn open_cmd_paths() -> Vec<&'static str> {
    vec![
        r"HKEY_CLASSES_ROOT\Directory\shell\MonaOpenCmd",
        r"HKEY_CLASSES_ROOT\Directory\Background\shell\MonaOpenCmd",
    ]
}

fn copy_path_paths() -> Vec<&'static str> {
    vec![
        r"HKEY_CLASSES_ROOT\*\shell\MonaCopyPath",
        r"HKEY_CLASSES_ROOT\Directory\shell\MonaCopyPath",
    ]
}

fn paths_for(id: &str) -> Vec<&'static str> {
    match id {
        "TakeOwnership" => take_ownership_paths(),
        "OpenCmdHere" => open_cmd_paths(),
        "CopyPath" => copy_path_paths(),
        _ => vec![],
    }
}

fn label_for(id: &str) -> &'static str {
    match id {
        "TakeOwnership" => "取得所有权",
        "OpenCmdHere" => "在此处打开 CMD",
        "CopyPath" => "复制为路径",
        _ => "右键菜单项",
    }
}

fn build_take_ownership_script(mode: &str) -> String {
    let paths = take_ownership_paths();
    let command = "powershell -command \"start-process cmd -argumentlist '/c takeown /f \\\"%1\\\" && icacls \\\"%1\\\" /grant administrators:F' -verb runAs\"";
    if mode == "restore" {
        paths.iter().map(|p| format!("Remove-Item -Path 'HKCR:{}' -Recurse -Force -ErrorAction SilentlyContinue", p.strip_prefix("HKEY_CLASSES_ROOT\\").unwrap_or(p))).collect::<Vec<_>>().join("; ")
    } else {
        let mut parts = Vec::new();
        for path in &paths {
            let sub = path.strip_prefix("HKEY_CLASSES_ROOT\\").unwrap_or(path);
            parts.push(format!(
                "New-Item -Path 'HKCR:\\{sub}' -Force | Out-Null; Set-ItemProperty -Path 'HKCR:\\{sub}' -Name 'Mona' -Value '{MONA_MARKER}' -Force; Set-ItemProperty -Path 'HKCR:\\{sub}' -Name @ -Value '取得所有权' -Force; New-Item -Path 'HKCR:\\{sub}\\command' -Force | Out-Null; Set-ItemProperty -Path 'HKCR:\\{sub}\\command' -Name @ -Value '{command}' -Force"
            ));
        }
        parts.join("; ")
    }
}

fn build_open_cmd_script(mode: &str) -> String {
    let paths = open_cmd_paths();
    let command = "cmd.exe /k cd \"%V\"";
    if mode == "restore" {
        paths.iter().map(|p| format!("Remove-Item -Path 'HKCR:{}' -Recurse -Force -ErrorAction SilentlyContinue", p.strip_prefix("HKEY_CLASSES_ROOT\\").unwrap_or(p))).collect::<Vec<_>>().join("; ")
    } else {
        let mut parts = Vec::new();
        for path in &paths {
            let sub = path.strip_prefix("HKEY_CLASSES_ROOT\\").unwrap_or(path);
            parts.push(format!(
                "New-Item -Path 'HKCR:\\{sub}' -Force | Out-Null; Set-ItemProperty -Path 'HKCR:\\{sub}' -Name 'Mona' -Value '{MONA_MARKER}' -Force; Set-ItemProperty -Path 'HKCR:\\{sub}' -Name @ -Value '在此处打开 CMD' -Force; New-Item -Path 'HKCR:\\{sub}\\command' -Force | Out-Null; Set-ItemProperty -Path 'HKCR:\\{sub}\\command' -Name @ -Value '{command}' -Force"
            ));
        }
        parts.join("; ")
    }
}

fn build_copy_path_script(mode: &str) -> String {
    let paths = copy_path_paths();
    let command = "powershell -command Set-Clipboard -LiteralPath '%1'";
    if mode == "restore" {
        paths.iter().map(|p| format!("Remove-Item -Path 'HKCR:{}' -Recurse -Force -ErrorAction SilentlyContinue", p.strip_prefix("HKEY_CLASSES_ROOT\\").unwrap_or(p))).collect::<Vec<_>>().join("; ")
    } else {
        let mut parts = Vec::new();
        for path in &paths {
            let sub = path.strip_prefix("HKEY_CLASSES_ROOT\\").unwrap_or(path);
            parts.push(format!(
                "New-Item -Path 'HKCR:\\{sub}' -Force | Out-Null; Set-ItemProperty -Path 'HKCR:\\{sub}' -Name 'Mona' -Value '{MONA_MARKER}' -Force; Set-ItemProperty -Path 'HKCR:\\{sub}' -Name @ -Value '复制为路径' -Force; New-Item -Path 'HKCR:\\{sub}\\command' -Force | Out-Null; Set-ItemProperty -Path 'HKCR:\\{sub}\\command' -Name @ -Value '{command}' -Force"
            ));
        }
        parts.join("; ")
    }
}

fn build_script(item_id: &str, mode: &str) -> String {
    let builder = match item_id {
        "TakeOwnership" => build_take_ownership_script,
        "OpenCmdHere" => build_open_cmd_script,
        "CopyPath" => build_copy_path_script,
        _ => return String::new(),
    };
    let body = builder(mode);
    format!("$ErrorActionPreference='Stop'; New-PSDrive -Name HKCR -PSProvider Registry -Root HKEY_CLASSES_ROOT -ErrorAction SilentlyContinue | Out-Null; {body}; 'OK'")
}

fn catalog_items() -> Vec<ContextMenuItem> {
    let ids = ["TakeOwnership", "OpenCmdHere", "CopyPath"];
    ids.iter().map(|id| {
        let paths = paths_for(id);
        let is_applied = paths.iter().any(|p| key_exists(p));
        ContextMenuItem {
            id: id.to_string(),
            label: label_for(id).to_string(),
            description: match *id {
                "TakeOwnership" => "右键菜单添加「取得所有权」选项，快速获取文件/文件夹的管理员权限。".into(),
                "OpenCmdHere" => "右键菜单添加「在此处打开 CMD」，快速在当前目录打开命令提示符。".into(),
                "CopyPath" => "右键菜单添加「复制为路径」，快速复制文件/文件夹的完整路径到剪贴板。".into(),
                _ => String::new(),
            },
            risk: "low".into(),
            is_applied,
        }
    }).collect()
}

#[tauri::command]
pub async fn system_list_context_menu_items() -> Result<Vec<ContextMenuItem>, String> {
    let items = tokio::task::spawn_blocking(catalog_items).await.map_err(|e| format!("读取失败：{e}"))?;
    Ok(items)
}

#[tauri::command]
pub async fn system_apply_context_menu_item(
    state: State<'_, SystemState>,
    item_id: String,
    mode: String,
) -> Result<ContextMenuActionResult, String> {
    if !matches!(mode.as_str(), "recommended" | "restore") {
        return Err("无效的操作模式".into());
    }
    let script = build_script(&item_id, &mode);
    if script.is_empty() {
        return Err(format!("未知的右键菜单项：{item_id}"));
    }

    let result = tokio::task::spawn_blocking(move || run_elevated_powershell(&script, 30_000))
        .await
        .map_err(|e| format!("操作失败：{e}"))?;

    let label = label_for(&item_id);
    let title = format!("{} {}", if mode == "restore" { "移除" } else { "添加" }, label);
    let detail = match &result {
        Ok(_) => if mode == "restore" { format!("已移除「{label}」右键菜单") } else { format!("已添加「{label}」右键菜单") },
        Err(e) => e.clone(),
    };
    let status = if result.is_ok() { "成功" } else { "失败" };
    record_event(&state, &title, status, &detail);

    match result {
        Ok(_) => Ok(ContextMenuActionResult { item_id, success: true, detail }),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_three_items() {
        let items = catalog_items();
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn paths_are_non_empty_for_known_ids() {
        assert!(!paths_for("TakeOwnership").is_empty());
        assert!(!paths_for("OpenCmdHere").is_empty());
        assert!(!paths_for("CopyPath").is_empty());
        assert!(paths_for("Unknown").is_empty());
    }

    #[test]
    fn build_script_contains_marker_for_apply() {
        let script = build_script("TakeOwnership", "recommended");
        assert!(script.contains(MONA_MARKER));
        assert!(script.contains("HKCR"));
    }

    #[test]
    fn build_script_for_restore_contains_remove() {
        let script = build_script("OpenCmdHere", "restore");
        assert!(script.contains("Remove-Item"));
    }

    #[test]
    fn labels_are_correct() {
        assert_eq!(label_for("TakeOwnership"), "取得所有权");
        assert_eq!(label_for("OpenCmdHere"), "在此处打开 CMD");
        assert_eq!(label_for("CopyPath"), "复制为路径");
    }
}
