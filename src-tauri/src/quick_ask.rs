use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition, PhysicalSize, Position,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub const QUICK_ASK_LABEL: &str = "quick-ask";
pub const DEFAULT_QUICK_ASK_SHORTCUT: &str = "Ctrl+Alt+M";

#[derive(Default)]
pub struct QuickAskShortcutState {
    registered: Mutex<Option<String>>,
}

pub fn toggle_quick_ask(app: &AppHandle) {
    if let Err(e) = toggle_quick_ask_inner(app) {
        log::error!("Failed to toggle quick ask window: {}", e);
    }
}

pub fn register_quick_ask_shortcut(
    app: &AppHandle,
    state: &QuickAskShortcutState,
    shortcut_text: &str,
) -> Result<(), String> {
    let normalized = normalize_shortcut_label(shortcut_text);
    let shortcut = parse_shortcut(&normalized)?;
    let mut registered = state
        .registered
        .lock()
        .map_err(|e| format!("Failed to lock shortcut state: {}", e))?;

    if registered.as_deref() == Some(normalized.as_str()) {
        return Ok(());
    }

    if let Some(previous) = registered.take() {
        if let Ok(previous_shortcut) = parse_shortcut(&previous) {
            let _ = app.global_shortcut().unregister(previous_shortcut);
        }
    }

    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| format!("Failed to register shortcut {}: {}", normalized, e))?;
    *registered = Some(normalized);
    Ok(())
}

#[tauri::command]
pub fn quick_ask_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(QUICK_ASK_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn quick_ask_show(app: AppHandle) -> Result<(), String> {
    show_quick_ask(&app)
}

#[tauri::command]
pub fn quick_ask_focus_chat(app: AppHandle, chat_id: String) -> Result<(), String> {
    show_main_window(&app)?;
    app.emit(
        "quick-open-chat",
        serde_json::json!({
            "chatId": chat_id,
        }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quick_ask_open_note(app: AppHandle) -> Result<(), String> {
    show_main_window(&app)?;
    app.emit("tray-new-note", ()).map_err(|e| e.to_string())?;
    quick_ask_hide(app)
}

#[tauri::command]
pub fn quick_ask_open_ssh(app: AppHandle) -> Result<(), String> {
    show_main_window(&app)?;
    app.emit("tray-new-ssh", ()).map_err(|e| e.to_string())?;
    quick_ask_hide(app)
}

fn toggle_quick_ask_inner(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(QUICK_ASK_LABEL) {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e| e.to_string())?;
            return Ok(());
        }
        return show_existing_quick_ask_window(&window);
    }
    show_quick_ask(app)
}

fn show_quick_ask(app: &AppHandle) -> Result<(), String> {
    let window = WebviewWindowBuilder::new(
        app,
        QUICK_ASK_LABEL,
        WebviewUrl::App("#/quick-ask".into()),
    )
    .title("Mona Quick Ask")
    .inner_size(900.0, 140.0)
    .min_inner_size(560.0, 120.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    show_existing_quick_ask_window(&window)
}

fn show_existing_quick_ask_window(window: &WebviewWindow) -> Result<(), String> {
    let _ = window.set_always_on_top(true);
    place_quick_ask_window(window);
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn place_quick_ask_window(window: &WebviewWindow) {
    let monitor = window.current_monitor().ok().flatten();
    let outer_size = window.outer_size().ok();
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let monitor_size = monitor.size();
        let monitor_pos = monitor.position();
        let logical_monitor_size = physical_size_to_logical(*monitor_size, scale);
        let logical_monitor_pos = physical_position_to_logical(*monitor_pos, scale);
        let logical_window_width = outer_size
            .map(|size| size.width as f64 / scale)
            .unwrap_or(900.0);
        let logical_window_height = outer_size
            .map(|size| size.height as f64 / scale)
            .unwrap_or(140.0);
        let x = logical_monitor_pos.0 + (logical_monitor_size.0 - logical_window_width) / 2.0;
        let y = logical_monitor_pos.1 + logical_monitor_size.1 - logical_window_height - 48.0;
        let _ = window.set_position(Position::Logical(LogicalPosition::new(
            x.max(logical_monitor_pos.0),
            y,
        )));
        return;
    }
    let _ = window.center();
}

fn physical_size_to_logical(size: PhysicalSize<u32>, scale: f64) -> (f64, f64) {
    (size.width as f64 / scale, size.height as f64 / scale)
}

fn physical_position_to_logical(pos: PhysicalPosition<i32>, scale: f64) -> (f64, f64) {
    (pos.x as f64 / scale, pos.y as f64 / scale)
}

fn normalize_shortcut_label(raw: &str) -> String {
    raw.split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

fn parse_shortcut(raw: &str) -> Result<Shortcut, String> {
    let tokens: Vec<&str> = raw
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();

    if tokens.is_empty() {
        return Err("Shortcut cannot be empty".to_string());
    }

    let mut modifiers = Modifiers::empty();
    let mut key: Option<Code> = None;

    for token in tokens {
        match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= Modifiers::CONTROL,
            "alt" | "option" => modifiers |= Modifiers::ALT,
            "shift" => modifiers |= Modifiers::SHIFT,
            "cmd" | "command" | "meta" | "super" | "win" | "windows" => {
                modifiers |= Modifiers::SUPER
            }
            _ => {
                if key.is_some() {
                    return Err("Shortcut can only contain one non-modifier key".to_string());
                }
                key = Some(parse_key_code(token)?);
            }
        }
    }

    if modifiers.is_empty() {
        return Err("Shortcut must include at least one modifier key".to_string());
    }

    let key = key.ok_or_else(|| "Shortcut is missing a key".to_string())?;
    Ok(Shortcut::new(Some(modifiers), key))
}

fn parse_key_code(token: &str) -> Result<Code, String> {
    let upper = token.to_ascii_uppercase();
    if upper.len() == 1 {
        let ch = upper.as_bytes()[0] as char;
        if ch.is_ascii_alphabetic() {
            return match ch {
                'A' => Ok(Code::KeyA),
                'B' => Ok(Code::KeyB),
                'C' => Ok(Code::KeyC),
                'D' => Ok(Code::KeyD),
                'E' => Ok(Code::KeyE),
                'F' => Ok(Code::KeyF),
                'G' => Ok(Code::KeyG),
                'H' => Ok(Code::KeyH),
                'I' => Ok(Code::KeyI),
                'J' => Ok(Code::KeyJ),
                'K' => Ok(Code::KeyK),
                'L' => Ok(Code::KeyL),
                'M' => Ok(Code::KeyM),
                'N' => Ok(Code::KeyN),
                'O' => Ok(Code::KeyO),
                'P' => Ok(Code::KeyP),
                'Q' => Ok(Code::KeyQ),
                'R' => Ok(Code::KeyR),
                'S' => Ok(Code::KeyS),
                'T' => Ok(Code::KeyT),
                'U' => Ok(Code::KeyU),
                'V' => Ok(Code::KeyV),
                'W' => Ok(Code::KeyW),
                'X' => Ok(Code::KeyX),
                'Y' => Ok(Code::KeyY),
                'Z' => Ok(Code::KeyZ),
                _ => Err(format!("Unsupported shortcut key: {}", token)),
            };
        }
        if ch.is_ascii_digit() {
            return match ch {
                '0' => Ok(Code::Digit0),
                '1' => Ok(Code::Digit1),
                '2' => Ok(Code::Digit2),
                '3' => Ok(Code::Digit3),
                '4' => Ok(Code::Digit4),
                '5' => Ok(Code::Digit5),
                '6' => Ok(Code::Digit6),
                '7' => Ok(Code::Digit7),
                '8' => Ok(Code::Digit8),
                '9' => Ok(Code::Digit9),
                _ => Err(format!("Unsupported shortcut key: {}", token)),
            };
        }
    }

    if let Some(rest) = upper.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u8>() {
            return match n {
                1 => Ok(Code::F1),
                2 => Ok(Code::F2),
                3 => Ok(Code::F3),
                4 => Ok(Code::F4),
                5 => Ok(Code::F5),
                6 => Ok(Code::F6),
                7 => Ok(Code::F7),
                8 => Ok(Code::F8),
                9 => Ok(Code::F9),
                10 => Ok(Code::F10),
                11 => Ok(Code::F11),
                12 => Ok(Code::F12),
                _ => Err(format!("Unsupported function key: {}", token)),
            };
        }
    }

    match upper.as_str() {
        "SPACE" => Ok(Code::Space),
        "TAB" => Ok(Code::Tab),
        "ENTER" | "RETURN" => Ok(Code::Enter),
        "ESC" | "ESCAPE" => Ok(Code::Escape),
        "BACKSPACE" => Ok(Code::Backspace),
        "DELETE" | "DEL" => Ok(Code::Delete),
        "UP" | "ARROWUP" => Ok(Code::ArrowUp),
        "DOWN" | "ARROWDOWN" => Ok(Code::ArrowDown),
        "LEFT" | "ARROWLEFT" => Ok(Code::ArrowLeft),
        "RIGHT" | "ARROWRIGHT" => Ok(Code::ArrowRight),
        _ => Err(format!("Unsupported shortcut key: {}", token)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_shortcut() {
        assert!(parse_shortcut(DEFAULT_QUICK_ASK_SHORTCUT).is_ok());
    }

    #[test]
    fn rejects_shortcut_without_modifier() {
        assert!(parse_shortcut("M").is_err());
    }
}
