use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub root_path: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FileCheckResult {
    Editable { size: u64, mtime: u64 },
    TooLarge { size: u64, limit: u64 },
    Binary,
    NotEditable { reason: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentResult {
    pub content: String,
    pub mtime: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime: u64,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}
