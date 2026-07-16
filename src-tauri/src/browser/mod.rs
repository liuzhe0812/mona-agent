pub mod commands;
pub mod downloads;
pub mod suggestions;
pub mod storage;
pub mod tab;

use dashmap::DashMap;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc::channel;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tab::{BrowserTab, CreateTabResult};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;
#[cfg(target_os = "windows")]
use wry::WebViewExtWindows;

const CDP_PORT_START: u16 = 9300;

thread_local! {
    static NATIVE_BROWSER_WEBVIEWS: RefCell<HashMap<String, wry::WebView>> = RefCell::new(HashMap::new());
}

fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let (tx, rx) = channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(task());
        })
        .map_err(|error| error.to_string())?;
    rx.recv()
        .map_err(|_| "Main window thread stopped before completing browser action".to_string())?
}

fn with_native_webview<T: Send + 'static>(
    app: &AppHandle,
    id: &str,
    action: impl FnOnce(&wry::WebView) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let id = id.to_string();
    on_main_thread(app, move || {
        NATIVE_BROWSER_WEBVIEWS.with(|webviews| {
            let webviews = webviews.borrow();
            let webview = webviews
                .get(&id)
                .ok_or_else(|| format!("Native WebView2 tab {} not found", id))?;
            action(webview)
        })
    })
}

fn remove_native_webview(app: &AppHandle, id: &str) -> Result<(), String> {
    let id = id.to_string();
    on_main_thread(app, move || {
        NATIVE_BROWSER_WEBVIEWS.with(|webviews| {
            webviews.borrow_mut().remove(&id);
        });
        Ok(())
    })
}

fn decode_script_json(result: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<String>(result)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .or_else(|| serde_json::from_str(result).ok())
}

/// 广告拦截脚本：注入 CSS 隐藏常见广告元素，并拦截已知广告域名的请求
const AD_BLOCK_SCRIPT: &str = r#"
(function() {
  if (window.__mona_ad_block_injected) return;
  window.__mona_ad_block_injected = true;

  // 已知广告域名（简化版 EasyList）
  var adDomains = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
    'adservice.google.com', 'adnxs.com', 'amazon-adsystem.com',
    'criteo.com', 'taboola.com', 'outbrain.com', 'scorecardresearch.com',
    'quantserve.com', 'moatads.com', 'adsystem.com', 'pubmatic.com',
    'rubiconproject.com', 'openx.net', 'casalemedia.com', 'yieldmo.com',
    'adroll.com', 'krxd.net', 'bidswitch.net', 'contextweb.com',
    '3lift.com', 'rlcdn.com', 'bluekai.com', 'demdex.net',
    'mediavine.com', 'mediavine-cdn.com', 'adthrive.com',
    'facebook.com/tr', 'facebook.net/en_US/fbevents.js',
  ];

  // 拦截广告请求（通过覆盖 fetch 和 XMLHttpRequest）
  function isAdUrl(url) {
    if (!url) return false;
    try {
      var u = new URL(url, location.href);
      var host = u.hostname;
      for (var i = 0; i < adDomains.length; i++) {
        if (host.indexOf(adDomains[i]) !== -1) return true;
      }
    } catch(e) {}
    return false;
  }

  // 拦截 fetch
  var originalFetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url);
    if (isAdUrl(url)) {
      return Promise.reject(new Error('Blocked by Mona Ad Block'));
    }
    return originalFetch.apply(this, arguments);
  };

  // 拦截 XMLHttpRequest
  var originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (isAdUrl(url)) {
      this._mona_blocked = true;
      return;
    }
    return originalOpen.apply(this, arguments);
  };
  var originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    if (this._mona_blocked) return;
    return originalSend.apply(this, arguments);
  };

  // 隐藏常见广告元素
  var adSelectors = [
    '[id*="google_ads_"]', '[id*="div-gpt-ad"]', '[id*="ad-container"]',
    '[id*="ad_banner"]', '[id*="adbox"]', '[class*="ad-container"]',
    '[class*="ad-banner"]', '[class*="advertisement"]', '[class*="adsbygoogle"]',
    'ins.adsbygoogle', 'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]', 'iframe[src*="amazon-adsystem.com"]',
    'iframe[src*="adnxs.com"]', '[data-ad]', '[data-ad-slot]',
  ];

  function hideAds() {
    var css = adSelectors.join(',') + ' { display: none !important; }';
    var style = document.getElementById('mona-ad-block-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'mona-ad-block-style';
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hideAds);
  } else {
    hideAds();
  }
})();
"#;

/// 下载条目信息（可序列化，用于 IPC 返回和事件 payload）
#[derive(Debug, Clone, serde::Serialize)]
pub struct DownloadInfo {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub mime_type: String,
    pub total_bytes: i64,
    pub received_bytes: i64,
    pub state: String, // "in_progress" | "interrupted" | "completed" | "cancelled"
    pub save_path: String,
}

#[cfg(test)]
mod tests {
    use super::decode_script_json;

    #[test]
    fn script_result_decodes_json_string_values() {
        let result = decode_script_json(r#""[{\"name\":\"session\"}]""#).unwrap();
        assert_eq!(result[0]["name"], "session");
    }
}

/// 存储下载操作 COM 接口（用于 cancel/pause/resume）
/// WebView2 COM 接口是 MTA 兼容的，可以安全跨线程访问
#[cfg(target_os = "windows")]
pub struct DownloadEntry {
    pub operation: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
    pub info: DownloadInfo,
}

#[cfg(target_os = "windows")]
unsafe impl Send for DownloadEntry {}
#[cfg(target_os = "windows")]
unsafe impl Sync for DownloadEntry {}

#[cfg(not(target_os = "windows"))]
pub struct DownloadEntry {
    pub info: DownloadInfo,
}

pub struct BrowserState {
    tabs: Arc<DashMap<String, BrowserTab>>,
    next_cdp_port: AtomicU16,
    downloads: Arc<DashMap<String, DownloadEntry>>,
    next_download_id: Arc<AtomicU64>,
}

impl BrowserState {
    pub fn new() -> Self {
        Self {
            tabs: Arc::new(DashMap::new()),
            next_cdp_port: AtomicU16::new(CDP_PORT_START),
            downloads: Arc::new(DashMap::new()),
            next_download_id: Arc::new(AtomicU64::new(1)),
        }
    }

    /// 创建浏览器标签（在 Rust 侧创建 WebView，配置 on_navigation 允许外部导航）
    pub fn create_tab(
        &self,
        app: &AppHandle,
        id: &str,
        url: &str,
        is_incognito: bool,
        ad_block_enabled: bool,
    ) -> Result<CreateTabResult, String> {
        let cdp_port = self.next_cdp_port.fetch_add(1, Ordering::SeqCst);
        let webview_label = format!("browser-{}", id);

        // HMR 重载可能导致前端状态重置、重复调用 create_tab
        // 先清理同 label 的旧 webview 和 tab 记录，避免 add_child 冲突
        remove_native_webview(app, id)?;
        self.tabs.remove(id);

        let parsed_url: Url = url
            .parse()
            .map_err(|e| format!("Invalid URL: {}", e))?;

        // 导航事件可能在首次 load_url 后立即抵达；先登记元数据，确保事件能更新正确的标签。
        let tab = BrowserTab {
            id: id.to_string(),
            title: "New Tab".to_string(),
            url: url.to_string(),
            cdp_port,
            webview_label,
            is_ai_controlled: false,
            zoom_factor: 1.0,
            is_incognito,
            is_muted: false,
        };
        self.tabs.insert(id.to_string(), tab);

        // 获取主窗口

        // 为 on_navigation 闭包克隆所需变量
        let tabs = self.tabs.clone();
        let app_handle = app.clone();
        let app_handle2 = app.clone();
        let tab_id = id.to_string();
        let tab_id_events = tab_id.clone();
        let downloads = self.downloads.clone();
        let next_download_id = self.next_download_id.clone();

        // 仅在需要时注入广告拦截脚本；浏览器页面不注入应用桥接代码。
        let init_script = ad_block_enabled.then_some(AD_BLOCK_SCRIPT);
        let native_app = app.clone();
        let native_tab_id = id.to_string();
        let native_url = parsed_url.to_string();
        if let Err(error) = on_main_thread(app, move || {
            let window = native_app
                .get_window("main")
                .ok_or_else(|| "Main window not found".to_string())?;
        // 如果启用广告拦截，添加初始化脚本。

        let webview_builder = wry::WebViewBuilder::new()
            .with_url("about:blank")
            .with_incognito(is_incognito)
            .with_visible(false)
            .with_navigation_handler(move |url| {
                let scheme = Url::parse(&url).ok().map(|value| value.scheme().to_string());
                let allowed = matches!(scheme.as_deref(), Some("https" | "http")) || url == "about:blank";
                if allowed {
                    // 更新 DashMap 中的 tab URL
                    if let Some(mut tab) = tabs.get_mut(&tab_id) {
                        tab.url = url.clone();
                    }
                    // 通知前端 URL 变化
                    let _ = app_handle.emit(
                        "browser-url-changed",
                        serde_json::json!({ "id": tab_id, "url": url.clone() }),
                    );
                    // 通知前端导航开始
                }
                allowed
            });

        let webview_builder = match init_script {
            Some(script) => webview_builder.with_initialization_script(script),
            None => webview_builder,
        };

        // 初始位置放在屏幕外，避免 WebView 覆盖工具栏
        // updateWebviewBounds 会在前端将其移到正确位置
        let child_webview = webview_builder
            .build_as_child(&window)
            .map_err(|e| format!("Failed to create native WebView2 browser tab: {}", e))?;

        // 注册 WebView2 事件处理器
        let emit_handle = app_handle2.clone();
        let wv = &child_webview;
        {
            #[cfg(target_os = "windows")]
            {
                use webview2_com::Microsoft::Web::WebView2::Win32::{
                    ICoreWebView2,
                    ICoreWebView2_4,
                    ICoreWebView2NewWindowRequestedEventArgs,
                    ICoreWebView2NavigationCompletedEventArgs,
                    ICoreWebView2DownloadStartingEventArgs,
                    ICoreWebView2DownloadOperation,
                };
                use webview2_com::{
                    NewWindowRequestedEventHandler,
                    NavigationCompletedEventHandler,
                    DocumentTitleChangedEventHandler,
                    HistoryChangedEventHandler,
                    DownloadStartingEventHandler,
                    BytesReceivedChangedEventHandler,
                    StateChangedEventHandler,
                };
                use windows::core::IUnknown;
                use windows::core::Interface;
                use windows_strings::PWSTR;
                use windows::core::HSTRING;

                let controller = wv.controller();
                let core_webview = unsafe { controller.CoreWebView2().unwrap() };

                // 1. NewWindowRequested — 拦截 target="_blank"
                let emit = emit_handle.clone();
                let handler = NewWindowRequestedEventHandler::create(Box::new(
                    move |_sender: Option<ICoreWebView2>,
                          args: Option<ICoreWebView2NewWindowRequestedEventArgs>| {
                        if let Some(args) = args {
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
                            unsafe { let _ = args.SetHandled(true); }
                        }
                        Ok(())
                    },
                ));
                let mut token: i64 = 0;
                unsafe { let _ = core_webview.add_NewWindowRequested(&handler, &mut token); }

                // 2. NavigationCompleted — 加载完成/失败
                let nav_emit = emit_handle.clone();
                let nav_tab_id = tab_id_events.clone();
                let nav_handler = NavigationCompletedEventHandler::create(Box::new(
                    move |_sender: Option<ICoreWebView2>,
                          args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
                        if let Some(args) = args {
                            let mut success = windows::core::BOOL::default();
                            unsafe {
                                let _ = args.IsSuccess(&mut success);
                            }
                            let _ = nav_emit.emit(
                                "browser-nav-completed",
                                serde_json::json!({ "id": nav_tab_id, "success": success.as_bool() }),
                            );
                        }
                        Ok(())
                    },
                ));
                let mut token: i64 = 0;
                unsafe { let _ = core_webview.add_NavigationCompleted(&nav_handler, &mut token); }

                // 3. DocumentTitleChanged — 标题变化
                let title_emit = emit_handle.clone();
                let title_tab_id = tab_id_events.clone();
                let title_handler = DocumentTitleChangedEventHandler::create(Box::new(
                    move |sender: Option<ICoreWebView2>,
                          _args: Option<IUnknown>| {
                        if let Some(sender) = sender {
                            let mut title = PWSTR::null();
                            unsafe {
                                if sender.DocumentTitle(&mut title).is_ok() {
                                    let title_str = title.to_string().unwrap_or_default();
                                    windows::Win32::System::Com::CoTaskMemFree(Some(title.as_ptr() as *const _));
                                    if !title_str.is_empty() {
                                        let _ = title_emit.emit(
                                            "browser-tab-title-changed",
                                            serde_json::json!({ "id": title_tab_id, "title": title_str }),
                                        );
                                    }
                                }
                            }
                        }
                        Ok(())
                    },
                ));
                let mut token: i64 = 0;
                unsafe { let _ = core_webview.add_DocumentTitleChanged(&title_handler, &mut token); }

                // 4. HistoryChanged — 后退/前进按钮状态
                let hist_emit = emit_handle.clone();
                let hist_tab_id = tab_id_events.clone();
                let hist_handler = HistoryChangedEventHandler::create(Box::new(
                    move |sender: Option<ICoreWebView2>,
                          _args: Option<IUnknown>| {
                        if let Some(sender) = sender {
                            let mut can_go_back = windows::core::BOOL::default();
                            let mut can_go_forward = windows::core::BOOL::default();
                            unsafe {
                                let _ = sender.CanGoBack(&mut can_go_back);
                                let _ = sender.CanGoForward(&mut can_go_forward);
                            }
                            let _ = hist_emit.emit(
                                "browser-history-changed",
                                serde_json::json!({ "id": hist_tab_id, "canGoBack": can_go_back.as_bool(), "canGoForward": can_go_forward.as_bool() }),
                            );
                        }
                        Ok(())
                    },
                ));
                let mut token: i64 = 0;
                unsafe { let _ = core_webview.add_HistoryChanged(&hist_handler, &mut token); }

                // 5. DownloadStarting — 拦截下载，自定义保存路径，通知前端
                let dl_emit = emit_handle.clone();
                let dl_downloads = downloads.clone();
                let dl_next_id = next_download_id.clone();
                let dl_handler = DownloadStartingEventHandler::create(Box::new(
                    move |_sender: Option<ICoreWebView2>,
                          args: Option<ICoreWebView2DownloadStartingEventArgs>| {
                        if let Some(args) = args {
                            // 获取 DownloadOperation
                            let operation = match unsafe { args.DownloadOperation() } {
                                Ok(op) => op,
                                Err(_) => return Ok(()),
                            };

                            // 从 operation 读取元数据
                            let read_pwstr = |op: &ICoreWebView2DownloadOperation,
                                              getter: unsafe fn(&ICoreWebView2DownloadOperation, *mut PWSTR) -> windows::core::Result<()>| {
                                let mut raw = PWSTR::null();
                                unsafe {
                                    if getter(op, &mut raw).is_ok() {
                                        let s = raw.to_string().unwrap_or_default();
                                        windows::Win32::System::Com::CoTaskMemFree(Some(raw.as_ptr() as *const _));
                                        return s;
                                    }
                                }
                                String::new()
                            };

                            let uri = read_pwstr(&operation, |o, p| unsafe { o.Uri(p) });
                            let mime_type = read_pwstr(&operation, |o, p| unsafe { o.MimeType(p) });

                            // 从 URI 提取文件名
                            let filename = {
                                let parsed = url::Url::parse(&uri).ok();
                                let last_segment = parsed
                                    .as_ref()
                                    .and_then(|u| u.path_segments())
                                    .and_then(|mut seg| seg.next_back())
                                    .filter(|s| !s.is_empty())
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| "download".to_string());
                                urlencoding::decode(&last_segment)
                                    .map(|s| s.into_owned())
                                    .unwrap_or(last_segment)
                            };

                            // 构造保存路径：Downloads 文件夹 + 文件名
                            let download_dir = dirs::download_dir()
                                .unwrap_or_else(|| std::env::temp_dir());
                            let save_path = download_dir.join(&filename);
                            let save_path_str = save_path.to_string_lossy().to_string();

                            // 设置保存路径并标记为已处理（阻止默认下载 UI）
                            let path_hstring = HSTRING::from(&save_path_str);
                            unsafe {
                                let _ = args.SetResultFilePath(&path_hstring);
                                let _ = args.SetHandled(true);
                            }

                            let mut total_bytes: i64 = 0;
                            unsafe {
                                let _ = operation.TotalBytesToReceive(&mut total_bytes);
                            }

                            // 生成下载 ID
                            let dl_id = format!("dl-{}", dl_next_id.fetch_add(1, Ordering::SeqCst));

                            let info = DownloadInfo {
                                id: dl_id.clone(),
                                url: uri.clone(),
                                filename: filename.clone(),
                                mime_type: mime_type.clone(),
                                total_bytes,
                                received_bytes: 0,
                                state: "in_progress".to_string(),
                                save_path: save_path_str.clone(),
                            };

                            // 通知前端下载已开始
                            let _ = dl_emit.emit(
                                "browser-download-started",
                                serde_json::to_value(&info).unwrap_or(serde_json::json!({})),
                            );

                            // 注册 BytesReceivedChanged — 下载进度
                            let prog_emit = dl_emit.clone();
                            let prog_id = dl_id.clone();
                            let prog_handler = BytesReceivedChangedEventHandler::create(Box::new(
                                move |sender: Option<ICoreWebView2DownloadOperation>, _args| {
                                    if let Some(sender) = sender {
                                        let mut received: i64 = 0;
                                        let mut total: i64 = 0;
                                        unsafe {
                                            let _ = sender.BytesReceived(&mut received);
                                            let _ = sender.TotalBytesToReceive(&mut total);
                                        }
                                        let _ = prog_emit.emit(
                                            "browser-download-progress",
                                            serde_json::json!({ "id": prog_id, "receivedBytes": received, "totalBytes": total }),
                                        );
                                    }
                                    Ok(())
                                },
                            ));
                            let mut token: i64 = 0;
                            unsafe { let _ = operation.add_BytesReceivedChanged(&prog_handler, &mut token); }

                            // 注册 StateChanged — 下载状态变化
                            let state_emit = dl_emit.clone();
                            let state_id = dl_id.clone();
                            let state_downloads = dl_downloads.clone();
                            let state_handler = StateChangedEventHandler::create(Box::new(
                                move |sender: Option<ICoreWebView2DownloadOperation>, _args| {
                                    if let Some(sender) = sender {
                                        let mut dl_state = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_DOWNLOAD_STATE::default();
                                        unsafe {
                                            let _ = sender.State(&mut dl_state);
                                        }
                                        let state_str = match dl_state.0 {
                                            0 => "in_progress",
                                            1 => "interrupted",
                                            2 => "completed",
                                            _ => "unknown",
                                        };
                                        let _ = state_emit.emit(
                                            "browser-download-state-changed",
                                            serde_json::json!({ "id": state_id, "state": state_str }),
                                        );
                                        // 更新存储的 DownloadInfo
                                        if let Some(mut entry) = state_downloads.get_mut(&state_id) {
                                            entry.info.state = state_str.to_string();
                                            let mut received: i64 = 0;
                                            unsafe { let _ = sender.BytesReceived(&mut received); }
                                            entry.info.received_bytes = received;
                                        }
                                    }
                                    Ok(())
                                },
                            ));
                            let mut token: i64 = 0;
                            unsafe { let _ = operation.add_StateChanged(&state_handler, &mut token); }

                            // 存储 DownloadOperation
                            dl_downloads.insert(dl_id, DownloadEntry { operation, info });
                        }
                        Ok(())
                    },
                ));
                let mut token: i64 = 0;
                // DownloadStarting 在 ICoreWebView2_4 上，需要 cast
                if let Ok(cwv4) = core_webview.cast::<ICoreWebView2_4>() {
                    unsafe { let _ = cwv4.add_DownloadStarting(&dl_handler, &mut token); }
                }

                // 6. PermissionRequested — 权限管理（地理位置、通知、摄像头等默认拒绝，剪贴板允许）
                use webview2_com::PermissionRequestedEventHandler;
                use webview2_com::Microsoft::Web::WebView2::Win32::{
                    ICoreWebView2PermissionRequestedEventArgs,
                    COREWEBVIEW2_PERMISSION_KIND,
                    COREWEBVIEW2_PERMISSION_STATE,
                };
                let perm_handler = PermissionRequestedEventHandler::create(Box::new(
                    move |_sender: Option<ICoreWebView2>,
                          args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                        if let Some(args) = args {
                            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                            unsafe {
                                let _ = args.PermissionKind(&mut kind);
                                // 剪贴板读取权限允许，其他默认拒绝
                                let state = if kind.0 == 4 { // COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ = 4
                                    COREWEBVIEW2_PERMISSION_STATE(1) // ALLOW = 1
                                } else {
                                    COREWEBVIEW2_PERMISSION_STATE(2) // DENY = 2
                                };
                                let _ = args.SetState(state);
                            }
                        }
                        Ok(())
                    },
                ));
                let mut token: i64 = 0;
                unsafe { let _ = core_webview.add_PermissionRequested(&perm_handler, &mut token); }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = wv;
            }
        }

        child_webview
            .load_url(&native_url)
            .map_err(|e| format!("Failed to navigate browser tab: {}", e))?;
        NATIVE_BROWSER_WEBVIEWS.with(|webviews| {
            webviews.borrow_mut().insert(native_tab_id, child_webview);
        });
        Ok(())
        }) {
            self.tabs.remove(id);
            return Err(error);
        }

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
        if self.tabs.remove(id).is_some() {
            // 通过 label 获取子 WebView 并关闭
            remove_native_webview(app, id)?;
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
    pub fn set_tab_bounds(
        &self,
        app: &AppHandle,
        id: &str,
        left: f64,
        top: f64,
        width: f64,
        height: f64,
        visible: bool,
    ) -> Result<(), String> {
        if !self.tabs.contains_key(id) {
            return Err(format!("Tab {} not found", id));
        }
        with_native_webview(app, id, move |webview| {
            webview.set_visible(false).map_err(|error| error.to_string())?;
            webview
                .set_bounds(wry::Rect {
                    position: wry::dpi::LogicalPosition::new(left, top).into(),
                    size: wry::dpi::LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
                })
                .map_err(|error| error.to_string())?;
            if visible {
                webview.set_visible(true).map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }

    /// 隐藏除当前活动标签外的所有原生浏览器子 WebView。
    pub fn hide_tabs_except(&self, app: &AppHandle, active_id: Option<&str>) -> Result<(), String> {
        let ids = self
            .tabs
            .iter()
            .filter(|tab| Some(tab.key().as_str()) != active_id)
            .map(|tab| tab.key().clone())
            .collect::<Vec<_>>();

        for id in ids {
            with_native_webview(app, &id, |webview| {
                webview.set_visible(false).map_err(|error| error.to_string())
            })?;
        }
        Ok(())
    }

    pub fn navigate_tab(&self, app: &AppHandle, id: &str, url: &str) -> Result<(), String> {
        Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
        let url = url.to_string();
        let navigation_url = url.clone();
        with_native_webview(app, id, move |webview| {
            webview
                .load_url(&navigation_url)
                .map_err(|error| format!("Navigate failed: {}", error))
        })?;
        if let Some(mut tab) = self.tabs.get_mut(id) {
            tab.url = url;
        }
        Ok(())
    }

    /// 后退（通过 JS history.back()）
    pub fn go_back(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        with_native_webview(app, id, |webview| {
            webview
                .evaluate_script("if(window.history.length>1) window.history.back();")
                .map_err(|error| format!("Go back failed: {}", error))
        })
    }

    /// 前进（通过 JS history.forward()）
    pub fn go_forward(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        with_native_webview(app, id, |webview| {
            webview
                .evaluate_script("window.history.forward();")
                .map_err(|error| format!("Go forward failed: {}", error))
        })
    }

    /// 刷新（通过 JS location.reload()）
    pub fn reload(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        with_native_webview(app, id, |webview| {
            webview.reload().map_err(|error| format!("Reload failed: {}", error))
        })
    }

    /// 设置页面缩放（0.25 ~ 5.0）
    pub fn set_zoom(&self, app: &AppHandle, id: &str, zoom_factor: f64) -> Result<(), String> {
        let clamped = zoom_factor.clamp(0.25, 5.0);
        with_native_webview(app, id, move |webview| {
            webview
                .zoom(clamped)
                .map_err(|error| format!("Set zoom failed: {}", error))
        })?;
        if let Some(mut tab) = self.tabs.get_mut(id) {
            tab.zoom_factor = clamped;
        }
        Ok(())
    }

    /// 获取当前缩放
    pub fn get_zoom(&self, id: &str) -> Result<f64, String> {
        let tab = self
            .tabs
            .get(id)
            .ok_or_else(|| format!("Tab {} not found", id))?;
        Ok(tab.zoom_factor)
    }

    /// 打印当前页面
    pub fn print_page(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        with_native_webview(app, id, |webview| {
            webview.print().map_err(|error| format!("Print failed: {}", error))
        })
    }

    /// 在指定标签的 WebView 中执行 JS 代码
    pub fn eval_script(&self, app: &AppHandle, id: &str, script: &str) -> Result<(), String> {
        let script = script.to_string();
        with_native_webview(app, id, move |webview| {
            webview
                .evaluate_script(&script)
                .map_err(|error| format!("Eval failed: {}", error))
        })
    }

    /// WebView 内部 URL 变化回调
    pub fn clear_cache(&self, app: &AppHandle) -> Result<(), String> {
        let id = self
            .tabs
            .iter()
            .next()
            .map(|tab| tab.key().clone())
            .ok_or_else(|| "No browser tab found".to_string())?;

        with_native_webview(app, &id, |webview| {
            #[cfg(target_os = "windows")]
            {
                use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
                use windows::core::HSTRING;

                let core_webview = webview.webview();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(
                    Box::new(|_result: windows::core::Result<()>, _json: String| Ok(())),
                );
                unsafe {
                    let _ = core_webview.CallDevToolsProtocolMethod(
                        &HSTRING::from("Network.clearBrowserCache"),
                        &HSTRING::from("{}"),
                        &handler,
                    );
                }
            }
            Ok(())
        })
    }

    pub async fn eval_script_result(
        &self,
        app: &AppHandle,
        id: &str,
        script: &str,
    ) -> Result<serde_json::Value, String> {
        let script = script.to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Arc::new(Mutex::new(Some(tx)));
        with_native_webview(app, id, move |webview| {
            let tx = tx.clone();
            webview
                .evaluate_script_with_callback(&script, move |result| {
                    if let Some(tx) = tx.lock().ok().and_then(|mut sender| sender.take()) {
                        let _ = tx.send(result);
                    }
                })
                .map_err(|error| format!("Eval failed: {}", error))
        })?;

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
            .await
            .map_err(|_| "Timed out waiting for browser script result".to_string())?
            .map_err(|_| "Browser script result channel closed".to_string())?;
        decode_script_json(&result).ok_or_else(|| "Browser script returned invalid JSON".to_string())
    }

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

    // ── 下载管理 ──

    /// 取消下载
    pub fn cancel_download(&self, id: &str) -> Result<(), String> {
        let entry = self.downloads.get(id)
            .ok_or_else(|| format!("Download {} not found", id))?;
        #[cfg(target_os = "windows")]
        {
            unsafe { let _ = entry.operation.Cancel(); }
        }
        if let Some(mut entry) = self.downloads.get_mut(id) {
            entry.info.state = "cancelled".to_string();
        }
        Ok(())
    }

    /// 暂停下载
    pub fn pause_download(&self, id: &str) -> Result<(), String> {
        let entry = self.downloads.get(id)
            .ok_or_else(|| format!("Download {} not found", id))?;
        #[cfg(target_os = "windows")]
        {
            unsafe { let _ = entry.operation.Pause(); }
        }
        Ok(())
    }

    /// 恢复下载
    pub fn resume_download(&self, id: &str) -> Result<(), String> {
        let entry = self.downloads.get(id)
            .ok_or_else(|| format!("Download {} not found", id))?;
        #[cfg(target_os = "windows")]
        {
            unsafe { let _ = entry.operation.Resume(); }
        }
        Ok(())
    }

    /// 列出所有下载
    pub fn list_downloads(&self) -> Vec<DownloadInfo> {
        self.downloads.iter().map(|e| e.info.clone()).collect()
    }

    /// 获取下载信息（含 save_path 用于打开/显示）
    pub fn get_download_info(&self, id: &str) -> Result<DownloadInfo, String> {
        self.downloads.get(id)
            .map(|e| e.info.clone())
            .ok_or_else(|| format!("Download {} not found", id))
    }

    /// 移除已完成的下载记录
    pub fn remove_download(&self, id: &str) -> Result<(), String> {
        self.downloads.remove(id)
            .map(|_| ())
            .ok_or_else(|| format!("Download {} not found", id))
    }

    // ── 隐私安全 ──

    /// 获取当前页面的 Cookie（通过 JS document.cookie，仅返回非 HttpOnly 的 cookie）
    /// 结果通过 Tauri event "browser-cookies-result" 回传
    pub fn get_cookies(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let tab_id = id.to_string();
        let emit_handle = app.clone();
        let js = r#"
            (function() {
                return JSON.stringify((document.cookie || '').split(';').filter(Boolean).map(function(pair) {
                    var index = pair.indexOf('=');
                    return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: location.hostname, path: '/' };
                }));
            })()
        "#.to_string();
        // 闭包需要 'static，使用 emit_handle 而非 app
        with_native_webview(app, id, move |webview| {
            webview
                .evaluate_script_with_callback(&js, move |result| {
                    let cookies = decode_script_json(&result)
                        .unwrap_or_else(|| serde_json::json!([]));
                    let _ = emit_handle.emit(
                        "browser-cookies-result",
                        serde_json::json!({ "id": tab_id, "cookies": cookies }),
                    );
                })
                .map_err(|error| format!("Get cookies failed: {}", error))
        })
    }

    /// 清除当前页面的 Cookie（通过 JS 设置过期）
    pub fn clear_cookies(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let js = r#"
            (function() {
                var cookies = document.cookie.split(';');
                cookies.forEach(function(pair) {
                    var idx = pair.indexOf('=');
                    var name = idx > 0 ? pair.substring(0, idx).trim() : pair.trim();
                    if (name) {
                        // 清除当前域、路径、及父域的 cookie
                        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
                        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=' + location.hostname;
                        document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.' + location.hostname;
                    }
                });
            })();
        "#;
        let js = js.to_string();
        with_native_webview(app, id, move |webview| {
            webview
                .evaluate_script(&js)
                .map_err(|error| format!("Clear cookies failed: {}", error))
        })
    }

    /// 切换广告拦截状态（运行时注入或移除广告拦截脚本）
    pub fn set_ad_block_enabled(&self, app: &AppHandle, id: &str, enabled: bool) -> Result<(), String> {
        if enabled {
            // 注入广告拦截脚本
            let js = AD_BLOCK_SCRIPT;
            with_native_webview(app, id, move |webview| {
                webview
                    .evaluate_script(js)
                    .map_err(|error| format!("Enable ad block failed: {}", error))
            })?;
        } else {
            // 移除广告拦截样式
            let js = r#"
                (function() {
                    var style = document.getElementById('mona-ad-block-style');
                    if (style) style.parentNode.removeChild(style);
                    window.__mona_ad_block_injected = false;
                })();
            "#;
            let js = js.to_string();
            with_native_webview(app, id, move |webview| {
                webview
                    .evaluate_script(&js)
                    .map_err(|error| format!("Disable ad block failed: {}", error))
            })?;
        }
        Ok(())
    }

    /// 切换标签静音状态（通过 WebView2 的 IsMuted 属性）
    pub fn set_muted(&self, app: &AppHandle, id: &str, muted: bool) -> Result<(), String> {
        if let Some(mut tab) = self.tabs.get_mut(id) {
            tab.is_muted = muted;
        }
        with_native_webview(app, id, move |wv| {
            #[cfg(target_os = "windows")]
            {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
                use windows::core::Interface;
                let controller = wv.controller();
                let core_webview = unsafe { controller.CoreWebView2().unwrap() };
                // IsMuted 在 ICoreWebView2_8 上
                if let Ok(cwv8) = core_webview.cast::<ICoreWebView2_8>() {
                    unsafe { let _ = cwv8.SetIsMuted(muted); }
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = wv;
                let _ = muted;
            }
            Ok(())
        })?;
        Ok(())
    }

    /// 获取标签静音状态
    pub fn is_muted(&self, id: &str) -> Result<bool, String> {
        self.tabs
            .get(id)
            .map(|t| t.is_muted)
            .ok_or_else(|| format!("Tab {} not found", id))
    }

    /// 获取标签无痕状态
    pub fn is_incognito(&self, id: &str) -> Result<bool, String> {
        self.tabs
            .get(id)
            .map(|t| t.is_incognito)
            .ok_or_else(|| format!("Tab {} not found", id))
    }

    // ── 高级功能 ──

    /// 打开开发者工具
    pub fn open_devtools(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        with_native_webview(app, id, move |wv| {
            #[cfg(target_os = "windows")]
            {
                let controller = wv.controller();
                let core_webview = unsafe { controller.CoreWebView2().unwrap() };
                unsafe { let _ = core_webview.OpenDevToolsWindow(); }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = wv;
            }
            Ok(())
        })?;
        Ok(())
    }

    /// 切换暗色模式（注入或移除暗色模式 CSS）
    pub fn set_dark_mode(&self, app: &AppHandle, id: &str, enabled: bool) -> Result<(), String> {
        if enabled {
            // 注入暗色模式 CSS（反转颜色，但保留图片/视频）
            let js = r#"
                (function() {
                    if (document.getElementById('mona-dark-mode-style')) return;
                    var style = document.createElement('style');
                    style.id = 'mona-dark-mode-style';
                    style.textContent = `
                        html { filter: invert(1) hue-rotate(180deg) !important; }
                        img, picture, video, iframe, canvas, svg { filter: invert(1) hue-rotate(180deg) !important; }
                        * { background-color: inherit !important; }
                    `;
                    (document.head || document.documentElement).appendChild(style);
                })();
            "#;
            let js = js.to_string();
            with_native_webview(app, id, move |webview| {
                webview
                    .evaluate_script(&js)
                    .map_err(|error| format!("Enable dark mode failed: {}", error))
            })?;
        } else {
            // 移除暗色模式样式
            let js = r#"
                (function() {
                    var style = document.getElementById('mona-dark-mode-style');
                    if (style) style.parentNode.removeChild(style);
                })();
            "#;
            let js = js.to_string();
            with_native_webview(app, id, move |webview| {
                webview
                    .evaluate_script(&js)
                    .map_err(|error| format!("Disable dark mode failed: {}", error))
            })?;
        }
        Ok(())
    }

    /// 获取页面元信息（用于分享/二维码）
    pub fn get_page_info(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let tab_id = id.to_string();
        let emit_handle = app.clone();
        let js = r#"
            (function() {
                var description = document.querySelector('meta[name="description"]');
                var ogImage = document.querySelector('meta[property="og:image"]');
                return JSON.stringify({
                    url: location.href,
                    title: document.title || '',
                    description: description ? description.getAttribute('content') || '' : '',
                    ogImage: ogImage ? ogImage.getAttribute('content') || '' : ''
                });
            })()
        "#.to_string();
        with_native_webview(app, id, move |webview| {
            webview
                .evaluate_script_with_callback(&js, move |result| {
                    let info = decode_script_json(&result)
                        .unwrap_or_else(|| serde_json::json!({}));
                    let _ = emit_handle.emit(
                        "browser-page-info-result",
                        serde_json::json!({ "id": tab_id, "info": info }),
                    );
                })
                .map_err(|error| format!("Get page info failed: {}", error))
        })
    }
}
