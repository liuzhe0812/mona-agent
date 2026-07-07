//! 全局右下角通知弹窗：独立 Tauri 窗口，无边框、透明、置顶、跳过任务栏。
//!
//! 桌面级弹窗，不受主窗口最小化影响，自带 logo 和自定义样式。
//! 多条通知垂直堆叠在屏幕右下角，从右上方滑入。

use std::sync::Mutex;

use base64::Engine;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const NOTIFICATION_LABEL_PREFIX: &str = "notification-";
/// 通知窗口固定宽度（逻辑像素）
const WIN_WIDTH: f64 = 360.0;
/// 通知窗口固定高度（逻辑像素）
const WIN_HEIGHT: f64 = 96.0;
/// 窗口与屏幕边缘的间距
const MARGIN: f64 = 20.0;
/// 多条通知之间的垂直间距
const STACK_GAP: f64 = 10.0;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    pub label: String,
    /// action 标识符，点击后 emit 事件到主窗口
    pub action: String,
    /// 是否为主要按钮（影响样式）
    #[serde(default)]
    pub primary: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    /// 唯一 id，用于窗口 label
    pub id: String,
    pub title: String,
    pub body: String,
    /// 图标类型：mail / schedule / update / info / success / warning / error
    /// 前端按类型渲染不同图标和配色
    #[serde(default = "default_icon")]
    pub icon: String,
    /// 操作按钮列表（最多 2 个，超出截断）
    #[serde(default)]
    pub actions: Vec<NotificationAction>,
    /// 自动关闭时间（毫秒），0 表示不自动关闭
    #[serde(default = "default_auto_close")]
    pub auto_close_ms: u64,
    /// 点击通知卡片本身时触发的 action（可选）
    #[serde(default)]
    pub click_action: Option<String>,
}

fn default_icon() -> String {
    "info".to_string()
}

fn default_auto_close() -> u64 {
    6000
}

/// 全局通知窗口状态：维护当前活跃的通知窗口 label 列表，用于堆叠布局。
pub struct NotificationWindowState {
    active: Mutex<Vec<String>>,
}

impl NotificationWindowState {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(Vec::new()),
        }
    }
}

/// 显示一个右下角通知弹窗（内部实现，Rust 侧后台任务可直接调用）。
///
/// 创建独立的 Tauri 窗口，无边框、透明、置顶、跳过任务栏，
/// 加载 `#/notification` 路由，前端渲染通知内容。
/// 多条通知会垂直堆叠在屏幕右下角。
pub fn show_notification_inner(app: &AppHandle, payload: NotificationPayload) -> Result<(), String> {
    let label = format!("{}{}", NOTIFICATION_LABEL_PREFIX, payload.id);

    // 如果已存在同名窗口，先关闭（避免重复）
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.close();
        // 从活跃列表移除
        let _ = app
            .state::<NotificationWindowState>()
            .active
            .lock()
            .map(|mut active| active.retain(|l| l != &label));
    }

    // 编码 payload 到 URL（base64，避免特殊字符问题）
    let json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.as_bytes());
    let url = format!("#/notification?data={}", encoded);

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("")
        .inner_size(WIN_WIDTH, WIN_HEIGHT)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .shadow(false)
        .build()
        .map_err(|e| e.to_string())?;

    // 计算右下角位置（考虑堆叠）
    place_notification_window(app, &window)?;

    // 加入活跃列表
    let _ = app
        .state::<NotificationWindowState>()
        .active
        .lock()
        .map(|mut active| active.push(label.clone()));

    window.show().map_err(|e| e.to_string())?;

    Ok(())
}

/// Tauri 命令封装：供前端 invoke 调用。
#[tauri::command]
pub async fn show_notification(
    app: AppHandle,
    payload: NotificationPayload,
) -> Result<(), String> {
    show_notification_inner(&app, payload)
}

/// 计算窗口在右下角的位置，考虑多通知堆叠。
///
/// 位置基于当前活跃通知数量：第 N 条（从 0 开始）的 y 偏移为
/// `屏幕底部 - MARGIN - (N+1) * (WIN_HEIGHT + STACK_GAP)`。
fn place_notification_window(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor available".to_string())?;
    let scale = monitor.scale_factor();
    let monitor_size = monitor.size();
    let monitor_pos = monitor.position();

    // 计算堆叠索引：当前活跃数量即新窗口的索引
    let stack_index = app
        .state::<NotificationWindowState>()
        .active
        .lock()
        .map(|g| g.len() as f64)
        .unwrap_or(0.0);

    // 逻辑坐标计算
    let monitor_width_logical = monitor_size.width as f64 / scale;
    let monitor_height_logical = monitor_size.height as f64 / scale;
    let monitor_x_logical = monitor_pos.x as f64 / scale;
    let monitor_y_logical = monitor_pos.y as f64 / scale;

    let x = monitor_x_logical + monitor_width_logical - WIN_WIDTH - MARGIN;
    let y = monitor_y_logical + monitor_height_logical
        - MARGIN
        - (stack_index + 1.0) * WIN_HEIGHT
        - stack_index * STACK_GAP;

    // 转回物理坐标设置
    window
        .set_position(PhysicalPosition::new(
            (x * scale) as i32,
            (y * scale) as i32,
        ))
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 前端调用：关闭自己这个通知窗口。
/// 关闭后从活跃列表移除，并重新布局剩余窗口（向下移动填补空缺）。
#[tauri::command]
pub fn close_notification_window(app: AppHandle, label: String) -> Result<(), String> {
    close_and_relayout(&app, &label);
    Ok(())
}

/// 关闭指定通知窗口并重新布局剩余窗口。
///
/// 关闭中间一条通知后，其上方的通知需要向下移动填补空缺。
fn close_and_relayout(app: &AppHandle, label: &str) {
    // 从活跃列表移除
    let remaining: Vec<String> = app
        .state::<NotificationWindowState>()
        .active
        .lock()
        .map(|mut active| {
            active.retain(|l| l != label);
            active.clone()
        })
        .unwrap_or_default();

    // 关闭窗口
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }

    // 重新布局剩余窗口（按剩余顺序从下往上堆叠）
    // remaining[0] 是最早创建的（最底层），remaining[N-1] 是最新创建的（最顶层）
    // 但视觉上最新创建的在最上方，所以索引 0 对应最底层（y 最大）
    let monitor = match app.get_webview_window(label) {
        Some(w) => w.current_monitor().ok().flatten(),
        None => None,
    };
    // 窗口已关闭，无法用它取 monitor；改用主窗口或第一个剩余窗口
    let monitor = monitor.or_else(|| {
        remaining
            .iter()
            .find_map(|l| app.get_webview_window(l)?.current_monitor().ok().flatten())
    });

    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let monitor_size = monitor.size();
    let monitor_pos = monitor.position();

    let monitor_width_logical = monitor_size.width as f64 / scale;
    let monitor_height_logical = monitor_size.height as f64 / scale;
    let monitor_x_logical = monitor_pos.x as f64 / scale;
    let monitor_y_logical = monitor_pos.y as f64 / scale;

    for (i, l) in remaining.iter().enumerate() {
        let Some(window) = app.get_webview_window(l) else {
            continue;
        };
        let stack_index = i as f64;
        let x = monitor_x_logical + monitor_width_logical - WIN_WIDTH - MARGIN;
        let y = monitor_y_logical + monitor_height_logical
            - MARGIN
            - (stack_index + 1.0) * WIN_HEIGHT
            - stack_index * STACK_GAP;
        let _ = window.set_position(PhysicalPosition::new(
            (x * scale) as i32,
            (y * scale) as i32,
        ));
    }
}

/// 通知窗口加载完成后调用：通知主窗口有通知被点击（可选，前端也可以直接 emit）。
#[tauri::command]
pub fn emit_notification_action(
    app: AppHandle,
    action: String,
) -> Result<(), String> {
    app.emit("notification-action", serde_json::json!({ "action": action }))
        .map_err(|e| e.to_string())
}
