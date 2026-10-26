use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::{auth_send, get_device_fingerprint, get_hostname, load_auth_token, save_auth_token};

pub(super) static ACCOUNT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceReplacement {
    id: String,
    revision: u64,
}

#[derive(Deserialize, Serialize)]
struct LoginDevice {
    id: String,
    revision: u64,
    name: String,
    platform: String,
    current: bool,
    last_seen_at: String,
    bound_at: String,
}

#[derive(Deserialize)]
struct DeviceLimit {
    devices: Vec<LoginDevice>,
    device_limit: u8,
    plan: String,
    required_replacements: usize,
}

fn hex_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase())
}

fn validate_selection(request_id: &str, replacements: &[DeviceReplacement]) -> Result<(), String> {
    if !(8..=64).contains(&request_id.len())
        || !request_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || replacements.len() > 16
    {
        return Err("登录请求无效，请重新选择设备。".into());
    }
    let mut seen = std::collections::HashSet::new();
    for item in replacements {
        if !hex_id(&item.id) || item.revision == 0 || !seen.insert(item.id.as_str()) {
            return Err("设备选择无效，请刷新后重试。".into());
        }
    }
    Ok(())
}

fn device_limit_payload(body: Value) -> Result<Value, String> {
    let limit: DeviceLimit = serde_json::from_value(body)
        .map_err(|_| "设备列表返回异常，请重新登录。".to_string())?;
    let expected = match limit.plan.as_str() { "free" => 1, "pro" => 3, _ => 0 };
    if limit.device_limit != expected || expected == 0 || limit.devices.len() > 16
        || limit.required_replacements == 0 || limit.required_replacements > limit.devices.len()
        || limit.devices.iter().any(|d| !hex_id(&d.id) || d.revision == 0 || d.name.len() > 480)
    {
        return Err("设备列表返回异常，请重新登录。".into());
    }
    Ok(json!({"success":false,"error":"device_limit_exceeded","devices":limit.devices,
        "device_limit":limit.device_limit,"plan":limit.plan,
        "required_replacements":limit.required_replacements}))
}

pub(super) async fn login(account: String, password: String, request_id: Option<String>,
                          replacements: Option<Vec<DeviceReplacement>>) -> Result<Value, String> {
    let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let replacements = replacements.unwrap_or_default();
    validate_selection(&request_id, &replacements)?;
    let platform = if cfg!(target_os="windows") { "windows" }
        else if cfg!(target_os="macos") { "macos" } else { "linux" };
    let name: String = get_hostname().chars().filter(|c| !c.is_control()).take(120).collect();
    let payload = json!({"account":account,"password":password,"request_id":request_id,
        "device_fingerprint":get_device_fingerprint(),"device_name":if name.is_empty() { platform } else { &name },
        "platform":platform,"replacements":replacements});
    let response = auth_send(|client, base| client.post(format!("{base}/auth/desktop/login")).json(&payload)).await?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("账号服务尚未支持设备登录，请先升级服务端。".into());
    }
    let body: Value = response.json().await.map_err(|_| "账号服务返回异常，请稍后重试。".to_string())?;
    if status == reqwest::StatusCode::CONFLICT && body["error"] == "device_limit_exceeded" {
        return device_limit_payload(body);
    }
    if !status.is_success() {
        return Err(super::translate_error(body["error"].as_str().unwrap_or("登录失败，请稍后重试。")));
    }
    let token = body["access_token"].as_str().filter(|t| !t.is_empty() && t.len() < 16384)
        .ok_or_else(|| "登录凭据返回异常，请重新登录。".to_string())?;
    if !body["device_session_id"].as_str().is_some_and(hex_id) {
        return Err("账号服务返回异常，请重新登录。".into());
    }
    save_auth_token(token)?;
    super::clear_account_status_cache();
    // Account credentials are never returned to the React process.
    Ok(json!({"success":true}))
}

pub(super) enum StatusError {
    Unavailable,
    Rejected,
    Invalid(String),
}

pub(super) async fn status(token: &str) -> Result<super::AccountStatusCache, StatusError> {
    let response = auth_send(|client, base| client.get(format!("{base}/auth/desktop/status"))
        .bearer_auth(token)).await.map_err(|_| StatusError::Unavailable)?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        if load_auth_token().as_deref() == Some(token) {
            let _ = super::remove_auth_token();
            super::clear_account_status_cache();
        }
        return Err(StatusError::Rejected);
    }
    if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(StatusError::Unavailable);
    }
    if !status.is_success() {
        return Err(StatusError::Invalid("账号服务尚未支持设备登录，请先升级服务端。".into()));
    }
    let mut cache: super::AccountStatusCache = response.json().await
        .map_err(|_| StatusError::Invalid("账号信息返回异常，请稍后重试。".into()))?;
    if !matches!(cache.status.as_str(), "valid" | "free")
        || !cache.device_session_id.as_deref().is_some_and(hex_id)
        || !matches!(cache.device_limit, Some(1 | 3))
    {
        return Err(StatusError::Invalid("账号信息返回异常，请稍后重试。".into()));
    }
    cache.verified_at = Some(chrono::Utc::now().to_rfc3339());
    cache.account_token_sha256 = Some(super::token_fingerprint(token));
    Ok(cache)
}

async fn account_response(response: reqwest::Response, token: &str) -> Result<Value, String> {
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        if load_auth_token().as_deref() == Some(token) {
            let _ = super::remove_auth_token();
            super::clear_account_status_cache();
        }
        return Err("此设备的登录已结束，请重新登录。".into());
    }
    super::service_json(response).await
}

#[tauri::command]
pub async fn list_login_devices() -> Result<Value, String> {
    let _guard = ACCOUNT_LOCK.lock().await;
    let token = load_auth_token().ok_or_else(|| "请先登录。".to_string())?;
    let response = auth_send(|client, base| client.get(format!("{base}/auth/desktop/devices"))
        .bearer_auth(&token)).await?;
    let body = account_response(response, &token).await?;
    let devices: Vec<LoginDevice> = serde_json::from_value(body["devices"].clone())
        .map_err(|_| "设备列表返回异常。".to_string())?;
    Ok(json!({"devices":devices,"device_limit":body["device_limit"],"plan":body["plan"]}))
}

fn confirmed_removal(body: Value, device_id: &str) -> Result<Value, String> {
    if body.get("success").and_then(Value::as_bool) != Some(true)
        || body.get("device_id").and_then(Value::as_str) != Some(device_id)
        || !body.get("current_device_removed").is_some_and(Value::is_boolean)
    {
        return Err("尚未确认移除结果，请刷新设备列表核对。".into());
    }
    Ok(json!({"success": true, "device_id": device_id,
        "current_device_removed": body["current_device_removed"]}))
}

#[tauri::command]
pub async fn revoke_login_device(app: AppHandle, device: DeviceReplacement) -> Result<Value, String> {
    validate_selection("device_revoke", std::slice::from_ref(&device))?;
    let _guard = ACCOUNT_LOCK.lock().await;
    let token = load_auth_token().ok_or_else(|| "请先登录。".to_string())?;
    let response = auth_send(|client, base| client.post(format!("{base}/auth/desktop/devices/revoke"))
        .bearer_auth(&token).json(&device)).await?;
    let result = confirmed_removal(account_response(response, &token).await?, &device.id)?;
    if result["current_device_removed"] == true {
        super::remove_auth_token()?;
        super::clear_account_status_cache();
        let _ = app.emit("auth-state-changed", json!({"loggedIn":false,"devicesChanged":true}));
    } else {
        let _ = app.emit("auth-state-changed", json!({"devicesChanged":true}));
    }
    Ok(result)
}

pub(super) async fn logout() -> Result<(), String> {
    if let Some(token) = load_auth_token() {
        let response = auth_send(|client, base| client.post(format!("{base}/auth/desktop/logout"))
            .bearer_auth(&token)).await
            .map_err(|_| "暂时无法退出账号。登录名额尚未释放，请联网后重试。".to_string())?;
        // An already revoked/expired login needs no further remote mutation.
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            let result = account_response(response, &token).await?;
            if result.get("success").and_then(Value::as_bool) != Some(true) {
                return Err("尚未确认退出结果，请联网后重试。".into());
            }
        }
    }
    super::remove_auth_token()?;
    super::clear_account_status_cache();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_selection_is_rejected_without_network() {
        assert!(validate_selection("request_valid", &[]).is_ok());
        let device = DeviceReplacement { id:"a".repeat(32), revision:1 };
        assert!(validate_selection("request_valid", &[device.clone()]).is_ok());
        assert!(validate_selection("request_valid", &[device.clone(), device]).is_err());
        assert!(validate_selection("bad\nrequest", &[]).is_err());
    }

    #[test]
    fn removal_requires_confirmed_result_for_the_exact_device() {
        let id = "a".repeat(32);
        for value in [json!(null), json!({}), json!({"success":false}),
            json!({"success":true,"device_id":"b".repeat(32),"current_device_removed":true}),
            json!({"success":true,"device_id":id,"current_device_removed":"true"})] {
            assert!(confirmed_removal(value, &id).is_err());
        }
        let result = confirmed_removal(json!({"success":true,"device_id":id,
            "current_device_removed":true,"access_token":"SENSITIVE"}), &id).unwrap();
        assert_eq!(result["current_device_removed"], true);
        assert!(!result.to_string().contains("SENSITIVE"));
    }

    #[test]
    fn conflict_response_excludes_credentials_and_fingerprints() {
        let result = device_limit_payload(json!({"device_limit":1,"plan":"free","required_replacements":1,
            "access_token":"SENSITIVE_TOKEN","devices":[{"id":"a".repeat(32),"revision":1,"name":"Office",
            "platform":"windows","current":false,"last_seen_at":"2026-10-12T00:00:00Z","bound_at":"2026-10-12T00:00:00Z",
            "token_version":"SENSITIVE_VERSION","device_fingerprint":"SENSITIVE_FINGERPRINT"}]})).unwrap();
        assert_eq!(result["success"], false);
        assert!(!result.to_string().contains("SENSITIVE"));
        assert!(device_limit_payload(json!({"device_limit":0,"plan":"free","devices":[]})).is_err());
    }
}
