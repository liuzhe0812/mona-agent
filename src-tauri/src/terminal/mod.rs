pub mod approval;
pub mod commands;
pub mod config;
pub mod credential_store;
pub mod desktop;
pub mod error;
pub mod ide;
pub mod session;
pub mod shell;
pub mod sftp;
pub mod ssh;
pub mod vnc;

use approval::ApprovalState;
use sftp::batch::BatchTransferManager;
use session::SessionManager;
use ssh::known_hosts::KnownHostsStore;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct TerminalState {
    pub manager: SessionManager,
    pub known_hosts: Arc<KnownHostsStore>,
    pub approval: ApprovalState,
    pub batch_transfer: BatchTransferManager,
    pub transfer_cancels: Arc<RwLock<HashMap<String, CancellationToken>>>,
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
            transfer_cancels: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    }
