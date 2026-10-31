use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::{Notify, RwLock};
use tokio_util::sync::CancellationToken;

pub async fn wait_until_ready(
    cancel: &CancellationToken,
    paused: &AtomicBool,
    resume: &Notify,
) -> bool {
    while paused.load(Ordering::Relaxed) {
        tokio::select! {
            _ = cancel.cancelled() => return false,
            _ = resume.notified() => {},
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {},
        }
    }
    !cancel.is_cancelled()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchTransferStatus {
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
}

impl Clone for BatchTransferManager {
    fn clone(&self) -> Self {
        Self {
            active_transfers: self.active_transfers.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn cancellation_ends_a_paused_transfer() {
        let cancel = CancellationToken::new();
        let paused = AtomicBool::new(true);
        let resume = Notify::new();
        let wait = super::wait_until_ready(&cancel, &paused, &resume);
        tokio::pin!(wait);

        tokio::select! {
            _ = &mut wait => panic!("paused transfer must wait for cancellation or resume"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {},
        }
        cancel.cancel();
        let ready = tokio::time::timeout(Duration::from_secs(2), &mut wait)
            .await
            .expect("cancellation should end the paused wait promptly");
        assert!(!ready);
        assert!(paused.load(Ordering::Relaxed));
    }
}
