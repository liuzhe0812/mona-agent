pub mod commands;
pub mod storage;
pub mod tab;

use dashmap::DashMap;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tab::{BrowserTab, CreateTabResult};
use tauri::{AppHandle, Emitter, Manager, WebviewBuilder, WebviewUrl};
use url::Url;

const CDP_PORT_START: u16 = 9300;

/// 注入 tab ID 标记的初始化脚本
/// target="_blank" 链接和 window.open 由 WebView2 的 NewWindowRequested 事件处理
const TAB_ID_INJECTOR: &str = r#"
(function() {
  if (window.__mona_fullscreen_keys_injected) return;
  window.__mona_fullscreen_keys_injected = true;
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape' && e.key !== 'F11') return;
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    window.__TAURI__.event.emit('browser-fullscreen-key', { key: e.key });
  }, true);
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
        let app_handle2 = app.clone();
        let tab_id = id.to_string();

        // 注入 tab ID 标记，供 Playwright CDP 通过 evaluate 识别对应 Page
        let init_script = format!(
            "{}\nwindow.__mona_tab_id = '{}';",
            TAB_ID_INJECTOR, id
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
        let child_webview = window
            .add_child(
                webview_builder,
                tauri::LogicalPosition::new(-9999, -9999),
                tauri::LogicalSize::new(1, 1),
            )
            .map_err(|e| format!("Failed to create webview: {}", e))?;

        // 注册 WebView2 NewWindowRequested 事件处理器
        // 当用户点击 target="_blank" 链接时，WebView2 触发此事件
        // 我们拦截它，通知前端创建新标签页，而不是让系统浏览器打开
        let emit_handle = app_handle2.clone();
        child_webview.with_webview(move |wv| {
            #[cfg(target_os = "windows")]
            {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NewWindowRequestedEventArgs;
                use webview2_com::NewWindowRequestedEventHandler;
                use windows_strings::PWSTR;

                let controller = wv.controller();
                let core_webview = unsafe { controller.CoreWebView2().unwrap() };

                let emit = emit_handle.clone();
                let handler = NewWindowRequestedEventHandler::create(Box::new(
                    move |_sender: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2>,
                          args: Option<ICoreWebView2NewWindowRequestedEventArgs>| {
                        if let Some(args) = args {
                            // 获取请求的 URI
                            let mut raw_uri = PWSTR::null();
                            let uri = unsafe {
                                match args.Uri(&mut raw_uri) {
                                    Ok(()) => {
                                        let s = raw_uri.to_string().unwrap_or_default();
                                        windows::Win32::System::Com::CoTaskMemFree(Some(raw_uri.as_ptr() as *const _));
                                        s
                                    }
                                    Err(_) => String::new(),
                                }
                            };
                            if !uri.is_empty() {
                                let _ = emit.emit(
                                    "browser-open-new-tab",
                                    serde_json::json!({ "url": uri }),
                                );
                            }
                            // 阻止系统浏览器打开
                            unsafe { let _ = args.SetHandled(true); }
                        }
                        Ok(())
                    },
                ));

                let mut token: i64 = 0;
                unsafe {
                    let _ = core_webview.add_NewWindowRequested(&handler, &mut token);
                }
            }
        }).map_err(|e| format!("Failed to register NewWindowRequested handler: {}", e))?;

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
