use crate::browser::tab::{BrowserTab, CreateTabResult};
use crate::browser::{BrowserState, DownloadInfo};
use tauri::Manager;

/// 创建浏览器标签（Rust 侧创建 WebView，配置 on_navigation 允许外部导航）
#[tauri::command]
pub async fn browser_create_tab(
    app: tauri::AppHandle,
    id: String,
    url: String,
    is_incognito: Option<bool>,
    ad_block_enabled: Option<bool>,
) -> Result<CreateTabResult, String> {
    let state = app.state::<BrowserState>();
    state.create_tab(&app, &id, &url, is_incognito.unwrap_or(false), ad_block_enabled.unwrap_or(true))
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

// ── 下载管理命令 ──

/// 取消下载
#[tauri::command]
pub async fn browser_cancel_download(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.cancel_download(&id)
}

/// 暂停下载
#[tauri::command]
pub async fn browser_pause_download(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.pause_download(&id)
}

/// 恢复下载
#[tauri::command]
pub async fn browser_resume_download(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.resume_download(&id)
}

/// 列出所有下载
#[tauri::command]
pub async fn browser_list_downloads(
    app: tauri::AppHandle,
) -> Result<Vec<DownloadInfo>, String> {
    let state = app.state::<BrowserState>();
    Ok(state.list_downloads())
}

/// 打开下载的文件（使用系统默认程序）
#[tauri::command]
pub async fn browser_open_download(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    let info = state.get_download_info(&id)?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &info.save_path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&info.save_path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&info.save_path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

/// 在文件管理器中显示下载的文件
#[tauri::command]
pub async fn browser_reveal_download(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    let info = state.get_download_info(&id)?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &info.save_path])
            .spawn()
            .map_err(|e| format!("Failed to reveal file: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &info.save_path])
            .spawn()
            .map_err(|e| format!("Failed to reveal file: {}", e))?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = info; // Linux: xdg-open doesn't support reveal
    }
    Ok(())
}

/// 移除下载记录
#[tauri::command]
pub async fn browser_remove_download(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.remove_download(&id)
}

// ── 导航增强命令 ──

/// 设置页面缩放
#[tauri::command]
pub async fn browser_set_zoom(
    app: tauri::AppHandle,
    id: String,
    zoom_factor: f64,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.set_zoom(&app, &id, zoom_factor)
}

/// 获取当前缩放
#[tauri::command]
pub async fn browser_get_zoom(
    app: tauri::AppHandle,
    id: String,
) -> Result<f64, String> {
    let state = app.state::<BrowserState>();
    state.get_zoom(&id)
}

/// 打印当前页面
#[tauri::command]
pub async fn browser_print_page(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.print_page(&app, &id)
}

/// 获取页面源码
#[tauri::command]
pub async fn browser_get_page_source(
    app: tauri::AppHandle,
    id: String,
) -> Result<String, String> {
    let state = app.state::<BrowserState>();
    state.get_page_source(&app, &id)
}

/// 在 WebView 中执行 JS 代码
#[tauri::command]
pub async fn browser_eval_script(
    app: tauri::AppHandle,
    id: String,
    script: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.eval_script(&app, &id, &script)
}

// ── 隐私安全命令 ──

/// 获取当前页面的 Cookie（结果通过 browser-cookies-result 事件回传）
#[tauri::command]
pub async fn browser_get_cookies(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.get_cookies(&app, &id)
}

/// 清除当前页面的 Cookie
#[tauri::command]
pub async fn browser_clear_cookies(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.clear_cookies(&app, &id)
}

/// 切换广告拦截状态
#[tauri::command]
pub async fn browser_set_ad_block(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.set_ad_block_enabled(&app, &id, enabled)
}

/// 切换标签静音
#[tauri::command]
pub async fn browser_set_muted(
    app: tauri::AppHandle,
    id: String,
    muted: bool,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.set_muted(&app, &id, muted)
}

/// 获取标签静音状态
#[tauri::command]
pub async fn browser_is_muted(
    app: tauri::AppHandle,
    id: String,
) -> Result<bool, String> {
    let state = app.state::<BrowserState>();
    state.is_muted(&id)
}

/// 获取标签无痕状态
#[tauri::command]
pub async fn browser_is_incognito(
    app: tauri::AppHandle,
    id: String,
) -> Result<bool, String> {
    let state = app.state::<BrowserState>();
    state.is_incognito(&id)
}

// ── 高级功能命令 ──

/// 打开开发者工具
#[tauri::command]
pub async fn browser_open_devtools(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.open_devtools(&app, &id)
}

/// 切换暗色模式
#[tauri::command]
pub async fn browser_set_dark_mode(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.set_dark_mode(&app, &id, enabled)
}

/// 获取页面元信息（结果通过 browser-page-info-result 事件回传）
#[tauri::command]
pub async fn browser_get_page_info(
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let state = app.state::<BrowserState>();
    state.get_page_info(&app, &id)
}
