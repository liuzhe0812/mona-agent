pub mod approval;
pub mod commands;
pub mod config;
pub mod credential_store;
pub mod desktop;
pub mod docker;
pub mod error;
pub mod ide;
pub mod maintenance;
pub mod maintenance_cmds;
pub mod session;
pub mod sftp;
pub mod shell;
pub mod ssh;
pub mod vnc;

use approval::ApprovalState;
use session::SessionManager;
use sftp::batch::BatchTransferManager;
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
    pub maintenance: Arc<maintenance::MaintenanceStore>,
    /// Cancellation tokens for in-flight maintenance steps, keyed by task id.
    pub maintenance_cancels: Arc<RwLock<HashMap<String, CancellationToken>>>,
    pub docker: docker::DockerState,
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
        let maintenance = maintenance::MaintenanceStore::new().unwrap_or_else(|e| {
            log::error!(
                "Failed to open maintenance store, using in-memory db: {}",
                e
            );
            maintenance::MaintenanceStore::new_in_memory()
                .expect("in-memory maintenance store must work")
        });
        Self {
            manager: SessionManager::new(32),
            known_hosts,
            approval: ApprovalState::new(),
            batch_transfer: BatchTransferManager::new(),
            transfer_cancels: Arc::new(RwLock::new(HashMap::new())),
            maintenance: Arc::new(maintenance),
            maintenance_cancels: Arc::new(RwLock::new(HashMap::new())),
            docker: docker::DockerState::new(),
        }
    }
}
