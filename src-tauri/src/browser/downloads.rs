use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};

const WINDOW_LABEL: &str = "browser-downloads";
const WIDTH: f64 = 360.0;
const HEIGHT: f64 = 420.0;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPopupAnchor {
    pub left: f64,
    pub top: f64,
}

fn place_window(app: &AppHandle, anchor: &DownloadPopupAnchor) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "downloads window not found".to_string())?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let main_position = main.inner_position().map_err(|e| e.to_string())?;

    window
        .set_position(PhysicalPosition::new(
            main_position.x + (anchor.left * scale).round() as i32,
            main_position.y + (anchor.top * scale).round() as i32,
        ))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_show_downloads(
    app: AppHandle,
    anchor: DownloadPopupAnchor,
) -> Result<(), String> {
    log::info!("[browser_downloads] show_downloads called, anchor={:?}", anchor);
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let app = &app_handle;
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            log::info!("[browser_downloads] reusing existing window, placing and showing");
            if let Err(e) = place_window(app, &anchor) {
                log::error!("[browser_downloads] place_window failed: {}", e);
            }
            if let Err(e) = window.show() {
                log::error!("[browser_downloads] window.show failed: {}", e);
            }
            return;
        }

        log::info!("[browser_downloads] creating new window");
        let Some(main) = app.get_webview_window("main") else {
            log::error!("[browser_downloads] main window not found");
            return;
        };
        let builder = WebviewWindowBuilder::new(
            app,
            WINDOW_LABEL,
            WebviewUrl::App("#/browser-downloads".into()),
        )
        .title("")
        .decorations(false)
        .skip_taskbar(true)
        .resizable(false)
        .focusable(false)
        .visible(false)
        .shadow(false);
        let window = match builder.parent(&main).and_then(|builder| builder.build()) {
            Ok(w) => w,
            Err(e) => {
                log::error!("[browser_downloads] build window failed: {}", e);
                return;
            }
        };
        crate::attach_permission_allower(&window);
        if let Err(e) = window.set_size(LogicalSize::new(WIDTH, HEIGHT)) {
            log::error!("[browser_downloads] set_size failed: {}", e);
        }
        if let Err(e) = place_window(app, &anchor) {
            log::error!("[browser_downloads] place_window failed: {}", e);
        }
        if let Err(e) = window.show() {
            log::error!("[browser_downloads] window.show failed: {}", e);
        } else {
            log::info!("[browser_downloads] window shown successfully");
        }
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_toggle_downloads(app: AppHandle, anchor: DownloadPopupAnchor) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return Ok(());
        }
    }
    browser_show_downloads(app, anchor).await
}

#[tauri::command]
pub fn browser_hide_downloads(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
