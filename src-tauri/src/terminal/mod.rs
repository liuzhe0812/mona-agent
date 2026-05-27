pub mod approval;
pub mod commands;
pub mod config;
pub mod credential_store;
pub mod desktop;
pub mod error;
pub mod session;
pub mod shell;
pub mod ssh;
pub mod sftp;

use approval::ApprovalState;
use sftp::batch::BatchTransferManager;
use session::SessionManager;
use ssh::known_hosts::KnownHostsStore;
use std::sync::Arc;

#[derive(Clone)]
pub struct TerminalState {
    pub manager: SessionManager,
    pub known_hosts: Arc<KnownHostsStore>,
    pub approval: ApprovalState,
    pub batch_transfer: BatchTransferManager,
}

impl TerminalState {
    pub fn new() -> Self {
        let known_hosts = Arc::new(
            KnownHostsStore::new()
                .and_then(|kh| {
                    kh.load().ok();
                    Ok(kh)
                })
                .unwrap_or_else(|_| KnownHostsStore::new_in_memory()),
        );
        Self {
            manager: SessionManager::new(32),
            known_hosts,
            approval: ApprovalState::new(),
            batch_transfer: BatchTransferManager::new(),
        }
    }

    pub fn shared() -> Arc<Self> {
        Arc::new(Self::new())
    }
}
