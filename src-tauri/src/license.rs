use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const LICENSE_FILENAME: &str = "license.jwt";
const AUTH_TOKEN_SECRET_NAME: &str = "mona_auth_token";
const AUTH_SERVER_URL_PRIMARY: &str = "https://mona-ai.cn";
const AUTH_SERVER_URL_FALLBACK: &str = "https://www.mona-ai.cn";
const LICENSE_CACHE_MAX_AGE_DAYS: i64 = 7;

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

// ── Auth token storage ──

fn save_auth_token(token: &str) -> Result<(), String> {
    crate::terminal::credential_store::store_secret(AUTH_TOKEN_SECRET_NAME, token)?;
    let path = auth_token_path()?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn load_auth_token() -> Option<String> {
    if let Ok(Some(token)) =
        crate::terminal::credential_store::load_secret(AUTH_TOKEN_SECRET_NAME)
    {
        if let Ok(path) = auth_token_path() {
            if path.exists() {
                let _ = std::fs::remove_file(path);
            }
        }
        return Some(token);
    }
    let path = auth_token_path().ok()?;
    if !path.exists() {
        return None;
    }
    let token = std::fs::read_to_string(&path).ok()?.trim().to_string();
    if save_auth_token(&token).is_ok() {
        Some(token)
    } else {
        None
    }
}

pub fn remove_auth_token() -> Result<(), String> {
    crate::terminal::credential_store::delete_secret(AUTH_TOKEN_SECRET_NAME)?;
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
    #[serde(default)]
    verified_at: Option<String>,
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

/// 依次尝试 Mona 根域名和 www 兼容域名发送请求。只在连接失败时回退，
/// 收到 HTTP 响应（含 4xx/5xx）直接返回。
async fn auth_send<F>(build: F) -> Result<reqwest::Response, String>
where
    F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
{
    let client = build_client()?;
    let urls = [AUTH_SERVER_URL_PRIMARY, AUTH_SERVER_URL_FALLBACK];
    let mut last_err = String::new();
    for base in &urls {
        match build(&client, base).send().await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                last_err = format!("Request failed: {}", e);
            }
        }
    }
    Err(last_err)
}

async fn service_json(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        let _ = remove_auth_token();
        return Err("登录已过期，请重新登录 (401)".to_string());
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = resp
        .text()
        .await
        .map_err(|_| "读取 Mona 服务响应失败，请稍后重试".to_string())?;
    let body = decode_service_body(status, &content_type, &text)?;
    if status.is_success() {
        return Ok(body);
    }
    let code = body.get("error").and_then(|value| value.as_str()).unwrap_or("");
    let message = match code {
        "credit_payments_disabled" => "余额充值暂未开放",
        "alipay_disabled" => "支付宝支付暂不可用",
        "product_not_found" => "充值商品已下架，请刷新后重试",
        "custom_recharge_disabled" => "自定义充值暂不可用",
        "custom_recharge_out_of_range" => "充值金额超出管理员设置范围",
        "order_conflict" => "充值订单状态已变化，请重新发起",
        "managed_model_unavailable" => "Mona AI 暂不可用",
        "insufficient_credits" => "模型余额不足，请先充值",
        _ => body
            .get("detail")
            .and_then(|value| value.as_str())
            .unwrap_or("服务请求失败"),
    };
    Err(format!("{} ({})", message, status.as_u16()))
}

fn decode_service_body(
    status: reqwest::StatusCode,
    content_type: &str,
    text: &str,
) -> Result<serde_json::Value, String> {
    serde_json::from_str(text).map_err(|_| {
        if !content_type.to_ascii_lowercase().contains("json") {
            "Mona 服务尚未部署或路由异常，请升级服务端".to_string()
        } else {
            format!("Mona 服务返回格式异常 ({})", status.as_u16())
        }
    })
}

#[tauri::command]
pub async fn get_pricing() -> Result<serde_json::Value, String> {
    let resp = auth_send(|client, base| client.get(format!("{}/config/pricing", base))).await?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;
    Ok(body)
}

#[tauri::command]
pub async fn list_notifications() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/notifications/", base))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn get_unread_notification_count() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/notifications/unread-count", base))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn mark_notification_read(notification_id: i64) -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/notifications/{}/read", base, notification_id))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    Ok(serde_json::json!({ "success": true }))
}

/// 将后端返回的错误码翻译为用户可读的中文提示
fn translate_error(error: &str) -> String {
    let detail = match error {
        "invalid_code" => "验证码错误或已过期，请重新获取",
        "email_exists" => "该邮箱已注册，请直接登录",
        "account_exists" => "该账号已被注册，请更换",
        "invalid_credentials" => "账号或密码错误",
        "same_as_old" => "新密码不能与旧密码相同",
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
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/auth/send-register-code", base))
            .json(&serde_json::json!({ "email": email, "account": account }))
    })
    .await?;

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
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/auth/register?device_fingerprint={}", base, machine_fp))
            .json(&serde_json::json!({ "email": email, "password": password, "code": code, "account": account }))
    })
    .await?;

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
        save_auth_token(token)?;
        return Ok(serde_json::json!({ "success": true }));
    }

    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
    Err(translate_error(error))
}

#[tauri::command]
pub async fn auth_login(app: AppHandle, account: String, password: String) -> Result<serde_json::Value, String> {
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/auth/login", base))
            .json(&serde_json::json!({ "account": account, "password": password }))
    })
    .await?;

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("Parse error: {}", e))?;

    if let Some(token) = body.get("access_token").and_then(|v| v.as_str()) {
        save_auth_token(token)?;
        let _ = app.emit("auth-state-changed", serde_json::json!({ "loggedIn": true }));
        return Ok(serde_json::json!({ "success": true }));
    }

    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("Unknown error");
    Err(translate_error(error))
}

#[tauri::command]
pub async fn auth_logout(app: AppHandle) -> Result<serde_json::Value, String> {
    remove_auth_token()?;
    // Also remove license cache
    if let Ok(path) = license_cache_path() {
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
    let _ = app.emit("auth-state-changed", serde_json::json!({ "loggedIn": false }));
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub async fn auth_forgot_password(email: String) -> Result<serde_json::Value, String> {
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/auth/forgot-password", base))
            .json(&serde_json::json!({ "email": email }))
    })
    .await?;

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
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/auth/reset-password", base))
            .json(&serde_json::json!({ "email": email, "code": code, "new_password": new_password }))
    })
    .await?;

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
pub async fn auth_change_password(
    old_password: String,
    new_password: String,
) -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/auth/change-password", base))
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({ "old_password": old_password, "new_password": new_password }))
    })
    .await?;

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
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/license/bind-device", base))
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({ "device_fingerprint": machine_fp }))
    })
    .await?;

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

    let resp = auth_send(|client, base| {
        // Rebuild the multipart form on each attempt — reqwest::multipart::Form
        // does not implement Clone, so we reconstruct from the raw bytes.
        let part = reqwest::multipart::Part::bytes(bytes.clone())
            .file_name(file_name.clone())
            .mime_str(mime)
            .expect("mime string is validated above");
        let form = reqwest::multipart::Form::new().part("file", part);
        client
            .post(format!("{}/upload/image", base))
            .multipart(form)
    })
    .await?;

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
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/payment/subscribe", base))
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "plan_code": plan_code,
                "payment_method": payment_method,
            }))
    })
    .await?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("Server returned status {} with non-JSON response", status))?;

    if body.get("payment_url").is_some() {
        validate_payment_urls_in_payload(&body)?;
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
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/payment/orders/{}", base, order_id))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;

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
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/payment/subscription", base))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn get_credit_products() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/credits/products", base))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;
    service_json(resp).await
}

#[tauri::command]
pub async fn get_credit_balance() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/credits/balance", base))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;
    service_json(resp).await
}

#[tauri::command]
pub async fn get_credit_ledger(limit: u32) -> Result<serde_json::Value, String> {
    if !(1..=100).contains(&limit) {
        return Err("limit must be between 1 and 100".to_string());
    }
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/credits/ledger?limit={}", base, limit))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;
    service_json(resp).await
}

#[tauri::command]
pub async fn get_credit_orders(limit: u32) -> Result<serde_json::Value, String> {
    if !(1..=50).contains(&limit) {
        return Err("limit must be between 1 and 50".to_string());
    }
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/credits/orders?limit={}", base, limit))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;
    let body = service_json(resp).await?;
    validate_payment_urls_in_payload(&body)?;
    Ok(body)
}

#[tauri::command]
pub async fn get_credit_usage(tz_offset_minutes: i32) -> Result<serde_json::Value, String> {
    if !(-720..=840).contains(&tz_offset_minutes) {
        return Err("timezone offset must be between -720 and 840 minutes".to_string());
    }
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .get(format!(
                "{}/credits/usage?tz_offset_minutes={}",
                base, tz_offset_minutes
            ))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;
    service_json(resp).await
}

#[tauri::command]
pub async fn create_credit_order(
    product_code: String,
    idempotency_key: String,
) -> Result<serde_json::Value, String> {
    if !(16..=64).contains(&idempotency_key.len())
        || !idempotency_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("Invalid credit order idempotency key".to_string());
    }
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/credits/orders", base))
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "product_code": product_code,
                "idempotency_key": idempotency_key,
            }))
    })
    .await?;
    let body = service_json(resp).await?;
    validate_payment_urls_in_payload(&body)?;
    Ok(body)
}

fn valid_custom_recharge_amount(raw: &str) -> bool {
    let mut parts = raw.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if parts.next().is_some()
        || whole.is_empty()
        || whole.len() > 10
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    if let Some(value) = fraction {
        if value.is_empty()
            || value.len() > 2
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return false;
        }
    }
    raw.bytes().any(|byte| byte.is_ascii_digit() && byte != b'0')
}

#[tauri::command]
pub async fn create_custom_credit_order(
    amount: String,
    idempotency_key: String,
) -> Result<serde_json::Value, String> {
    if !valid_custom_recharge_amount(&amount) {
        return Err("Invalid custom recharge amount".to_string());
    }
    if !(16..=64).contains(&idempotency_key.len())
        || !idempotency_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("Invalid credit order idempotency key".to_string());
    }
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/credits/orders", base))
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({
                "custom_amount": amount,
                "idempotency_key": idempotency_key,
            }))
    })
    .await?;
    let body = service_json(resp).await?;
    validate_payment_urls_in_payload(&body)?;
    Ok(body)
}

#[tauri::command]
pub async fn get_credit_order_status(
    order_id: i64,
    reconcile: Option<bool>,
) -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/credits/orders/{}", base, order_id))
            .query(&[("reconcile", reconcile.unwrap_or(false))])
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;
    service_json(resp).await
}

#[tauri::command]
pub async fn get_model_access_credentials() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/model-access/token", base))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;
    let mut api_base = resp.url().clone();
    api_base.set_path("/v1");
    api_base.set_query(None);
    let mut body = service_json(resp).await?;
    body["api_base"] = serde_json::Value::String(api_base.to_string().trim_end_matches('/').to_string());
    Ok(body)
}

#[tauri::command]
pub async fn get_managed_model_prices() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/model-access/prices", base))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;
    service_json(resp).await
}

#[tauri::command]
pub async fn get_managed_model_catalog() -> Result<serde_json::Value, String> {
    let token = load_auth_token().ok_or_else(|| "Not logged in".to_string())?;
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/model-access/catalog", base))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;
    service_json(resp).await
}

#[tauri::command]
pub async fn cancel_auto_renew(reason: Option<String>) -> Result<serde_json::Value, String> {
    let token = match load_auth_token() {
        Some(t) => t,
        None => return Err("Not logged in".to_string()),
    };
    let reason_val = reason.unwrap_or_default();
    let resp = auth_send(|client, base| {
        client
            .post(format!("{}/payment/cancel-auto-renew", base))
            .header("Authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({ "reason": reason_val }))
    })
    .await?;

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
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/payment/renewals", base))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;

    if !resp.status().is_success() {
        return Err(format!("Server error: {}", resp.status()));
    }

    resp.json::<serde_json::Value>().await.map_err(|e| format!("Parse error: {}", e))
}

fn validate_payment_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|_| "Invalid payment URL".to_string())?;
    let allowed_host = matches!(
        parsed.host_str(),
        Some("openapi.alipay.com" | "openapi-sandbox.dl.alipaydev.com")
    );
    if parsed.scheme() != "https"
        || !allowed_host
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(443)
    {
        return Err("Payment URL is not an allowed Alipay HTTPS endpoint".to_string());
    }
    Ok(parsed)
}

fn validate_payment_urls_in_payload(body: &serde_json::Value) -> Result<(), String> {
    if let Some(value) = body.get("payment_url") {
        if !value.is_null() {
            let payment_url = value
                .as_str()
                .ok_or_else(|| "Invalid payment URL field".to_string())?;
            validate_payment_url(payment_url)?;
        }
    }
    if let Some(orders) = body.get("orders").and_then(|value| value.as_array()) {
        for order in orders {
            if let Some(value) = order.get("payment_url") {
                if !value.is_null() {
                    let payment_url = value
                        .as_str()
                        .ok_or_else(|| "Invalid payment URL field".to_string())?;
                    validate_payment_url(payment_url)?;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn open_payment_url(app: AppHandle, url: String) -> Result<(), String> {
    let payment_url = validate_payment_url(&url)?;
    app.opener()
        .open_url(payment_url.as_str(), None::<&str>)
        .map_err(|e| format!("Failed to open payment URL: {}", e))
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
                if let Some(mut cache) = load_license_cache() {
                    if !cached_license_has_access(&cache) {
                        cache.status = "expired".to_string();
                    }
                    return Ok(serde_json::to_value(&cache).unwrap_or_default());
                }
                // No cache and offline — no access. User must register/login
                // to obtain a trial; there is no machine-local trial anymore.
                return Ok(serde_json::json!({
                    "status": "missing",
                    "expires_at": null,
                    "trial": false,
                    "remaining_days": 0,
                    "email": null,
                    "account": null
                }));
            }
        }
    }

    // 3. Not logged in — no local trial, prompt to register/login
    Ok(serde_json::json!({
        "status": "missing",
        "expires_at": null,
        "trial": false,
        "remaining_days": 0,
        "email": null,
        "account": null
    }))
}

/// Read-only local license state check for Agent subscription gating.
///
/// Returns `true` only when one of the following local, trusted sources is
/// valid: imported `license.jwt` or a server result cached within the last 7 days.
/// No network requests are made — this is safe to call on every Agent turn.
/// Fail-closed: any read/parse error returns `false` so that personal data is
/// never leaked to an unverified state.
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
        return cached_license_has_access(&cache);
    }

    false
}

/// Parse an expiry string (RFC3339 or YYYY-MM-DD) into a UTC DateTime.
fn parse_expiry(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(trimmed)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .or_else(|_| {
            chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
                .map(|d| chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                    d.and_hms_opt(23, 59, 59).expect("valid end-of-day time"),
                    chrono::Utc,
                ))
        })
        .ok()
}

/// Returns true if the given date string is in the past.
/// Accepts both `YYYY-MM-DD` and full RFC3339 timestamps.
fn is_expired(expires_at: &str) -> bool {
    match parse_expiry(expires_at) {
        Some(exp) => chrono::Utc::now() >= exp,
        None => true,
    }
}

async fn check_license_server(token: &str) -> Result<LicenseCache, String> {
    let machine_fp = get_machine_fingerprint();
    let resp = auth_send(|client, base| {
        client
            .get(format!("{}/license/check?device_fingerprint={}", base, machine_fp))
            .header("Authorization", format!("Bearer {}", token))
    })
    .await?;

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
        verified_at: Some(chrono::Utc::now().to_rfc3339()),
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

    if decoded.claims.plan != "pro" {
        return Ok(serde_json::json!({
            "status": "invalid",
            "expires_at": format_exp(decoded.claims.exp)
        }));
    }

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
    use super::{
        cached_license_has_access, create_credit_order, create_custom_credit_order,
        decode_service_body, get_credit_ledger, get_credit_orders, get_credit_usage, is_expired,
        valid_custom_recharge_amount, validate_payment_url, validate_payment_urls_in_payload,
        LicenseCache,
    };

    #[test]
    fn invalid_cached_expiry_is_rejected() {
        assert!(is_expired("not-a-date"));
        assert!(is_expired(""));
    }

    #[test]
    fn server_cache_requires_recent_verification() {
        let mut cache = LicenseCache {
            status: "valid".to_string(),
            expires_at: None,
            trial: false,
            email: None,
            account: None,
            verified_at: Some(chrono::Utc::now().to_rfc3339()),
        };
        assert!(cached_license_has_access(&cache));

        cache.verified_at = Some(
            (chrono::Utc::now() - chrono::Duration::days(8)).to_rfc3339(),
        );
        assert!(!cached_license_has_access(&cache));
    }

    #[tokio::test]
    async fn credit_ledger_limit_is_validated_before_network_access() {
        assert_eq!(
            get_credit_ledger(0).await.unwrap_err(),
            "limit must be between 1 and 100"
        );
        assert_eq!(
            get_credit_ledger(101).await.unwrap_err(),
            "limit must be between 1 and 100"
        );
        assert_eq!(
            get_credit_orders(0).await.unwrap_err(),
            "limit must be between 1 and 50"
        );
        assert_eq!(
            get_credit_orders(51).await.unwrap_err(),
            "limit must be between 1 and 50"
        );
        assert_eq!(
            get_credit_usage(-721).await.unwrap_err(),
            "timezone offset must be between -720 and 840 minutes"
        );
        assert_eq!(
            get_credit_usage(841).await.unwrap_err(),
            "timezone offset must be between -720 and 840 minutes"
        );
        assert_eq!(
            create_credit_order("starter".into(), "short".into())
                .await
                .unwrap_err(),
            "Invalid credit order idempotency key"
        );
        assert_eq!(
            create_custom_credit_order("1.001".into(), "checkoutattempt0001".into())
                .await
                .unwrap_err(),
            "Invalid custom recharge amount"
        );
    }

    #[test]
    fn custom_recharge_amount_uses_plain_positive_cents() {
        assert!(valid_custom_recharge_amount("1"));
        assert!(valid_custom_recharge_amount("1.20"));
        assert!(valid_custom_recharge_amount("5000.00"));
        assert!(!valid_custom_recharge_amount("0"));
        assert!(!valid_custom_recharge_amount("-1"));
        assert!(!valid_custom_recharge_amount("1.001"));
        assert!(!valid_custom_recharge_amount("1e2"));
    }

    #[test]
    fn payment_urls_are_restricted_to_alipay_https_gateways() {
        assert!(validate_payment_url("https://openapi.alipay.com/gateway.do?x=1").is_ok());
        assert!(validate_payment_url(
            "https://openapi-sandbox.dl.alipaydev.com/gateway.do?x=1"
        )
        .is_ok());
        assert!(validate_payment_url("http://openapi.alipay.com/gateway.do").is_err());
        assert!(validate_payment_url("https://example.com/gateway.do").is_err());
        assert!(validate_payment_url(
            "https://openapi.alipay.com.evil.example/gateway.do"
        )
        .is_err());
        assert!(validate_payment_urls_in_payload(&serde_json::json!({
            "payment_url": "https://example.com/phishing"
        }))
        .is_err());
        assert!(validate_payment_urls_in_payload(&serde_json::json!({
            "orders": [{
                "payment_url": "https://openapi.alipay.com/gateway.do?order=1"
            }]
        }))
        .is_ok());
    }

    #[test]
    fn non_json_service_pages_report_a_deployment_mismatch() {
        assert_eq!(
            decode_service_body(
                reqwest::StatusCode::OK,
                "text/html; charset=utf-8",
                "<html>Mona</html>",
            )
            .unwrap_err(),
            "Mona 服务尚未部署或路由异常，请升级服务端"
        );
        assert_eq!(
            decode_service_body(
                reqwest::StatusCode::BAD_GATEWAY,
                "application/json",
                "not-json",
            )
            .unwrap_err(),
            "Mona 服务返回格式异常 (502)"
        );
    }
}

fn cached_license_has_access(cache: &LicenseCache) -> bool {
    if cache.status != "valid" {
        return false;
    }
    if cache.expires_at.as_deref().is_some_and(is_expired) {
        return false;
    }
    let Some(verified_at) = cache.verified_at.as_deref().and_then(parse_expiry) else {
        return false;
    };
    chrono::Utc::now().signed_duration_since(verified_at)
        <= chrono::Duration::days(LICENSE_CACHE_MAX_AGE_DAYS)
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
                    .map_err(|_| "unknown-host".to_string())
            })
            .unwrap_or_else(|_| "unknown-host".to_string())
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
