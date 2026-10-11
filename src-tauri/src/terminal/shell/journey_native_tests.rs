//! Opt-in workbench host: actual WebView2, IPC HTTP bridge, browser and ConPTY.
//! Only endpoint discovery/token injection are fixture wiring; no normal app startup.
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::Manager;

use crate::browser::{commands as browser_commands, BrowserState};
use crate::terminal::{commands, TerminalState};

struct Endpoint { base: String, token: String }

#[tauri::command]
fn gateway_status(state: tauri::State<'_, Endpoint>) -> Value {
    let url = url::Url::parse(&state.base).expect("validated fixture URL");
    json!({"running": true, "port": url.port(), "ws_port": null})
}

#[tauri::command]
async fn local_http_request(state: tauri::State<'_, Endpoint>, method: String, url: String,
    mut headers: Vec<(String, String)>, body: Option<Vec<u8>>) -> Result<crate::LocalHttpResponse, String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid fixture URL")?;
    if parsed.origin().ascii_serialization() != state.base
        || !parsed.path().starts_with("/api/development/") {
        return Err("Native verification only addresses its own development API".into());
    }
    // Explicit fixture credential avoids reading the user's services.token.
    headers.retain(|(name, _)| !name.eq_ignore_ascii_case("x-mona-token"));
    headers.push(("X-Mona-Token".into(), state.token.clone()));
    crate::perform_local_http_request(method, url, headers, body).await
}

#[test]
#[ignore = "explicit isolated UI/API/profile and CDP required; no normal Mona services"]
fn development_native_workbench_host() {
    let output = PathBuf::from(std::env::var_os("MONA_JOURNEY_OUTPUT").expect("isolated output"));
    let allowed = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("output").canonicalize().unwrap();
    let output = output.canonicalize().unwrap();
    assert!(output.starts_with(&allowed) && output != allowed);
    let profile = PathBuf::from(std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").expect("isolated profile")).canonicalize().unwrap();
    assert!(profile.starts_with(&output) && profile != output);
    assert!(!output.join("native-host.json").exists());
    let ui: url::Url = std::env::var("MONA_JOURNEY_UI").unwrap().parse().unwrap();
    let api: url::Url = std::env::var("MONA_JOURNEY_API").unwrap().parse().unwrap();
    for url in [&ui, &api] {
        assert!(url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
            && url.port().is_some() && url.username().is_empty() && url.password().is_none());
    }
    let token = std::env::var("MONA_SMOKE_TOKEN").expect("fixture credential");
    assert!(token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()));
    let endpoint = Endpoint { base: api.origin().ascii_serialization(), token };
    let started = Instant::now();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.mona.workbench-test.{}", uuid::Uuid::new_v4().simple());
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = Some(ui.clone());
    let app = tauri::Builder::default().any_thread()
        .manage(endpoint).manage(BrowserState::new()).manage(super::isolated_terminal_state())
        .invoke_handler(tauri::generate_handler![gateway_status, local_http_request,
            commands::shell_spawn, commands::shell_write, commands::shell_resize,
            commands::shell_kill, commands::shell_get_buffer, commands::terminal_list_sessions,
            browser_commands::browser_create_tab, browser_commands::browser_close_tab,
            browser_commands::browser_update_tab_url, browser_commands::browser_update_tab_title,
            browser_commands::browser_list_tabs, browser_commands::browser_set_tab_bounds,
            browser_commands::browser_hide_tabs_except, browser_commands::browser_navigate_tab,
            browser_commands::browser_go_back, browser_commands::browser_go_forward,
            browser_commands::browser_reload, browser_commands::browser_open_devtools,
            browser_commands::browser_set_zoom, browser_commands::browser_get_zoom,
            browser_commands::browser_eval_script_result, browser_commands::browser_get_page_info])
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(ui))
                .title("Mona isolated workbench verification").inner_size(1600.0, 1000.0)
                .visible(false).focused(false).build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut stopped = false;
                for _ in 0..4500 {
                    if output.join("stop-native").is_file() { stopped = true; break; }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                let mut errors = Vec::new();
                let browser = handle.state::<BrowserState>();
                for tab in browser.list_tabs() {
                    if browser.close_tab(&handle, &tab.id).await.is_err() { errors.push("browser_close"); }
                }
                for session in handle.state::<TerminalState>().manager.list_sessions().await {
                    if commands::shell_kill(handle.state(), session.id).await.is_err() { errors.push("shell_close"); }
                }
                let report = json!({"status": if stopped && errors.is_empty() {"closed"} else {"failed"},
                    "stopObserved": stopped, "cleanupErrors": errors, "elapsedSeconds": started.elapsed().as_secs_f64(),
                    "scope": "Actual module frontend and native IPC/resources in isolated host; app bootstrap/provider-settings shell not included"});
                let saved = std::fs::write(output.join("native-host.json"), serde_json::to_vec_pretty(&report).unwrap()).is_ok();
                handle.exit(if saved && stopped && errors.is_empty() {0} else {1});
            });
            Ok(())
        }).build(context).expect("isolated workbench host");
    app.run_return(|_, _| {});
}
