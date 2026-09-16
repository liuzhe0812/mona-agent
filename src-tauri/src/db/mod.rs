pub mod catalog;
pub mod structure;
pub mod commands;
pub mod error;
pub mod manager;
pub mod types;
pub(crate) mod sql_script;

use manager::ConnectionManager;
use tokio::sync::Mutex;

pub struct DbState {
    pub manager: Mutex<ConnectionManager>,
}

impl DbState {
    pub fn new() -> Self {
        Self {
            manager: Mutex::new(ConnectionManager::new()),
        }
    }
}
