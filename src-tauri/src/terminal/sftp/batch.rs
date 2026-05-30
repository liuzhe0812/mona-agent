use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tokio::sync::{Notify, RwLock};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchTransferStatus {
    Pending,
    Connecting,
    Transferring,
    Completed,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferProgress {
    pub bytes_transferred: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTransferProgress {
    pub batch_id: String,
    pub session_id: String,
    pub host: String,
    pub status: BatchTransferStatus,
    pub current_file: Option<String>,
    pub files_completed: usize,
    pub files_total: usize,
    pub bytes_transferred: u64,
    pub bytes_total: u64,
    pub error: Option<String>,
    pub speed: Option<u64>,
    pub eta_seconds: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct BatchTransferTask {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub files: Vec<String>,
    pub remote_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct BatchTransferConfig {
    pub max_concurrent: usize,
    pub target_directory: String,
    pub overwrite: bool,
    pub retry_count: u32,
    pub retry_delay_ms: u64,
}

impl Default for BatchTransferConfig {
    fn default() -> Self {
        Self {
            max_concurrent: 3,
            target_directory: "/tmp".to_string(),
            overwrite: false,
            retry_count: 2,
            retry_delay_ms: 1000,
        }
    }
}

pub struct BatchTransferControl {
    pub cancel_token: CancellationToken,
    pub is_paused: Arc<AtomicBool>,
    pub resume_notify: Arc<Notify>,
}

pub struct BatchTransferManager {
    pub active_transfers: Arc<RwLock<HashMap<String, BatchTransferControl>>>,
}

impl BatchTransferManager {
    pub fn new() -> Self {
        Self {
            active_transfers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn cancel_batch(&self, batch_id: &str) -> Result<(), String> {
        let transfers = self.active_transfers.read().await;
        if let Some(control) = transfers.get(batch_id) {
            control.cancel_token.cancel();
        }
        Ok(())
    }

    pub async fn pause_batch(&self, batch_id: &str) -> Result<(), String> {
        let transfers = self.active_transfers.read().await;
        if let Some(control) = transfers.get(batch_id) {
            control.is_paused.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    pub async fn resume_batch(&self, batch_id: &str) -> Result<(), String> {
        let transfers = self.active_transfers.read().await;
        if let Some(control) = transfers.get(batch_id) {
            control.is_paused.store(false, Ordering::Relaxed);
            control.resume_notify.notify_waiters();
        }
        Ok(())
    }

    pub async fn is_active(&self, batch_id: &str) -> bool {
        let transfers = self.active_transfers.read().await;
        transfers.contains_key(batch_id)
    }
}

impl Clone for BatchTransferManager {
    fn clone(&self) -> Self {
        Self {
            active_transfers: self.active_transfers.clone(),
        }
    }
}
