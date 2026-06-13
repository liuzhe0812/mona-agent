mod browser;
mod db;
mod gateway;
mod ipc_bridge;
mod license;
mod notes;
mod python;
mod quick_ask;
mod settings;
mod terminal;
mod tray;
mod updater;

use gateway::GatewayManager;
use settings::AppSettings;
use std::sync::Arc;
use tauri::Emitter;
use tauri::Listener;
use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;
use tauri_plugin_global_shortcut::ShortcutState;

const GATEWAY_START_TIMEOUT_SECS: u64 = 90;

#[derive(Clone)]
pub struct GatewayState {
    inner: Arc<GatewayStateInner>,
}

struct GatewayStateInner {
    manager: GatewayManager,
    port: std::sync::Mutex<Option<u16>>,
}

impl GatewayState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(GatewayStateInner {
                manager: GatewayManager::new(),
                port: std::sync::Mutex::new(None),
            }),
        }
    }

    pub fn start(&self, settings: &AppSettings, app_handle: &tauri::AppHandle) -> Result<u16, String> {
        let port = self.inner.manager.start(settings, app_handle)?;
        *self.inner.port.lock().map_err(|e| e.to_string())? = Some(port);
        Ok(port)
    }

    pub fn stop(&self) -> Result<(), String> {
        self.inner.manager.stop()?;
        *self.inner.port.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.inner.manager.is_running()
    }

    pub fn exit_message(&self) -> Option<String> {
        self.inner.manager.exit_message()
    }

    pub fn port(&self) -> Option<u16> {
        self.inner.port.lock().ok()?.as_ref().copied()
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalHttpResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

#[tauri::command]
async fn get_settings() -> Result<AppSettings, String> {
    Ok(settings::load_settings())
}

#[tauri::command]
async fn update_settings(
    app: tauri::AppHandle,
    shortcut_state: tauri::State<'_, quick_ask::QuickAskShortcutState>,
    new_settings: AppSettings,
) -> Result<AppSettings, String> {
    quick_ask::register_quick_ask_shortcut(
        &app,
        shortcut_state.inner(),
        &new_settings.quick_ask_shortcut,
    )?;
    settings::save_settings(&new_settings)?;
    Ok(settings::load_settings())
}

#[tauri::command]
async fn start_gateway(
    state: tauri::State<'_, GatewayState>,
    app_handle: tauri::AppHandle,
) -> Result<u16, String> {
    let settings = settings::load_settings();
    settings::ensure_desktop_config(settings.gateway_port)?;
    let port = state.start(&settings, &app_handle)?;
    let wait_state = state.inner().clone();
    gateway::wait_for_gateway(port, GATEWAY_START_TIMEOUT_SECS, move || {
        wait_state.exit_message()
    })
    .await?;
    Ok(port)
}

#[tauri::command]
async fn stop_gateway(state: tauri::State<'_, GatewayState>) -> Result<(), String> {
    state.stop()
}

#[tauri::command]
async fn gateway_status(state: tauri::State<'_, GatewayState>) -> Result<serde_json::Value, String> {
    let running = state.is_running();
    let port = state.port();
    let ws_port = settings::read_mona_ws_port();
    Ok(serde_json::json!({
        "running": running,
        "port": port,
        "ws_port": ws_port,
    }))
}

#[tauri::command]
async fn diagnose_gateway(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let gateway = python::gateway_exe_path();
    let resource_dir = app_handle.path().resource_dir().map(|p| p.display().to_string()).unwrap_or_else(|e| format!("ERROR: {}", e));
    let exe_path = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|e| format!("ERROR: {}", e));
    let data_dir = crate::settings::app_data_dir().display().to_string();

    let mut resource_candidates = Vec::new();
    if let Ok(rd) = app_handle.path().resource_dir() {
        let c = rd.join(python::GATEWAY_EXE_NAME);
        resource_candidates.push(serde_json::json!({
            "path": c.display().to_string(),
            "exists": c.exists()
        }));
    }
    if let Ok(ep) = std::env::current_exe() {
        if let Some(ed) = ep.parent() {
            for sub in &["resources", ""] {
                let c = if sub.is_empty() { ed.join(python::GATEWAY_EXE_NAME) } else { ed.join(sub).join(python::GATEWAY_EXE_NAME) };
                resource_candidates.push(serde_json::json!({
                    "path": c.display().to_string(),
                    "exists": c.exists()
                }));
            }
        }
    }

    Ok(serde_json::json!({
        "gateway_exe": {
            "path": gateway.display().to_string(),
            "exists": gateway.exists()
        },
        "data_dir": data_dir,
        "resource_dir": resource_dir,
        "current_exe": exe_path,
        "resource_candidates": resource_candidates,
    }))
}

fn is_loopback_http_url(url: &reqwest::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }

    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[tauri::command]
async fn local_http_request(
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
) -> Result<LocalHttpResponse, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL: {}", e))?;
    if !is_loopback_http_url(&parsed) {
        return Err("local_http_request only allows localhost or loopback URLs".to_string());
    }

    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("Invalid HTTP method: {}", e))?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|e| format!("Failed to create local HTTP client: {}", e))?;

    let mut request = client.request(method, parsed);
    for (name, value) in headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| format!("Invalid header name: {}", e))?;
        let value = reqwest::header::HeaderValue::from_str(&value)
            .map_err(|e| format!("Invalid header value: {}", e))?;
        request = request.header(name, value);
    }

    if let Some(body) = body {
        request = request.body(body);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Local HTTP request failed: {}", e))?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read local HTTP response: {}", e))?
        .to_vec();

    Ok(LocalHttpResponse {
        status: status.as_u16(),
        status_text,
        headers,
        body,
    })
}

#[tauri::command]
async fn open_in_browser(state: tauri::State<'_, GatewayState>) -> Result<(), String> {
    let port = state.port().ok_or("Gateway not running")?;
    let url = format!("http://127.0.0.1:{}", port);
    open::that(&url).map_err(|e| format!("Failed to open browser: {}", e))
}

mod open {
    pub fn that(url: &str) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd")
                .args(["/c", "start", "", url])
                .creation_flags(0x08000000)
                .spawn()?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(url).spawn()?;
        }
        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open").arg(url).spawn()?;
        }
        Ok(())
    }
}

#[tauri::command]
async fn mona_config_status() -> Result<settings::MonaConfigStatus, String> {
    Ok(settings::check_mona_config())
}

#[tauri::command]
async fn write_mona_provider_config(
    provider: String,
    api_key: String,
    api_base: Option<String>,
) -> Result<(), String> {
    settings::write_mona_provider_config(&provider, &api_key, api_base.as_deref())
}

#[tauri::command]
async fn write_mona_model_config(
    model: String,
    provider: String,
) -> Result<(), String> {
    settings::write_mona_model_config(&model, &provider)
}

fn open_md_reader_window(app_handle: &tauri::AppHandle, file_path: &str) {
    // 查找已有的 MD 阅读器窗口，有则发送事件让它开新 tab
    for window in app_handle.webview_windows().values() {
        let label = window.label();
        if label.starts_with("md-reader-") {
            let _ = app_handle.emit_to(label, "md-file-open", file_path);
            let _ = window.set_focus();
            return;
        }
    }

    // 没有已有窗口，创建新窗口
    let encoded = urlencoding::encode(file_path);
    let url = format!("#/md-reader?file={}", encoded);
    let label = format!("md-reader-{}", file_path.replace(|c: char| !c.is_alphanumeric(), "-"));
    let label_truncated = if label.len() > 64 {
        &label[..64]
    } else {
        &label
    };

    let _ = WebviewWindowBuilder::new(app_handle, label_truncated, WebviewUrl::App(url.into()))
        .title("Mona - Markdown 阅读器")
        .inner_size(1000.0, 700.0)
        .min_inner_size(600.0, 400.0)
        .center()
        .build();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 在 WebView2 启动前设置 CDP 调试端口（全局，所有 WebView 共享）
    #[cfg(windows)]
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--remote-debugging-port=9300",
        );
    }

    let gateway_state = GatewayState::new();
    let terminal_state = terminal::TerminalState::new();
    let db_state = db::DbState::new();

    let terminal_state_for_bridge = terminal_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let mode = settings::load_settings().quick_ask_mode;
                        if mode == "full" {
                            quick_ask::toggle_main_window(app);
                        } else {
                            quick_ask::toggle_quick_ask(app);
                        }
                    }
                })
                .build())
        .manage(gateway_state.clone())
        .manage(terminal_state)
        .manage(db_state)
        .manage(quick_ask::QuickAskShortcutState::default())
        .manage(browser::BrowserState::new())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            start_gateway,
            stop_gateway,
            gateway_status,
            diagnose_gateway,
            local_http_request,
            open_in_browser,
            mona_config_status,
            write_mona_provider_config,
            write_mona_model_config,
            quick_ask::quick_ask_hide,
            quick_ask::quick_ask_show,
            quick_ask::quick_ask_focus_chat,
            quick_ask::quick_ask_open_note,
            quick_ask::quick_ask_open_ssh,
            notes::notes_load_state,
            notes::notes_save_state,
            notes::notes_export_temp,
            notes::notes_create_from_chat,
            notes::notes_search,
            notes::notes_save_image,
            notes::notes_get_assets_dir,
            notes::notes_read_image,
            terminal::commands::ssh_connect,
            terminal::commands::ssh_connect_with_id,
            terminal::commands::ssh_disconnect,
            terminal::commands::ssh_open_sftp,
            terminal::commands::ssh_reconnect,
            terminal::commands::ssh_port_forward,
            terminal::commands::ssh_write,
            terminal::commands::ssh_resize,
            terminal::commands::shell_spawn,
            terminal::commands::shell_write,
            terminal::commands::shell_resize,
            terminal::commands::shell_kill,
            terminal::commands::shell_get_buffer,
            terminal::commands::sftp_list,
            terminal::commands::sftp_mkdir,
            terminal::commands::sftp_remove,
            terminal::commands::sftp_rename,
            terminal::commands::sftp_stat,
            terminal::commands::sftp_canonicalize,
            terminal::commands::sftp_download,
            terminal::commands::sftp_upload,
            terminal::commands::terminal_save_connections,
            terminal::commands::terminal_load_connections,
            terminal::commands::ssh_trust_host_key,
            terminal::commands::ssh_remove_host_key,
            terminal::commands::terminal_list_sessions,
            terminal::commands::terminal_get_output,
            terminal::commands::terminal_exec_command,
            terminal::commands::terminal_request_exec,
            terminal::commands::terminal_respond_exec,
            terminal::commands::terminal_list_pending_exec,
            terminal::commands::get_file_icon,
            terminal::commands::get_file_type_icon,
            terminal::commands::local_list_dir,
            terminal::commands::local_home_dir,
            terminal::commands::local_desktop_dir,
            terminal::commands::sftp_batch_upload,
            terminal::commands::sftp_batch_cancel,
            terminal::commands::sftp_batch_pause,
            terminal::commands::sftp_batch_resume,
            terminal::commands::sftp_touch,
            terminal::commands::sftp_chmod,
            terminal::commands::sftp_stat_detail,
            terminal::commands::sftp_download_dir,
            terminal::commands::sftp_upload_dir,
            terminal::commands::sftp_upload_file,
            terminal::commands::sftp_download_file,
            terminal::commands::sftp_cancel_transfer,
            terminal::ide::commands::ide_open_project,
            terminal::ide::commands::ide_check_file,
            terminal::ide::commands::ide_read_file,
            terminal::ide::commands::ide_write_file,
            terminal::ide::commands::ide_exec_command,
            terminal::desktop::commands::desktop_connect,
            terminal::desktop::commands::desktop_disconnect,
            terminal::desktop::commands::desktop_exec,
            terminal::desktop::commands::desktop_list_files,
            terminal::desktop::commands::desktop_get_file_content,
            terminal::desktop::commands::desktop_save_file_content,
            terminal::desktop::commands::desktop_get_system_info,
            terminal::desktop::commands::desktop_get_processes,
            terminal::desktop::commands::desktop_get_disks,
            terminal::desktop::commands::desktop_start_terminal,
            terminal::desktop::commands::desktop_send_terminal_input,
            terminal::desktop::commands::desktop_resize_terminal,
            db::commands::db_connect,
            db::commands::db_disconnect,
            db::commands::db_test_connection,
            db::commands::db_execute_query,
            db::commands::db_get_databases,
            db::commands::db_get_tables,
            db::commands::db_get_views,
            db::commands::db_get_table_info,
            db::commands::db_get_server_stats,
            db::commands::db_get_processes,
            db::commands::db_get_users,
            db::commands::db_kill_process,
            db::commands::db_backup_database,
            db::commands::db_restore_database,
            db::commands::db_list_connections,
            db::commands::db_save_connections,
            db::commands::db_load_connections,
            license::get_machine_id,
            license::check_license,
            license::import_license,
            license::get_pricing,
            license::auth_register,
            license::send_register_code,
            license::auth_login,
            license::auth_logout,
            license::auth_forgot_password,
            license::auth_reset_password,
            license::get_auth_status,
            license::bind_device,
            license::list_notifications,
            license::get_unread_notification_count,
            license::mark_notification_read,
            updater::check_for_updates,
            updater::perform_update,
            updater::get_current_version,
            browser::commands::browser_create_tab,
            browser::commands::browser_close_tab,
            browser::commands::browser_update_tab_url,
            browser::commands::browser_update_tab_title,
            browser::commands::browser_list_tabs,
            browser::commands::browser_get_cdp_port,
            browser::commands::browser_set_ai_status,
            browser::commands::browser_navigate_tab,
            browser::commands::browser_go_back,
            browser::commands::browser_go_forward,
            browser::commands::browser_reload,
            browser::commands::browser_on_url_changed,
            browser::storage::browser_add_bookmark,
            browser::storage::browser_remove_bookmark,
            browser::storage::browser_update_bookmark,
            browser::storage::browser_is_bookmarked,
            browser::storage::browser_list_bookmarks,
            browser::storage::browser_import_bookmarks,
            browser::storage::browser_record_visit,
            browser::storage::browser_clear_history,
            browser::storage::browser_clear_cache,
            browser::storage::browser_search_suggestions,
        ])
        .setup(move |app| {
            // 设置高分辨率窗口图标，确保任务栏在高 DPI 下清晰
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_icon(tray::load_icon());
            }

            tray::setup_tray(app)?;

            let app_handle_for_file = app.handle().clone();
            app.listen("tauri://file-open", move |event| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    if let Some(paths) = payload.get("paths").and_then(|p| p.as_array()) {
                        for path in paths {
                            if let Some(path_str) = path.as_str() {
                                open_md_reader_window(&app_handle_for_file, path_str);
                            }
                        }
                    }
                }
            });

            let mut has_md_file = false;
            for arg in std::env::args().skip(1) {
                let lower = arg.to_lowercase();
                if lower.ends_with(".md") || lower.ends_with(".markdown") {
                    open_md_reader_window(app.handle(), &arg);
                    has_md_file = true;
                }
            }

            if has_md_file {
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.close();
                }
            }

            let settings = settings::load_settings();
            let shortcut_state = app.state::<quick_ask::QuickAskShortcutState>();
            if let Err(e) = quick_ask::register_quick_ask_shortcut(
                app.handle(),
                shortcut_state.inner(),
                &settings.quick_ask_shortcut,
            ) {
                log::error!("Failed to register quick ask shortcut: {}", e);
            }

            if settings.auto_start_gateway {
                let config_status = settings::check_mona_config();
                if config_status.has_provider {
                    if let Err(e) = settings::ensure_desktop_config(settings.gateway_port) {
                        log::error!("Failed to ensure desktop config: {}", e);
                    }
                    let state = gateway_state.clone();
                    let settings_clone = settings.clone();
                    let app_handle_clone = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        match state.start(&settings_clone, &app_handle_clone) {
                            Ok(actual_port) => {
                                let wait_state = state.clone();
                                match gateway::wait_for_gateway(
                                    actual_port,
                                    GATEWAY_START_TIMEOUT_SECS,
                                    move || wait_state.exit_message(),
                                )
                                .await
                                {
                                    Ok(()) => {
                                        log::info!("Gateway ready on port {}", actual_port);
                                    }
                                    Err(e) => {
                                        log::error!("Gateway failed to start: {}", e);
                                    }
                                }
                            }
                            Err(e) => {
                                log::error!("Failed to start gateway: {}", e);
                            }
                        }
                    });
                } else {
                    log::info!("No provider configured, skipping gateway auto-start");
                }
            }

            // Cleanup after update (remove backups, markers)
            if let Err(e) = updater::cleanup_after_update() {
                log::warn!("Update cleanup failed: {}", e);
            }

            // Auto-check for updates 5 seconds after launch
            let app_handle_for_update = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                match updater::fetch_manifest("https://mona.lzfun.vip/updates/update.json").await {
                    Ok(manifest) => {
                        let current = updater::get_app_version();
                        let latest = manifest.version.clone();
                        if updater::check_update_available(&current, &manifest.version) {
                            let _ = app_handle_for_update.emit(
                                "update-available",
                                updater::UpdateCheckResult {
                                    has_update: true,
                                    current_version: current,
                                    latest_version: manifest.version,
                                    notes: manifest.notes,
                                    size: Some(manifest.size),
                                },
                            );
                            log::info!("Update available: {}", latest);
                        }
                    }
                    Err(e) => {
                        log::info!("Update check failed: {}", e);
                    }
                }
            });

            let window = app.get_webview_window("main").unwrap();
            let gateway_state_for_close = gateway_state.clone();
            window.clone().on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let current_settings = settings::load_settings();
                    if current_settings.run_in_background {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        let _ = gateway_state_for_close.stop();
                    }
                }
            });

            let bridge = Arc::new(ipc_bridge::IpcBridge::new(app.handle().clone()));
            let ts = terminal_state_for_bridge.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = bridge.start(ts).await {
                    log::error!("IPC bridge failed: {}", e);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    ipc_bridge::remove_port_file();
}
