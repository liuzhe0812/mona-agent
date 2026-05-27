mod db;
mod gateway;
mod notes;
mod python;
mod settings;
mod terminal;
mod tray;

use gateway::GatewayManager;
use settings::AppSettings;
use std::sync::Arc;
use tauri::Manager;

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

    pub fn start(&self, settings: &AppSettings) -> Result<u16, String> {
        let port = self.inner.manager.start(settings)?;
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

    pub fn port(&self) -> Option<u16> {
        self.inner.port.lock().ok()?.as_ref().copied()
    }
}

#[tauri::command]
async fn get_settings() -> Result<AppSettings, String> {
    Ok(settings::load_settings())
}

#[tauri::command]
async fn update_settings(new_settings: AppSettings) -> Result<AppSettings, String> {
    settings::save_settings(&new_settings)?;
    Ok(settings::load_settings())
}

#[tauri::command]
async fn start_gateway(state: tauri::State<'_, GatewayState>) -> Result<u16, String> {
    let settings = settings::load_settings();
    settings::ensure_desktop_config(settings.gateway_port)?;
    let port = state.start(&settings)?;
    gateway::wait_for_gateway(port, 30).await?;
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
async fn initialize_python_env() -> Result<(), String> {
    python::initialize_python()
}

#[tauri::command]
async fn is_python_ready() -> Result<bool, String> {
    Ok(python::is_python_initialized())
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
            std::process::Command::new("cmd")
                .args(["/c", "start", url])
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let gateway_state = GatewayState::new();
    let terminal_state = terminal::TerminalState::new();
    let db_state = db::DbState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .manage(gateway_state.clone())
        .manage(terminal_state)
        .manage(db_state)
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            start_gateway,
            stop_gateway,
            gateway_status,
            initialize_python_env,
            is_python_ready,
            open_in_browser,
            mona_config_status,
            write_mona_provider_config,
            write_mona_model_config,
            notes::notes_load_state,
            notes::notes_save_state,
            notes::notes_export_temp,
            terminal::commands::ssh_connect,
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
            db::commands::db_list_connections,
            db::commands::db_save_connections,
            db::commands::db_load_connections,
        ])
        .setup(move |app| {
            tray::setup_tray(app)?;

            let settings = settings::load_settings();

            if settings.auto_start_gateway {
                let config_status = settings::check_mona_config();
                if config_status.has_provider {
                    if let Err(e) = settings::ensure_desktop_config(settings.gateway_port) {
                        log::error!("Failed to ensure desktop config: {}", e);
                    }
                    let state = gateway_state.clone();
                    let settings_clone = settings.clone();
                    tauri::async_runtime::spawn(async move {
                        match state.start(&settings_clone) {
                            Ok(actual_port) => {
                                match gateway::wait_for_gateway(actual_port, 30).await {
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
