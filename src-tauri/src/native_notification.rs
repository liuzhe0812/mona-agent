//! All desktop notifications use the operating system's notification center.

use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    pub label: String,
    pub action: String,
    #[serde(default)]
    pub primary: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub id: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub only_when_background: bool,
    #[serde(default)]
    pub actions: Vec<NotificationAction>,
    pub click_action: Option<String>,
    pub click_data: Option<serde_json::Value>,
}

impl NotificationPayload {
    fn action_for(&self, button: Option<&str>) -> Option<&str> {
        if let Some(button) = button.filter(|button| !button.is_empty()) {
            return self
                .actions
                .iter()
                .take(2)
                .find(|action| action.action == button)
                .map(|action| action.action.as_str());
        }
        self.click_action.as_deref().or_else(|| {
            self.actions
                .iter()
                .take(2)
                .find(|action| action.primary)
                .map(|action| action.action.as_str())
        })
    }

    fn opens_mail_preview(&self, action: Option<&str>) -> bool {
        action == Some("open-email")
            && self.click_data.as_ref().is_some_and(|data| {
                data["type"] == "mail"
                    && ["accountId", "uid", "folder"]
                        .iter()
                        .all(|key| data[*key].as_str().is_some_and(|value| !value.is_empty()))
            })
    }
}

fn activate(app: &AppHandle, payload: &NotificationPayload, button: Option<&str>) {
    let button = button.filter(|button| !button.is_empty());
    let action = payload.action_for(button).map(str::to_owned);
    if button.is_some() && action.is_none() {
        return;
    }
    let foreground = action.as_deref() != Some("update-dismiss")
        && !payload.opens_mail_preview(action.as_deref());
    let data = payload.click_data.clone();
    let app_handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if foreground {
            if let Some(window) = app_handle.get_webview_window("main") {
                if let Err(error) = window
                    .show()
                    .and_then(|_| window.unminimize())
                    .and_then(|_| window.set_focus())
                {
                    log::error!("Notification could not open the main window: {error}");
                }
            }
        }
        if let Some(action) = action {
            if let Err(error) = app_handle.emit_to(
                "main",
                "notification-action",
                serde_json::json!({ "action": action, "data": data }),
            ) {
                log::error!("Notification action could not be delivered: {error}");
            }
        }
    }) {
        log::error!("Notification activation could not be scheduled: {error}");
    }
}

pub async fn show_native(app: &AppHandle, payload: NotificationPayload) -> Result<(), String> {
    if payload.only_when_background {
        for window in app.webview_windows().values() {
            if window.is_focused().map_err(|error| error.to_string())? {
                return Ok(());
            }
        }
    }
    show_platform(app, payload).await
}

#[cfg(windows)]
async fn show_platform(app: &AppHandle, payload: NotificationPayload) -> Result<(), String> {
    use tauri_winrt_notification::{IconCrop, Toast};
    let icon = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("notification-icon.png");
    if !icon.exists() {
        std::fs::create_dir_all(icon.parent().unwrap()).map_err(|error| error.to_string())?;
        std::fs::write(&icon, include_bytes!("../icons/icon.png"))
            .map_err(|error| error.to_string())?;
    }
    let app_handle = app.clone();
    let (sent, received) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let mut toast = Toast::new(crate::tray::ensure_aumid_registered())
            .title(&payload.title)
            .text1(&payload.body)
            .icon(&icon, IconCrop::Square, "Mona");
        for action in payload.actions.iter().take(2) {
            toast = toast.add_button(&action.label, &action.action);
        }
        let result = toast
            .on_activated(move |button| {
                activate(&app_handle, &payload, button.as_deref());
                Ok(())
            })
            .show()
            .map_err(|error| error.to_string());
        let _ = sent.send(result);
    })
    .map_err(|error| error.to_string())?;
    received.await.map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
async fn show_platform(app: &AppHandle, payload: NotificationPayload) -> Result<(), String> {
    use mac_usernotifications::{Action, AuthorizationStatus, Notification};
    mac_usernotifications::check_bundle().map_err(|error| error.to_string())?;
    let settings = mac_usernotifications::get_notification_settings()
        .await
        .map_err(|error| error.to_string())?;
    let permitted = match settings.authorization_status {
        AuthorizationStatus::NotDetermined => mac_usernotifications::request_auth()
            .await
            .map_err(|error| error.to_string())?,
        AuthorizationStatus::Authorized
        | AuthorizationStatus::Provisional
        | AuthorizationStatus::Ephemeral => true,
        AuthorizationStatus::Denied | AuthorizationStatus::Unknown => false,
    };
    if !permitted {
        return Err("系统通知未获授权，请在 macOS 系统设置中允许 Mona 通知。".into());
    }
    let mut notification = Notification::new()
        .id(&payload.id)
        .title(&payload.title)
        .message(&payload.body)
        // Bound the response wait; this does not change the system banner's lifetime.
        .timeout(std::time::Duration::from_secs(24 * 60 * 60));
    for action in payload.actions.iter().take(2) {
        notification = notification.action(Action::button(&action.action, &action.label));
    }
    let handle = notification
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match handle.response().await {
            Ok(response) if response.close_reason.is_some() => {}
            Ok(response) if response.is_default_action() => activate(&app_handle, &payload, None),
            Ok(response) if response.close_reason.is_none() => {
                activate(&app_handle, &payload, Some(&response.action_identifier));
            }
            Ok(_) => {}
            Err(error) => log::error!("Native notification response failed: {error}"),
        }
    });
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
async fn show_platform(app: &AppHandle, payload: NotificationPayload) -> Result<(), String> {
    use notify_rust::{Notification, NotificationResponse};
    let app_handle = app.clone();
    let handle = tauri::async_runtime::spawn_blocking({
        let payload = payload.clone();
        move || {
            let mut notification = Notification::new();
            notification
                .summary(&payload.title)
                .body(&payload.body)
                .appname("Mona");
            notification.action("default", "打开");
            for action in payload.actions.iter().take(2) {
                notification.action(&action.action, &action.label);
            }
            notification.show().map_err(|error| error.to_string())
        }
    })
    .await
    .map_err(|error| error.to_string())??;
    std::thread::Builder::new()
        .name("native-notification-response".into())
        .spawn(move || {
            if let Err(error) =
                handle.wait_for_response(|response: &NotificationResponse| match response {
                    NotificationResponse::Default => activate(&app_handle, &payload, None),
                    NotificationResponse::Action(action) => {
                        activate(&app_handle, &payload, Some(action))
                    }
                    NotificationResponse::Reply(_) | NotificationResponse::Closed(_) => {}
                })
            {
                log::error!("Native notification response failed: {error}");
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn show_notification(app: AppHandle, payload: NotificationPayload) -> Result<(), String> {
    show_native(&app, payload).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> NotificationPayload {
        serde_json::from_value(serde_json::json!({
            "id": "邮件通知", "title": "消息", "body": "完整正文\n第二行 <>&",
            "clickAction": "open-email", "clickData": {
                "type": "mail", "accountId": "account-1", "uid": "42", "folder": "INBOX"
            }
        }))
        .unwrap()
    }

    #[test]
    fn preserves_full_text_and_mail_destination() {
        let notification = payload();
        assert_eq!(notification.body, "完整正文\n第二行 <>&");
        assert_eq!(notification.action_for(None), Some("open-email"));
        assert!(notification.opens_mail_preview(notification.action_for(None)));
        assert!(!notification.opens_mail_preview(Some("open-schedule")));
    }

    #[test]
    fn routes_only_offered_buttons_and_uses_primary_on_body_click() {
        let mut notification = payload();
        notification.click_action = None;
        notification.actions = vec![
            NotificationAction {
                label: "立即更新".into(),
                action: "update-now".into(),
                primary: true,
            },
            NotificationAction {
                label: "稍后".into(),
                action: "update-dismiss".into(),
                primary: false,
            },
        ];
        assert_eq!(notification.action_for(None), Some("update-now"));
        assert_eq!(
            notification.action_for(Some("update-dismiss")),
            Some("update-dismiss")
        );
        assert_eq!(notification.action_for(Some("unoffered-action")), None);
    }

    #[test]
    fn incomplete_mail_data_opens_the_main_window() {
        let mut notification = payload();
        notification.click_data.as_mut().unwrap()["uid"] = serde_json::Value::Null;
        assert!(!notification.opens_mail_preview(notification.action_for(None)));
    }
}
