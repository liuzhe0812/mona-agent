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
    // 与地址栏建议窗一致：不可聚焦的悬浮窗，不抢焦点、无焦点事件，避免失焦即隐藏
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let app = &app_handle;
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            log::info!("[downloads] window exists, re-show");
            if let Err(e) = place_window(app, &anchor) {
                log::warn!("[downloads] place_window failed: {e}");
            }
            if let Err(e) = window.show() {
                log::warn!("[downloads] show failed: {e}");
            }
            log_window_state(&window);
            return;
        }

        let Some(main) = app.get_webview_window("main") else {
            log::warn!("[downloads] main window not found");
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
            Ok(window) => window,
            Err(e) => {
                log::warn!("[downloads] build failed: {e}");
                return;
            }
        };
        log::info!("[downloads] window built");
        if let Err(e) = window.set_size(LogicalSize::new(WIDTH, HEIGHT)) {
            log::warn!("[downloads] set_size failed: {e}");
        }
        if let Err(e) = place_window(app, &anchor) {
            log::warn!("[downloads] place_window failed: {e}");
        }
        if let Err(e) = window.show() {
            log::warn!("[downloads] show failed: {e}");
        }
        log_window_state(&window);
    })
    .map_err(|e| e.to_string())
}

fn log_window_state(window: &tauri::WebviewWindow) {
    let visible = window.is_visible().map_err(|e| e.to_string());
    let pos = window.outer_position().map_err(|e| e.to_string());
    let size = window.outer_size().map_err(|e| e.to_string());
    log::info!(
        "[downloads] state visible={:?} outer_pos={:?} outer_size={:?}",
        visible,
        pos,
        size
    );
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
