use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Manager,
};

pub fn setup_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let open_browser_item =
        MenuItem::with_id(app, "open_browser", "在浏览器中打开", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 Mona", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_item, &open_browser_item, &quit_item])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Mona")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "open_browser" => {
                if let Some(gateway) = app.try_state::<crate::GatewayState>() {
                    if let Some(port) = gateway.port() {
                        let url = format!("http://127.0.0.1:{}", port);
                        let _ = open::that(&url);
                    }
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
