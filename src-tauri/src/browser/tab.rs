use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserTab {
    pub id: String,
    pub title: String,
    pub url: String,
    pub cdp_port: u16,
    pub webview_label: String,
    pub is_ai_controlled: bool,
    #[serde(default = "default_zoom")]
    pub zoom_factor: f64,
    #[serde(default)]
    pub is_incognito: bool,
    #[serde(default = "default_false")]
    pub is_muted: bool,
}

fn default_zoom() -> f64 {
    1.0
}

fn default_false() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTabResult {
    pub id: String,
    pub cdp_port: u16,
}
