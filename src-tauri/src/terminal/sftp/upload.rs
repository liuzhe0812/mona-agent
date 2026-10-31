use std::path::{Path, PathBuf};

use crate::terminal::error::TerminalError;

pub struct UploadEntry {
    pub local_path: PathBuf,
    pub relative_path: String,
    pub is_dir: bool,
    pub size: u64,
}

pub async fn collect_upload_entries(files: &[String]) -> Result<Vec<UploadEntry>, TerminalError> {
    async fn walk(
        path: &Path,
        relative_path: String,
        root: &Path,
        ancestors: &mut Vec<PathBuf>,
        entries: &mut Vec<UploadEntry>,
    ) -> Result<(), TerminalError> {
        let resolved = tokio::fs::canonicalize(path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("无法读取本地路径 '{}': {}", path.display(), e))
        })?;
        if !resolved.starts_with(root) {
            return Err(TerminalError::SftpOperation(format!(
                "链接 '{}' 指向所选文件夹之外，已停止上传",
                path.display()
            )));
        }
        let metadata = tokio::fs::metadata(&resolved).await.map_err(|e| {
            TerminalError::SftpOperation(format!(
                "无法读取本地文件信息 '{}': {}",
                path.display(),
                e
            ))
        })?;
        if metadata.is_dir() && ancestors.contains(&resolved) {
            return Err(TerminalError::SftpOperation(format!(
                "链接 '{}' 指向上级文件夹，已停止循环上传",
                path.display()
            )));
        }
        if !metadata.is_dir() && !metadata.is_file() {
            return Err(TerminalError::SftpOperation(format!(
                "'{}' 不是可上传的文件或文件夹",
                path.display()
            )));
        }
        entries.push(UploadEntry {
            local_path: resolved.clone(),
            relative_path: relative_path.clone(),
            is_dir: metadata.is_dir(),
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
        });
        if metadata.is_dir() {
            ancestors.push(resolved.clone());
            let mut directory = tokio::fs::read_dir(&resolved).await.map_err(|e| {
                TerminalError::SftpOperation(format!(
                    "无法读取本地文件夹 '{}': {}",
                    path.display(),
                    e
                ))
            })?;
            while let Some(entry) = directory.next_entry().await.map_err(|e| {
                TerminalError::SftpOperation(format!(
                    "无法读取本地文件夹 '{}': {}",
                    path.display(),
                    e
                ))
            })? {
                let relative = format!("{}/{}", relative_path, entry.file_name().to_string_lossy());
                Box::pin(walk(&entry.path(), relative, root, ancestors, entries)).await?;
            }
            ancestors.pop();
        }
        Ok(())
    }

    let mut entries = Vec::new();
    for file in files {
        let path = Path::new(file);
        let name = path
            .file_name()
            .ok_or_else(|| TerminalError::SftpOperation("请选择要上传的文件或文件夹".into()))?;
        let root = tokio::fs::canonicalize(path).await.map_err(|e| {
            TerminalError::SftpOperation(format!("无法读取本地路径 '{}': {}", path.display(), e))
        })?;
        walk(
            path,
            name.to_string_lossy().into_owned(),
            &root,
            &mut Vec::new(),
            &mut entries,
        )
        .await?;
    }
    let mut targets = std::collections::HashSet::new();
    for entry in &entries {
        if !targets.insert(&entry.relative_path) {
            return Err(TerminalError::SftpOperation(format!(
                "多个上传来源对应同一远程路径 '{}'，请分开上传",
                entry.relative_path
            )));
        }
    }
    Ok(entries)
}

#[cfg(test)]
#[path = "upload_tests.rs"]
mod tests;
