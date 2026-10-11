use serde_json::{json, Value};

fn protocol_request(action: &str, width: Option<u32>, height: Option<u32>) -> Result<(&'static str, Value), String> {
    match action {
        "capture" => Ok(("Page.captureScreenshot", json!({"format":"png", "captureBeyondViewport":false}))),
        "clear_cache" => Ok(("Network.clearBrowserCache", json!({}))),
        "clear_cookies" => Ok(("Network.clearBrowserCookies", json!({}))),
        "device_off" => Ok(("Emulation.clearDeviceMetricsOverride", json!({}))),
        "device" => match (width, height) {
            (Some(width @ 240..=3840), Some(height @ 200..=2160)) => Ok(("Emulation.setDeviceMetricsOverride", json!({"width":width,"height":height,"deviceScaleFactor":1,"mobile":false}))),
            _ => Err("设备尺寸超出支持范围".into()),
        },
        _ => Err("不支持的浏览器操作".into()),
    }
}

#[tauri::command]
pub async fn browser_page_action(app: tauri::AppHandle, webview: tauri::Webview, id: String, action: String, width: Option<u32>, height: Option<u32>) -> Result<Value, String> {
    if webview.label() != "main" { return Err("此页面不能执行浏览器操作".into()); }
    let (method, params) = protocol_request(&action, width, height)?;
    #[cfg(target_os = "windows")]
    {
        use std::sync::{Arc, Mutex};
        use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
        use windows::core::HSTRING;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = Arc::new(Mutex::new(Some(sender)));
        super::get_browser_webview(&app, &id)?.with_webview(move |wv| {
            let callback_sender = sender.clone();
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, result| {
                let result = status.map_err(|e| e.to_string()).and_then(|_| serde_json::from_str::<Value>(&result).map_err(|e| e.to_string()));
                if let Some(sender) = callback_sender.lock().expect("browser action reply lock").take() { let _ = sender.send(result); }
                Ok(())
            }));
            let result = unsafe { wv.controller().CoreWebView2().and_then(|core| core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params.to_string()), &handler)) };
            if let Err(error) = result {
                if let Some(sender) = sender.lock().expect("browser action reply lock").take() { let _ = sender.send(Err(error.to_string())); }
            }
        }).map_err(|e| e.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(15), receiver).await
            .map_err(|_| "浏览器操作超时，请重试".to_string())?.map_err(|_| "浏览器操作已中断".to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = (app, id, method, params); Err("当前系统暂不支持此操作".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_protocol_methods_and_device_dimensions() {
        assert!(protocol_request("Runtime.evaluate", None, None).is_err());
        assert!(protocol_request("device", Some(0), Some(844)).is_err());
        assert!(protocol_request("device", Some(390), Some(844)).is_ok());
        assert_eq!(protocol_request("clear_cookies", None, None).unwrap().0, "Network.clearBrowserCookies");
        assert_eq!(protocol_request("capture", None, None).unwrap().1["format"], "png");
    }
}
