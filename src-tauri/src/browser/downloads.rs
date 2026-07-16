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
        .set_size(LogicalSize::new(WIDTH, HEIGHT))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            main_position.x + (anchor.left * scale).round() as i32,
            main_position.y + (anchor.top * scale).round() as i32,
        ))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_show_downloads(
    app: AppHandle,
    anchor: DownloadPopupAnchor,
) -> Result<(), String> {
    if app.get_webview_window(WINDOW_LABEL).is_none() {
        let window_app = app.clone();
        app.run_on_main_thread(move || {
            if window_app.get_webview_window(WINDOW_LABEL).is_some() {
                return;
            }
            let Some(main) = window_app.get_webview_window("main") else {
                return;
            };
            let builder = WebviewWindowBuilder::new(
                &window_app,
                WINDOW_LABEL,
                WebviewUrl::App("#/browser-downloads".into()),
            )
            .title("")
            .decorations(false)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .shadow(false);
            let Ok(window) = builder.parent(&main).and_then(|builder| builder.build())
            else {
                return;
            };
            let _ = window.set_size(LogicalSize::new(WIDTH, HEIGHT));
            let _ = place_window(&window_app, &anchor);
            let _ = window.show();
            let _ = window.set_focus();
        })
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    place_window(&app, &anchor)?;
    show_browser_downloads_window(app)
}

#[tauri::command]
pub fn show_browser_downloads_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_hide_downloads(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
