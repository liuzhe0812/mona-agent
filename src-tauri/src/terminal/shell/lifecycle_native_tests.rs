//! Explicit native smoke test. No normal Mona startup, user databases or services.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{Listener, Manager};
use tokio::sync::RwLock;

use crate::browser::BrowserState;
use crate::terminal::{approval::ApprovalState, commands, docker::DockerState,
    maintenance::MaintenanceStore, session::SessionManager, sftp::batch::BatchTransferManager,
    ssh::known_hosts::KnownHostsStore, TerminalState};

fn isolated_terminal_state() -> TerminalState {
    TerminalState {
        manager: SessionManager::new(32),
        known_hosts: Arc::new(KnownHostsStore::new_in_memory()),
        approval: ApprovalState::new(),
        batch_transfer: BatchTransferManager::new(),
        transfer_cancels: Arc::new(RwLock::new(HashMap::new())),
        maintenance: Arc::new(MaintenanceStore::new_in_memory().expect("isolated database")),
        maintenance_cancels: Arc::new(RwLock::new(HashMap::new())),
        docker: DockerState::new(),
    }
}

fn checked(checks: &mut Vec<String>, name: &str, condition: bool) -> Result<(), String> {
    if !condition { return Err(format!("Native acceptance failed: {name}")); }
    checks.push(name.into());
    eprintln!("NATIVE_CHECK {name}");
    Ok(())
}

async fn answer_cursor_query(app: &tauri::AppHandle, id: &str, output: &str,
    cursor_replies: &mut HashMap<String, usize>) -> Result<(), String> {
    // This is terminal-emulator input, not synthesized process output.
    let count = output.matches("\x1b[6n").count();
    let replied = cursor_replies.entry(id.into()).or_default();
    while *replied < count {
        commands::shell_write(app.state(), id.into(), "\x1b[1;1R".into()).await?;
        *replied += 1;
    }
    Ok(())
}

async fn wait_shell(app: &tauri::AppHandle, id: &str, marker: &str,
    cursor_replies: &mut HashMap<String, usize>) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let output = commands::shell_get_buffer(app.state(), id.into()).await?;
            answer_cursor_query(app, id, &output, cursor_replies).await?;
            if output.contains(marker) { return Ok(()); }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await.map_err(|_| "Timed out waiting for real shell output".to_string())?
}

async fn browser_visible(app: &tauri::AppHandle, id: &str) -> Result<bool, String> {
    let view = app.get_webview(&format!("browser-{id}")).ok_or("Missing native view")?;
    let (send, receive) = tokio::sync::oneshot::channel();
    view.with_webview(move |native| {
        let mut visible = windows::core::BOOL::default();
        let result = unsafe { native.controller().IsVisible(&mut visible) }
            .map(|_| visible.as_bool()).map_err(|error| error.to_string());
        let _ = send.send(result);
    }).map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), receive).await
        .map_err(|_| "Native visibility query timed out".to_string())?
        .map_err(|error| error.to_string())?
}

async fn cancel_pending_creation(app: &tauri::AppHandle, checks: &mut Vec<String>) -> Result<(), String> {
    let browser = app.state::<BrowserState>();
    let id = "cancelled-create";
    let (release, gate) = std::sync::mpsc::channel::<()>();
    let (entered, waiting) = tokio::sync::oneshot::channel();
    // Hold only this isolated host's UI queue so cancellation reaches a real pending create.
    app.get_window("main").ok_or("Missing main window")?.run_on_main_thread(move || {
        let _ = entered.send(());
        let _ = gate.recv_timeout(Duration::from_secs(5));
    }).map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), waiting).await
        .map_err(|_| "Native test queue did not enter its barrier".to_string())?
        .map_err(|error| error.to_string())?;
    let owner = app.clone();
    let pending = tokio::spawn(async move {
        owner.state::<BrowserState>().create_tab(&owner, id, "about:blank", false, false).await
    });
    let reserved = tokio::time::timeout(Duration::from_secs(2), async {
        while !browser.list_tabs().iter().any(|tab| tab.id == id) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.is_ok();
    let hide = browser.hide_tabs_except(app, None).await;
    pending.abort();
    let cancelled = pending.await.is_err_and(|error| error.is_cancelled());
    drop(release);
    if !reserved || !cancelled { return Err("Did not cancel the pending native creation".into()); }
    tokio::time::timeout(Duration::from_secs(5), async {
        while browser.list_tabs().iter().any(|tab| tab.id == id)
            || app.get_webview(&format!("browser-{id}")).is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.map_err(|_| "Cancelled creation leaked its reservation or native view".to_string())?;
    checked(checks, "cancelled_creation_releases_native_reservation", true)?;
    checked(checks, "pending_creation_hides_other_pages_and_reports_missing_view",
        hide.is_err() && !browser_visible(app, "preview-a").await? && !browser_visible(app, "preview-b").await?)?;
    browser.create_tab(app, id, "about:blank", false, false).await?;
    checked(checks, "same_id_retries_after_cancelled_creation",
        app.get_webview(&format!("browser-{id}")).is_some())?;
    browser.close_tab(app, id).await
}

async fn abandon_created_reply(app: &tauri::AppHandle, checks: &mut Vec<String>) -> Result<(), String> {
    use std::future::Future;
    let browser = app.state::<BrowserState>();
    let id = "abandoned-create";
    let (release, gate) = std::sync::mpsc::channel::<()>();
    let (entered, waiting) = tokio::sync::oneshot::channel();
    app.get_window("main").ok_or("Missing main window")?.run_on_main_thread(move || {
        let _ = entered.send(());
        let _ = gate.recv_timeout(Duration::from_secs(5));
    }).map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), waiting).await
        .map_err(|_| "Native test queue did not enter its barrier".to_string())?
        .map_err(|error| error.to_string())?;
    let mut creation = Box::pin(browser.create_tab(app, id, "about:blank", false, false));
    let pending = std::future::poll_fn(|cx| {
        std::task::Poll::Ready(creation.as_mut().poll(cx).is_pending())
    }).await;
    drop(release);
    if !pending { return Err("Native creation completed before the reply could be abandoned".into()); }
    tokio::time::timeout(Duration::from_secs(5), async {
        while app.get_webview(&format!("browser-{id}")).is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.map_err(|_| "Pending creation produced no native view".to_string())?;
    // Query the actual controller while deliberately leaving the create reply unconsumed.
    browser_visible(app, id).await?;
    drop(creation);
    tokio::time::timeout(Duration::from_secs(5), async {
        while browser.list_tabs().iter().any(|tab| tab.id == id)
            || app.get_webview(&format!("browser-{id}")).is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.map_err(|_| "Abandoned native reply leaked its original view".to_string())?;
    checked(checks, "abandoned_native_reply_reclaims_exact_view", true)?;
    browser.create_tab(app, id, "about:blank", false, false).await?;
    checked(checks, "same_id_retries_after_abandoned_native_reply",
        app.get_webview(&format!("browser-{id}")).is_some())?;
    browser.close_tab(app, id).await
}

async fn exercise(app: &tauri::AppHandle, output: &Path, checks: &mut Vec<String>) -> Result<(), String> {
    let project = output.join("项目 A");
    std::fs::create_dir(&project).map_err(|error| error.to_string())?;
    let first = commands::shell_spawn(app.clone(), app.state(), 80, 24,
        Some(project.to_string_lossy().into_owned())).await?;
    let second = commands::shell_spawn(app.clone(), app.state(), 80, 24,
        Some(project.to_string_lossy().into_owned())).await?;
    checked(checks, "separate_native_processes", first != second)?;
    let mut cursor_replies = HashMap::new();
    wait_shell(app, &first, ">", &mut cursor_replies).await?;
    wait_shell(app, &second, ">", &mut cursor_replies).await?;
    commands::shell_write(app.state(), first.clone(),
        "$monaLifecycleValue='session-A'; Write-Output ('MONA_'+'FIRST'); (Get-Location).Path\r".into()).await?;
    wait_shell(app, &first, "MONA_FIRST", &mut cursor_replies).await?;
    let first_output = commands::shell_get_buffer(app.state(), first.clone()).await?;
    checked(checks, "native_project_working_directory", first_output.contains("项目 A"))?;
    commands::shell_write(app.state(), second.clone(),
        "Write-Output ('OTHER_'+[string]$monaLifecycleValue+'_END')\r".into()).await?;
    wait_shell(app, &second, "OTHER__END", &mut cursor_replies).await?;
    checked(checks, "shell_variables_do_not_cross_sessions", true)?;
    commands::shell_resize(app.state(), first.clone(), 110, 35).await?;
    checked(checks, "real_pty_resize", true)?;

    let browser = app.state::<BrowserState>();
    browser.create_tab(app, "preview-a", "about:blank", false, false).await?;
    browser.create_tab(app, "preview-b", "about:blank", false, false).await?;
    checked(checks, "native_duplicate_create_rejected",
        browser.create_tab(app, "preview-a", "about:blank", false, false).await.is_err()
        && browser.list_tabs().len() == 2)?;
    browser.eval_script_result(app, "preview-a",
        "document.body.innerHTML='<input id=\"draft\"><button>Keep</button>'; document.querySelector('#draft').value='UNSAVED_FORM'; true").await?;
    browser.set_tab_bounds(app, "preview-a", 640.0, 100.0, 440.0, 660.0, true).await?;
    browser.hide_tabs_except(app, Some("preview-a")).await?;
    checked(checks, "only_selected_native_preview_visible",
        browser_visible(app, "preview-a").await? && !browser_visible(app, "preview-b").await?)?;
    let view = app.get_webview("browser-preview-a").ok_or("Missing original view")?;
    checked(checks, "native_content_below_header", view.position().map_err(|e| e.to_string())?.y >= 100)?;
    browser.hide_tabs_except(app, None).await?;
    checked(checks, "module_hide_keeps_both_webviews",
        !browser_visible(app, "preview-a").await? && !browser_visible(app, "preview-b").await?
        && browser.list_tabs().len() == 2)?;
    browser.set_tab_bounds(app, "preview-b", 600.0, 100.0, 400.0, 600.0, true).await?;
    browser.hide_tabs_except(app, Some("preview-b")).await?;
    checked(checks, "native_session_switch_hides_previous_view",
        !browser_visible(app, "preview-a").await? && browser_visible(app, "preview-b").await?)?;
    browser.set_tab_bounds(app, "preview-a", 0.0, 80.0, 1100.0, 700.0, true).await?;
    browser.hide_tabs_except(app, Some("preview-a")).await?;
    let value = browser.eval_script_result(app, "preview-a", "document.querySelector('#draft').value").await?;
    checked(checks, "native_form_survives_switch_and_maximize", value == json!("UNSAVED_FORM"))?;
    let privilege = browser.eval_script_result(app, "preview-a", "typeof window.__TAURI_INTERNALS__").await?;
    checked(checks, "preview_has_no_tauri_api", privilege == json!("undefined"))?;
    let before = Instant::now();
    app.get_window("main").ok_or("Missing main window")?
        .set_size(tauri::LogicalSize::new(1200.0, 850.0)).map_err(|error| error.to_string())?;
    checked(checks, "window_control_remains_responsive", before.elapsed() < Duration::from_secs(2))?;
    for index in 0..20 {
        let id = format!("cycle-{index}");
        browser.create_tab(app, &id, "about:blank", false, false).await?;
        browser.set_tab_bounds(app, &id, 600.0, 100.0, 300.0, 500.0, true).await?;
        browser.close_tab(app, &id).await?;
        if app.get_webview(&format!("browser-{id}")).is_some() {
            return Err(format!("Native view leaked after close: {index}"));
        }
        if browser.set_tab_bounds(app, &id, 0.0, 0.0, 300.0, 500.0, true).await.is_ok() {
            return Err("A closed native tab accepted a late layout".into());
        }
    }
    checked(checks, "twenty_native_create_close_cycles_without_orphans", browser.list_tabs().len() == 2)?;
    cancel_pending_creation(app, checks).await?;
    abandon_created_reply(app, checks).await?;
    checked(checks, "other_browser_page_and_manual_form_preserved",
        browser.eval_script_result(app, "preview-a", "document.querySelector('#draft').value").await? == json!("UNSAVED_FORM"))?;
    let sessions = commands::terminal_list_sessions(app.state()).await?;
    checked(checks, "terminal_remains_running_while_preview_switches",
        sessions.iter().any(|session| session.id == first && session.status == "connected"))?;

    let exits = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = exits.clone();
    let listener = app.listen("terminal-session-status", move |event| {
        if let Ok(value) = serde_json::from_str(event.payload()) { captured.lock().unwrap().push(value); }
    });
    commands::shell_write(app.state(), first.clone(), "exit\r".into()).await?;
    let mut last_exit_state = String::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let text = commands::shell_get_buffer(app.state(), first.clone()).await?;
            answer_cursor_query(app, &first, &text, &mut cursor_replies).await?;
            let rows = commands::terminal_list_sessions(app.state()).await?;
            last_exit_state = format!("status={:?}, events={:?}, exit_marker={}",
                rows.iter().find(|row| row.id == first).map(|row| &row.status),
                exits.lock().unwrap(), text.contains("[Shell exited]"));
            if rows.iter().any(|row| row.id == first && row.status == "disconnected")
                && exits.lock().unwrap().iter().any(|event| event["sessionId"] == first && event["status"] == "disconnected") {
                return Ok::<(), String>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await.map_err(|_| format!("Native exit event or process status missing: {last_exit_state}"))??;
    app.unlisten(listener);
    checked(checks, "natural_exit_reports_native_status_and_event", true)?;
    checked(checks, "terminal_output_retained_after_natural_exit",
        commands::shell_get_buffer(app.state(), first.clone()).await?.contains("MONA_FIRST"))?;
    commands::shell_kill(app.state(), first.clone()).await?;
    commands::shell_kill(app.state(), first.clone()).await?;
    let sessions = commands::terminal_list_sessions(app.state()).await?;
    checked(checks, "ending_exited_shell_is_idempotent_and_preserves_other_session",
        !sessions.iter().any(|session| session.id == first)
        && sessions.iter().any(|session| session.id == second && session.status == "connected"))?;
    commands::shell_kill(app.state(), second).await?;
    checked(checks, "native_terminal_cleanup_complete", commands::terminal_list_sessions(app.state()).await?.is_empty())?;
    Ok(())
}

struct NativeFailureLog;
impl log::Log for NativeFailureLog {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("NATIVE_RUNTIME {} {}: {}", record.level(), record.target(), record.args());
        }
    }
    fn flush(&self) {}
}
static NATIVE_FAILURE_LOG: NativeFailureLog = NativeFailureLog;

#[path = "journey_native_tests.rs"]
mod journey_native_tests;

#[test]
#[ignore = "requires explicit isolated output and an installed Windows WebView2 runtime"]
fn development_native_lifecycle() {
    if log::set_logger(&NATIVE_FAILURE_LOG).is_ok() { log::set_max_level(log::LevelFilter::Warn); }
    let output = PathBuf::from(std::env::var_os("MONA_LIFECYCLE_OUTPUT").expect("explicit test output"));
    let permitted = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("output").canonicalize().unwrap();
    assert!(output.canonicalize().unwrap().starts_with(permitted));
    let profile = PathBuf::from(std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").expect("isolated WebView2 profile"));
    assert!(profile.canonicalize().unwrap().starts_with(output.canonicalize().unwrap()));
    assert!(!output.join("native-report.json").exists(), "do not overwrite existing evidence");
    let started = Instant::now();
    let result = Arc::new(Mutex::new(None::<Result<(), String>>));
    let completed = result.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.mona.lifecycle-test.{}", uuid::Uuid::new_v4().simple());
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    let app = tauri::Builder::default().any_thread()
        .manage(BrowserState::new()).manage(isolated_terminal_state())
        .setup(move |app| {
            let missing_host = tauri::async_runtime::block_on(app.state::<BrowserState>()
                .create_tab(app.handle(), "startup-retry", "about:blank", false, false));
            let missing_host_clean = missing_host.is_err() && app.state::<BrowserState>().list_tabs().is_empty();
            // Hidden native window: exercise real Wry/ConPTY without taking over the user's desktop.
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External("about:blank".parse()?))
                .title("Mona isolated lifecycle verification")
                .inner_size(1200.0, 850.0).visible(false).focused(false).build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut checks = Vec::new();
                let outcome = tokio::time::timeout(Duration::from_secs(180), async {
                    checked(&mut checks, "failed_creation_leaves_no_reservation", missing_host_clean)?;
                    handle.state::<BrowserState>().create_tab(&handle, "startup-retry", "about:blank", false, false).await?;
                    handle.state::<BrowserState>().close_tab(&handle, "startup-retry").await?;
                    checked(&mut checks, "same_id_retries_after_failed_creation", true)?;
                    exercise(&handle, &output, &mut checks).await
                }).await.unwrap_or_else(|_| Err("Native lifecycle verification timed out".into()));
                let mut cleanup_errors = Vec::new();
                for tab in handle.state::<BrowserState>().list_tabs() {
                    if let Err(error) = handle.state::<BrowserState>().close_tab(&handle, &tab.id).await { cleanup_errors.push(error); }
                }
                for session in handle.state::<TerminalState>().manager.list_sessions().await {
                    if let Err(error) = commands::shell_kill(handle.state(), session.id).await { cleanup_errors.push(error); }
                }
                let outcome = outcome.and_then(|_| if cleanup_errors.is_empty() { Ok(()) } else { Err("Native cleanup failed".into()) });
                let report = json!({"status": if outcome.is_ok() { "passed" } else { "failed" },
                    "checks": checks, "error": outcome.as_ref().err(), "cleanupErrors": cleanup_errors,
                    "elapsedSeconds": started.elapsed().as_secs_f64(),
                    "scope": "Production BrowserState, shell commands, Wry WebView2 and Windows ConPTY in an isolated hidden native host; not a full logged-in Mona UI run"});
                let write = std::fs::write(output.join("native-report.json"), serde_json::to_vec_pretty(&report).unwrap());
                *completed.lock().unwrap() = Some(outcome.and_then(|_| write.map_err(|error| error.to_string())));
                handle.exit(0);
            });
            Ok(())
        }).build(context).expect("create isolated native host");
    app.run_return(|_, _| {});
    result.lock().unwrap().take().expect("native verification finished").expect("native verification passed");
}
