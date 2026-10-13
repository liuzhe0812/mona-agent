//! Only explicit UI preferences are portable. Paths, security and credentials stay local.
use super::{AppSettings, update_mona_config_at};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

const MODULES: &[&str] = &["chat", "development", "note", "doc", "email", "schedule", "ssh", "db", "system", "profile", "stock", "settings"];

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Module { key: String, visible: bool, order: u32 }

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preferences {
    send_message_shortcut: String,
    default_view: String,
    quick_ask_mode: String,
    sidebar_modules: Vec<Module>,
}

fn data(settings: &AppSettings) -> Result<Value, String> {
    let raw = serde_json::to_value(settings).map_err(|_| "使用偏好无法读取。")?;
    let value = json!({"send_message_shortcut": raw["send_message_shortcut"],
        "default_view": raw["default_view"], "quick_ask_mode": raw["quick_ask_mode"],
        "sidebar_modules": raw["sidebar_modules"]});
    validate(&value)?;
    Ok(value)
}

fn validate(value: &Value) -> Result<(), String> {
    let preferences: Preferences = serde_json::from_value(value.clone())
        .map_err(|_| "同步内容包含不支持的使用偏好，未修改本机设置。")?;
    let mut seen = std::collections::HashSet::new();
    if !matches!(preferences.send_message_shortcut.as_str(), "enter" | "ctrl_enter")
        || !matches!(preferences.quick_ask_mode.as_str(), "compact" | "full")
        || !MODULES.contains(&preferences.default_view.as_str())
        || preferences.sidebar_modules.len() > MODULES.len()
        || preferences.sidebar_modules.iter().any(|module| !MODULES.contains(&module.key.as_str())
            || module.order > 64 || !seen.insert(module.key.as_str())) {
        return Err("使用偏好格式无效，未修改本机设置。".into());
    }
    Ok(())
}

fn fingerprint(value: &Value) -> Result<String, String> {
    serde_json::to_vec(value).map(|bytes| hex::encode(Sha256::digest(bytes)))
        .map_err(|_| "使用偏好无法核对。".into())
}

pub(super) fn revision(settings: &AppSettings) -> Result<String, String> {
    fingerprint(&data(settings)?)
}

fn read_at(path: &Path) -> Result<AppSettings, String> {
    if !path.exists() { return Ok(AppSettings::default()); }
    let meta = fs::symlink_metadata(path).map_err(|_| "本机设置暂时无法读取。")?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > 1024 * 1024 {
        return Err("本机设置文件异常，未同步。".into());
    }
    let bytes = fs::read(path).map_err(|_| "本机设置暂时无法读取。")?;
    serde_json::from_slice(&bytes).map_err(|_| "本机设置格式异常，未用默认值覆盖。".into())
}

pub(super) fn save_at(path: &Path, settings: &AppSettings) -> Result<(), String> {
    let desired = data(settings)?;
    read_at(path)?;
    update_mona_config_at(path, |document| {
        let current: AppSettings = serde_json::from_value(document.clone()).map_err(|_| "本机设置格式异常。")?;
        let before = data(&current)?;
        if desired != before && settings.preferences_revision.as_deref() != Some(fingerprint(&before)?.as_str()) {
            return Err("使用偏好已在其他窗口或设备更新。请重新打开设置后再保存，当前修改尚未写入。".into());
        }
        let mut value = serde_json::to_value(settings).map_err(|_| "本机设置无法保存。")?;
        value.as_object_mut().unwrap().remove("preferences_revision");
        document.as_object_mut().unwrap().extend(value.as_object().unwrap().clone());
        document.as_object_mut().unwrap().remove("preferences_revision");
        Ok(())
    })?;
    Ok(())
}

pub(crate) fn request(args: &Value) -> Result<Value, String> {
    request_at(&super::settings_path(), args)
}

fn request_at(path: &Path, args: &Value) -> Result<Value, String> {
    match args["action"].as_str() {
        Some("read") => {
            let value = data(&read_at(path)?)?;
            Ok(json!({"fingerprint": fingerprint(&value)?, "data": value}))
        }
        Some("apply") => {
            let expected = args["expected"].as_str().filter(|v| v.len() == 64
                && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
                .ok_or("使用偏好版本无效。")?;
            let desired = &args["data"];
            validate(desired)?;
            read_at(path)?;
            let changed = update_mona_config_at(path, |document| {
                let settings: AppSettings = serde_json::from_value(document.clone()).map_err(|_| "本机设置格式异常。")?;
                let before = data(&settings)?;
                if &before == desired { return Ok(()); }
                if fingerprint(&before)? != expected {
                    return Err("使用偏好已在本机更新，已保留修改，稍后重新同步。".into());
                }
                document.as_object_mut().unwrap().extend(desired.as_object().unwrap().clone());
                Ok(())
            })?;
            Ok(json!({"applied": true, "reused": !changed, "fingerprint": fingerprint(desired)?, "data": desired}))
        }
        _ => Err("不支持的使用偏好同步操作。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_fingerprint_matches_the_python_wire_contract() {
        let value = json!({"send_message_shortcut":"enter", "default_view":"chat", "quick_ask_mode":"compact",
            "sidebar_modules":[{"visible":true,"order":0,"key":"chat"}]});
        validate(&value).unwrap();
        assert_eq!(fingerprint(&value).unwrap(), "5cc44cf64fd96afa6891e64ab67416f00535ec141d3382288298372ba59dca95");
    }

    #[test]
    fn cloud_projection_contains_only_four_explicit_preferences() {
        let settings = AppSettings { config_path: Some("local-only-config".into()), computer_use_enabled: true,
            ..AppSettings::default() };
        let value = data(&settings).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert!(value.get("config_path").is_none());
        assert!(value.get("computer_use_enabled").is_none());
        let mut forbidden = value.clone(); forbidden["computer_use_enabled"] = json!(true);
        assert!(validate(&forbidden).is_err());
    }

    #[test]
    fn remote_patch_preserves_local_authority_and_unknown_settings() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"config_path":"local-only","gateway_port":18000,"computer_use_enabled":false,"future_key":7}"#).unwrap();
        let first = request_at(&path, &json!({"action":"read"})).unwrap();
        let mut next = first["data"].clone(); next["send_message_shortcut"] = json!("ctrl_enter");
        let reply = request_at(&path, &json!({"action":"apply","expected":first["fingerprint"],"data":next})).unwrap();
        assert_eq!(reply["applied"], true);
        let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["gateway_port"], 18000); assert_eq!(stored["computer_use_enabled"], false);
        assert_eq!(stored["config_path"], "local-only"); assert_eq!(stored["future_key"], 7);
        assert!(stored.get("preferences_revision").is_none());
    }

    #[test]
    fn stale_remote_and_local_saves_never_overwrite_recent_preferences() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("settings.json");
        let initial = request_at(&path, &json!({"action":"read"})).unwrap();
        let mut old = AppSettings::default(); old.preferences_revision = Some(initial["fingerprint"].as_str().unwrap().into());
        let mut next = initial["data"].clone(); next["send_message_shortcut"] = json!("ctrl_enter");
        let apply = json!({"action":"apply","expected":initial["fingerprint"],"data":next});
        assert_eq!(request_at(&path, &apply).unwrap()["reused"], false);
        assert_eq!(request_at(&path, &apply).unwrap()["reused"], true);
        old.quick_ask_mode = "full".into();
        assert!(save_at(&path, &old).is_err());
        let different = json!({"action":"apply","expected":initial["fingerprint"],"data":data(&old).unwrap()});
        assert!(request_at(&path, &different).is_err());
        assert_eq!(read_at(&path).unwrap().send_message_shortcut, super::super::SendMessageShortcut::CtrlEnter);
    }

    #[test]
    fn corrupt_settings_cannot_become_default_cloud_values() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("settings.json");
        fs::write(&path, b"{broken").unwrap();
        assert!(request_at(&path, &json!({"action":"read"})).is_err());
        assert!(save_at(&path, &AppSettings::default()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
    }

    #[test]
    fn unknown_modules_and_invalid_modes_are_rejected() {
        let baseline = data(&AppSettings::default()).unwrap();
        for (field, value) in [("default_view", json!("run_command")), ("quick_ask_mode", json!("command")),
            ("send_message_shortcut", json!("shift_enter")), ("sidebar_modules", json!([{"key":"run", "visible":true,"order":0}]))] {
            let mut changed = baseline.clone(); changed[field] = value; assert!(validate(&changed).is_err());
        }
    }
}
