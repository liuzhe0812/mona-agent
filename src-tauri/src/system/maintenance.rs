use serde::{Deserialize, Serialize};
use tauri::State;

use super::SystemState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceEvent {
    pub id: String,
    pub ts: i64,
    pub category: String,
    pub title: String,
    pub source: String,
    pub status: String,
    pub detail: String,
    pub bytes_changed: u64,
    pub reversible: bool,
    pub related_id: Option<String>,
    pub restore_enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceHistory {
    pub events: Vec<MaintenanceEvent>,
}

fn software_category(action: &str) -> &'static str {
    match action {
        "upgrade" => "更新",
        "uninstall" => "卸载",
        _ => "维护",
    }
}

#[tauri::command]
pub async fn system_get_maintenance_history(
    state: State<'_, SystemState>,
) -> Result<MaintenanceHistory, String> {
    let inner = state.0.lock().map_err(|error| format!("State lock: {error}"))?;
    inner.db.execute_batch(
        "CREATE TABLE IF NOT EXISTS startup_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            item_name TEXT NOT NULL,
            action TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS software_operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            package_id TEXT NOT NULL,
            name TEXT NOT NULL,
            action TEXT NOT NULL,
            success INTEGER NOT NULL,
            exit_code INTEGER,
            message TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cleanup_operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            bytes_changed INTEGER NOT NULL,
            detail TEXT NOT NULL
        );",
    ).map_err(|error| format!("初始化维护记录失败：{error}"))?;

    let mut events = Vec::new();
    {
        let mut statement = inner.db.prepare(
            "SELECT id, ts, item_id, item_name, action FROM startup_changes ORDER BY ts DESC LIMIT 100",
        ).map_err(|error| format!("读取启动项记录失败：{error}"))?;
        let rows = statement.query_map([], |row| {
            let id: i64 = row.get(0)?;
            let ts: i64 = row.get(1)?;
            let item_id: String = row.get(2)?;
            let item_name: String = row.get(3)?;
            let action: String = row.get(4)?;
            let enabled = action == "enable";
            Ok(MaintenanceEvent {
                id: format!("startup-{id}"),
                ts,
                category: "启动项".to_string(),
                title: format!("{} {item_name} 启动项", if enabled { "恢复" } else { "禁用" }),
                source: "用户操作".to_string(),
                status: "成功".to_string(),
                detail: format!("启动状态已切换为{}", if enabled { "启用" } else { "禁用" }),
                bytes_changed: 0,
                reversible: true,
                related_id: Some(item_id),
                restore_enabled: Some(!enabled),
            })
        }).map_err(|error| format!("读取启动项记录失败：{error}"))?;
        events.extend(rows.filter_map(Result::ok));
    }
    {
        let mut statement = inner.db.prepare(
            "SELECT id, ts, package_id, name, action, success, message FROM software_operations ORDER BY ts DESC LIMIT 100",
        ).map_err(|error| format!("读取软件记录失败：{error}"))?;
        let rows = statement.query_map([], |row| {
            let id: i64 = row.get(0)?;
            let ts: i64 = row.get(1)?;
            let package_id: String = row.get(2)?;
            let name: String = row.get(3)?;
            let action: String = row.get(4)?;
            let success: bool = row.get::<_, i64>(5)? != 0;
            let message: String = row.get(6)?;
            let category = software_category(&action);
            Ok(MaintenanceEvent {
                id: format!("software-{id}"),
                ts,
                category: category.to_string(),
                title: format!("{category} {name}"),
                source: "用户操作".to_string(),
                status: if success { "成功" } else { "失败" }.to_string(),
                detail: if message.is_empty() { "安装器未返回详细信息".to_string() } else { message },
                bytes_changed: 0,
                reversible: false,
                related_id: Some(package_id),
                restore_enabled: None,
            })
        }).map_err(|error| format!("读取软件记录失败：{error}"))?;
        events.extend(rows.filter_map(Result::ok));
    }
    {
        let mut statement = inner.db.prepare(
            "SELECT id, ts, title, status, bytes_changed, detail FROM cleanup_operations ORDER BY ts DESC LIMIT 100",
        ).map_err(|error| format!("读取清理记录失败：{error}"))?;
        let rows = statement.query_map([], |row| {
            let id: i64 = row.get(0)?;
            Ok(MaintenanceEvent {
                id: format!("cleanup-{id}"),
                ts: row.get(1)?,
                category: "清理".to_string(),
                title: row.get(2)?,
                source: "用户操作".to_string(),
                status: row.get(3)?,
                bytes_changed: row.get::<_, i64>(4)?.max(0) as u64,
                detail: row.get(5)?,
                reversible: false,
                related_id: None,
                restore_enabled: None,
            })
        }).map_err(|error| format!("读取清理记录失败：{error}"))?;
        events.extend(rows.filter_map(Result::ok));
    }
    events.sort_by(|left, right| right.ts.cmp(&left.ts));
    events.truncate(200);
    Ok(MaintenanceHistory { events })
}

#[cfg(test)]
mod tests {
    use super::software_category;

    #[test]
    fn maps_persisted_software_actions_to_maintenance_categories() {
        assert_eq!(software_category("upgrade"), "更新");
        assert_eq!(software_category("uninstall"), "卸载");
        assert_eq!(software_category("unknown"), "维护");
    }
}
