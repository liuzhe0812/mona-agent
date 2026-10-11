use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use crate::browser::{BrowserState, read_webview2_string};
use super::browser_extensions;

async fn profile_path(view: tauri::Webview) -> Result<String, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    view.with_webview(move |view| {
        use windows::core::Interface;
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_13;
        let result = unsafe { view.controller().CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_13>()).and_then(|core| core.Profile()) }
            .map(|profile| read_webview2_string(|value| unsafe { profile.ProfilePath(value) })).map_err(|e| e.to_string());
        let _ = send.send(result);
    }).map_err(|e| e.to_string())?;
    receive.await.map_err(|e| e.to_string())?
}

#[test]
#[ignore = "explicit hidden Windows WebView2 integration test with an isolated profile"]
fn browser_extensions_native() {
    let output = PathBuf::from(std::env::var_os("MONA_EXTENSION_TEST_OUTPUT").expect("explicit output directory"));
    let allowed = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("output").canonicalize().unwrap();
    assert!(output.canonicalize().unwrap().starts_with(allowed));
    assert!(std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none(), "profile overrides prevent isolation");
    let result = Arc::new(Mutex::new(None));
    let completed = result.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.mona.extension-test.{}", uuid::Uuid::new_v4().simple());
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    let app = tauri::Builder::default().any_thread().manage(BrowserState::new()).setup(move |app| {
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External("about:blank".parse()?))
            .data_directory(output.join("main-profile")).visible(false).focused(false).build()?;
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let outcome: Result<(), String> = tokio::time::timeout(Duration::from_secs(120), async {
                let main = handle.get_webview("main").ok_or("Missing test host")?;
                let browser = handle.state::<BrowserState>();
                browser.create_tab(&handle, "extension-test", "about:blank", false, false).await?;
                let page = handle.get_webview("browser-extension-test").ok_or("Missing browser view")?;
                let main_path = profile_path(main.clone()).await?;
                let page_path = profile_path(page.clone()).await?;
                if main_path.is_empty() || page_path.is_empty() || main_path == page_path { return Err("Browser and app profiles are not isolated".into()); }
                std::fs::write(output.join("profiles.json"), serde_json::to_vec(&serde_json::json!({"main": main_path,"browser":page_path})).unwrap()).map_err(|e| e.to_string())?;
                let initial = browser_extensions(handle.clone(), main.clone(), "extension-test".into(), "list".into(), None, None, None).await?;
                std::fs::write(output.join("initial-extensions.json"), serde_json::to_vec(&initial).unwrap()).map_err(|e| e.to_string())?;
                let folder = output.join("test-extension");
                std::fs::create_dir(&folder).map_err(|e| e.to_string())?;
                std::fs::write(folder.join("manifest.json"), r#"{"manifest_version":3,"name":"Mona Test Extension","version":"1.0"}"#).map_err(|e| e.to_string())?;
                browser_extensions(handle.clone(), main.clone(), "extension-test".into(), "install".into(), Some(folder.to_string_lossy().into()), None, None).await?;
                let rows = browser_extensions(handle.clone(), main.clone(), "extension-test".into(), "list".into(), None, None, None).await?;
                let extension = rows.into_iter().find(|row| row.name == "Mona Test Extension" && row.enabled).ok_or("Installed extension not returned")?;
                for enabled in [false, true] {
                    browser_extensions(handle.clone(), main.clone(), "extension-test".into(), "enable".into(), None, Some(extension.id.clone()), Some(enabled)).await?;
                    let rows = browser_extensions(handle.clone(), main.clone(), "extension-test".into(), "list".into(), None, None, None).await?;
                    if !rows.iter().any(|row| row.id == extension.id && row.enabled == enabled) { return Err("Extension state not applied".into()); }
                }
                if browser_extensions(handle.clone(), page, "extension-test".into(), "remove".into(), None, Some(extension.id.clone()), None).await.is_ok() { return Err("Remote page accepted extension management".into()); }
                browser_extensions(handle.clone(), main.clone(), "extension-test".into(), "remove".into(), None, Some(extension.id), None).await?;
                let remaining = browser_extensions(handle.clone(), main.clone(), "extension-test".into(), "list".into(), None, None, None).await?;
                if remaining.len() != initial.len() || remaining.iter().any(|row| !initial.iter().any(|original| row.id == original.id)) { return Err("Extension removal not applied".into()); }
                crate::browser::page_actions::browser_page_action(handle.clone(), main.clone(), "extension-test".into(), "device".into(), Some(390), Some(844)).await?;
                crate::browser::page_actions::browser_page_action(handle.clone(), main.clone(), "extension-test".into(), "device_off".into(), None, None).await?;
                browser.set_tab_bounds(&handle, "extension-test", 0.0, 0.0, 640.0, 480.0, true).await?;
                let screenshot = crate::browser::page_actions::browser_page_action(handle.clone(), main.clone(), "extension-test".into(), "capture".into(), None, None).await?;
                if !screenshot["data"].as_str().is_some_and(|data| data.starts_with("iVBORw0")) { return Err("Screenshot did not return a PNG".into()); }
                for action in ["clear_cache", "clear_cookies"] {
                    crate::browser::page_actions::browser_page_action(handle.clone(), main.clone(), "extension-test".into(), action.into(), None, None).await?;
                }
                browser.close_tab(&handle, "extension-test").await?;
                Ok(())
            }).await.unwrap_or_else(|_| Err("Native extension test timed out".into()));
            for tab in handle.state::<BrowserState>().list_tabs() { let _ = handle.state::<BrowserState>().close_tab(&handle, &tab.id).await; }
            std::fs::write(output.join("result.json"), serde_json::to_vec(&serde_json::json!({"passed":outcome.is_ok(),"error":outcome.as_ref().err()})).unwrap()).expect("write result");
            *completed.lock().unwrap() = Some(outcome);
            handle.exit(0);
        });
        Ok(())
    }).build(context).expect("isolated native test app");
    app.run_return(|_, _| {});
    result.lock().unwrap().take().expect("completed test").expect("native extension integration");
}
