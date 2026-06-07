use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarShortcuts {
    #[serde(default = "default_shortcut_mona")]
    pub mona: String,
    #[serde(default = "default_shortcut_note")]
    pub note: String,
    #[serde(default = "default_shortcut_ssh")]
    pub ssh: String,
    #[serde(default = "default_shortcut_db")]
    pub db: String,
    #[serde(default = "default_shortcut_kb")]
    pub kb: String,
    #[serde(default = "default_shortcut_ppt")]
    pub ppt: String,
}

fn default_shortcut_mona() -> String { "Alt+1".to_string() }
fn default_shortcut_note() -> String { "Alt+2".to_string() }
fn default_shortcut_ssh() -> String { "Alt+3".to_string() }
fn default_shortcut_db() -> String { "Alt+4".to_string() }
fn default_shortcut_kb() -> String { "Alt+5".to_string() }
fn default_shortcut_ppt() -> String { "Alt+6".to_string() }

impl Default for SidebarShortcuts {
    fn default() -> Self {
        Self {
            mona: default_shortcut_mona(),
            note: default_shortcut_note(),
            ssh: default_shortcut_ssh(),
            db: default_shortcut_db(),
            kb: default_shortcut_kb(),
            ppt: default_shortcut_ppt(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default = "default_run_in_background")]
    pub run_in_background: bool,
    #[serde(default = "default_auto_start_gateway")]
    pub auto_start_gateway: bool,
    #[serde(default = "default_gateway_port")]
    pub gateway_port: u16,
    #[serde(default = "default_quick_ask_shortcut")]
    pub quick_ask_shortcut: String,
    #[serde(default)]
    pub sidebar_shortcuts: SidebarShortcuts,
    #[serde(default)]
    pub config_path: Option<String>,
}

fn default_run_in_background() -> bool {
    true
}
fn default_auto_start_gateway() -> bool {
    true
}
fn default_gateway_port() -> u16 {
    17173
}
fn default_quick_ask_shortcut() -> String {
    crate::quick_ask::DEFAULT_QUICK_ASK_SHORTCUT.to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            run_in_background: default_run_in_background(),
            auto_start_gateway: default_auto_start_gateway(),
            gateway_port: default_gateway_port(),
            quick_ask_shortcut: default_quick_ask_shortcut(),
            sidebar_shortcuts: SidebarShortcuts::default(),
            config_path: None,
        }
    }
}

pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("mona")
}

pub fn settings_path() -> PathBuf {
    app_data_dir().join(SETTINGS_FILE)
}

pub fn load_settings() -> AppSettings {
    let path = settings_path();
    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(settings) => return settings,
                Err(e) => {
                    log::warn!("Failed to parse settings: {}", e);
                }
            },
            Err(e) => {
                log::warn!("Failed to read settings: {}", e);
            }
        }
    }
    AppSettings::default()
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let dir = app_data_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create settings dir: {}", e))?;
    let content =
        serde_json::to_string_pretty(settings).map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(settings_path(), content).map_err(|e| format!("Failed to write settings: {}", e))
}

pub fn mona_config_path() -> PathBuf {
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        PathBuf::from(home).join(".mona").join("config.json")
    } else {
        app_data_dir().join("config.json")
    }
}

pub fn read_mona_ws_port() -> u16 {
    let config_path = mona_config_path();
    if !config_path.exists() {
        return 8765;
    }
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return 8765,
    };
    let config: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return 8765,
    };
    config
        .get("channels")
        .and_then(|c| c.get("websocket"))
        .and_then(|ws| ws.get("port"))
        .and_then(|p| p.as_u64())
        .unwrap_or(8765) as u16
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonaConfigStatus {
    pub config_exists: bool,
    pub has_provider: bool,
    pub provider_name: Option<String>,
}

pub fn check_mona_config() -> MonaConfigStatus {
    let config_path = mona_config_path();
    if !config_path.exists() {
        return MonaConfigStatus {
            config_exists: false,
            has_provider: false,
            provider_name: None,
        };
    }

    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => {
            return MonaConfigStatus {
                config_exists: true,
                has_provider: false,
                provider_name: None,
            }
        }
    };

    let config: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => {
            return MonaConfigStatus {
                config_exists: true,
                has_provider: false,
                provider_name: None,
            }
        }
    };

    let providers = match config.get("providers").and_then(|p| p.as_object()) {
        Some(p) => p,
        None => {
            return MonaConfigStatus {
                config_exists: true,
                has_provider: false,
                provider_name: None,
            }
        }
    };

    for (name, value) in providers {
        if let Some(obj) = value.as_object() {
            if let Some(api_key) = obj.get("apiKey").and_then(|k| k.as_str()) {
                if !api_key.is_empty() {
                    return MonaConfigStatus {
                        config_exists: true,
                        has_provider: true,
                        provider_name: Some(name.clone()),
                    };
                }
            }
            if let Some(api_key) = obj.get("api_key").and_then(|k| k.as_str()) {
                if !api_key.is_empty() {
                    return MonaConfigStatus {
                        config_exists: true,
                        has_provider: true,
                        provider_name: Some(name.clone()),
                    };
                }
            }
        }
    }

    MonaConfigStatus {
        config_exists: true,
        has_provider: false,
        provider_name: None,
    }
}

pub fn write_mona_provider_config(
    provider: &str,
    api_key: &str,
    api_base: Option<&str>,
) -> Result<(), String> {
    let config_path = mona_config_path();
    let parent = config_path.parent().ok_or("Invalid config path")?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let mut config: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let providers = config
        .as_object_mut()
        .ok_or("Config is not an object")?
        .entry("providers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("providers is not an object")?;

    let mut provider_obj = serde_json::json!({});
    if let Some(existing) = providers.get(provider) {
        if let Some(obj) = existing.as_object() {
            provider_obj = serde_json::Value::Object(obj.clone());
        }
    }
    let obj = provider_obj.as_object_mut().ok_or("provider is not an object")?;
    obj.insert("apiKey".to_string(), serde_json::json!(api_key));
    if let Some(base) = api_base {
        obj.insert("apiBase".to_string(), serde_json::json!(base));
    }

    providers.insert(provider.to_string(), provider_obj);

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, content).map_err(|e| format!("Failed to write config: {}", e))?;

    log::info!("Wrote provider config for {}", provider);
    Ok(())
}

pub fn write_mona_model_config(model: &str, provider: &str) -> Result<(), String> {
    let config_path = mona_config_path();
    let parent = config_path.parent().ok_or("Invalid config path")?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let mut config: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let root = config.as_object_mut().ok_or("Config is not an object")?;

    let agents = root
        .entry("agents")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("agents is not an object")?;

    let defaults = agents
        .entry("defaults")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("defaults is not an object")?;

    defaults.insert("model".to_string(), serde_json::json!(model));
    defaults.insert("provider".to_string(), serde_json::json!(provider));

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, content).map_err(|e| format!("Failed to write config: {}", e))?;

    log::info!("Wrote model config: {} (provider: {})", model, provider);
    Ok(())
}

pub fn ensure_desktop_config(gateway_port: u16) -> Result<(), String> {
    let config_path = mona_config_path();
    let parent = config_path.parent().ok_or("Invalid config path")?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;

    let mut config: serde_json::Value = if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let root = config.as_object_mut().ok_or("Config is not an object")?;

    let gateway = root
        .entry("gateway")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("gateway is not an object")?;
    gateway.insert("port".to_string(), serde_json::json!(gateway_port));
    gateway.insert("host".to_string(), serde_json::json!("127.0.0.1"));

    let channels = root
        .entry("channels")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("channels is not an object")?;

    let websocket = channels
        .entry("websocket")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("websocket is not an object")?;
    websocket.insert("enabled".to_string(), serde_json::json!(true));
    websocket.insert("host".to_string(), serde_json::json!("127.0.0.1"));
    websocket
        .entry("allowFrom")
        .or_insert_with(|| serde_json::json!(["*"]));

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, content).map_err(|e| format!("Failed to write config: {}", e))?;

    log::info!("Ensured desktop config: websocket enabled, gateway port {}", gateway_port);
    Ok(())
}
