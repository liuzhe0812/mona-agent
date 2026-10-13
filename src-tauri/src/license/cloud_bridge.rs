//! Private Python bridge: React receives neither account tokens nor stored vault keys.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use super::{device_sessions, load_auth_token, token_fingerprint};

fn hex(value: &str, size: usize) -> bool {
    value.len() == size && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn route_allowed(method: &str, path: &str) -> bool {
    if path.len() > 256 || path.contains(['%', '#', '\\']) { return false; }
    let (base, query) = path.split_once('?').unwrap_or((path, ""));
    let parts: Vec<_> = base.split('/').collect();
    let allowed = match (method, parts.as_slice()) {
        ("GET", ["", "space"]) | ("GET", ["", "changes"]) => true,
        ("POST", ["", "space"]) | ("POST", ["", "objects", "reserve"])
            | ("POST", ["", "resources", "commit"]) => query.is_empty(),
        ("POST", ["", "objects", id, operation]) => hex(id, 64)
            && matches!(*operation, "confirm" | "download" | "release") && query.is_empty(),
        ("GET", ["", "resources", id, "history"]) => hex(id, 32),
        _ => false,
    };
    if !allowed { return false; }
    if !query.is_empty() {
        if method != "GET" { return false; }
        let keys = if base == "/changes" { vec!["after", "limit"] }
            else if base.ends_with("/history") { vec!["before"] } else { return false; };
        let mut seen = std::collections::HashSet::new();
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else { return false; };
            if !keys.contains(&key) || !seen.insert(key) || value.parse::<u64>().is_err() { return false; }
        }
    }
    true
}

fn bound_token(binding: &str) -> Result<String, String> {
    let token = load_auth_token().ok_or("请先登录 Mona。")?;
    if !hex(binding, 64) || token_fingerprint(&token) != binding {
        return Err("账号已变化，本次同步已停止。".into());
    }
    Ok(token)
}

async fn control(token: &str, method: &str, path: &str, payload: &Value) -> Result<Value, String> {
    if !route_allowed(method, path) || payload.to_string().len() > 256 * 1024 {
        return Err("云同步请求无效。".into());
    }
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30)).build().map_err(|_| "账号服务暂不可用。")?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "请求方法无效。")?;
    for origin in [super::AUTH_SERVER_URL_PRIMARY, super::AUTH_SERVER_URL_FALLBACK] {
        let mut request = client.request(method.clone(), format!("{origin}/cloud/v1{path}")).bearer_auth(token);
        if !payload.is_null() { request = request.json(payload); }
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(error) if error.is_connect() => continue,
            Err(_) => return Err("云同步请求结果尚未确认，请稍后核对。".into()),
        };
        let status = response.status().as_u16();
        if response.status().is_redirection() { return Err("云服务地址返回了不允许的跳转。".into()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "读取同步状态失败。")? {
            if bytes.len() + chunk.len() > 16 * 1024 * 1024 { return Err("同步目录过大，请分批读取。".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let data: Value = serde_json::from_slice(&bytes).map_err(|_| "云同步服务响应异常。")?;
        if !data.is_object() { return Err("云同步服务响应异常。".into()); }
        return Ok(json!({"status":status,"data":data}));
    }
    Err("暂时无法连接云同步服务。".into())
}

fn account_id(token: &str) -> Result<String, String> {
    // Called only after the server has validated the currently locked token.
    let middle = token.split('.').nth(1).ok_or("账号凭据无效。")?;
    let bytes = URL_SAFE_NO_PAD.decode(middle).map_err(|_| "账号凭据无效。")?;
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| "账号凭据无效。")?;
    let id = payload["sub"].as_str().ok_or("账号凭据无效。")?;
    if id.parse::<u64>().ok().filter(|id| *id > 0).is_none() { return Err("账号凭据无效。".into()); }
    Ok(id.to_string())
}

pub(crate) async fn context() -> Result<Value, String> {
    let _guard = device_sessions::ACCOUNT_LOCK.lock().await;
    let token = load_auth_token().ok_or("请先登录 Mona。")?;
    let cache = device_sessions::status(&token).await.map_err(|_| "请联网核对账号后再同步。")?;
    let user = account_id(&token)?;
    let response = control(&token, "GET", "/space", &Value::Null).await?;
    if response["status"] != 200 {
        return Ok(json!({"binding":token_fingerprint(&token),"account_id":user,
            "plan":cache.plan,"cloud_status":response["status"],"error":response["data"]["error"]}));
    }
    let space = &response["data"]["space"];
    let recovery = if let Some(vault) = space["vault_id"].as_str().filter(|v| hex(v,32)) {
        crate::terminal::credential_store::load_secret(&format!("mona_cloud_{user}_{vault}"))?
    } else { None };
    Ok(json!({"binding":token_fingerprint(&token),"account_id":user,"plan":cache.plan,
        "cloud_status":200,"exists":response["data"]["exists"],"space":space,"recovery":recovery}))
}

pub(crate) async fn request(args: &Value) -> Result<Value, String> {
    let _guard = device_sessions::ACCOUNT_LOCK.lock().await;
    let binding = args["binding"].as_str().ok_or("缺少账号绑定。")?;
    let token = bound_token(binding)?;
    let method = args["method"].as_str().ok_or("缺少请求方法。")?;
    let path = args["path"].as_str().ok_or("缺少同步操作。")?;
    control(&token, method, path, &args["payload"]).await
}

pub(crate) async fn store_key(args: &Value) -> Result<Value, String> {
    let _guard = device_sessions::ACCOUNT_LOCK.lock().await;
    let token = bound_token(args["binding"].as_str().ok_or("缺少账号绑定。")?)?;
    device_sessions::status(&token).await.map_err(|_| "请联网核对账号后保存恢复密钥。")?;
    let user = account_id(&token)?;
    let vault = args["vault_id"].as_str().filter(|v| hex(v,32)).ok_or("云空间标识无效。")?;
    let recovery = args["recovery"].as_str().ok_or("恢复密钥无效。")?;
    if recovery.len() > 160 || !recovery.starts_with(&format!("mona-v1:{vault}:"))
        || !recovery.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':'|b'-'|b'_')) {
        return Err("恢复密钥格式无效。".into());
    }
    let name = format!("mona_cloud_{user}_{vault}");
    if let Some(existing) = crate::terminal::credential_store::load_secret(&name)? {
        if existing != recovery { return Err("本机已有不同的恢复密钥，未覆盖。".into()); }
    }
    crate::terminal::credential_store::store_secret(&name, recovery)?;
    Ok(json!({"saved":true}))
}

fn update_payload(args: &Value) -> Result<Value, String> {
    let keys = args["work_keys"].as_array().ok_or("同步通知无效。")?;
    let planning = args["planning"].as_bool().ok_or("同步通知无效。")?;
    if keys.len() > 100 || keys.iter().any(|value| {
        let Some(key) = value.as_str().and_then(|key| key.strip_prefix("websocket:")) else { return true; };
        key.is_empty() || key.len() > 128 || !key.as_bytes()[0].is_ascii_alphanumeric()
            || !key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    }) {
        return Err("同步通知无效。".into());
    }
    // This invalidates local views only. No content, credentials, or arbitrary
    // frontend events can pass through the synchronization notification.
    Ok(json!({"work_keys": keys, "planning": planning}))
}

pub(crate) async fn notify(app: &tauri::AppHandle, args: &Value) -> Result<Value, String> {
    use tauri::Emitter;
    let payload = update_payload(args)?;
    let _guard = device_sessions::ACCOUNT_LOCK.lock().await;
    bound_token(args["binding"].as_str().ok_or("缺少账号绑定。")?)?;
    app.emit("mona-cloud-updated", payload).map_err(|_| "界面尚未刷新，请重新打开相应页面。")?;
    Ok(json!({"emitted": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sync_notifications_carry_only_bounded_view_invalidations() {
        let data = update_payload(&json!({"binding": "private", "work_keys": ["websocket:one"],
            "planning": true, "access_token": "private", "content": "private"})).unwrap();
        assert_eq!(data, json!({"work_keys": ["websocket:one"], "planning": true}));
        for key in ["development:one", "websocket:../x", "websocket:", "websocket:/x"] {
            assert!(update_payload(&json!({"work_keys": [key], "planning": false})).is_err());
        }
        assert!(update_payload(&json!({"work_keys": [], "planning": "true"})).is_err());
        assert!(update_payload(&json!({"work_keys": vec!["websocket:a"; 101], "planning": false})).is_err());
    }

    #[test]
    fn only_bounded_cloud_control_routes_are_allowed() {
        assert!(route_allowed("GET", "/space"));
        assert!(route_allowed("GET", "/changes?after=1&limit=10"));
        assert!(route_allowed("POST", &format!("/objects/{}/download", "a".repeat(64))));
        for path in ["https://other.invalid", "/../admin", "/space?x=1", "/changes?limit=1&limit=2", "/changes#x", "/objects/a/download"] {
            assert!(!route_allowed("GET", path), "{path}");
        }
        assert!(!route_allowed("DELETE", "/space"));
        assert!(!route_allowed("POST", "/space?after=1"));
    }
}
