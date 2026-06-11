pub mod commands;
pub mod tab;

use dashmap::DashMap;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tab::{BrowserTab, CreateTabResult};
use tauri::{AppHandle, Emitter, Manager, WebviewBuilder, WebviewUrl};
use url::Url;

const CDP_PORT_START: u16 = 9300;

/// 拦截新窗口请求的初始化脚本
/// 1. 拦截所有带 target="_blank" 的链接点击，改为同窗口导航
/// 2. 拦截 window.open() 调用，改为同窗口导航
/// 注意：子 WebView 中 __TAURI_INTERNALS__ 不可用，URL 变化通过 on_navigation 回调通知
const BLANK_LINK_INTERCEPTOR: &str = r#"
(function() {
  // 拦截 target="_blank" 链接点击
  window.addEventListener('click', function(e) {
    var link = e.target.closest('a[target="_blank"]');
    if (link && link.href) {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = link.href;
    }
  }, true);
  // 拦截 window.open() 调用，改为同窗口导航
  window.open = function(url) {
    if (url) {
      window.location.href = url;
    }
    return null;
  };
})();
"#;

pub struct BrowserState {
    tabs: Arc<DashMap<String, BrowserTab>>,
    next_cdp_port: AtomicU16,
}

impl BrowserState {
    pub fn new() -> Self {
        Self {
            tabs: Arc::new(DashMap::new()),
            next_cdp_port: AtomicU16::new(CDP_PORT_START),
        }
    }

    /// 创建浏览器标签（在 Rust 侧创建 WebView，配置 on_navigation 允许外部导航）
    pub fn create_tab(
        &self,
        app: &AppHandle,
        id: &str,
        url: &str,
    ) -> Result<CreateTabResult, String> {
        let cdp_port = self.next_cdp_port.fetch_add(1, Ordering::SeqCst);
        let webview_label = format!("browser-{}", id);

        let parsed_url: Url = url
            .parse()
            .map_err(|e| format!("Invalid URL: {}", e))?;

        // 获取主窗口
        let window = app
            .get_window("main")
            .ok_or_else(|| "Main window not found".to_string())?;

        // 为 on_navigation 闭包克隆所需变量
        let tabs = self.tabs.clone();
        let app_handle = app.clone();
        let tab_id = id.to_string();

        // 创建子 WebView，配置 on_navigation：
        // 1. 允许所有 https/http 导航
        // 2. 通知前端 URL 变化（子 WebView 中 __TAURI_INTERNALS__ 不可用，必须在此回调中处理）
        //
        // 注意：不设置 data_directory，因为 WebView2 不同 data_directory 会启动独立的浏览器进程，
        // 导致子 WebView 不共享主窗口的 CDP 端口（--remote-debugging-port=9300），
        // Playwright 无法通过 CDP 连接到子 WebView。
        // 所有 WebView 共享同一用户数据目录（EBWebView），cookies/localStorage 自然持久化。

        // 注入 tab ID 标记，供 Playwright CDP 通过 evaluate 识别对应 Page
        let init_script = format!(
            "{}\nwindow.__mona_tab_id = '{}';",
            BLANK_LINK_INTERCEPTOR, id
        );

        let webview_builder = WebviewBuilder::new(&webview_label, WebviewUrl::External(parsed_url))
            .on_navigation(move |url| {
                // 更新 DashMap 中的 tab URL
                if let Some(mut tab) = tabs.get_mut(&tab_id) {
                    tab.url = url.to_string();
                }
                // 通知前端 URL 变化
                let _ = app_handle.emit(
                    "browser-url-changed",
                    serde_json::json!({ "id": tab_id, "url": url.to_string() }),
                );
                let scheme = url.scheme();
                scheme == "https" || scheme == "http"
            })
            .initialization_script(init_script);

        // 初始位置放在屏幕外，避免 WebView 覆盖工具栏
        // updateWebviewBounds 会在前端将其移到正确位置
        window
            .add_child(
                webview_builder,
                tauri::LogicalPosition::new(-9999, -9999),
                tauri::LogicalSize::new(1, 1),
            )
            .map_err(|e| format!("Failed to create webview: {}", e))?;

        let tab = BrowserTab {
            id: id.to_string(),
            title: "New Tab".to_string(),
            url: url.to_string(),
            cdp_port,
            webview_label,
            is_ai_controlled: false,
        };

        self.tabs.insert(id.to_string(), tab);

        // 通知前端新标签已创建（AI 通过 IPC 创建时前端不知道）
        let _ = app.emit(
            "browser-tab-created",
            serde_json::json!({
                "id": id,
                "url": url,
                "title": "New Tab",
                "cdp_port": cdp_port,
            }),
        );

        Ok(CreateTabResult {
            id: id.to_string(),
            cdp_port,
        })
    }

    /// 关闭标签
    pub fn close_tab(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        if let Some((_, tab)) = self.tabs.remove(id) {
            // 通过 label 获取子 WebView 并关闭
            if let Some(webview) = app.get_webview(&tab.webview_label) {
                let _ = webview.close();
            }
            let _ = app.emit("browser-tab-closed", id);
            Ok(())
        } else {
            Err(format!("Tab {} not found", id))
        }
    }

    /// 更新标签 URL
    pub fn update_tab_url(&self, id: &str, url: &str) -> Result<(), String> {
        let mut tab = self
            .tabs
            .get_mut(id)
            .ok_or_else(|| format!("Tab {} not found", id))?;
        tab.url = url.to_string();
        Ok(())
    }

    /// 更新标签标题
    pub fn update_tab_title(&self, id: &str, title: &str) -> Result<(), String> {
        let mut tab = self
            .tabs
            .get_mut(id)
            .ok_or_else(|| format!("Tab {} not found", id))?;
        tab.title = title.to_string();
        Ok(())
    }

    pub fn list_tabs(&self) -> Vec<BrowserTab> {
        self.tabs.iter().map(|r| r.value().clone()).collect()
    }

    pub fn get_cdp_port(&self, id: &str) -> Result<u16, String> {
        self.tabs
            .get(id)
            .map(|t| t.cdp_port)
            .ok_or_else(|| format!("Tab {} not found", id))
    }

    pub fn set_ai_status(&self, id: &str, controlled: bool) -> Result<(), String> {
        let mut tab = self
            .tabs
            .get_mut(id)
            .ok_or_else(|| format!("Tab {} not found", id))?;
        tab.is_ai_controlled = controlled;
        Ok(())
    }

    /// 导航标签到指定 URL（用于 target="_blank" 新窗口请求等场景）
    pub fn navigate_tab(&self, app: &AppHandle, id: &str, url: &str) -> Result<(), String> {
        let tab = self
            .tabs
            .get(id)
            .ok_or_else(|| format!("Tab {} not found", id))?;
        let webview = app
            .get_webview(&tab.webview_label)
            .ok_or_else(|| format!("WebView {} not found", tab.webview_label))?;
        let parsed_url: Url = url
            .parse()
            .map_err(|e| format!("Invalid URL: {}", e))?;
        webview
            .navigate(parsed_url)
            .map_err(|e| format!("Navigate failed: {}", e))?;
        drop(tab); // 释放 DashMap 引用后再修改
        if let Some(mut tab) = self.tabs.get_mut(id) {
            tab.url = url.to_string();
        }
        Ok(())
    }

    /// 后退（通过 JS history.back()）
    pub fn go_back(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let tab = self
            .tabs
            .get(id)
            .ok_or_else(|| format!("Tab {} not found", id))?;
        let webview = app
            .get_webview(&tab.webview_label)
            .ok_or_else(|| format!("WebView {} not found", tab.webview_label))?;
        webview
            .eval("if(window.history.length>1) window.history.back();")
            .map_err(|e| format!("Go back failed: {}", e))
    }

    /// 前进（通过 JS history.forward()）
    pub fn go_forward(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let tab = self
            .tabs
            .get(id)
            .ok_or_else(|| format!("Tab {} not found", id))?;
        let webview = app
            .get_webview(&tab.webview_label)
            .ok_or_else(|| format!("WebView {} not found", tab.webview_label))?;
        webview
            .eval("window.history.forward();")
            .map_err(|e| format!("Go forward failed: {}", e))
    }

    /// 刷新（通过 JS location.reload()）
    pub fn reload(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let tab = self
            .tabs
            .get(id)
            .ok_or_else(|| format!("Tab {} not found", id))?;
        let webview = app
            .get_webview(&tab.webview_label)
            .ok_or_else(|| format!("WebView {} not found", tab.webview_label))?;
        webview
            .eval("window.location.reload();")
            .map_err(|e| format!("Reload failed: {}", e))
    }

    /// WebView 内部 URL 变化回调
    pub fn on_url_changed(&self, app: &AppHandle, id: &str, url: &str) -> Result<(), String> {
        if let Some(mut tab) = self.tabs.get_mut(id) {
            tab.url = url.to_string();
        }
        let _ = app.emit(
            "browser-url-changed",
            serde_json::json!({ "id": id, "url": url }),
        );
        Ok(())
    }
}
