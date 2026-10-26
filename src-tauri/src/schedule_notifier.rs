//! Schedule reminder notifier.
//!
//! Polls the Python services process's ``/api/schedule/notifications`` endpoint on a
//! background tokio task and sends native desktop notifications through the
//! same entry point used by mail and other application reminders.

use std::time::Duration;

use serde::Deserialize;

use crate::native_notification::{self, NotificationPayload};

#[derive(Deserialize)]
struct NotificationsResponse {
    notifications: Vec<NotificationEntry>,
}

#[derive(Deserialize)]
struct NotificationEntry {
    #[serde(default)]
    id: Option<String>,
    title: String,
    body: String,
    /// Optional click routing pushed by cross-process producers (stock-module
    /// review cron). Absent means the legacy schedule behavior.
    #[serde(default)]
    click_action: Option<String>,
    #[serde(default)]
    click_data: Option<serde_json::Value>,
}

/// Start a background polling task that sends native notifications for
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
                                only_when_background: false,
                                actions: vec![],
                                click_action: Some(
                                    n.click_action
                                        .unwrap_or_else(|| "open-schedule".to_string()),
                                ),
                                click_data: n.click_data,
                            };
                            if let Err(e) =
                                native_notification::show_native(&app, payload).await
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
            poll_stock_notifications(&app, port).await;
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
}

async fn stock_request(
    method: &str,
    url: String,
    request_id: Option<String>,
) -> Option<crate::LocalHttpResponse> {
    let headers = request_id
        .map(|id| vec![("X-Mona-Request-ID".to_string(), id)])
        .unwrap_or_default();
    match tokio::time::timeout(
        Duration::from_secs(5),
        crate::perform_local_http_request(method.to_string(), url, headers, None),
    )
    .await
    {
        Ok(Ok(response)) if response.status == 200 => Some(response),
        _ => None,
    }
}

async fn poll_stock_notifications(app: &tauri::AppHandle, port: u16) {
    let base = format!("http://127.0.0.1:{port}/api/stock-vibe/notifications");
    let Some(response) = stock_request("GET", base.clone(), None).await else {
        return;
    };
    let Ok(data) = serde_json::from_slice::<NotificationsResponse>(&response.body) else {
        return;
    };
    for entry in data.notifications {
        let Some(id) = entry.id else {
            continue;
        };
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            continue;
        }
        let Some(claim) = stock_request(
            "POST",
            format!("{base}/{id}/claim"),
            Some(uuid::Uuid::new_v4().simple().to_string()),
        )
        .await
        else {
            continue;
        };
        let Ok(receipt) = serde_json::from_slice::<serde_json::Value>(&claim.body) else {
            continue;
        };
        if receipt["status"] != "completed" || receipt["receipt"]["body"]["claimed"] != true {
            continue;
        }
        let payload = NotificationPayload {
            id: format!("stock-vibe-{id}"),
            title: entry.title,
            body: entry.body,
            only_when_background: false,
            actions: vec![],
            click_action: Some("open-stock".to_string()),
            click_data: entry.click_data,
        };
        // Claim is durable before showing. A crash leaves an unknown delivery;
        // it must not replay a possibly shown toast after the next restart.
        match native_notification::show_native(app, payload).await {
            Ok(()) => {
                let _ = stock_request(
                    "POST",
                    format!("{base}/{id}/ack"),
                    Some(uuid::Uuid::new_v4().simple().to_string()),
                )
                .await;
            }
            Err(error) => log::error!("Stock notification delivery is unconfirmed: {error}"),
        }
    }
}
