use std::io::Cursor;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Emitter, Manager,
};

/// 从编译时嵌入的 PNG 字节解码为 Tauri Image（高分辨率，确保高 DPI 清晰）
pub fn load_icon() -> Image<'static> {
    let data = include_bytes!("../icons/icon.png");
    let decoder = png::Decoder::new(Cursor::new(data));
    let mut reader = decoder.read_info().expect("icon.png decode failed");
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("icon.png read failed");
    let (w, h) = (info.width, info.height);
    buf.truncate(buf.len());
    Image::new_owned(buf, w, h)
}

pub fn setup_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let new_note_item = MenuItem::with_id(app, "new_note", "新建笔记", true, None::<&str>)?;
    let new_ssh_item =
        MenuItem::with_id(app, "new_ssh", "新建 SSH 会话", true, None::<&str>)?;
    let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 Mona", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&new_note_item, &new_ssh_item, &show_item, &quit_item],
    )?;

    TrayIconBuilder::new()
        .icon(load_icon())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Mona")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "new_note" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("tray-new-note", ());
            }
            "new_ssh" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("tray-new-ssh", ());
            }
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                if let Some(gateway) = app.try_state::<crate::GatewayState>() {
                    let _ = gateway.stop();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
