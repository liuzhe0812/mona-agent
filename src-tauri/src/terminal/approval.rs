use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingCommand {
    pub request_id: String,
    pub session_id: String,
    pub command: String,
    pub source: String,
    /// Direct terminal requests execute after approval. Structured callers
    /// execute their own checked command and only need the verdict.
    pub execute_after_approval: bool,
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
        self.submit_with_mode(session_id, command, source, true)
            .await
    }

    pub async fn submit_deferred(
        &self,
        session_id: String,
        command: String,
        source: String,
    ) -> (PendingCommand, oneshot::Receiver<ApprovalVerdict>) {
        self.submit_with_mode(session_id, command, source, false)
            .await
    }

    async fn submit_with_mode(
        &self,
        session_id: String,
        command: String,
        source: String,
        execute_after_approval: bool,
    ) -> (PendingCommand, oneshot::Receiver<ApprovalVerdict>) {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();

        let pending_cmd = PendingCommand {
            request_id: request_id.clone(),
            session_id,
            command,
            source,
            execute_after_approval,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn distinguishes_direct_and_structured_approval_requests() {
        let manager = ApprovalManager::new();
        let (direct, _) = manager
            .submit("s1".into(), "echo direct".into(), "terminal".into())
            .await;
        let (deferred, _) = manager
            .submit_deferred("s1".into(), "echo checked".into(), "docker".into())
            .await;
        assert!(direct.execute_after_approval);
        assert!(!deferred.execute_after_approval);
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
