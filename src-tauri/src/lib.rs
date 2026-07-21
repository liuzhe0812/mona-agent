mod browser;
mod contacts;
mod db;
mod email;
mod gateway;
mod hoard;
mod ipc_bridge;
mod license;
mod notes;
mod notes_links;
mod notification_window;
mod python;
mod quick_ask;
mod schedule_notifier;
mod settings;
mod system;
mod terminal;
mod tray;
mod updater;

use gateway::GatewayManager;
use settings::AppSettings;
use std::sync::{Arc, Mutex};
use tauri::webview::{DownloadEvent, WebviewWindowBuilder};
use tauri::{Emitter, Listener, Manager, WebviewUrl};
use tauri::utils::config::Color;
use tauri_plugin_global_shortcut::ShortcutState;

const GATEWAY_START_TIMEOUT_SECS: u64 = 90;

#[cfg(test)]
mod browser_ipc_tests {
    #[test]
    fn browser_uses_tauri_managed_child_webviews() {
        let browser = include_str!("browser/mod.rs");
        let runtime = include_str!("lib.rs");

        assert!(browser.contains("WebviewBuilder::new"));
        assert!(!browser.contains("wry::WebViewBuilder"));
        assert!(!runtime.contains(&["tauri_plugin_shell", "::init()"].concat()));
        assert!(!runtime.contains(&[".invoke", "_system("].concat()));
    }

    #[test]
    fn browser_popups_are_owned_by_the_main_window() {
        for popup in [
            include_str!("browser/downloads.rs"),
            include_str!("browser/suggestions.rs"),
        ] {
            assert!(popup.contains(".parent(&main)"));
            assert!(!popup.contains(".always_on_top(true)"));
        }
    }

    #[test]
    fn browser_popups_are_shown_when_first_created() {
        for popup in [
            include_str!("browser/downloads.rs"),
            include_str!("browser/suggestions.rs"),
        ] {
            assert!(popup.contains(".visible(false)"));
            assert!(popup.contains("window.show()"));
        }
    }

    #[test]
    fn browser_popup_capabilities_use_window_labels() {
        let capabilities = include_str!("../capabilities/default.json");

        assert!(capabilities.contains("browser-address-suggestions"));
        assert!(capabilities.contains("browser-downloads"));
        assert!(!capabilities.contains("\"browser-suggestions\""));
    }
}

/// 存储首次启动时待打开的 md 文件路径（前端就绪后拉取）
#[derive(Default)]
struct PendingMdFiles(Mutex<Vec<String>>);

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

#[tauri::command]
async fn write_mona_image_gen_config(
    provider: String,
    model: String,
    enabled: Option<bool>,
) -> Result<(), String> {
    settings::write_mona_image_gen_config(&provider, &model, enabled)
}

#[tauri::command]
async fn write_mona_video_gen_config(
    provider: String,
    model: String,
    enabled: Option<bool>,
) -> Result<(), String> {
    settings::write_mona_video_gen_config(&provider, &model, enabled)
}

#[tauri::command]
async fn read_email_schedule_config() -> Result<serde_json::Value, String> {
    Ok(settings::read_email_schedule_config())
}

#[tauri::command]
async fn write_email_schedule_config(
    schedule: serde_json::Value,
) -> Result<(), String> {
    settings::write_email_schedule_config(&schedule)
}

fn emit_md_file_open(app_handle: &tauri::AppHandle, file_path: &str) {
    // 存入 pending 列表，供前端首次加载时拉取
    if let Some(pending) = app_handle.try_state::<PendingMdFiles>() {
        if let Ok(mut files) = pending.0.lock() {
            files.push(file_path.to_string());
        }
    }
    // 同时 emit，供已就绪的前端监听器接收
    let _ = app_handle.emit_to("main", "md-file-open", file_path);
    if let Some(main_window) = app_handle.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.unminimize();
        let _ = main_window.set_focus();
    }
}

/// 前端启动时调用，拉取并清空 pending 的 md 文件路径
#[tauri::command]
fn get_pending_md_files(state: tauri::State<PendingMdFiles>) -> Vec<String> {
    let mut files = state.0.lock().unwrap();
    let result = files.clone();
    files.clear();
    result
}

/// 前端主题切换时调用，同步窗口背景色，避免拖动调整大小时露出对比色残影。
/// 浅色主题传 (255,255,255,255)，深色主题传 (26,26,26,255) 匹配 body 背景。
#[tauri::command]
fn set_window_background_color(
    app: tauri::AppHandle,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_background_color(Some(Color(r, g, b, a)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    browser::configure_webview2_cdp();

    let gateway_state = GatewayState::new();
    let terminal_state = terminal::TerminalState::new();
    let db_state = db::DbState::new();
    let email_state = email::EmailState::new();
    let contacts_state = contacts::ContactsState::new();

    let terminal_state_for_bridge = terminal_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 二次启动时，检查命令行参数中是否有 md 文件
            for arg in args.iter().skip(1) {
                let lower = arg.to_lowercase();
                if lower.ends_with(".md") || lower.ends_with(".markdown") {
                    let _ = app.emit_to("main", "md-file-open", arg.as_str());
                }
            }
            // 激活主窗口
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
                let _ = main_window.unminimize();
            }
        })
        )
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
        .plugin(tauri_plugin_notification::init())
        .manage(gateway_state.clone())
        .manage(terminal_state)
        .manage(db_state)
        .manage(email_state)
        .manage(contacts_state)
        .manage(quick_ask::QuickAskShortcutState::default())
        .manage(browser::BrowserState::new())
        .manage(browser::suggestions::AddressSuggestionWindowState::new())
        .manage(PendingMdFiles::default())
        .manage(tray::PendingMailNavigation::default())
        .manage(notification_window::NotificationWindowState::new())
        .manage(system::SystemState::new())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            start_gateway,
            stop_gateway,
            gateway_status,
            diagnose_gateway,
            gateway::read_gateway_log,
            local_http_request,
            open_in_browser,
            mona_config_status,
            write_mona_provider_config,
            write_mona_model_config,
            write_mona_image_gen_config,
            write_mona_video_gen_config,
            read_email_schedule_config,
            write_email_schedule_config,
            get_pending_md_files,
            set_window_background_color,
            quick_ask::quick_ask_hide,
            quick_ask::quick_ask_show,
            quick_ask::quick_ask_focus_chat,
            quick_ask::quick_ask_open_note,
            quick_ask::quick_ask_open_ssh,
            notes::notes_load_state,
            notes::notes_save_state,
            notes::notes_export_temp,
            notes::notes_create_from_chat,
            notes::notes_edit_note,
            notes::notes_read_note_content,
            notes::notes_search,
            notes::notes_search_all,
            notes::notes_save_image,
            notes::notes_get_assets_dir,
            notes::notes_vault_get_path,
            notes::notes_vault_set_path,
            notes::notes_vault_pick_directory,
            notes::get_agent_search_scope,
            notes::set_agent_search_scope,
            notes_links::notes_links_get_graph,
            notes_links::notes_links_save_positions,
            notes_links::notes_links_get_backlinks,
            notes_links::notes_links_get_mentions,
            notes_links::notes_links_rename_sync,
            notes_links::notes_links_search_mentions,
            notes_links::notes_moc_list,
            hoard::hoard_add,
            hoard::hoard_update,
            hoard::hoard_delete,
            hoard::hoard_get,
            hoard::hoard_list,
            hoard::hoard_search,
            hoard::hoard_count,
            hoard::hoard_add_relation,
            hoard::hoard_get_relations,
            terminal::commands::ssh_connect,
            terminal::commands::ssh_connect_with_id,
            terminal::commands::ssh_disconnect,
            terminal::commands::ssh_open_sftp,
            terminal::commands::ssh_reconnect,
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
            terminal::commands::sftp_paste,
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
            terminal::commands::expand_upload_paths_command,
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
            terminal::ide::commands::ide_remote_get_system_info,
            terminal::ide::commands::ide_remote_get_processes,
            terminal::ide::commands::ide_remote_get_ports,
            terminal::ide::commands::ide_remote_kill_process,
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
            terminal::vnc::commands::vnc_connect,
            terminal::vnc::commands::vnc_disconnect,
            terminal::vnc::commands::vnc_reconnect,
            terminal::vnc::commands::vnc_list_sessions,
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
            email::email_list_accounts,
            email::email_add_account,
            email::email_update_account_settings,
            email::email_delete_account,
            email::email_get_messages,
            email::email_parse_local_body,
            email::email_get_unified_inbox,
            email::email_mark_read,
            email::email_toggle_starred,
            email::email_move_message,
            email::email_fetch_attachment,
            email::email_fetch_body,
            email::email_fetch_raw,
            email::email_rebuild_index,
            email::email_list_rules,
            email::email_save_rule,
            email::email_delete_rule,
            email::email_outbox_add,
            email::email_outbox_list,
            email::email_outbox_delete,
            email::email_outbox_process,
            email::email_save_draft,
            email::email_test_connection,
            email::email_open_compose_window,
            email::email_close_compose_window,
            email::email_open_view_window,
            email::email_list_folders,
            email::email_get_folders,
            email::email_sync_folders,
            email::email_unread_counts,
            email::email_statistics,
            email::email_create_folder,
            email::email_sync,
            email::email_download_attachment_to_file,
            email::email_send,
            email::email_delete_message,
            email::email_mark_all_read,
            email::email_empty_folder,
            email::email_get_decrypted_password,
            email::email_get_analysis,
            email::email_save_analysis,
            email::email_analyze,
            email::email_search_messages,
            email::email_batch_action,
            email::email_apply_rules,
            email::email_start_idle,
            email::email_stop_idle,
            contacts::contact_list,
            contacts::contact_search,
            contacts::contact_add,
            contacts::contact_add_if_not_exists,
            contacts::contact_import_csv,
            contacts::contact_update,
            contacts::contact_delete,
            contacts::contact_clear_account,
            contacts::contact_get_sync_state,
            contacts::contact_save_sync_state,
            contacts::contact_sync,
            contacts::contact_test_carddav,
            contacts::contact_sync_eas,
            contacts::contact_test_eas,
            license::get_machine_id,
            license::check_license,
            license::license_has_access,
            license::import_license,
            license::get_pricing,
            license::auth_register,
            license::send_register_code,
            license::auth_login,
            license::auth_logout,
            license::auth_forgot_password,
            license::auth_reset_password,
            license::auth_change_password,
            license::get_auth_status,
            license::bind_device,
            license::upload_image,
            license::list_notifications,
            license::get_unread_notification_count,
            license::mark_notification_read,
            license::create_subscription,
            license::poll_payment_status,
            license::get_subscription_info,
            license::cancel_auto_renew,
            license::list_renewals,
            license::open_external_url,
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
            browser::commands::browser_set_tab_bounds,
            browser::commands::browser_hide_tabs_except,
            browser::commands::browser_navigate_tab,
            browser::commands::browser_go_back,
            browser::commands::browser_go_forward,
            browser::commands::browser_reload,
            browser::commands::browser_on_url_changed,
            browser::commands::browser_cancel_download,
            browser::commands::browser_pause_download,
            browser::commands::browser_resume_download,
            browser::commands::browser_list_downloads,
            browser::commands::browser_open_download,
            browser::commands::browser_reveal_download,
            browser::commands::browser_remove_download,
            browser::commands::browser_set_zoom,
            browser::commands::browser_get_zoom,
            browser::commands::browser_print_page,
            browser::commands::browser_eval_script,
            browser::commands::browser_eval_script_result,
            browser::commands::browser_get_cookies,
            browser::commands::browser_clear_cookies,
            browser::commands::browser_set_ad_block,
            browser::commands::browser_set_muted,
            browser::commands::browser_is_muted,
            browser::commands::browser_is_incognito,
            browser::commands::browser_open_devtools,
            browser::commands::browser_set_dark_mode,
            browser::commands::browser_get_page_info,
            browser::suggestions::browser_show_address_suggestions,
            browser::suggestions::show_browser_address_suggestions_window,
            browser::suggestions::browser_hide_address_suggestions,
            browser::suggestions::browser_select_address_suggestion,
            browser::downloads::browser_show_downloads,
            browser::downloads::browser_toggle_downloads,
            browser::downloads::browser_hide_downloads,
            browser::storage::browser_add_bookmark,
            browser::storage::browser_remove_bookmark,
            browser::storage::browser_update_bookmark,
            browser::storage::browser_is_bookmarked,
            browser::storage::browser_list_bookmarks,
            browser::storage::browser_import_bookmarks,
            browser::storage::browser_record_visit,
            browser::storage::browser_clear_history,
            browser::storage::browser_list_history,
            browser::storage::browser_delete_history,
            browser::storage::browser_clear_cache,
            browser::storage::browser_search_suggestions,
            tray::set_tray_unread_count,
            tray::send_mail_notification,
            tray::check_and_clear_pending_mail,
            notification_window::show_notification,
            notification_window::show_notification_window,
            notification_window::close_notification_window,
            notification_window::emit_notification_action,
            system::system_get_overview,
            system::system_get_history,
            system::scan_storage,
            system::clean_storage,
            system::software::system_winget_status,
            system::software::system_list_software,
            system::software::system_check_updates,
            system::software::system_upgrade_software,
            system::software::system_uninstall_software,
            system::software::system_list_windows_apps,
            system::software::system_remove_windows_app,
            system::startup::system_list_startup_items,
            system::startup::system_acknowledge_startup_items,
            system::startup::system_toggle_startup_item,
            system::startup::system_batch_toggle_startup_items,
            system::startup::system_get_boot_history,
            system::startup::system_get_startup_changes,
            system::maintenance::system_get_maintenance_history,
            system::diagnostics::system_get_configuration_audit,
            system::diagnostics::system_apply_configuration_item,
            system::diagnostics::system_check_pending_reboot,
            system::diagnostics::system_check_component_health,
            system::diagnostics::system_check_driver_issues,
            system::diagnostics::system_check_power_events,
            system::diagnostics::system_check_network_configuration,
            system::diagnostics::system_check_recovery_status,
        ])
        .setup(move |app| {
            // 创建主窗口（在 builder 上注册 on_download，让 video 原生下载按钮生效）
            // 禁用 Tauri 原生拖放处理器，启用 HTML5 drag-and-drop API（标签页拖拽排序等）
            let _main_window = WebviewWindowBuilder::new(
                app, "main", WebviewUrl::App("index.html".into()),
            )
            .title("Mona")
            .inner_size(1200.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .center()
            .decorations(false)
            .background_color(Color(255, 255, 255, 255))
            .disable_drag_drop_handler()
            .on_download(|webview, event| {
                match event {
                    DownloadEvent::Requested { url, destination } => {
                        let path_seg = url
                            .path_segments()
                            .and_then(|mut segs| segs.next_back())
                            .filter(|s| !s.is_empty())
                            .unwrap_or("download");
                        let filename = if std::path::Path::new(path_seg).extension().is_none() {
                            format!("{}.mp4", path_seg)
                        } else {
                            path_seg.to_string()
                        };
                        if let Ok(mut dir) = webview.path().download_dir() {
                            let mut name = filename.clone();
                            let stem = std::path::Path::new(&filename)
                                .file_stem()
                                .and_then(|s| s.to_str())
                                .unwrap_or("download")
                                .to_string();
                            let ext = std::path::Path::new(&filename)
                                .extension()
                                .and_then(|s| s.to_str())
                                .unwrap_or("mp4")
                                .to_string();
                            let mut i = 1;
                            while dir.join(&name).exists() {
                                name = format!("{} ({}).{}", stem, i, ext);
                                i += 1;
                            }
                            dir.push(&name);
                            *destination = dir;
                        }
                    }
                    DownloadEvent::Finished { path, success, .. } => {
                        log::debug!("[download] finished: {:?} success={}", path, success);
                    }
                    _ => {}
                }
                true
            })
            .build()?;

            // 设置高分辨率窗口图标，确保任务栏在高 DPI 下清晰
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_icon(tray::load_icon());

                // 在主窗口上注册 WebView2 PermissionRequested 处理器，
                // 自动批准麦克风权限（用于笔记模块的录音转写功能），
                // 避免弹出 WebView2 默认的权限请求弹窗，其他权限保持默认行为。
                #[cfg(target_os = "windows")]
                {
                    use tauri::webview::Webview;
                    let _ = win.with_webview(|wv| {
                        use webview2_com::PermissionRequestedEventHandler;
                        use webview2_com::Microsoft::Web::WebView2::Win32::{
                            ICoreWebView2PermissionRequestedEventArgs, COREWEBVIEW2_PERMISSION_KIND,
                            COREWEBVIEW2_PERMISSION_STATE,
                        };
                        unsafe {
                            let core = wv.controller().CoreWebView2().ok();
                            if let Some(core) = core {
                                let handler = PermissionRequestedEventHandler::create(
                                    Box::new(
                                        move |_sender, args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                                            if let Some(args) = args {
                                                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                                                let _ = args.PermissionKind(&mut kind);
                                                // COREWEBVIEW2_PERMISSION_KIND_MICROPHONE = 1
                                                if kind.0 == 1 {
                                                    let _ = args.SetState(
                                                        COREWEBVIEW2_PERMISSION_STATE(1), // ALLOW
                                                    );
                                                }
                                            }
                                            Ok(())
                                        },
                                    ),
                                );
                                let mut token: i64 = 0;
                                let _ = core.add_PermissionRequested(&handler, &mut token);
                            }
                        }
                    });
                }
            }

            tray::setup_tray(app)?;

            // 启动后台线程执行邮件索引一致性校验（不阻塞 UI）
            // 扫描 mail 目录与 SQLite 索引对比，修复差异（.eml 有索引无 → 重建；索引有 .eml 无 → 删孤儿）
            {
                let email_state = app
                    .state::<email::EmailState>()
                    .inner()
                    .clone();
                std::thread::spawn(move || {
                    email::verify_consistency_on_startup(&email_state);
                });
            }

            // 启动系统采样后台线程：每 10 秒写入 CPU/内存/网络指标到 SQLite，60 分钟窗口环形置换
            {
                let system_state = app.state::<system::SystemState>().inner().clone();
                system::start_background_sampler(system_state.0);
            }

            // Register the existing notes vault's assets directory with the
            // asset protocol scope so images can be rendered via convertFileSrc.
            if let Some(vault) = notes::read_vault_path_for_setup() {
                notes::register_vault_assets_scope(app.handle(), &vault);
            }

            let app_handle_for_file = app.handle().clone();
            app.listen("tauri://file-open", move |event| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    if let Some(paths) = payload.get("paths").and_then(|p| p.as_array()) {
                        for path in paths {
                            if let Some(path_str) = path.as_str() {
                                emit_md_file_open(&app_handle_for_file, path_str);
                            }
                        }
                    }
                }
            });

            for arg in std::env::args().skip(1) {
                let lower = arg.to_lowercase();
                if lower.ends_with(".md") || lower.ends_with(".markdown") {
                    emit_md_file_open(app.handle(), &arg);
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
                                        // Start polling for schedule reminders to fire
                                        // native system toasts independent of webview state.
                                        schedule_notifier::start_polling(
                                            app_handle_clone.clone(),
                                            actual_port,
                                        );
                                        // 启动邮箱后台静默同步引擎：30s 后首次执行，之后每 5 分钟一次
                                        email::start_background_sync(
                                            app_handle_clone.clone(),
                                            actual_port,
                                        );
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
                    log::debug!("No provider configured, skipping gateway auto-start");
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
                        log::warn!("Update check failed: {}", e);
                    }
                }
            });

            let window = app.get_webview_window("main").unwrap();
            let gateway_state_for_close = gateway_state.clone();
            window.clone().on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let current_settings = settings::load_settings();
                    if current_settings.run_in_background {
                        log::debug!("[window] CloseRequested: prevent_close + hide (run_in_background=true)");
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        log::debug!("[window] CloseRequested: closing app (run_in_background=false)");
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
