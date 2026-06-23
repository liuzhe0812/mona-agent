//! Schedule reminder notifier.
//!
//! Polls the Python gateway's ``/api/schedule/notifications`` endpoint on a
//! background tokio task and fires native Windows toast notifications for
//! each pending reminder. This works independently of the webview state —
//! even when the window is minimized to the tray, the Rust side keeps
//! polling and showing toasts.

use std::time::Duration;

use serde::Deserialize;

use crate::tray;

#[derive(Deserialize)]
struct NotificationsResponse {
    notifications: Vec<NotificationEntry>,
}

#[derive(Deserialize)]
struct NotificationEntry {
    title: String,
    body: String,
    #[serde(rename = "item_id")]
    #[allow(dead_code)]
    item_id: Option<String>,
}

/// Start a background polling task that fires native toast notifications
/// for schedule reminders. Should be called once after the gateway is ready.
pub fn start_polling(app: tauri::AppHandle, port: u16) {
    let url = format!("http://127.0.0.1:{}/api/schedule/notifications", port);
    tauri::async_runtime::spawn(async move {
        // Initial delay to let the schedule service finish bootstrapping.
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            match reqwest::get(&url).await {
                Ok(resp) => match resp.json::<NotificationsResponse>().await {
                    Ok(data) => {
                        for n in data.notifications {
                            tray::show_generic_toast(&app, n.title, n.body);
                        }
                    }
                    Err(e) => {
                        log::debug!("Schedule notifications parse failed: {}", e);
                    }
                },
                Err(e) => {
                    // Gateway might be temporarily unavailable; retry next cycle.
                    log::debug!("Schedule notifications poll failed: {}", e);
                }
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}
