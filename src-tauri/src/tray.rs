use std::io::Cursor;
use std::sync::{Arc, Mutex};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Emitter, Manager,
};

const TRAY_ID: &str = "main";

/// 从编译时嵌入的 PNG 字节解码为 Tauri Image（高分辨率，确保高 DPI 清晰）
fn decode_icon() -> (Vec<u8>, u32, u32) {
    let data = include_bytes!("../icons/icon.png");
    let decoder = png::Decoder::new(Cursor::new(data));
    let mut reader = decoder.read_info().expect("icon.png decode failed");
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).expect("icon.png read failed");
    let (w, h) = (info.width, info.height);
    buf.truncate(buf.len());
    (buf, w, h)
}

pub fn load_icon() -> Image<'static> {
    let (buf, w, h) = decode_icon();
    Image::new_owned(buf, w, h)
}

/// 在图标右下角绘制黄色信封角标：黄色圆形背景 + 深色信封图案
fn draw_mail_badge(buf: &mut [u8], width: u32, height: u32) {
    if width < 16 || height < 16 {
        return;
    }
    // 角标圆形半径，约占图标边长的 1/4
    let badge_radius = (width.min(height) as i32 / 4).max(6);
    let cx = width as i32 - badge_radius - 2;
    let cy = height as i32 - badge_radius - 2;
    let r_sq = badge_radius * badge_radius;

    // 1. 绘制黄色圆形背景 (#FBBF24 amber-400)
    for y in 0..height as i32 {
        for x in 0..width as i32 {
            let dx = x - cx;
            let dy = y - cy;
            if dx * dx + dy * dy <= r_sq {
                let idx = ((y * width as i32 + x) * 4) as usize;
                if idx + 3 < buf.len() {
                    buf[idx] = 251;     // R
                    buf[idx + 1] = 191; // G
                    buf[idx + 2] = 36;  // B  (amber-400)
                    buf[idx + 3] = 255; // A
                }
            }
        }
    }

    // 2. 在黄色圆形中央绘制深色信封图案
    let env_w = (badge_radius * 3 / 2).max(6);
    let env_h = (env_w * 2 / 3).max(4);
    let env_x0 = cx - env_w / 2;
    let env_y0 = cy - env_h / 2;
    let env_x1 = env_x0 + env_w - 1;
    let env_y1 = env_y0 + env_h - 1;

    for y in env_y0..=env_y1 {
        for x in env_x0..=env_x1 {
            if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
                continue;
            }
            let idx = ((y * width as i32 + x) * 4) as usize;
            if idx + 3 >= buf.len() {
                continue;
            }
            let rel_x = x - env_x0;
            let rel_y = y - env_y0;
            // 信封边框（1px）
            let on_border = x == env_x0 || x == env_x1 || y == env_y0 || y == env_y1;
            // 信封折盖：从左上角到中心底点，再从右上角到中心底点
            let mid_x = env_w / 2;
            let on_flap_left =
                rel_x <= mid_x && rel_y * env_w == rel_x * env_h * 2;
            let on_flap_right =
                rel_x >= mid_x && (env_w - 1 - rel_x) * env_h * 2 == rel_y * env_w;

            if on_border || on_flap_left || on_flap_right {
                buf[idx] = 30;      // R
                buf[idx + 1] = 41;  // G
                buf[idx + 2] = 59;  // B  (slate-800)
                buf[idx + 3] = 255; // A
            }
        }
    }
}

fn load_icon_with_badge() -> Image<'static> {
    let (mut buf, w, h) = decode_icon();
    draw_mail_badge(&mut buf, w, h);
    Image::new_owned(buf, w, h)
}

/// 待跳转邮件页面的标志：通知点击后窗口获得焦点时检查
pub struct PendingMailNavigation(pub Arc<Mutex<bool>>);

impl Default for PendingMailNavigation {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(false)))
    }
}

pub fn setup_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let new_note_item = MenuItem::with_id(app, "new_note", "新建笔记", true, None::<&str>)?;
    let restart_item = MenuItem::with_id(app, "restart_gateway", "重启服务", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 Mona", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[&new_note_item, &restart_item, &quit_item],
    )?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(load_icon())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Mona")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "new_note" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let _ = app.emit("tray-new-note", ());
            }
            "restart_gateway" => {
                let settings = crate::settings::load_settings();
                if let Some(services) = app.try_state::<crate::ServicesState>() {
                    let _ = services.stop();
                }
                if let Some(gateway) = app.try_state::<crate::GatewayState>() {
                    let _ = gateway.stop();
                    match gateway.start(&settings, app) {
                        Ok(port) => {
                            log::info!("Gateway restarted on port {port}");
                            let _ = app.emit("gateway-restarted", port);
                        }
                        Err(e) => {
                            log::error!("Failed to restart gateway: {e}");
                        }
                    }
                }
                if let Some(services) = app.try_state::<crate::ServicesState>() {
                    match services.start(&settings, app) {
                        Ok(port) => {
                            log::info!("Services restarted on port {port}");
                            let _ = app.emit("services-restarted", port);
                        }
                        Err(e) => {
                            log::error!("Failed to restart services: {e}");
                        }
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
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// 根据未读邮件数切换托盘图标：count > 0 显示红点徽章
#[tauri::command]
pub fn set_tray_unread_count(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let icon = if count > 0 {
        load_icon_with_badge()
    } else {
        load_icon()
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
        let tooltip = if count > 0 {
            format!("Mona · {count} 封未读邮件")
        } else {
            "Mona".to_string()
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
    Ok(())
}

/// 注册 AUMID 到 Windows 注册表，使 WinRT Toast 通知能正确显示应用名和图标，
/// 而不是回退到 PowerShell 通知。仅注册一次。
#[cfg(windows)]
fn ensure_aumid_registered() -> &'static str {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::sync::Once;

    static REGISTER: Once = Once::new();
    const AUMID: &str = "com.mona.desktop";

    REGISTER.call_once(|| {
        let exe_path = std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let key = format!(r"HKCU\Software\Classes\AppUserModelId\{}", AUMID);

        // 注册 DisplayName 和 IconUri，使 Toast 通知显示 "Mona" 而非 "PowerShell"
        let _ = Command::new("reg")
            .args(["ADD", &key, "/v", "DisplayName", "/t", "REG_SZ", "/d", "Mona", "/f"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
        let _ = Command::new("reg")
            .args(["ADD", &key, "/v", "IconUri", "/t", "REG_SZ", "/d", &exe_path, "/f"])
            .creation_flags(0x08000000)
            .output();
    });

    AUMID
}

/// 在主线程上创建并显示 WinRT Toast 通知。
/// Toast 不是 Send，必须在主线程上创建和显示。
#[cfg(windows)]
fn show_windows_toast(
    app: tauri::AppHandle,
    title: String,
    body: String,
    pending: Arc<Mutex<bool>>,
) {
    use tauri_winrt_notification::Toast;

    let aumid = ensure_aumid_registered();
    let app_handle = app;

    let toast = Toast::new(aumid)
        .title(&title)
        .text1(&body)
        .on_activated(move |_action| {
            // 通知被点击：设置 pending 标志并激活主窗口
            if let Ok(mut flag) = pending.lock() {
                *flag = true;
            }
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            Ok(())
        });

    if let Err(e) = toast.show() {
        log::error!("Failed to show Windows toast: {}", e);
    }
}

/// 显示一个通用系统 Toast 通知（不跟踪点击跳转状态）。
/// 供日程提醒等模块通过后台轮询触发，即使窗口最小化到托盘也能弹出。
pub fn show_generic_toast(app: &tauri::AppHandle, title: String, body: String) {
    #[cfg(windows)]
    {
        let pending = Arc::new(Mutex::new(false));
        let app_handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            show_windows_toast(app_handle, title, body, pending);
        });
    }

    #[cfg(not(windows))]
    {
        let _ = (app, title, body);
    }
}

/// 发送新邮件通知。
/// Windows 上使用 WinRT Toast（应用级通知，非 PowerShell），点击后激活窗口并设置 pending 标志。
#[tauri::command]
pub async fn send_mail_notification(
    app: tauri::AppHandle,
    state: tauri::State<'_, PendingMailNavigation>,
    title: String,
    body: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let pending = state.0.clone();
        let app_handle = app.clone();
        // Toast 不是 Send，必须在主线程上创建
        let _ = app.run_on_main_thread(move || {
            show_windows_toast(app_handle, title, body, pending);
        });
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let _ = (state, app, title, body);
        Ok(())
    }
}

/// 前端在窗口获得焦点时调用，检查是否有 pending 邮件导航
#[tauri::command]
pub fn check_and_clear_pending_mail(
    state: tauri::State<'_, PendingMailNavigation>,
) -> Result<bool, String> {
    let mut flag = state.0.lock().map_err(|e| e.to_string())?;
    let was_pending = *flag;
    *flag = false;
    Ok(was_pending)
}
