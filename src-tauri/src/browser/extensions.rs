use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(serde::Serialize)]
pub struct BrowserExtension {
    id: String,
    name: String,
    enabled: bool,
}

fn is_runtime_extension(id: &str) -> bool {
    // WebView2 includes these platform components in GetBrowserExtensions.
    matches!(id, "dgiklkfkllikcanfonkcabmbdfmgleag" | "mhjfbmdgcfjbbpaeojofohoefgiehjai")
}

fn extension_directory(path: &str) -> Result<PathBuf, String> {
    let root = Path::new(path).canonicalize().map_err(|e| format!("无法读取扩展目录：{e}"))?;
    if !root.is_dir() { return Err("请选择扩展目录".into()); }
    let manifest = root.join("manifest.json").canonicalize().map_err(|e| format!("未找到 manifest.json：{e}"))?;
    if !manifest.starts_with(&root) { return Err("扩展清单不在所选目录内".into()); }
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(manifest).map_err(|e| e.to_string())?)
        .map_err(|e| format!("扩展清单无效：{e}"))?;
    if !matches!(value["manifest_version"].as_u64(), Some(2 | 3)) || value["name"].as_str().is_none() {
        return Err("扩展清单缺少名称或有效版本".into());
    }
    Ok(root)
}

#[tauri::command]
pub async fn browser_extensions(
    app: tauri::AppHandle, webview: tauri::Webview, id: String, action: String,
    path: Option<String>, extension_id: Option<String>, enabled: Option<bool>,
) -> Result<Vec<BrowserExtension>, String> {
    if webview.label() != "main" { return Err("此页面不能管理扩展".into()); }
    if !matches!(action.as_str(), "list" | "install" | "enable" | "remove") { return Err("未知扩展操作".into()); }
    let directory = if action == "install" { Some(extension_directory(path.as_deref().ok_or("请选择扩展目录")?)?) } else { None };
    if matches!(action.as_str(), "enable" | "remove") && extension_id.as_deref().unwrap_or("").is_empty() { return Err("缺少扩展标识".into()); }
    if action == "enable" && enabled.is_none() { return Err("缺少启用状态".into()); }
    if extension_id.as_deref().is_some_and(is_runtime_extension) { return Err("不能修改浏览器内置组件".into()); }
    if app.state::<super::BrowserState>().list_tabs().iter().any(|tab| tab.id == id && tab.is_incognito) {
        return Err("请在普通浏览器标签页管理扩展".into());
    }
    #[cfg(target_os = "windows")]
    { native::run(&app, &id, action, directory, extension_id, enabled).await }
    #[cfg(not(target_os = "windows"))]
    { let _ = (app, id, directory, extension_id, enabled); Err("当前系统暂不支持浏览器扩展".into()) }
}

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use std::sync::{Arc, Mutex};
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_13, ICoreWebView2Profile7, ICoreWebView2BrowserExtension};
    use webview2_com::{ProfileGetBrowserExtensionsCompletedHandler, ProfileAddBrowserExtensionCompletedHandler, BrowserExtensionEnableCompletedHandler, BrowserExtensionRemoveCompletedHandler};
    use windows::core::{Interface, HSTRING, PWSTR, BOOL};

    type Reply = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<Vec<BrowserExtension>, String>>>>>;
    fn reply(tx: &Reply, result: Result<Vec<BrowserExtension>, String>) {
        if let Some(sender) = tx.lock().expect("extension reply lock").take() { let _ = sender.send(result); }
    }
    unsafe fn text(get: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>) -> windows::core::Result<String> {
        let mut value = PWSTR::null();
        get(&mut value)?;
        let result = value.to_string();
        windows::Win32::System::Com::CoTaskMemFree(Some(value.as_ptr().cast()));
        Ok(result?)
    }
    unsafe fn info(extension: &ICoreWebView2BrowserExtension) -> windows::core::Result<BrowserExtension> {
        let mut enabled = BOOL::default();
        extension.IsEnabled(&mut enabled)?;
        Ok(BrowserExtension { id: text(|p| extension.Id(p))?, name: text(|p| extension.Name(p))?, enabled: enabled.as_bool() })
    }
    pub async fn run(app: &tauri::AppHandle, id: &str, action: String, directory: Option<PathBuf>, extension_id: Option<String>, enabled: Option<bool>) -> Result<Vec<BrowserExtension>, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx: Reply = Arc::new(Mutex::new(Some(tx)));
        super::super::get_browser_webview(app, id)?.with_webview(move |wv| {
            let execute = || -> windows::core::Result<()> { unsafe {
                let profile: ICoreWebView2Profile7 = wv.controller().CoreWebView2()?.cast::<ICoreWebView2_13>()?.Profile()?.cast()?;
                if let Some(path) = directory {
                    let result_tx = tx.clone();
                    let handler = ProfileAddBrowserExtensionCompletedHandler::create(Box::new(move |status, extension| {
                        let result = status.and_then(|_| extension.as_ref().ok_or_else(|| windows::core::Error::from_hresult(windows::core::HRESULT(0x80004005_u32 as i32))))
                            .and_then(|extension| info(extension)).map(|item| vec![item]).map_err(|e| e.to_string());
                        reply(&result_tx, result); Ok(())
                    }));
                    return profile.AddBrowserExtension(&HSTRING::from(path.to_string_lossy().as_ref()), &handler);
                }
                let result_tx = tx.clone();
                let handler = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |status, extensions| {
                    let apply = || -> windows::core::Result<()> {
                        status?;
                        let list = extensions.ok_or_else(|| windows::core::Error::from_hresult(windows::core::HRESULT(0x80004005_u32 as i32)))?;
                        let mut count = 0; list.Count(&mut count)?;
                        let mut rows = Vec::new();
                        for index in 0..count {
                            let extension = list.GetValueAtIndex(index)?;
                            let row = info(&extension)?;
                            if is_runtime_extension(&row.id) { continue; }
                            if action != "list" && Some(&row.id) == extension_id.as_ref() {
                                let operation_tx = result_tx.clone();
                                if action == "enable" {
                                    let handler = BrowserExtensionEnableCompletedHandler::create(Box::new(move |status| {
                                        reply(&operation_tx, status.map(|_| Vec::new()).map_err(|e| e.to_string())); Ok(())
                                    }));
                                    extension.Enable(enabled.unwrap_or(false), &handler)?;
                                } else {
                                    let handler = BrowserExtensionRemoveCompletedHandler::create(Box::new(move |status| {
                                        reply(&operation_tx, status.map(|_| Vec::new()).map_err(|e| e.to_string())); Ok(())
                                    }));
                                    extension.Remove(&handler)?;
                                }
                                return Ok(());
                            }
                            rows.push(row);
                        }
                        reply(&result_tx, if action == "list" { Ok(rows) } else { Err("扩展不存在，请刷新列表".into()) });
                        Ok(())
                    };
                    if let Err(error) = apply() { reply(&result_tx, Err(error.to_string())); }
                    Ok(())
                }));
                profile.GetBrowserExtensions(&handler)
            }};
            if let Err(error) = execute() { reply(&tx, Err(format!("扩展操作失败：{error}"))); }
        }).map_err(|e| e.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(30), rx).await
            .map_err(|_| "扩展操作结果未确认，请刷新列表核对".to_string())?
            .map_err(|_| "扩展操作已中断".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_real_directory_and_manifest() {
        let dir = tempfile::tempdir().unwrap();
        assert!(extension_directory(dir.path().to_str().unwrap()).is_err());
        std::fs::write(dir.path().join("manifest.json"), r#"{"name":"Test","manifest_version":3,"version":"1.0"}"#).unwrap();
        assert_eq!(extension_directory(dir.path().to_str().unwrap()).unwrap(), dir.path().canonicalize().unwrap());
        std::fs::write(dir.path().join("manifest.json"), "{}").unwrap();
        assert!(extension_directory(dir.path().to_str().unwrap()).is_err());
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "extensions_native_tests.rs"]
mod native_tests;
