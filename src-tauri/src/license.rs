use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const LICENSE_FILENAME: &str = "license.jwt";
const AUTH_SERVER_URL: &str = "https://mona.lzfun.vip";
const TRIAL_DAYS: i64 = 31;

fn license_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .ok_or_else(|| "Cannot determine app data directory".to_string())?;
    Ok(base.join("mona"))
}

fn license_path() -> Result<PathBuf, String> {
    Ok(license_dir()?.join(LICENSE_FILENAME))
}

fn auth_token_path() -> Result<PathBuf, String> {
    Ok(license_dir()?.join("auth_token"))
}

fn license_cache_path() -> Result<PathBuf, String> {
    Ok(license_dir()?.join("license_cache.json"))
}

fn local_trial_path() -> Result<PathBuf, String> {
    Ok(license_dir()?.join("local_trial_start"))
}

// ── Local trial (no login required) ──

fn get_or_create_local_trial_start() -> String {
    let path = match local_trial_path() {
        Ok(p) => p,
        Err(_) => return chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
    };

    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            let trimmed = content.trim().to_string();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }

    // First launch — record trial start time
    let now_str = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    if let Ok(dir) = license_dir() {
        let _ = std::fs::create_dir_all(&dir);
    }
    let _ = std::fs::write(&path, &now_str);
    now_str
}

fn check_local_trial() -> Result<serde_json::Value, String> {
    let start_str = get_or_create_local_trial_start();
    let start = chrono::DateTime::parse_from_rfc3339(&start_str)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());

    let now = chrono::Utc::now();
    let trial_end = start + chrono::Duration::days(TRIAL_DAYS);
    let remaining = (trial_end - now).num_days();

    if now < trial_end {
        Ok(serde_json::json!({
            "status": "valid",
            "expires_at": trial_end.format("%Y-%m-%d").to_string(),
            "trial": true,
            "local_trial": true,
            "remaining_days": remaining.max(0),
            "email": null,
            "account": null
        }))
    } else {
        Ok(serde_json::json!({
            "status": "expired",
            "expires_at": trial_end.format("%Y-%m-%d").to_string(),
            "trial": true,
            "local_trial": true,
            "remaining_days": 0,
            "email": null,
            "account": null
        }))
    }
}

// ── Auth token storage ──

fn save_auth_token(token: &str) -> Result<(), String> {
    let dir = license_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = auth_token_path()?;
    std::fs::write(&path, token).map_err(|e| e.to_string())
}

fn load_auth_token() -> Option<String> {
    let path = auth_token_path().ok()?;
    if !path.exists() {
        return None;
    }
    std::fs::read_to_string(&path).ok().map(|s| s.trim().to_string())
}

pub fn remove_auth_token() -> Result<(), String> {
    let path = auth_token_path()?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── License cache (offline fallback) ──

#[derive(Debug, Serialize, Deserialize)]
struct LicenseCache {
    status: String,
    expires_at: Option<String>,
    trial: bool,
    email: Option<String>,
    account: Option<String>,
}

fn save_license_cache(cache: &LicenseCache) {
    if let Ok(path) = license_cache_path() {
        if let Ok(dir) = license_dir() {
            let _ = std::fs::create_dir_all(&dir);
        }
        if let Ok(json) = serde_json::to_string(cache) {
            let _ = std::fs::write(&path, json);
        }
    }
}

fn load_license_cache() -> Option<LicenseCache> {
    let path = license_cache_path().ok()?;
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

// ── Machine fingerprint ──

fn get_machine_fingerprint() -> String {
    let fingerprint = collect_fingerprint();
    let mut hasher = Sha256::new();
    hasher.update(fingerprint.as_bytes());
    hex::encode(hasher.finalize())
}

// ── Server API calls ──

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))
}

#[tauri::command]
pub async fn get_pricing() -> Result<serde_json::Value, String> {
    let client = build_client()?;
    let resp = client
        .get(format!("{}/config/pricing", AUTH_SERVER_URL))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;
    Ok(body)
}

#[tauri::command]
pub async fn list_notifications() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let client = build_client()?;
    let resp = client
        .get(format!("{}/notifications/", AUTH_SERVER_URL))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn get_unread_notification_count() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let client = build_client()?;
    let resp = client
        .get(format!("{}/notifications/unread-count", AUTH_SERVER_URL))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn mark_notification_read(notification_id: i64) -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let client = build_client()?;
    let resp = client
        .post(format!("{}/notifications/{}/read", AUTH_SERVER_URL, notification_id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    Ok(serde_json::json!({ "success": true }))
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
}

/// 将后端返回的错误码翻译为用户可读的中文提示
fn translate_error(error: &str) -> String {
    let detail = match error {
        "invalid_code" => "验证码错误或已过期，请重新获取",
        "email_exists" => "该邮箱已注册，请直接登录",
        "account_exists" => "该账号已被注册，请更换",
        "invalid_credentials" => "账号或密码错误",
        "user_not_found" => "用户不存在",
        "email_send_failed" => "验证码邮件发送失败，请稍后重试",
        "device_limit_exceeded" => "设备绑定数量已达上限",
        "device_mismatch" => "设备不匹配，请先绑定当前设备",
        "rate_limit_exceeded" => "操作过于频繁，请稍后再试",
        "subscription_expired" => "订阅已过期",
        "subscription_not_found" => "未找到有效订阅",
        "alipay_disabled" => "支付服务未配置，请联系客服",
        "already_subscribed" => "您已有有效订阅，无需重复购买",
        "plan_not_found" => "套餐不存在",
        "plan_not_renewable" => "该套餐不支持自动续费",
        "order_not_found" => "订单不存在",
        "agreement_not_found" => "未找到签约协议",
        _ => return error.to_string(),
    };
    detail.to_string()
}

#[tauri::command]
pub async fn send_register_code(email: String, account: String) -> Result<serde_json::Value, String> {
    let client = build_client()?;
    let resp = client
        .post(format!("{}/auth/send-register-code", AUTH_SERVER_URL))
        .json(&serde_json::json!({ "email": email, "account": account }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("Server returned status {} with non-JSON response", status))?;

    if body.get("message").is_some() {
        return Ok(serde_json::json!({ "success": true, "message": body["message"] }));
    }

    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
    Err(translate_error(error))
}

#[tauri::command]
pub async fn auth_register(email: String, password: String, code: String, account: String) -> Result<serde_json::Value, String> {
    let machine_fp = get_machine_fingerprint();
    let client = build_client()?;
    let resp = client
        .post(format!("{}/auth/register?device_fingerprint={}", AUTH_SERVER_URL, machine_fp))
        .json(&serde_json::json!({ "email": email, "password": password, "code": code, "account": account }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
        save_auth_token(token)?;
        return Ok(serde_json::json!({ "success": true }));
    }

    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
    Err(translate_error(error))
}

#[tauri::command]
pub async fn auth_login(account: String, password: String) -> Result<serde_json::Value, String> {
    let client = build_client()?;
    let resp = client
        .post(format!("{}/auth/login", AUTH_SERVER_URL))
        .json(&serde_json::json!({ "account": account, "password": password }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
        save_auth_token(token)?;
        return Ok(serde_json::json!({ "success": true }));
    }

    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
    Err(translate_error(error))
}

#[tauri::command]
pub async fn auth_logout() -> Result<serde_json::Value, String> {
    remove_auth_token()?;
    // Also remove license cache
    if let Ok(path) = license_cache_path() {
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn auth_forgot_password(email: String) -> Result<serde_json::Value, String> {
    let client = build_client()?;
    let resp = client
        .post(format!("{}/auth/forgot-password", AUTH_SERVER_URL))
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("Server returned status {} with non-JSON response", status))?;

    if body.get("message").is_some() {
        return Ok(serde_json::json!({ "success": true, "message": body["message"] }));
    }

    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
    Err(translate_error(error))
}

#[tauri::command]
pub async fn auth_reset_password(
    email: String,
    code: String,
    new_password: String,
) -> Result<serde_json::Value, String> {
    let client = build_client()?;
    let resp = client
        .post(format!("{}/auth/reset-password", AUTH_SERVER_URL))
        .json(&serde_json::json!({ "email": email, "code": code, "new_password": new_password }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("Server returned status {} with non-JSON response", status))?;

    if body.get("message").is_some() {
        return Ok(serde_json::json!({ "success": true, "message": body["message"] }));
    }

    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
    Err(translate_error(error))
}

#[tauri::command]
pub async fn get_auth_status() -> Result<serde_json::Value, String> {
    let token = load_auth_token();
    Ok(serde_json::json!({ "logged_in": token.is_some() }))
}

#[tauri::command]
pub async fn bind_device() -> Result<serde_json::Value, String> {
    let token = match load_auth_token() {
        Some(t) => t,
        None => return Err("Not logged in".to_string()),
    };
    let machine_fp = get_machine_fingerprint();
    let client = build_client()?;
    let resp = client
        .post(format!("{}/license/bind-device", AUTH_SERVER_URL))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({ "device_fingerprint": machine_fp }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    if body.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(body);
    }

    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("Bind failed");
    Err(error.to_string())
}

// ── Image upload (for video image-to-video reference) ──

#[tauri::command]
pub async fn upload_image(file_path: String) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&file_path);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("upload.png")
        .to_string();

    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "png".to_string());
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(mime)
        .map_err(|e| format!("Mime error: {}", e))?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let resp = client
        .post(format!("{}/upload/image", AUTH_SERVER_URL))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Parse error: {}", e))
}

// ── License check ──

#[derive(Debug, Serialize, Deserialize)]
struct LicenseClaims {
    sub: String,
    fp: String,
    plan: String,
    exp: usize,
    iat: usize,
    jti: String,
}

#[tauri::command]
pub async fn get_machine_id() -> Result<String, String> {
    Ok(get_machine_fingerprint())
}

// ── 支付宝订阅相关命令 ──

#[tauri::command]
pub async fn create_subscription(plan_code: String, payment_method: String) -> Result<serde_json::Value, String> {
    let token = match load_auth_token() {
        Some(t) => t,
        None => return Err("Not logged in".to_string()),
    };
    let client = build_client()?;
    let resp = client
        .post(format!("{}/payment/subscribe", AUTH_SERVER_URL))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({
            "plan_code": plan_code,
            "payment_method": payment_method,
        }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("Server returned status {} with non-JSON response", status))?;

    if body.get("payment_url").is_some() {
        return Ok(body);
    }

    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("Subscribe failed");
    Err(error.to_string())
}

#[tauri::command]
pub async fn poll_payment_status(order_id: i64) -> Result<serde_json::Value, String> {
    let token = match load_auth_token() {
        Some(t) => t,
        None => return Err("Not logged in".to_string()),
    };
    let client = build_client()?;
    let resp = client
        .get(format!("{}/payment/orders/{}", AUTH_SERVER_URL, order_id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn get_subscription_info() -> Result<serde_json::Value, String> {
    let token = match load_auth_token() {
        Some(t) => t,
        None => return Err("Not logged in".to_string()),
    };
    let client = build_client()?;
    let resp = client
        .get(format!("{}/payment/subscription", AUTH_SERVER_URL))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn cancel_auto_renew(reason: Option<String>) -> Result<serde_json::Value, String> {
    let token = match load_auth_token() {
        Some(t) => t,
        None => return Err("Not logged in".to_string()),
    };
    let client = build_client()?;
    let resp = client
        .post(format!("{}/payment/cancel-auto-renew", AUTH_SERVER_URL))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({ "reason": reason.unwrap_or_default() }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("Server returned status {} with non-JSON response", status))?;

    if body.get("cancelled_at").is_some() {
        return Ok(body);
    }

    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("Cancel failed");
    Err(error.to_string())
}

#[tauri::command]
pub async fn list_renewals() -> Result<serde_json::Value, String> {
    let token = match load_auth_token() {
        Some(t) => t,
        None => return Err("Not logged in".to_string()),
    };
    let client = build_client()?;
    let resp = client
        .get(format!("{}/payment/renewals", AUTH_SERVER_URL))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    // 使用系统默认浏览器打开支付 URL
    #[cfg(windows)]
    {
        // raw_arg 避免对 URL 中的 & " 等特殊字符二次转义
        // 构造命令行: cmd /c start "" "https://..."
        std::process::Command::new("cmd")
            .raw_arg(format!("/c start \"\" \"{}\"", url))
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn check_license() -> Result<serde_json::Value, String> {
    // 1. If there's a license.jwt file, verify locally (paid license)
    let path = license_path()?;
    if path.exists() {
        match check_paid_license(&path) {
            Ok(result) => {
                // Only return immediately if the license is still valid
                let status = result.get("status").and_then(|v| v.as_str()).unwrap_or("");
                if status == "valid" || status == "machine_mismatch" {
                    return Ok(result);
                }
                // License expired or invalid — fall through to server check
                // so admin changes (extended trial, new subscription) can take effect
            }
            Err(_) => {
                // Failed to read license file — fall through to server check
            }
        }
    }

    // 2. If logged in, check via server
    if let Some(token) = load_auth_token() {
        match check_license_server(&token).await {
            Ok(result) => {
                save_license_cache(&result);
                return Ok(serde_json::to_value(&result).unwrap_or_default());
            }
            Err(_) => {
                // Network error — fall back to local cache
                if let Some(cache) = load_license_cache() {
                    return Ok(serde_json::to_value(&cache).unwrap_or_default());
                }
                // No cache but logged in — still grant local trial as fallback
                return check_local_trial();
            }
        }
    }

    // 3. Not logged in — check local trial
    check_local_trial()
}

/// Read-only local license state check for Agent subscription gating.
///
/// Returns `true` only when one of the following local, trusted sources is
/// valid: imported `license.jwt`, cached server result (`license_cache.json`),
/// or an unexpired local trial. No network requests are made — this is safe
/// to call on every Agent turn. Fail-closed: any read/parse error returns
/// `false` so that personal data is never leaked to an unverified state.
#[tauri::command]
pub async fn license_has_access() -> Result<bool, String> {
    Ok(check_license_access())
}

/// Synchronous core logic for `license_has_access`. Also called directly by
/// the IPC bridge so Python Agent tools can invoke it via `tauri_invoke`.
pub fn check_license_access() -> bool {
    // 1. Imported paid license (JWT verified locally, machine fingerprint match)
    if let Ok(path) = license_path() {
        if path.exists() {
            if let Ok(result) = check_paid_license(&path) {
                let status = result.get("status").and_then(|v| v.as_str()).unwrap_or("");
                if status == "valid" {
                    return true;
                }
                // machine_mismatch / expired / invalid → fall through to other sources
            }
        }
    }

    // 2. Cached server license result (offline fallback, no network)
    if let Some(cache) = load_license_cache() {
        if cache.status == "valid" {
            if let Some(ref exp_str) = cache.expires_at {
                if !is_expired(exp_str) {
                    return true;
                }
            } else {
                // No expiry recorded — trust the cached "valid" status
                return true;
            }
        }
    }

    // 3. Local trial (31-day window from first launch, no login required)
    if let Ok(result) = check_local_trial() {
        let status = result.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if status == "valid" {
            return true;
        }
    }

    false
}

/// Returns true if the given date string is in the past.
/// Accepts both `YYYY-MM-DD` and full RFC3339 timestamps.
fn is_expired(expires_at: &str) -> bool {
    let trimmed = expires_at.trim();
    if trimmed.is_empty() {
        return true;
    }
    // Try full RFC3339 first, then fall back to date-only parsing
    let parsed = chrono::DateTime::parse_from_rfc3339(trimmed)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .or_else(|_| {
            chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
                .map(|d| chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                    d.and_hms_opt(23, 59, 59).expect("valid end-of-day time"),
                    chrono::Utc,
                ))
        });
    match parsed {
        Ok(exp) => chrono::Utc::now() >= exp,
        Err(_) => true,
    }
}

async fn check_license_server(token: &str) -> Result<LicenseCache, String> {
    let machine_fp = get_machine_fingerprint();
    let client = build_client()?;
    let resp = client
        .get(format!("{}/license/check?device_fingerprint={}", AUTH_SERVER_URL, machine_fp))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        // Token expired or invalid
        let _ = remove_auth_token();
        return Err("Token expired".to_string());
    }

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    Ok(LicenseCache {
        status: body.get("status").and_then(|v| v.as_str()).unwrap_or("missing").to_string(),
        expires_at: body.get("expires_at").and_then(|v| v.as_str()).map(|s| s.to_string()),
        trial: body.get("trial").and_then(|v| v.as_bool()).unwrap_or(false),
        email: body.get("email").and_then(|v| v.as_str()).map(|s| s.to_string()),
        account: body.get("account").and_then(|v| v.as_str()).map(|s| s.to_string()),
    })
}

fn check_paid_license(path: &PathBuf) -> Result<serde_json::Value, String> {
    let token = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read license file: {}", e))?;

    let public_key = load_public_key()?;

    let validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    let decoded: jsonwebtoken::TokenData<LicenseClaims> = match jsonwebtoken::decode(&token, &public_key, &validation) {
        Ok(d) => d,
        Err(e) => {
            let err_str = e.to_string();
            if err_str.contains("ExpiredSignature") {
                let expired_at = extract_exp_fallback(&token);
                return Ok(serde_json::json!({
                    "status": "expired",
                    "expires_at": expired_at
                }));
            }
            return Ok(serde_json::json!({
                "status": "invalid",
                "expires_at": null
            }));
        }
    };

    let current_fp = {
        let machine_id = get_machine_fingerprint();
        let mut hasher = Sha256::new();
        hasher.update(machine_id.as_bytes());
        hex::encode(hasher.finalize())
    };

    if decoded.claims.fp != current_fp {
        return Ok(serde_json::json!({
            "status": "machine_mismatch",
            "expires_at": format_exp(decoded.claims.exp)
        }));
    }

    Ok(serde_json::json!({
        "status": "valid",
        "expires_at": format_exp(decoded.claims.exp)
    }))
}

#[tauri::command]
pub async fn import_license(path: String) -> Result<serde_json::Value, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Ok(serde_json::json!({
            "success": false,
            "message": "文件不存在"
        }));
    }

    let content = std::fs::read_to_string(&src)
        .map_err(|e| format!("读取文件失败: {}", e))?;

    let public_key = load_public_key()?;
    let validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    match jsonwebtoken::decode::<LicenseClaims>(&content, &public_key, &validation) {
        Ok(_) => {}
        Err(e) => {
            let msg = if e.to_string().contains("ExpiredSignature") {
                "License 已过期".to_string()
            } else {
                format!("License 无效: {}", e)
            };
            return Ok(serde_json::json!({
                "success": false,
                "message": msg
            }));
        }
    }

    let dir = license_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;

    let dest = license_path()?;
    std::fs::write(&dest, content.trim())
        .map_err(|e| format!("保存 License 失败: {}", e))?;

    Ok(serde_json::json!({
        "success": true,
        "message": "License 导入成功"
    }))
}

const LICENSE_PUBKEY: &str = include_str!("license_pubkey.pem");

fn load_public_key() -> Result<jsonwebtoken::DecodingKey, String> {
    jsonwebtoken::DecodingKey::from_rsa_pem(LICENSE_PUBKEY.as_bytes())
        .map_err(|e| format!("公钥格式错误: {}", e))
}

fn extract_exp_fallback(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = URL_SAFE_NO_PAD
        .decode(parts[1])
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    claims.get("exp")?
        .as_u64()
        .map(|ts| {
            let secs = ts as i64;
            chrono::DateTime::from_timestamp(secs, 0)
                .map(|dt| dt.format("%Y-%m-%d").to_string())
                .unwrap_or_default()
        })
}

#[cfg(test)]
mod subscription_access_tests {
    use super::is_expired;

    #[test]
    fn invalid_cached_expiry_is_rejected() {
        assert!(is_expired("not-a-date"));
        assert!(is_expired(""));
    }
}

fn format_exp(exp: usize) -> String {
    let secs = exp as i64;
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn collect_fingerprint() -> String {
    let mut parts: Vec<String> = Vec::new();

    parts.push(get_hostname());
    parts.push(get_username());
    parts.push(get_cpu_info());
    parts.push(get_disk_serial());

    parts.join("|")
}

fn get_hostname() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown-host".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOSTNAME")
            .or_else(|_| {
                std::fs::read_to_string("/etc/hostname")
                    .map(|s| s.trim().to_string())
                    .map_err(|_| "unknown-host".into())
            })
            .unwrap_or_else(|_| "unknown-host".into())
    }
}

fn get_username() -> String {
    #[cfg(windows)]
    {
        std::env::var("USERNAME").unwrap_or_else(|_| "unknown-user".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("USER").unwrap_or_else(|_| "unknown-user".into())
    }
}

fn get_cpu_info() -> String {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .args(["/c", "wmic cpu get ProcessorId"])
            .creation_flags(0x08000000)
            .output();
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let id = stdout
                    .lines()
                    .skip(1)
                    .find_map(|line| {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    })
                    .unwrap_or_default();
                format!("cpu:{}", id)
            }
            Err(_) => "cpu:unknown".into(),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("sh")
            .args(["-c", "sysctl -n machdep.cpu.brand_string"])
            .output();
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                format!("cpu:{}", stdout.trim())
            }
            Err(_) => "cpu:unknown".into(),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("sh")
            .args(["-c", "cat /proc/cpuinfo | grep 'model name' | head -1"])
            .output();
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let line = stdout.trim();
                format!("cpu:{}", line)
            }
            Err(_) => "cpu:unknown".into(),
        }
    }
}

fn get_disk_serial() -> String {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .args(["/c", "wmic diskdrive get serialnumber"])
            .creation_flags(0x08000000)
            .output();
        match output {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let serial = stdout
                    .lines()
                    .skip(1)
                    .find_map(|line| {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    })
                    .unwrap_or_default();
                format!("disk:{}", serial)
            }
            Err(_) => "disk:unknown".into(),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("sh")
            .args([
                "-c",
                "ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/ { gsub(/\"/,\"\"); print $NF }'",
            ])
            .output();
        match output {
            Ok(out) => {
                let uuid = String::from_utf8_lossy(&out.stdout).trim().to_string();
                format!("disk:{}", uuid)
            }
            Err(_) => "disk:unknown".into(),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("sh")
            .args([
                "-c",
                "lsblk -ndo SERIAL $(findmnt -n -o SOURCE /) 2>/dev/null || echo unknown",
            ])
            .output();
        match output {
            Ok(out) => {
                let serial = String::from_utf8_lossy(&out.stdout).trim().to_string();
                format!("disk:{}", serial)
            }
            Err(_) => "disk:unknown".into(),
        }
    }
}
