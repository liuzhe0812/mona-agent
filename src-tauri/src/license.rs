use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const LICENSE_FILENAME: &str = "license.jwt";
const TRIAL_CACHE_FILENAME: &str = "trial_cache.json";
const AUTH_SERVER_URL: &str = "http://47.117.69.105:8000";
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

fn trial_cache_path() -> Result<PathBuf, String> {
    Ok(license_dir()?.join(TRIAL_CACHE_FILENAME))
}

#[derive(Debug, Serialize, Deserialize)]
struct TrialCache {
    active: bool,
    expires_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct TrialActivateResponse {
    active: bool,
    expires_at: Option<String>,
}

fn get_machine_fingerprint() -> String {
    let fingerprint = collect_fingerprint();
    let mut hasher = Sha256::new();
    hasher.update(fingerprint.as_bytes());
    hex::encode(hasher.finalize())
}

async fn activate_trial_server() -> Result<TrialActivateResponse, String> {
    let machine_fp = get_machine_fingerprint();
    let url = format!("{}/trial/activate", AUTH_SERVER_URL);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "machine_fingerprint": machine_fp }))
        .send()
        .await
        .map_err(|e| format!("Trial activation request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Trial activation server error: {}", resp.status()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Trial activation parse error: {}", e))?;

    let active = body.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
    let expires_at = body
        .get("expires_at")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(TrialActivateResponse { active, expires_at })
}

fn save_trial_cache(active: bool, expires_at: &str) {
    if let Ok(path) = trial_cache_path() {
        if let Ok(dir) = license_dir() {
            let _ = std::fs::create_dir_all(&dir);
        }
        let cache = TrialCache {
            active,
            expires_at: expires_at.to_string(),
        };
        if let Ok(json) = serde_json::to_string(&cache) {
            let _ = std::fs::write(&path, json);
        }
    }
}

fn load_trial_cache() -> Option<TrialCache> {
    let path = trial_cache_path().ok()?;
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

fn get_trial_status() -> (bool, String) {
    // Try to load from local cache first (used as fallback)
    if let Some(cache) = load_trial_cache() {
        return (cache.active, cache.expires_at);
    }
    (false, String::new())
}

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

#[tauri::command]
pub async fn check_license() -> Result<serde_json::Value, String> {
    let path = license_path()?;
    if !path.exists() {
        // No license file — check trial via server
        match activate_trial_server().await {
            Ok(resp) => {
                let expires_at = resp.expires_at.clone().unwrap_or_default();
                save_trial_cache(resp.active, &expires_at);
                if resp.active {
                    return Ok(serde_json::json!({
                        "status": "valid",
                        "expires_at": expires_at,
                        "trial": true
                    }));
                }
                return Ok(serde_json::json!({
                    "status": "expired",
                    "expires_at": expires_at,
                    "trial": true
                }));
            }
            Err(_) => {
                // Network error — fall back to local cache
                let (active, expires_at) = get_trial_status();
                if active {
                    return Ok(serde_json::json!({
                        "status": "valid",
                        "expires_at": expires_at,
                        "trial": true
                    }));
                }
                if !expires_at.is_empty() {
                    return Ok(serde_json::json!({
                        "status": "expired",
                        "expires_at": expires_at,
                        "trial": true
                    }));
                }
                // No cache at all — grant local temporary trial,
                // will be synced with server on next successful connection
                let now = chrono::Utc::now();
                let trial_end = now + chrono::Duration::days(TRIAL_DAYS);
                let expires_at_str = trial_end.format("%Y-%m-%d").to_string();
                save_trial_cache(true, &expires_at_str);
                return Ok(serde_json::json!({
                    "status": "valid",
                    "expires_at": expires_at_str,
                    "trial": true
                }));
            }
        }
    }

    let token = std::fs::read_to_string(&path)
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
    #[cfg(not(windows))]
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
    #[cfg(not(windows))]
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
