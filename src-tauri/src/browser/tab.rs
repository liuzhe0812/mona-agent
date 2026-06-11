use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserTab {
    pub id: String,
    pub title: String,
    pub url: String,
    pub cdp_port: u16,
    pub webview_label: String,
    pub is_ai_controlled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTabResult {
    pub id: String,
    pub cdp_port: u16,
}
