use crate::browser::tab::{BrowserTab, CreateTabResult};
use crate::browser::BrowserState;
use tauri::Manager;

/// 创建浏览器标签（Rust 侧创建 WebView，配置 on_navigation 允许外部导航）
#[tauri::command]
pub async fn browser_create_tab(
    app: tauri::AppHandle,
    id: String,
    url: String,
) -> Result<CreateTabResult, String> {
    let state = app.state::<BrowserState>();
    state.create_tab(&app, &id, &url)
}

/// 关闭浏览器标签
#[tauri::command]
pub async fn browser_close_tab(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.close_tab(&app, &id)
}

/// 更新标签 URL
#[tauri::command]
pub async fn browser_update_tab_url(
    app: tauri::AppHandle,
    id: String,
    url: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.update_tab_url(&id, &url)
}

/// 更新标签标题
#[tauri::command]
pub async fn browser_update_tab_title(
    app: tauri::AppHandle,
    id: String,
    title: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.update_tab_title(&id, &title)
}

/// 列出所有标签
#[tauri::command]
pub async fn browser_list_tabs(
    app: tauri::AppHandle,
) -> Result<Vec<BrowserTab>, String> {
    let state = app.state::<BrowserState>();
    Ok(state.list_tabs())
}

/// 获取标签的 CDP 端口
#[tauri::command]
pub async fn browser_get_cdp_port(
    app: tauri::AppHandle,
    id: String,
) -> Result<u16, String> {
    let state = app.state::<BrowserState>();
    state.get_cdp_port(&id)
}

/// 设置 AI 控制状态
#[tauri::command]
pub async fn browser_set_ai_status(
    app: tauri::AppHandle,
    id: String,
    controlled: bool,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.set_ai_status(&id, controlled)
}

/// 导航标签到指定 URL（用于地址栏输入、target="_blank" 等场景）
#[tauri::command]
pub async fn browser_navigate_tab(
    app: tauri::AppHandle,
    id: String,
    url: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.navigate_tab(&app, &id, &url)
}

/// 后退
#[tauri::command]
pub async fn browser_go_back(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.go_back(&app, &id)
}

/// 前进
#[tauri::command]
pub async fn browser_go_forward(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.go_forward(&app, &id)
}

/// 刷新
#[tauri::command]
pub async fn browser_reload(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.reload(&app, &id)
}

/// WebView 内部 URL 变化回调（由 initialization_script 调用）
#[tauri::command]
pub async fn browser_on_url_changed(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    url: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    let label = webview.label();
    // 从 webview_label 提取 tab id（格式: browser-{id}）
    let id = label.strip_prefix("browser-").unwrap_or(label);
    state.on_url_changed(&app, id, &url)
}
