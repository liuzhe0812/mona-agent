use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingCommand {
    pub request_id: String,
    pub session_id: String,
    pub command: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApprovalVerdict {
    Approved,
    Rejected { reason: String },
}

struct PendingEntry {
    command: PendingCommand,
    tx: oneshot::Sender<ApprovalVerdict>,
}

pub struct ApprovalManager {
    pending: Mutex<HashMap<String, PendingEntry>>,
}

impl ApprovalManager {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub async fn submit(
        &self,
        session_id: String,
        command: String,
        source: String,
    ) -> (PendingCommand, oneshot::Receiver<ApprovalVerdict>) {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        let pending_cmd = PendingCommand {
            request_id: request_id.clone(),
            session_id,
            command,
            source,
        };

        let entry = PendingEntry {
            command: pending_cmd.clone(),
            tx,
        };

        self.pending.lock().await.insert(request_id, entry);
        (pending_cmd, rx)
    }

    pub async fn respond(
        &self,
        request_id: &str,
        verdict: ApprovalVerdict,
    ) -> Result<PendingCommand, String> {
        let mut pending = self.pending.lock().await;
        let entry = pending
            .remove(request_id)
            .ok_or_else(|| format!("Request {} not found", request_id))?;
        let _ = entry.tx.send(verdict);
        Ok(entry.command)
    }

    pub async fn list_pending(&self) -> Vec<PendingCommand> {
        let pending = self.pending.lock().await;
        pending.values().map(|e| e.command.clone()).collect()
    }

}

#[derive(Clone)]
pub struct ApprovalState {
    pub manager: Arc<ApprovalManager>,
}

impl ApprovalState {
    pub fn new() -> Self {
        Self {
            manager: Arc::new(ApprovalManager::new()),
        }
    }
}
