use serde::{Deserialize, Serialize};
use fs2::FileExt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarShortcuts {
    #[serde(default = "default_shortcut_mona")]
    pub mona: String,
    #[serde(default = "default_shortcut_note")]
    pub note: String,
    #[serde(default = "default_shortcut_ssh")]
    pub ssh: String,
    #[serde(default = "default_shortcut_email")]
    pub email: String,
    #[serde(default = "default_shortcut_schedule")]
    pub schedule: String,
    #[serde(default = "default_shortcut_db")]
    pub db: String,
}

fn default_shortcut_mona() -> String { "Alt+1".to_string() }
fn default_shortcut_note() -> String { "Alt+2".to_string() }
fn default_shortcut_ssh() -> String { "Alt+3".to_string() }
fn default_shortcut_email() -> String { "Alt+4".to_string() }
fn default_shortcut_schedule() -> String { "Alt+5".to_string() }
fn default_shortcut_db() -> String { "Alt+6".to_string() }

impl Default for SidebarShortcuts {
    fn default() -> Self {
        Self {
            mona: default_shortcut_mona(),
            note: default_shortcut_note(),
            ssh: default_shortcut_ssh(),
            email: default_shortcut_email(),
            schedule: default_shortcut_schedule(),
            db: default_shortcut_db(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidebarModuleConfig {
    pub key: String,
    pub visible: bool,
    pub order: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendMessageShortcut {
    Enter,
    CtrlEnter,
}

impl Default for SendMessageShortcut {
    fn default() -> Self {
        Self::Enter
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
    #[serde(default = "default_services_port")]
    pub services_port: u16,
    #[serde(default = "default_quick_ask_shortcut")]
    pub quick_ask_shortcut: String,
    #[serde(default = "default_quick_ask_mode")]
    pub quick_ask_mode: String,
    #[serde(default)]
    pub send_message_shortcut: SendMessageShortcut,
    #[serde(default)]
    pub sidebar_shortcuts: SidebarShortcuts,
    #[serde(default = "default_default_view")]
    pub default_view: String,
    #[serde(default = "default_sidebar_modules")]
    pub sidebar_modules: Vec<SidebarModuleConfig>,
    #[serde(default)]
    pub config_path: Option<String>,
    #[serde(default = "default_browser_automation_enabled")]
    pub browser_automation_enabled: bool,
    #[serde(default)]
    pub computer_use_enabled: bool,
}

fn default_default_view() -> String {
    "chat".to_string()
}

fn default_sidebar_modules() -> Vec<SidebarModuleConfig> {
    vec![
        SidebarModuleConfig { key: "chat".to_string(), visible: true, order: 0 },
        SidebarModuleConfig { key: "note".to_string(), visible: true, order: 1 },
        SidebarModuleConfig { key: "doc".to_string(), visible: true, order: 2 },
        SidebarModuleConfig { key: "email".to_string(), visible: true, order: 3 },
        SidebarModuleConfig { key: "schedule".to_string(), visible: true, order: 4 },
        SidebarModuleConfig { key: "ssh".to_string(), visible: true, order: 5 },
        SidebarModuleConfig { key: "db".to_string(), visible: true, order: 6 },
        SidebarModuleConfig { key: "system".to_string(), visible: true, order: 7 },
        SidebarModuleConfig { key: "profile".to_string(), visible: true, order: 8 },
        SidebarModuleConfig { key: "stock".to_string(), visible: true, order: 9 },
    ]
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
fn default_services_port() -> u16 {
    17174
}
fn default_quick_ask_shortcut() -> String {
    crate::quick_ask::DEFAULT_QUICK_ASK_SHORTCUT.to_string()
}
fn default_quick_ask_mode() -> String {
    "compact".to_string()
}
fn default_browser_automation_enabled() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            run_in_background: default_run_in_background(),
            auto_start_gateway: default_auto_start_gateway(),
            gateway_port: default_gateway_port(),
            services_port: default_services_port(),
            quick_ask_shortcut: default_quick_ask_shortcut(),
            quick_ask_mode: default_quick_ask_mode(),
            send_message_shortcut: SendMessageShortcut::default(),
            sidebar_shortcuts: SidebarShortcuts::default(),
            default_view: default_default_view(),
            sidebar_modules: default_sidebar_modules(),
            config_path: None,
            browser_automation_enabled: default_browser_automation_enabled(),
            computer_use_enabled: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_desktop_config_at, update_mona_config_at, AppSettings, SendMessageShortcut,
    };
    use std::fs;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn legacy_settings_default_to_enter_send() {
        let settings: AppSettings = serde_json::from_str("{}").unwrap();

        assert_eq!(settings.send_message_shortcut, SendMessageShortcut::Enter);
        assert_eq!(
            settings
                .sidebar_modules
                .iter()
                .map(|module| module.key.as_str())
                .collect::<Vec<_>>(),
            vec![
                "chat", "note", "doc", "email", "schedule", "ssh", "db", "system",
                "profile", "stock",
            ],
        );
        assert!(settings.browser_automation_enabled);
        assert!(!settings.computer_use_enabled);
    }

    #[test]
    fn ctrl_enter_send_round_trips() {
        let mut settings = AppSettings::default();
        settings.send_message_shortcut = SendMessageShortcut::CtrlEnter;

        let json = serde_json::to_string(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.send_message_shortcut, SendMessageShortcut::CtrlEnter);
    }

    #[test]
    fn invalid_send_shortcut_is_rejected() {
        let result = serde_json::from_str::<AppSettings>(
            r#"{"send_message_shortcut":"shift_enter"}"#,
        );

        assert!(result.is_err());
    }

    #[test]
    fn automation_settings_round_trip() {
        let settings = AppSettings {
            browser_automation_enabled: false,
            computer_use_enabled: true,
            ..AppSettings::default()
        };

        let json = serde_json::to_string(&settings).unwrap();
        let restored: AppSettings = serde_json::from_str(&json).unwrap();

        assert!(!restored.browser_automation_enabled);
        assert!(restored.computer_use_enabled);
    }

    #[test]
    fn ensure_desktop_config_preserves_model_settings_and_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        fs::write(
            &path,
            r#"{
  "agents": {"defaults": {"provider": "deepseek", "model": "deepseek-chat"}},
  "providers": {"deepseek": {"apiKey": "test-key"}},
  "tools": {"restrictToWorkspace": true}
}"#,
        )
        .unwrap();

        assert!(ensure_desktop_config_at(&path, 17173, 17174).unwrap());
        let first_write = fs::read(&path).unwrap();
        let config: serde_json::Value = serde_json::from_slice(&first_write).unwrap();
        assert_eq!(config["agents"]["defaults"]["model"], "deepseek-chat");
        assert_eq!(config["providers"]["deepseek"]["apiKey"], "test-key");
        assert_eq!(config["tools"]["restrictToWorkspace"], true);
        assert_eq!(config["gateway"]["port"], 17173);
        assert_eq!(config["services"]["port"], 17174);
        assert_eq!(config["channels"]["websocket"]["enabled"], true);

        assert!(!ensure_desktop_config_at(&path, 17173, 17174).unwrap());
        assert_eq!(fs::read(&path).unwrap(), first_write);
    }

    #[test]
    fn ensure_desktop_config_rejects_invalid_json_without_overwriting_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let invalid = br#"{"providers":"#;
        fs::write(&path, invalid).unwrap();

        let error = ensure_desktop_config_at(&path, 17173, 17174).unwrap_err();

        assert!(error.contains("refusing to overwrite"));
        assert_eq!(fs::read(&path).unwrap(), invalid);
    }

    #[test]
    fn config_updates_are_serialized_without_losing_sections() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        fs::write(&path, "{}").unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();

        let first_path = path.clone();
        let first = thread::spawn(move || {
            update_mona_config_at(&first_path, |config| {
                entered_tx.send(()).unwrap();
                thread::sleep(Duration::from_millis(100));
                config
                    .as_object_mut()
                    .unwrap()
                    .insert("agents".to_string(), serde_json::json!({"defaults": {}}));
                Ok(())
            })
            .unwrap();
        });
        entered_rx.recv().unwrap();

        let second_path = path.clone();
        let second = thread::spawn(move || {
            update_mona_config_at(&second_path, |config| {
                config
                    .as_object_mut()
                    .unwrap()
                    .insert("providers".to_string(), serde_json::json!({}));
                Ok(())
            })
            .unwrap();
        });

        first.join().unwrap();
        second.join().unwrap();
        let config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(config.get("agents").is_some());
        assert!(config.get("providers").is_some());
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

fn config_lock_path(config_path: &Path) -> Result<PathBuf, String> {
    let file_name = config_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid config path")?;
    Ok(config_path.with_file_name(format!("{file_name}.lock")))
}

fn update_mona_config_at<F>(config_path: &Path, update: F) -> Result<bool, String>
where
    F: FnOnce(&mut serde_json::Value) -> Result<(), String>,
{
    let parent = config_path.parent().ok_or("Invalid config path")?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;

    let lock_path = config_lock_path(config_path)?;
    let mut lock_file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("Failed to open config lock: {e}"))?;
    if lock_file
        .metadata()
        .map_err(|e| format!("Failed to inspect config lock: {e}"))?
        .len()
        == 0
    {
        lock_file
            .write_all(&[0])
            .map_err(|e| format!("Failed to initialize config lock: {e}"))?;
        lock_file
            .sync_data()
            .map_err(|e| format!("Failed to sync config lock: {e}"))?;
    }
    lock_file
        .lock_exclusive()
        .map_err(|e| format!("Failed to lock config: {e}"))?;

    let mut config = if config_path.exists() {
        let content = fs::read_to_string(config_path)
            .map_err(|e| format!("Failed to read config: {e}"))?;
        serde_json::from_str(&content).map_err(|e| {
            format!("Failed to parse config; refusing to overwrite {config_path:?}: {e}")
        })?
    } else {
        serde_json::json!({})
    };
    if !config.is_object() {
        return Err("Config is not an object; refusing to overwrite it".to_string());
    }

    let original = config.clone();
    update(&mut config)?;
    if config == original {
        return Ok(false);
    }

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create temporary config: {e}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write temporary config: {e}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync temporary config: {e}"))?;
    temporary
        .persist(config_path)
        .map_err(|e| format!("Failed to replace config: {}", e.error))?;
    Ok(true)
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
    update_mona_config_at(&config_path, |config| {
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
        let obj = provider_obj
            .as_object_mut()
            .ok_or("provider is not an object")?;
        obj.insert("apiKey".to_string(), serde_json::json!(api_key));
        if let Some(base) = api_base {
            obj.insert("apiBase".to_string(), serde_json::json!(base));
        }

        providers.insert(provider.to_string(), provider_obj);
        Ok(())
    })?;

    log::debug!("Wrote provider config for {}", provider);
    Ok(())
}

pub fn write_mona_model_config(model: &str, provider: &str) -> Result<(), String> {
    let config_path = mona_config_path();
    update_mona_config_at(&config_path, |config| {
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
        Ok(())
    })?;

    log::debug!("Wrote model config: {} (provider: {})", model, provider);
    Ok(())
}

/// 读取 config.json 中 tools.emailIntel.schedule 字段。
/// 返回完整的 schedule 配置对象（camelCase 键），不存在时返回默认值。
pub fn read_email_schedule_config() -> serde_json::Value {
    let config_path = mona_config_path();
    let default = serde_json::json!({
        "enabled": false,
        "folders": [],
        "createMode": "confirm",
        "leadMinutes": 15,
        "skipSenders": [],
        "parseTimeoutSeconds": 30,
    });
    if !config_path.exists() {
        return default;
    }
    let content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return default,
    };
    let config: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return default,
    };
    config
        .get("tools")
        .and_then(|t| t.get("emailIntel"))
        .and_then(|e| e.get("schedule"))
        .cloned()
        .unwrap_or(default)
}

/// 写入 config.json 中 tools.emailIntel.schedule 字段。
/// 接收完整的 schedule 配置对象（camelCase 键），合并写入现有 config.json。
pub fn write_email_schedule_config(schedule: &serde_json::Value) -> Result<(), String> {
    let config_path = mona_config_path();
    update_mona_config_at(&config_path, |config| {
        let root = config.as_object_mut().ok_or("Config is not an object")?;
        let tools = root
            .entry("tools".to_string())
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("tools is not an object")?;
        let email_intel = tools
            .entry("emailIntel".to_string())
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("emailIntel is not an object")?;
        email_intel.insert("schedule".to_string(), schedule.clone());
        Ok(())
    })?;

    log::debug!("Wrote email schedule config");
    Ok(())
}

pub fn ensure_desktop_config(gateway_port: u16, services_port: u16) -> Result<(), String> {
    let config_path = mona_config_path();
    let changed = ensure_desktop_config_at(&config_path, gateway_port, services_port)?;
    if changed {
        log::info!(
            "Ensured desktop config: websocket enabled, gateway port {}, services port {}",
            gateway_port,
            services_port
        );
    }
    Ok(())
}

fn ensure_desktop_config_at(
    config_path: &Path,
    gateway_port: u16,
    services_port: u16,
) -> Result<bool, String> {
    update_mona_config_at(config_path, |config| {
        let root = config.as_object_mut().ok_or("Config is not an object")?;

        let gateway = root
            .entry("gateway")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("gateway is not an object")?;
        gateway.insert("port".to_string(), serde_json::json!(gateway_port));
        gateway.insert("host".to_string(), serde_json::json!("127.0.0.1"));

        let services = root
            .entry("services")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("services is not an object")?;
        services.insert("port".to_string(), serde_json::json!(services_port));

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
        Ok(())
    })
}

/// 写入 config.json 中 tools.imageGeneration 字段（enabled/provider/model）。
/// 仅写入非 None 的字段，已存在的其他字段（defaultAspectRatio 等）保留不变。
pub fn write_mona_image_gen_config(
    provider: &str,
    model: &str,
    enabled: Option<bool>,
) -> Result<(), String> {
    let config_path = mona_config_path();
    update_mona_config_at(&config_path, |config| {
        let image_gen = config
            .as_object_mut()
            .ok_or("Config is not an object")?
            .entry("tools".to_string())
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("tools is not an object")?
            .entry("imageGeneration".to_string())
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("imageGeneration is not an object")?;

        image_gen.insert("provider".to_string(), serde_json::json!(provider));
        image_gen.insert("model".to_string(), serde_json::json!(model));
        if let Some(enabled) = enabled {
            image_gen.insert("enabled".to_string(), serde_json::json!(enabled));
        }
        Ok(())
    })?;

    log::debug!("Wrote imageGeneration config: provider={}, model={}", provider, model);
    Ok(())
}

/// 写入 config.json 中 tools.videoGeneration 字段（enabled/provider/model）。
pub fn write_mona_video_gen_config(
    provider: &str,
    model: &str,
    enabled: Option<bool>,
) -> Result<(), String> {
    let config_path = mona_config_path();
    update_mona_config_at(&config_path, |config| {
        let video_gen = config
            .as_object_mut()
            .ok_or("Config is not an object")?
            .entry("tools".to_string())
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("tools is not an object")?
            .entry("videoGeneration".to_string())
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("videoGeneration is not an object")?;

        video_gen.insert("provider".to_string(), serde_json::json!(provider));
        video_gen.insert("model".to_string(), serde_json::json!(model));
        if let Some(enabled) = enabled {
            video_gen.insert("enabled".to_string(), serde_json::json!(enabled));
        }
        Ok(())
    })?;

    log::debug!("Wrote videoGeneration config: provider={}, model={}", provider, model);
    Ok(())
}
