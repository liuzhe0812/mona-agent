pub mod commands;
pub mod downloads;
pub mod storage;
pub mod tab;

use dashmap::DashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tab::{BrowserTab, CreateTabResult};
use tauri::{
    webview::NewWindowResponse,
    AppHandle, Emitter, Manager, WebviewBuilder, WebviewUrl,
};
use url::Url;

pub const CDP_PORT: u16 = 9300;

/// 打开内置页面（下载记录/历史记录），由浏览器 WebView 内的快捷键调用
#[tauri::command]
pub async fn browser_open_internal_page(app: AppHandle, kind: String) -> Result<(), String> {
    app.emit("browser-open-internal-page", kind)
        .map_err(|e| e.to_string())
}

pub fn configure_webview2_cdp() {
    #[cfg(target_os = "windows")]
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            format!("--remote-debugging-port={CDP_PORT}"),
        );
    }
}

fn browser_initialization_script(id: &str) -> String {
    let id = serde_json::to_string(id).expect("browser tab id is serializable");
    // Inject a hover-reveal scrollbar style so web pages match Mona's UI spec:
    // thumb is hidden by default and only fades in when the cursor is inside
    // the scrollable region. Uses neutral gray (works on both light and dark
    // sites) instead of Mona's CSS variables, which don't exist in page scope.
    format!(
        r#"window.__mona_tab_id = {id};
(function () {{
  if (window.__mona_scrollbar_style) return;
  window.__mona_scrollbar_style = true;
  var css = [
    'html {{ scrollbar-width: thin; scrollbar-color: transparent transparent; transition: scrollbar-color 0.2s ease; }}',
    'html:hover {{ scrollbar-color: rgba(128,128,128,0.4) transparent; }}',
    '::-webkit-scrollbar {{ width: 8px; height: 8px; }}',
    '::-webkit-scrollbar-track {{ background: transparent; }}',
    '::-webkit-scrollbar-thumb {{ background-color: transparent; border-radius: 9999px; border: 2px solid transparent; background-clip: padding-box; transition: background-color 0.2s ease; }}',
    ':hover::-webkit-scrollbar-thumb {{ background-color: rgba(128,128,128,0.4); }}',
    ':hover::-webkit-scrollbar-thumb:hover {{ background-color: rgba(128,128,128,0.6); }}'
  ].join('\n');
  var style = document.createElement('style');
  style.setAttribute('data-mona-scrollbar', 'true');
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // 拦截 Ctrl+J（下载记录）和 Ctrl+H（历史记录），避免 WebView2 弹出原生界面
  window.addEventListener('keydown', function (e) {{
    if (!(e.ctrlKey || e.metaKey)) return;
    var key = e.key.toLowerCase();
    if (key === 'j' || key === 'h') {{
      e.preventDefault();
      e.stopPropagation();
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
        window.__TAURI_INTERNALS__.invoke('browser_open_internal_page', {{ kind: key === 'j' ? 'downloads' : 'history' }});
      }}
    }}
  }}, true);
}})();
"#
    )
}

fn next_available_download_path(directory: &Path, filename: &str) -> PathBuf {
    let filename = Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("download");
    let candidate = directory.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(filename);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1.. {
        let name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = directory.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

async fn remove_native_webview(app: &AppHandle, id: &str) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&format!("browser-{}", id)) {
        webview.close().map_err(|error| error.to_string())?;

        // Webview::close only queues the runtime close message. Wait for a
        // following main-thread task so a subsequent add_child cannot race
        // the WebView2 controller teardown.
        let window = app
            .get_window("main")
            .ok_or_else(|| "Main window not found".to_string())?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(());
            })
            .map_err(|error| error.to_string())?;
        match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
            Ok(Ok(_)) => {}
            Ok(Err(_)) => {
                return Err("Browser tab close barrier was cancelled".to_string());
            }
            Err(_) => {
                return Err("Timed out waiting for browser tab to close".to_string());
            }
        }
    }
    Ok(())
}

fn get_browser_webview(app: &AppHandle, id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&format!("browser-{}", id))
        .ok_or_else(|| format!("Browser tab {} not found", id))
}

fn decode_script_json(result: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<String>(result)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .or_else(|| serde_json::from_str(result).ok())
}

#[cfg(target_os = "windows")]
fn read_webview2_string(
    getter: impl FnOnce(*mut windows_strings::PWSTR) -> windows::core::Result<()>,
) -> String {
    let mut raw = windows_strings::PWSTR::null();
    if getter(&mut raw).is_err() {
        return String::new();
    }
    let value = unsafe { raw.to_string() }.unwrap_or_default();
    unsafe {
        windows::Win32::System::Com::CoTaskMemFree(Some(raw.as_ptr().cast()));
    }
    value
}

fn emit_browser_event(app: AppHandle, event: &'static str, payload: serde_json::Value) {
    tauri::async_runtime::spawn(async move {
        let _ = app.emit(event, payload);
    });
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
#[serde(rename_all = "camelCase")]
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
    use super::{
        browser_initialization_script, decode_script_json, next_available_download_path,
        DownloadInfo, CDP_PORT,
    };

    #[test]
    fn script_result_decodes_json_string_values() {
        let result = decode_script_json(r#""[{\"name\":\"session\"}]""#).unwrap();
        assert_eq!(result[0]["name"], "session");
    }

    #[test]
    fn download_payload_matches_the_frontend_contract() {
        let value = serde_json::to_value(DownloadInfo {
            id: "dl-1".to_string(),
            url: "https://example.com/file".to_string(),
            filename: "file".to_string(),
            mime_type: "application/octet-stream".to_string(),
            total_bytes: 2,
            received_bytes: 1,
            state: "in_progress".to_string(),
            save_path: "file".to_string(),
        })
        .unwrap();

        assert_eq!(value["totalBytes"], 2);
        assert_eq!(value["receivedBytes"], 1);
        assert_eq!(value["savePath"], "file");
        assert!(value.get("total_bytes").is_none());
    }

    #[test]
    fn browser_webviews_start_hidden_and_offscreen() {
        let source = include_str!("mod.rs");
        let managed_builder = ["WebviewBuilder", "::new"].concat();
        let offscreen = ["LogicalPosition::new(", "-9999, -9999)"].concat();
        let hidden = ["child_webview", ".hide()"].concat();

        assert!(source.contains(&managed_builder));
        assert!(source.contains(&offscreen));
        assert!(source.contains(&hidden));
    }

    #[test]
    fn browser_webview_lifecycle_is_serialized_and_close_is_acknowledged() {
        let source = include_str!("mod.rs");
        let close = source
            .split("async fn remove_native_webview")
            .nth(1)
            .and_then(|source| source.split("fn get_browser_webview").next())
            .unwrap();

        assert!(source.contains("lifecycle: tokio::sync::Mutex<()>"));
        assert!(source.matches("self.lifecycle.lock().await").count() >= 2);
        assert!(close.contains("run_on_main_thread"));
        assert!(close.contains("tokio::time::timeout"));
    }

    #[test]
    fn browser_webviews_share_the_main_webview2_environment() {
        let source = include_str!("mod.rs");

        assert!(source.contains("get_webview(\"main\")"));
        assert!(source.contains("with_environment(webview.environment())"));
    }

    #[test]
    fn browser_downloads_have_one_tab_independent_native_owner() {
        let source = include_str!("mod.rs");
        let implementation = source.rsplit("impl BrowserState").next().unwrap();
        let native_handler = ["DownloadStarting", "EventHandler::create"].concat();
        let managed_hook = [".on_", "download("].concat();

        assert_eq!(implementation.matches(&native_handler).count(), 1);
        assert!(!implementation.contains(&managed_hook));
        assert!(implementation.contains("operation: Some(operation.clone())"));
    }

    #[test]
    fn browser_new_windows_use_the_managed_webview_hook() {
        let source = include_str!("mod.rs");
        let duplicate_handler = ["NewWindowRequested", "EventHandler"].concat();

        assert!(source.contains(".on_new_window(move"));
        assert!(!source.contains(&duplicate_handler));
    }

    #[test]
    fn visible_bounds_updates_do_not_hide_the_webview() {
        let source = include_str!("mod.rs");
        let bounds = source
            .split("pub async fn set_tab_bounds")
            .nth(1)
            .and_then(|source| source.split("pub async fn hide_tabs_except").next())
            .unwrap();

        assert!(!bounds.contains("webview.hide()"));
    }

    #[test]
    fn browser_tabs_share_cdp_port_and_have_safe_page_markers() {
        assert_eq!(CDP_PORT, 9300);
        assert_eq!(
            browser_initialization_script("tab-'\"-1"),
            "window.__mona_tab_id = \"tab-'\\\"-1\";"
        );
    }

    #[test]
    fn downloads_do_not_overwrite_existing_files() {
        let directory = std::env::temp_dir().join(format!(
            "mona-browser-download-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let existing = directory.join("report.pdf");
        std::fs::write(&existing, b"existing").unwrap();

        assert_eq!(
            next_available_download_path(&directory, "report.pdf"),
            directory.join("report (1).pdf")
        );

        std::fs::remove_file(existing).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}

/// 存储下载操作 COM 接口（用于 cancel/pause/resume）
/// WebView2 COM 接口是 MTA 兼容的，可以安全跨线程访问
#[cfg(target_os = "windows")]
pub struct DownloadEntry {
    pub operation:
        Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation>,
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

/// WebView2 COM 接口是 MTA 兼容的，可安全跨线程访问
/// 用于在 Tauri async_runtime 中持有 DownloadStarting 事件参数与 Deferral
#[cfg(target_os = "windows")]
struct DownloadStartingArgsSend {
    args: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadStartingEventArgs,
    deferral: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral,
    operation: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
}
#[cfg(target_os = "windows")]
unsafe impl Send for DownloadStartingArgsSend {}
#[cfg(target_os = "windows")]
unsafe impl Sync for DownloadStartingArgsSend {}

#[cfg(target_os = "windows")]
impl DownloadStartingArgsSend {
    /// 在文件保存对话框完成后调用：根据用户选择的路径完成下载启动流程
    fn finish(
        self,
        save_path: Option<PathBuf>,
        fallback_filename: &str,
        downloads_dir: &Path,
        downloads: Arc<DashMap<String, DownloadEntry>>,
        next_id: Arc<AtomicU64>,
        emit: AppHandle,
        uri: String,
        mime_type: String,
    ) {
        use windows::core::HSTRING;
        let Self {
            args,
            deferral,
            operation,
        } = self;
        let save_path = match save_path {
            Some(p) => p,
            None => {
                // 用户取消对话框 → 取消下载
                unsafe {
                    let _ = args.SetCancel(true);
                    let _ = deferral.Complete();
                }
                return;
            }
        };
        let save_path = if save_path.exists() {
            next_available_download_path(
                save_path.parent().unwrap_or(downloads_dir),
                save_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(fallback_filename),
            )
        } else {
            save_path
        };
        unsafe {
            if let Err(error) = args.SetResultFilePath(
                &HSTRING::from(save_path.to_string_lossy().as_ref()),
            ) {
                log::error!("[DownloadStarting] SetResultFilePath failed: {error}");
                let _ = args.SetCancel(true);
                let _ = deferral.Complete();
                return;
            }
            if let Err(error) = args.SetHandled(true) {
                log::error!("[DownloadStarting] SetHandled failed: {error}");
                let _ = args.SetCancel(true);
                let _ = deferral.Complete();
                return;
            }
        }
        let mut total_bytes = 0;
        unsafe {
            let _ = operation.TotalBytesToReceive(&mut total_bytes);
        }
        let id = format!("dl-{}", next_id.fetch_add(1, Ordering::SeqCst));
        let info = DownloadInfo {
            id: id.clone(),
            url: uri,
            filename: save_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("download")
                .to_string(),
            mime_type,
            total_bytes,
            received_bytes: 0,
            state: "in_progress".to_string(),
            save_path: save_path.to_string_lossy().to_string(),
        };
        downloads.insert(
            id.clone(),
            DownloadEntry {
                operation: Some(operation.clone()),
                info: info.clone(),
            },
        );
        let _ = emit.emit("browser-download-started", info);
        register_download_progress_handlers(operation, emit, downloads, id);
        unsafe {
            let _ = deferral.Complete();
        }
    }
}

/// 注册 BytesReceivedChanged 和 StateChanged 事件处理器（进度推送 + 状态更新）
#[cfg(target_os = "windows")]
fn register_download_progress_handlers(
    operation: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
    emit: AppHandle,
    downloads: Arc<DashMap<String, DownloadEntry>>,
    id: String,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED,
        COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
        ICoreWebView2DownloadOperation,
    };
    use webview2_com::{BytesReceivedChangedEventHandler, StateChangedEventHandler};
    let progress_emit = emit.clone();
    let progress_downloads = downloads.clone();
    let progress_id = id.clone();
    let last_progress_ms = Arc::new(AtomicU64::new(0));
    let progress_handler = BytesReceivedChangedEventHandler::create(Box::new(
        move |sender: Option<ICoreWebView2DownloadOperation>, _args| {
            let Some(sender) = sender else {
                return Ok(());
            };
            let mut received = 0;
            let mut total = 0;
            unsafe {
                let _ = sender.BytesReceived(&mut received);
                let _ = sender.TotalBytesToReceive(&mut total);
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let previous = last_progress_ms.load(Ordering::Relaxed);
            let finished = total > 0 && received >= total;
            if !finished && now.saturating_sub(previous) < 250 {
                return Ok(());
            }
            if last_progress_ms
                .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_err()
            {
                return Ok(());
            }
            if let Some(mut entry) = progress_downloads.get_mut(&progress_id) {
                entry.info.received_bytes = received;
                entry.info.total_bytes = total;
            }
            let _ = progress_emit.emit(
                "browser-download-progress",
                serde_json::json!({
                    "id": progress_id,
                    "receivedBytes": received,
                    "totalBytes": total,
                }),
            );
            Ok(())
        },
    ));
    let mut token = 0;
    unsafe {
        let _ = operation.add_BytesReceivedChanged(&progress_handler, &mut token);
    }

    let state_emit = emit;
    let state_downloads = downloads;
    let state_id = id;
    let state_handler = StateChangedEventHandler::create(Box::new(
        move |sender: Option<ICoreWebView2DownloadOperation>, _args| {
            let Some(sender) = sender else {
                return Ok(());
            };
            let mut native_state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
            let mut received = 0;
            let mut total = 0;
            unsafe {
                sender.State(&mut native_state)?;
                let _ = sender.BytesReceived(&mut received);
                let _ = sender.TotalBytesToReceive(&mut total);
            }
            let mut state = if native_state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                "completed"
            } else if native_state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
                "in_progress"
            } else {
                "interrupted"
            }
            .to_string();
            if let Some(mut entry) = state_downloads.get_mut(&state_id) {
                if entry.info.state == "cancelled" {
                    state = "cancelled".to_string();
                }
                entry.info.received_bytes = received;
                entry.info.total_bytes = total;
                entry.info.state = state.clone();
                if state == "completed" || state == "cancelled" {
                    entry.operation = None;
                }
            }
            let _ = state_emit.emit(
                "browser-download-progress",
                serde_json::json!({
                    "id": state_id,
                    "receivedBytes": received,
                    "totalBytes": total,
                }),
            );
            let _ = state_emit.emit(
                "browser-download-state-changed",
                serde_json::json!({ "id": state_id, "state": state }),
            );
            Ok(())
        },
    ));
    let mut token = 0;
    unsafe {
        let _ = operation.add_StateChanged(&state_handler, &mut token);
    }
}

pub struct BrowserState {
    tabs: Arc<DashMap<String, BrowserTab>>,
    downloads: Arc<DashMap<String, DownloadEntry>>,
    next_download_id: Arc<AtomicU64>,
    lifecycle: tokio::sync::Mutex<()>,
}

impl BrowserState {
    pub fn new() -> Self {
        Self {
            tabs: Arc::new(DashMap::new()),
            downloads: Arc::new(DashMap::new()),
            next_download_id: Arc::new(AtomicU64::new(1)),
            lifecycle: tokio::sync::Mutex::new(()),
        }
    }

    /// 创建浏览器标签（在 Rust 侧创建 WebView，配置 on_navigation 允许外部导航）
    pub async fn create_tab(
        &self,
        app: &AppHandle,
        id: &str,
        url: &str,
        is_incognito: bool,
        ad_block_enabled: bool,
    ) -> Result<CreateTabResult, String> {
        let _lifecycle_guard = self.lifecycle.lock().await;
        let cdp_port = CDP_PORT;
        let webview_label = format!("browser-{}", id);

        // A tab ID owns exactly one native WebView for its whole lifetime.
        // Replacing a duplicate here can overlap WebView2 teardown and creation.
        if self.tabs.contains_key(id) || app.get_webview(&webview_label).is_some() {
            return Err(format!("Browser tab {id} already exists"));
        }

        let parsed_url: Url = url
            .parse()
            .map_err(|e| format!("Invalid URL: {}", e))?;

        // 导航事件可能在首次 load_url 后立即抵达；先登记元数据，确保事件能更新正确的标签。
        let tab = BrowserTab {
            id: id.to_string(),
            title: "New Tab".to_string(),
            url: url.to_string(),
            cdp_port,
            webview_label: webview_label.clone(),
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
        let tab_id = id.to_string();
        let tab_id_events = tab_id.clone();
        let download_events = self.downloads.clone();
        let download_event_ids = self.next_download_id.clone();
        let download_event_app = app.clone();
        let new_window_app = app.clone();
        let new_window_source_id = id.to_string();
        let title_app = app.clone();
        let title_tab_id = id.to_string();

        // 仅在需要时注入广告拦截脚本；浏览器页面不注入应用桥接代码。
        let init_script = ad_block_enabled.then_some(AD_BLOCK_SCRIPT);
        let window = app
            .get_window("main")
            .ok_or_else(|| "Main window not found".to_string())?;
        let webview_builder = WebviewBuilder::new(&webview_label, WebviewUrl::External(parsed_url))
            .initialization_script(browser_initialization_script(id))
            .incognito(is_incognito)
            .on_new_window(move |url, _features| {
                emit_browser_event(
                    new_window_app.clone(),
                    "browser-open-new-tab",
                    serde_json::json!({
                        "sourceTabId": new_window_source_id,
                        "url": url.to_string(),
                    }),
                );
                NewWindowResponse::Deny
            })
            .on_document_title_changed(move |_webview, title| {
                if !title.is_empty() {
                    emit_browser_event(
                        title_app.clone(),
                        "browser-tab-title-changed",
                        serde_json::json!({ "id": title_tab_id, "title": title }),
                    );
                }
            })
            .on_navigation(move |url| {
                let allowed = matches!(url.scheme(), "https" | "http" | "blob" | "data")
                    || url.as_str() == "about:blank";
                if allowed {
                    if let Some(mut tab) = tabs.get_mut(&tab_id) {
                        tab.url = url.to_string();
                    }
                    emit_browser_event(
                        app_handle.clone(),
                        "browser-url-changed",
                        serde_json::json!({ "id": tab_id, "url": url.to_string() }),
                    );
                    emit_browser_event(
                        app_handle.clone(),
                        "browser-nav-started",
                        serde_json::json!({ "id": tab_id, "url": url.to_string() }),
                    );
                }
                allowed
            });

        let webview_builder = match init_script {
            Some(script) => webview_builder.initialization_script(script),
            None => webview_builder,
        };

        #[cfg(target_os = "windows")]
        let child_result = {
            let main = app
                .get_webview("main")
                .ok_or_else(|| "Main webview not found".to_string())?;
            let (tx, rx) = tokio::sync::oneshot::channel();
            main.with_webview(move |webview| {
                let result = window
                    .add_child(
                        webview_builder.with_environment(webview.environment()),
                        tauri::LogicalPosition::new(-9999, -9999),
                        tauri::LogicalSize::new(1, 1),
                    )
                    .map_err(|error| error.to_string());
                let _ = tx.send(result);
            })
            .map_err(|error| error.to_string())?;
            match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
                Ok(Ok(r)) => r,
                Ok(Err(_)) => {
                    return Err("Browser tab creation was cancelled".to_string());
                }
                Err(_) => {
                    return Err("Timed out creating browser tab".to_string());
                }
            }
        };

        #[cfg(not(target_os = "windows"))]
        let child_result = window
            .add_child(
                webview_builder,
                tauri::LogicalPosition::new(-9999, -9999),
                tauri::LogicalSize::new(1, 1),
            )
            .map_err(|error| error.to_string());

        let child_webview = match child_result {
            Ok(webview) => webview,
            Err(error) => {
                self.tabs.remove(id);
                return Err(format!("Failed to create browser tab: {error}"));
            }
        };
        if let Err(error) = child_webview.hide() {
            let _ = child_webview.close();
            self.tabs.remove(id);
            return Err(error.to_string());
        }

        // Tauri 没有历史状态 Hook，且页面加载 Hook 不提供导航成功状态；
        // 这里只保留这两个 WebView2 事件的唯一处理器。
        let emit_handle = app.clone();
        if let Err(error) = child_webview.with_webview(move |wv| {
            #[cfg(target_os = "windows")]
            {
                use webview2_com::Microsoft::Web::WebView2::Win32::{
                    ICoreWebView2,
                    ICoreWebView2_4,
                    ICoreWebView2DownloadStartingEventArgs,
                    ICoreWebView2NavigationCompletedEventArgs,
                };
                use webview2_com::{
                    DownloadStartingEventHandler,
                    NavigationCompletedEventHandler,
                    HistoryChangedEventHandler,
                };
                use windows::core::{Interface, IUnknown};

                let controller = wv.controller();
                let core_webview = unsafe { controller.CoreWebView2().unwrap() };

                // NavigationCompleted — 加载完成/失败
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
                            emit_browser_event(
                                nav_emit.clone(),
                                "browser-nav-completed",
                                serde_json::json!({ "id": nav_tab_id, "success": success.as_bool() }),
                            );
                        }
                        Ok(())
                    },
                ));
                let mut token: i64 = 0;
                unsafe { let _ = core_webview.add_NavigationCompleted(&nav_handler, &mut token); }

                // HistoryChanged — 后退/前进按钮状态
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
                            emit_browser_event(
                                hist_emit.clone(),
                                "browser-history-changed",
                                serde_json::json!({ "id": hist_tab_id, "canGoBack": can_go_back.as_bool(), "canGoForward": can_go_forward.as_bool() }),
                            );
                        }
                        Ok(())
                    },
                ));
                let mut token: i64 = 0;
                unsafe { let _ = core_webview.add_HistoryChanged(&hist_handler, &mut token); }

                // PermissionRequested — 权限管理（地理位置、通知、摄像头等默认拒绝，剪贴板允许）
                // DownloadStarting is the single download owner. Its COM
                // operation outlives the source tab, matching browser behavior.
                let dl_emit = download_event_app.clone();
                let dl_downloads = download_events.clone();
                let dl_next_id = download_event_ids.clone();
                let app_dialog = download_event_app.clone();
                let dl_handler = DownloadStartingEventHandler::create(Box::new(
                    move |_sender: Option<ICoreWebView2>,
                          args: Option<ICoreWebView2DownloadStartingEventArgs>| {
                        let Some(args) = args else {
                            log::warn!("[DownloadStarting] args is None");
                            return Ok(());
                        };
                        let operation = match unsafe { args.DownloadOperation() } {
                            Ok(op) => op,
                            Err(error) => {
                                log::error!("[DownloadStarting] DownloadOperation failed: {error}");
                                return Err(error);
                            }
                        };
                        let uri = read_webview2_string(|raw| unsafe { operation.Uri(raw) });
                        let mime_type =
                            read_webview2_string(|raw| unsafe { operation.MimeType(raw) });
                        let suggested_path =
                            read_webview2_string(|raw| unsafe { args.ResultFilePath(raw) });
                        let fallback = url::Url::parse(&uri)
                            .ok()
                            .and_then(|url| {
                                url.path_segments()
                                    .and_then(|mut segments| segments.next_back())
                                    .map(str::to_owned)
                            })
                            .filter(|name| !name.is_empty())
                            .and_then(|name| {
                                urlencoding::decode(&name)
                                    .ok()
                                    .map(|value| value.into_owned())
                            })
                            .unwrap_or_else(|| "download".to_string());
                        let filename = Path::new(&suggested_path)
                            .file_name()
                            .and_then(|name| name.to_str())
                            .filter(|name| !name.is_empty())
                            .unwrap_or(&fallback)
                            .to_string();

                        // 用 Deferral 推迟完成，弹出文件保存对话框，让用户选择路径（对齐 Chrome）
                        let deferral = match unsafe { args.GetDeferral() } {
                            Ok(deferral) => deferral,
                            Err(error) => {
                                log::error!("[DownloadStarting] GetDeferral failed: {error}");
                                return Err(error);
                            }
                        };
                        let send_args = DownloadStartingArgsSend {
                            args,
                            deferral,
                            operation: operation.clone(),
                        };
                        let uri_for_dialog = uri.clone();
                        let mime_for_dialog = mime_type.clone();
                        let dl_downloads_for_dialog = dl_downloads.clone();
                        let dl_next_id_for_dialog = dl_next_id.clone();
                        let dl_emit_for_dialog = dl_emit.clone();
                        let filename_for_dialog = filename.clone();
                        let dialog_app = app_dialog.clone();
                        tauri::async_runtime::spawn(async move {
                            use tauri_plugin_dialog::DialogExt;
                            let downloads_dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
                            let dialog = dialog_app
                                .dialog()
                                .file()
                                .set_file_name(&filename_for_dialog)
                                .set_directory(&downloads_dir);
                            dialog.save_file(move |file_path| {
                                let save_path = file_path
                                    .as_ref()
                                    .and_then(|p| p.as_path().map(|p| p.to_path_buf()));
                                send_args.finish(
                                    save_path,
                                    &filename_for_dialog,
                                    &downloads_dir,
                                    dl_downloads_for_dialog,
                                    dl_next_id_for_dialog,
                                    dl_emit_for_dialog,
                                    uri_for_dialog,
                                    mime_for_dialog,
                                );
                            });
                        });
                        Ok(())
                    },
                ));
                let mut token = 0;
                match core_webview.cast::<ICoreWebView2_4>() {
                    Ok(core_webview4) => unsafe {
                        if let Err(error) = core_webview4.add_DownloadStarting(&dl_handler, &mut token) {
                            log::error!("failed to register browser download handler: {error}");
                        }
                    },
                    Err(error) => {
                        log::error!("WebView2 download API unavailable (cast to ICoreWebView2_4 failed): {error}");
                    }
                }

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
        }) {
            let _ = child_webview.close();
            self.tabs.remove(id);
            return Err(format!("Failed to register browser events: {error}"));
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
    pub async fn close_tab(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let _lifecycle_guard = self.lifecycle.lock().await;
        if !self.tabs.contains_key(id) {
            return Err(format!("Tab {} not found", id));
        }
        remove_native_webview(app, id).await?;
        self.tabs.remove(id);
        let _ = app.emit("browser-tab-closed", id);
        Ok(())
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
    pub async fn set_tab_bounds(
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
        let webview = get_browser_webview(app, id)?;
        if !visible {
            webview.hide().map_err(|error| error.to_string())?;
            return Ok(());
        }
        webview
            .set_position(tauri::LogicalPosition::new(left, top))
            .map_err(|error| error.to_string())?;
        webview
            .set_size(tauri::LogicalSize::new(width.max(1.0), height.max(1.0)))
            .map_err(|error| error.to_string())?;
        webview.show().map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 隐藏除当前活动标签外的所有原生浏览器子 WebView。
    pub async fn hide_tabs_except(&self, app: &AppHandle, active_id: Option<&str>) -> Result<(), String> {
        let ids = self
            .tabs
            .iter()
            .filter(|tab| Some(tab.key().as_str()) != active_id)
            .map(|tab| tab.key().clone())
            .collect::<Vec<_>>();

        for id in ids {
            get_browser_webview(app, &id)?
                .hide()
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub async fn navigate_tab(&self, app: &AppHandle, id: &str, url: &str) -> Result<(), String> {
        let parsed_url = Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
        let webview = get_browser_webview(app, id)?;
        webview
            .navigate(parsed_url)
            .map_err(|error| format!("Navigate failed: {}", error))?;
        if let Some(mut tab) = self.tabs.get_mut(id) {
            tab.url = url.to_string();
        }
        Ok(())
    }

    /// 后退（通过 JS history.back()）
    pub async fn go_back(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        get_browser_webview(app, id)?
            .eval("if(window.history.length>1) window.history.back();")
            .map_err(|error| format!("Go back failed: {}", error))
    }

    /// 前进（通过 JS history.forward()）
    pub async fn go_forward(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        get_browser_webview(app, id)?
            .eval("window.history.forward();")
            .map_err(|error| format!("Go forward failed: {}", error))
    }

    /// 刷新（通过 JS location.reload()）
    pub async fn reload(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        get_browser_webview(app, id)?
            .reload()
            .map_err(|error| format!("Reload failed: {}", error))
    }

    /// 设置页面缩放（0.25 ~ 5.0）
    pub async fn set_zoom(&self, app: &AppHandle, id: &str, zoom_factor: f64) -> Result<(), String> {
        let clamped = zoom_factor.clamp(0.25, 5.0);
        get_browser_webview(app, id)?
            .set_zoom(clamped)
            .map_err(|error| format!("Set zoom failed: {}", error))?;
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
    pub async fn print_page(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        get_browser_webview(app, id)?
            .eval("window.print();")
            .map_err(|error| format!("Print failed: {}", error))
    }

    /// 在指定标签的 WebView 中执行 JS 代码
    pub async fn eval_script(&self, app: &AppHandle, id: &str, script: &str) -> Result<(), String> {
        get_browser_webview(app, id)?
            .eval(script)
            .map_err(|error| format!("Eval failed: {}", error))
    }

    /// WebView 内部 URL 变化回调
    pub async fn clear_cache(&self, app: &AppHandle) -> Result<(), String> {
        let id = self
            .tabs
            .iter()
            .next()
            .map(|tab| tab.key().clone())
            .ok_or_else(|| "No browser tab found".to_string())?;

        get_browser_webview(app, &id)?
            .with_webview(|webview| {
            #[cfg(target_os = "windows")]
            {
                use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
                use windows::core::HSTRING;

                if let Ok(core_webview) = unsafe { webview.controller().CoreWebView2() } {
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
            }
        })
        .map_err(|error| error.to_string())
    }

    pub async fn eval_script_result(
        &self,
        app: &AppHandle,
        id: &str,
        script: &str,
    ) -> Result<serde_json::Value, String> {
        let script = script.to_string();
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
        let tx = Arc::new(Mutex::new(Some(tx)));
        get_browser_webview(app, id)?
            .with_webview(move |webview| {
            #[cfg(target_os = "windows")]
            {
                use webview2_com::ExecuteScriptCompletedHandler;
                use windows::core::HSTRING;

                match unsafe { webview.controller().CoreWebView2() } {
                    Ok(core_webview) => {
                        let callback_tx = tx.clone();
                        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |status, result| {
                            if let Some(tx) = callback_tx.lock().ok().and_then(|mut sender| sender.take()) {
                                let result = status
                                    .map(|_| result)
                                    .map_err(|error| error.to_string());
                                let _ = tx.send(result);
                            }
                            Ok(())
                        }));
                        if let Err(error) = unsafe {
                            core_webview.ExecuteScript(&HSTRING::from(script), &handler)
                        } {
                            if let Some(tx) = tx.lock().ok().and_then(|mut sender| sender.take()) {
                                let _ = tx.send(Err(error.to_string()));
                            }
                        }
                    }
                    Err(error) => {
                        if let Some(tx) = tx.lock().ok().and_then(|mut sender| sender.take()) {
                            let _ = tx.send(Err(error.to_string()));
                        }
                    }
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = webview;
                let _ = script;
                if let Some(tx) = tx.lock().ok().and_then(|mut sender| sender.take()) {
                    let _ = tx.send(Err("Browser script results are unsupported".to_string()));
                }
            }
        })
        .map_err(|error| format!("Eval failed: {}", error))?;

        let result = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
            .await
            .map_err(|_| "Timed out waiting for browser script result".to_string())?
            .map_err(|_| "Browser script result channel closed".to_string())??;
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
        // 先 clone COM 引用并 drop 读锁，避免在持有 DashMap 读锁时
        // 调用 COM 方法（可能同步触发事件回调，回调里 get_mut 会死锁）
        #[cfg(target_os = "windows")]
        let operation_opt = {
            let entry = self.downloads.get(id)
                .ok_or_else(|| format!("Download {} not found", id))?;
            entry.operation.clone()
        };
        #[cfg(target_os = "windows")]
        {
            let operation = operation_opt
                .ok_or_else(|| "Download controls unavailable".to_string())?;
            unsafe { let _ = operation.Cancel(); }
        }
        if let Some(mut entry) = self.downloads.get_mut(id) {
            entry.info.state = "cancelled".to_string();
        }
        Ok(())
    }

    /// 暂停下载
    pub fn pause_download(&self, id: &str) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        let operation_opt = {
            let entry = self.downloads.get(id)
                .ok_or_else(|| format!("Download {} not found", id))?;
            entry.operation.clone()
        };
        #[cfg(target_os = "windows")]
        {
            let operation = operation_opt
                .ok_or_else(|| "Download controls unavailable".to_string())?;
            unsafe { let _ = operation.Pause(); }
        }
        Ok(())
    }

    /// 恢复下载
    pub fn resume_download(&self, id: &str) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        let operation_opt = {
            let entry = self.downloads.get(id)
                .ok_or_else(|| format!("Download {} not found", id))?;
            entry.operation.clone()
        };
        #[cfg(target_os = "windows")]
        {
            let operation = operation_opt
                .ok_or_else(|| "Download controls unavailable".to_string())?;
            unsafe { let _ = operation.Resume(); }
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
    pub async fn get_cookies(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let js = r#"
            (function() {
                return JSON.stringify((document.cookie || '').split(';').filter(Boolean).map(function(pair) {
                    var index = pair.indexOf('=');
                    return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: location.hostname, path: '/' };
                }));
            })()
        "#;
        let cookies = self.eval_script_result(app, id, js).await?;
        let _ = app.emit(
            "browser-cookies-result",
            serde_json::json!({ "id": id, "cookies": cookies }),
        );
        Ok(())
    }

    /// 清除当前页面的 Cookie（通过 JS 设置过期）
    pub async fn clear_cookies(&self, app: &AppHandle, id: &str) -> Result<(), String> {
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
        get_browser_webview(app, id)?
            .eval(js)
            .map_err(|error| format!("Clear cookies failed: {}", error))
    }

    /// 切换广告拦截状态（运行时注入或移除广告拦截脚本）
    pub async fn set_ad_block_enabled(&self, app: &AppHandle, id: &str, enabled: bool) -> Result<(), String> {
        if enabled {
            // 注入广告拦截脚本
            let js = AD_BLOCK_SCRIPT;
            get_browser_webview(app, id)?
                .eval(js)
                .map_err(|error| format!("Enable ad block failed: {}", error))?;
        } else {
            // 移除广告拦截样式
            let js = r#"
                (function() {
                    var style = document.getElementById('mona-ad-block-style');
                    if (style) style.parentNode.removeChild(style);
                    window.__mona_ad_block_injected = false;
                })();
            "#;
            get_browser_webview(app, id)?
                .eval(js)
                .map_err(|error| format!("Disable ad block failed: {}", error))?;
        }
        Ok(())
    }

    /// 切换标签静音状态（通过 WebView2 的 IsMuted 属性）
    pub async fn set_muted(&self, app: &AppHandle, id: &str, muted: bool) -> Result<(), String> {
        if let Some(mut tab) = self.tabs.get_mut(id) {
            tab.is_muted = muted;
        }
        get_browser_webview(app, id)?
            .with_webview(move |wv| {
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
        })
        .map_err(|error| error.to_string())?;
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
    pub async fn open_devtools(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        get_browser_webview(app, id)?
            .with_webview(move |wv| {
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
        })
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 切换暗色模式（注入或移除暗色模式 CSS）
    pub async fn set_dark_mode(&self, app: &AppHandle, id: &str, enabled: bool) -> Result<(), String> {
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
            get_browser_webview(app, id)?
                .eval(js)
                .map_err(|error| format!("Enable dark mode failed: {}", error))?;
        } else {
            // 移除暗色模式样式
            let js = r#"
                (function() {
                    var style = document.getElementById('mona-dark-mode-style');
                    if (style) style.parentNode.removeChild(style);
                })();
            "#;
            get_browser_webview(app, id)?
                .eval(js)
                .map_err(|error| format!("Disable dark mode failed: {}", error))?;
        }
        Ok(())
    }

    /// 获取页面元信息（用于分享/二维码）
    pub async fn get_page_info(&self, app: &AppHandle, id: &str) -> Result<(), String> {
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
        "#;
        let info = self.eval_script_result(app, id, js).await?;
        let _ = app.emit(
            "browser-page-info-result",
            serde_json::json!({ "id": id, "info": info }),
        );
        Ok(())
    }
}
