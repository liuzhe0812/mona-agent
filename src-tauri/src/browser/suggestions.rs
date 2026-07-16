use std::sync::Mutex;

use base64::Engine;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};

const WINDOW_LABEL: &str = "browser-address-suggestions";
const ITEM_HEIGHT: f64 = 52.0;
const WINDOW_PADDING: f64 = 8.0;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressSuggestion {
    pub url: String,
    pub title: String,
    pub is_bookmark: bool,
    pub visit_count: i64,
    pub last_visited_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressSuggestionPopup {
    pub tab_id: String,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub suggestions: Vec<AddressSuggestion>,
}

pub struct AddressSuggestionWindowState {
    active_tab: Mutex<Option<String>>,
}

impl AddressSuggestionWindowState {
    pub fn new() -> Self {
        Self {
            active_tab: Mutex::new(None),
        }
    }
}

fn popup_height(suggestions: &[AddressSuggestion]) -> f64 {
    WINDOW_PADDING + suggestions.len().min(8) as f64 * ITEM_HEIGHT
}

fn place_window(app: &AppHandle, payload: &AddressSuggestionPopup) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "address suggestions window not found".to_string())?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let main_position = main.inner_position().map_err(|e| e.to_string())?;
    let width = payload.width.clamp(240.0, 900.0);

    window
        .set_size(LogicalSize::new(width, popup_height(&payload.suggestions)))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            main_position.x + (payload.left * scale).round() as i32,
            main_position.y + (payload.top * scale).round() as i32,
        ))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_show_address_suggestions(
    app: AppHandle,
    state: tauri::State<'_, AddressSuggestionWindowState>,
    mut popup: AddressSuggestionPopup,
) -> Result<(), String> {
    popup.suggestions.truncate(8);
    if popup.suggestions.is_empty() {
        return browser_hide_address_suggestions(app, state, popup.tab_id);
    }

    if app.get_webview_window(WINDOW_LABEL).is_none() {
        let window_app = app.clone();
        let initial_popup = popup.clone();
        if let Ok(mut active_tab) = state.active_tab.lock() {
            *active_tab = Some(popup.tab_id);
        }
        app.run_on_main_thread(move || {
            if window_app.get_webview_window(WINDOW_LABEL).is_some() {
                return;
            }
            let Some(main) = window_app.get_webview_window("main") else {
                return;
            };
            let Ok(json) = serde_json::to_string(&initial_popup) else { return; };
            let data = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.as_bytes());
            let builder = WebviewWindowBuilder::new(
                &window_app,
                WINDOW_LABEL,
                WebviewUrl::App(format!("#/browser-suggestions?data={data}").into()),
            )
            .title("")
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .resizable(false)
            .focusable(false)
            .visible(false)
            .shadow(false);
            if builder.parent(&main).and_then(|builder| builder.build()).is_ok() {
                let _ = place_window(&window_app, &initial_popup);
                if let Some(window) = window_app.get_webview_window(WINDOW_LABEL) {
                    let _ = window.show();
                }
            }
        })
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    app.emit_to(WINDOW_LABEL, "browser-address-suggestions", &popup)
        .map_err(|e| e.to_string())?;

    place_window(&app, &popup)?;
    app.get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "address suggestions window not found".to_string())?
        .show()
        .map_err(|e| e.to_string())?;
    if let Ok(mut active_tab) = state.active_tab.lock() {
        *active_tab = Some(popup.tab_id);
    }
    Ok(())
}

#[tauri::command]
pub fn show_browser_address_suggestions_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_hide_address_suggestions(
    app: AppHandle,
    state: tauri::State<'_, AddressSuggestionWindowState>,
    tab_id: String,
) -> Result<(), String> {
    let mut active_tab = state.active_tab.lock().map_err(|e| e.to_string())?;
    if active_tab.as_deref() != Some(tab_id.as_str()) {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    *active_tab = None;
    Ok(())
}

#[tauri::command]
pub fn browser_select_address_suggestion(
    app: AppHandle,
    state: tauri::State<'_, AddressSuggestionWindowState>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    browser_hide_address_suggestions(app.clone(), state, tab_id.clone())?;
    app.emit_to(
        "main",
        "browser-address-suggestion-selected",
        serde_json::json!({ "tabId": tab_id, "url": url }),
    )
    .map_err(|e| e.to_string())
}
