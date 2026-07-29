//! Schedule reminder notifier.
//!
//! Polls the Python services process's ``/api/schedule/notifications`` endpoint on a
//! background tokio task and fires the same in-app notification windows used
//! by mail notifications. These are independent Tauri windows (borderless,
//! always-on-top, skip taskbar) so they pop up even when the main window is
//! minimized to the tray, and they render the Mona logo and custom styling
//! via the ``#/notification`` route.

use std::time::Duration;

use serde::Deserialize;

use crate::notification_window::{self, NotificationPayload};

#[derive(Deserialize)]
struct NotificationsResponse {
    notifications: Vec<NotificationEntry>,
}

#[derive(Deserialize)]
struct NotificationEntry {
    title: String,
    body: String,
}

/// Start a background polling task that fires notification windows for
/// schedule reminders. Should be called once after the gateway is ready.
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
                            let payload = NotificationPayload {
                                id: format!("schedule-{}", uuid::Uuid::new_v4()),
                                title: n.title,
                                body: n.body,
                                icon: "schedule".to_string(),
                                actions: vec![],
                                auto_close_ms: 8000,
                                click_action: Some("open-schedule".to_string()),
                                click_data: None,
                            };
                            if let Err(e) =
                                notification_window::show_notification_inner(&app, payload)
                            {
                                log::error!("Failed to show schedule notification: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        log::debug!("Schedule notifications parse failed: {}", e);
                    }
                },
                Err(e) => {
                    // Services might be temporarily unavailable; retry next cycle.
                    log::debug!("Schedule notifications poll failed: {}", e);
                }
            }
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}
