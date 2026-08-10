//! Terminal AI maintenance tasks: data model, SQLite persistence, state
//! machine, re-verify gate and risk adjudication.
//!
//! Commands and raw output are never persisted — only a SHA-256 hash of the
//! command, the exit code and timing metadata.

use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// ─── Model ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Planning,
    WaitingApproval,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Planning => "planning",
            TaskStatus::WaitingApproval => "waiting_approval",
            TaskStatus::Running => "running",
            TaskStatus::Succeeded => "succeeded",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "planning" => TaskStatus::Planning,
            "waiting_approval" => TaskStatus::WaitingApproval,
            "running" => TaskStatus::Running,
            "succeeded" => TaskStatus::Succeeded,
            "failed" => TaskStatus::Failed,
            "cancelled" => TaskStatus::Cancelled,
            _ => return None,
        })
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self,
            TaskStatus::Planning | TaskStatus::WaitingApproval | TaskStatus::Running
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskResolution {
    #[default]
    None,
    CompletedChanges,
    NoChangesNeeded,
    Partial,
    Failed,
}

impl TaskResolution {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskResolution::None => "",
            TaskResolution::CompletedChanges => "completed_changes",
            TaskResolution::NoChangesNeeded => "no_changes_needed",
            TaskResolution::Partial => "partial",
            TaskResolution::Failed => "failed",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "completed_changes" => TaskResolution::CompletedChanges,
            "no_changes_needed" => TaskResolution::NoChangesNeeded,
            "partial" => TaskResolution::Partial,
            "failed" => TaskResolution::Failed,
            _ => TaskResolution::None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Inspect,
    Change,
    Verify,
}

impl StepKind {
    fn as_str(&self) -> &'static str {
        match self {
            StepKind::Inspect => "inspect",
            StepKind::Change => "change",
            StepKind::Verify => "verify",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "inspect" => StepKind::Inspect,
            "change" => StepKind::Change,
            "verify" => StepKind::Verify,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

impl StepStatus {
    fn as_str(&self) -> &'static str {
        match self {
            StepStatus::Pending => "pending",
            StepStatus::Running => "running",
            StepStatus::Succeeded => "succeeded",
            StepStatus::Failed => "failed",
            StepStatus::Skipped => "skipped",
            StepStatus::Cancelled => "cancelled",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => StepStatus::Pending,
            "running" => StepStatus::Running,
            "succeeded" => StepStatus::Succeeded,
            "failed" => StepStatus::Failed,
            "skipped" => StepStatus::Skipped,
            "cancelled" => StepStatus::Cancelled,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceTask {
    pub id: String,
    pub session_id: String,
    pub config_id: String,
    pub target_label: String,
    pub goal: String,
    pub exec_mode: String,
    pub status: TaskStatus,
    pub resolution: TaskResolution,
    pub diagnosis: String,
    pub summary: String,
    pub error: String,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceStep {
    pub id: String,
    pub task_id: String,
    pub ordinal: i64,
    pub title: String,
    pub kind: StepKind,
    pub status: StepStatus,
    pub command_hash: String,
    pub exit_code: Option<i64>,
    pub duration_ms: Option<i64>,
    pub approved_at: Option<i64>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceTaskDetail {
    pub task: MaintenanceTask,
    pub steps: Vec<MaintenanceStep>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceEvent {
    pub session_id: String,
    pub task: MaintenanceTaskDetail,
}

// ─── Sanitization ───────────────────────────────────────────────────────────

const GOAL_MAX: usize = 2000;
const TEXT_MAX: usize = 8000;
const ERROR_MAX: usize = 2000;

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// Minimal scrub of `key=value` secrets before persistence.
fn scrub_secrets(s: &str) -> String {
    const KEYS: [&str; 4] = ["password=", "passwd=", "token=", "secret="];
    let lower = s.to_lowercase();
    let bytes = s.as_bytes();
    let lower_bytes = lower.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        let matched = KEYS
            .iter()
            .find(|key| lower_bytes[i..].starts_with(key.as_bytes()));
        if let Some(key) = matched {
            out.push_str(key);
            out.push_str("***");
            let mut j = i + key.len();
            while j < bytes.len() && !(bytes[j] as char).is_whitespace() {
                j += 1;
            }
            i = j;
        } else {
            let ch_len = s[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
            out.push_str(&s[i..i + ch_len]);
            i += ch_len;
        }
    }
    out
}

fn sanitize_goal(s: &str) -> String {
    truncate(&scrub_secrets(s), GOAL_MAX)
}

fn sanitize_text(s: &str) -> String {
    truncate(&scrub_secrets(s), TEXT_MAX)
}

fn sanitize_error(s: &str) -> String {
    truncate(&scrub_secrets(s), ERROR_MAX)
}

pub fn command_hash(command: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(command.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ─── Risk adjudication (single source of truth, Rust side) ──────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Risk {
    Normal,
    /// Matches configured dangerous patterns — requires explicit approval.
    Dangerous,
    /// Hard-coded catastrophic commands — blocked unconditionally.
    Forbidden,
}

const FORBIDDEN_PATTERNS: [&str; 7] = [
    "rm -rf /",
    "rm -rf /*",
    "mkfs.",
    "dd of=/dev/",
    "> /dev/sd",
    ":(){ :|:& };:",
    "chmod -R 777 /",
];

fn pattern_matches(pattern: &str, command_lower: &str) -> bool {
    let pat = pattern.to_lowercase();
    if !pat.contains('-') {
        return command_lower.contains(&pat);
    }
    // Mirror the Python semantics: parts joined by one or more non-word chars.
    let parts: Vec<&str> = pat.split('-').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return false;
    }
    let mut cursor = 0usize;
    for (i, part) in parts.iter().enumerate() {
        match command_lower[cursor..].find(part) {
            Some(rel) => {
                let start = cursor + rel;
                if i > 0 {
                    let gap = &command_lower[cursor..start];
                    if gap.is_empty() || !gap.chars().any(|c| !c.is_alphanumeric() && c != '_') {
                        return false;
                    }
                }
                cursor = start + part.len();
            }
            None => return false,
        }
    }
    true
}

pub fn classify_command(command: &str, dangerous_patterns: &[String]) -> Risk {
    let lower = command.to_lowercase();
    for pat in FORBIDDEN_PATTERNS {
        if pattern_matches(pat, &lower) {
            return Risk::Forbidden;
        }
    }
    for pat in dangerous_patterns {
        if pattern_matches(pat, &lower) {
            return Risk::Dangerous;
        }
    }
    Risk::Normal
}

// ─── Store ──────────────────────────────────────────────────────────────────

pub struct MaintenanceStore {
    conn: Mutex<Connection>,
}

fn db_path() -> Result<std::path::PathBuf, String> {
    let dir = dirs::config_dir().ok_or("Cannot determine config directory")?.join("mona");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    Ok(dir.join("terminal-maintenance.db"))
}

impl MaintenanceStore {
    pub fn new() -> Result<Self, String> {
        let path = db_path()?;
        let conn = Connection::open(&path)
            .map_err(|e| format!("Failed to open maintenance db {:?}: {}", path, e))?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.init()?;
        Ok(store)
    }

    pub fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.init()?;
        Ok(store)
    }

    fn init(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS terminal_maintenance_tasks (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                config_id TEXT NOT NULL,
                target_label TEXT NOT NULL,
                goal TEXT NOT NULL,
                exec_mode TEXT NOT NULL,
                status TEXT NOT NULL,
                diagnosis TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                finished_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS terminal_maintenance_steps (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                title TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                command_hash TEXT NOT NULL DEFAULT '',
                exit_code INTEGER,
                duration_ms INTEGER,
                approved_at INTEGER,
                started_at INTEGER,
                finished_at INTEGER,
                FOREIGN KEY(task_id) REFERENCES terminal_maintenance_tasks(id)
            );
            CREATE INDEX IF NOT EXISTS idx_terminal_maintenance_task_target
                ON terminal_maintenance_tasks(config_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_terminal_maintenance_steps_task
                ON terminal_maintenance_steps(task_id, ordinal);",
        )
        .map_err(|e| format!("Failed to init maintenance db: {}", e))?;

        // Migration: add resolution column if missing
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(terminal_maintenance_tasks)")
            .map_err(|e| e.to_string())?
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        if !cols.iter().any(|c| c == "resolution") {
            conn.execute(
                "ALTER TABLE terminal_maintenance_tasks ADD COLUMN resolution TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|e| e.to_string())?;
        }

        // Sweep tasks interrupted by an app crash / kill: no fake resume.
        let now = now_ms();
        conn.execute(
            "UPDATE terminal_maintenance_tasks
                SET status = 'failed', error = '任务被中断', finished_at = ?1
              WHERE status IN ('planning', 'waiting_approval', 'running')",
            params![now],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE terminal_maintenance_steps SET status = 'cancelled', finished_at = ?1
              WHERE status = 'running'",
            params![now],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE terminal_maintenance_steps SET status = 'skipped'
              WHERE status = 'pending'
                AND task_id IN (SELECT id FROM terminal_maintenance_tasks
                                 WHERE status IN ('succeeded', 'failed', 'cancelled'))",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn start_task(
        &self,
        session_id: &str,
        config_id: &str,
        target_label: &str,
        goal: &str,
        exec_mode: &str,
        steps: &[(String, StepKind)],
    ) -> Result<MaintenanceTaskDetail, String> {
        if steps.is_empty() {
            return Err("start requires at least one step".to_string());
        }
        let task_id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO terminal_maintenance_tasks
                (id, session_id, config_id, target_label, goal, exec_mode, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'planning', ?7)",
            params![
                task_id,
                session_id,
                config_id,
                target_label,
                sanitize_goal(goal),
                exec_mode,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        for (i, (title, kind)) in steps.iter().enumerate() {
            conn.execute(
                "INSERT INTO terminal_maintenance_steps
                    (id, task_id, ordinal, title, kind, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending')",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    task_id,
                    (i + 1) as i64,
                    truncate(title, 500),
                    kind.as_str()
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        drop(conn);
        self.get_task(&task_id)
    }

    fn map_task(row: &rusqlite::Row) -> rusqlite::Result<MaintenanceTask> {
        let status: String = row.get(6)?;
        let resolution: String = row.get(13)?;
        Ok(MaintenanceTask {
            id: row.get(0)?,
            session_id: row.get(1)?,
            config_id: row.get(2)?,
            target_label: row.get(3)?,
            goal: row.get(4)?,
            exec_mode: row.get(5)?,
            status: TaskStatus::from_str(&status).unwrap_or(TaskStatus::Failed),
            resolution: TaskResolution::from_str(&resolution),
            diagnosis: row.get(7)?,
            summary: row.get(8)?,
            error: row.get(9)?,
            created_at: row.get(10)?,
            started_at: row.get(11)?,
            finished_at: row.get(12)?,
        })
    }

    fn map_step(row: &rusqlite::Row) -> rusqlite::Result<MaintenanceStep> {
        let kind: String = row.get(4)?;
        let status: String = row.get(5)?;
        Ok(MaintenanceStep {
            id: row.get(0)?,
            task_id: row.get(1)?,
            ordinal: row.get(2)?,
            title: row.get(3)?,
            kind: StepKind::from_str(&kind).unwrap_or(StepKind::Inspect),
            status: StepStatus::from_str(&status).unwrap_or(StepStatus::Failed),
            command_hash: row.get(6)?,
            exit_code: row.get(7)?,
            duration_ms: row.get(8)?,
            approved_at: row.get(9)?,
            started_at: row.get(10)?,
            finished_at: row.get(11)?,
        })
    }

    pub fn get_task(&self, task_id: &str) -> Result<MaintenanceTaskDetail, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let task = conn
            .query_row(
                "SELECT id, session_id, config_id, target_label, goal, exec_mode, status,
                        diagnosis, summary, error, created_at, started_at, finished_at, resolution
                   FROM terminal_maintenance_tasks WHERE id = ?1",
                params![task_id],
                Self::map_task,
            )
            .map_err(|_| format!("Task not found: {}", task_id))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, task_id, ordinal, title, kind, status, command_hash,
                        exit_code, duration_ms, approved_at, started_at, finished_at
                   FROM terminal_maintenance_steps WHERE task_id = ?1 ORDER BY ordinal",
            )
            .map_err(|e| e.to_string())?;
        let steps = stmt
            .query_map(params![task_id], Self::map_step)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(MaintenanceTaskDetail { task, steps })
    }

    pub fn get_active_task(&self, session_id: &str) -> Result<Option<MaintenanceTaskDetail>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id: Option<String> = conn
            .query_row(
                "SELECT id FROM terminal_maintenance_tasks
                  WHERE session_id = ?1 AND status IN ('planning', 'waiting_approval', 'running')
                  ORDER BY created_at DESC LIMIT 1",
                params![session_id],
                |r| r.get(0),
            )
            .ok();
        drop(conn);
        match id {
            Some(id) => self.get_task(&id).map(Some),
            None => Ok(None),
        }
    }

    pub fn list_tasks(
        &self,
        config_id: Option<&str>,
        status: Option<&str>,
        limit: i64,
    ) -> Result<Vec<MaintenanceTask>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut sql = String::from(
            "SELECT id, session_id, config_id, target_label, goal, exec_mode, status,
                    diagnosis, summary, error, created_at, started_at, finished_at, resolution
               FROM terminal_maintenance_tasks WHERE 1=1",
        );
        let mut bindings: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(cid) = config_id {
            if !cid.is_empty() {
                sql.push_str(" AND config_id = ?");
                bindings.push(Box::new(cid.to_string()));
            }
        }
        if let Some(st) = status {
            if !st.is_empty() {
                sql.push_str(" AND status = ?");
                bindings.push(Box::new(st.to_string()));
            }
        }
        sql.push_str(" ORDER BY created_at DESC LIMIT ?");
        bindings.push(Box::new(limit.clamp(1, 500)));
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params_ref: Vec<&dyn rusqlite::ToSql> = bindings.iter().map(|b| b.as_ref()).collect();
        let tasks = stmt
            .query_map(params_ref.as_slice(), Self::map_task)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(tasks)
    }

    // ── State transitions (executor-only for running/result states) ──

    pub fn set_task_status(&self, task_id: &str, status: TaskStatus) -> Result<(), String> {
        let now = now_ms();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let (started, finished) = match status {
            TaskStatus::Running => (Some(now), None),
            TaskStatus::Succeeded | TaskStatus::Failed | TaskStatus::Cancelled => {
                (None, Some(now))
            }
            _ => (None, None),
        };
        if let Some(ts) = started {
            conn.execute(
                "UPDATE terminal_maintenance_tasks SET status = ?1,
                    started_at = COALESCE(started_at, ?2) WHERE id = ?3",
                params![status.as_str(), ts, task_id],
            )
            .map_err(|e| e.to_string())?;
        } else if let Some(ts) = finished {
            conn.execute(
                "UPDATE terminal_maintenance_tasks SET status = ?1, finished_at = ?2 WHERE id = ?3",
                params![status.as_str(), ts, task_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE terminal_maintenance_tasks SET status = ?1 WHERE id = ?2",
                params![status.as_str(), task_id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Mark a step running. Only a `pending` step may start.
    pub fn set_step_running(&self, step_id: &str, command: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "UPDATE terminal_maintenance_steps
                    SET status = 'running', command_hash = ?1, started_at = ?2
                  WHERE id = ?3 AND status = 'pending'",
                params![command_hash(command), now_ms(), step_id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("Step {} is not pending (already started or finished)", step_id));
        }
        Ok(())
    }

    pub fn set_step_result(
        &self,
        step_id: &str,
        status: StepStatus,
        exit_code: Option<i64>,
        duration_ms: i64,
    ) -> Result<(), String> {
        if !matches!(
            status,
            StepStatus::Succeeded | StepStatus::Failed | StepStatus::Cancelled
        ) {
            return Err("Invalid final step status".to_string());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "UPDATE terminal_maintenance_steps
                    SET status = ?1, exit_code = ?2, duration_ms = ?3, finished_at = ?4
                  WHERE id = ?5 AND status = 'running'",
                params![status.as_str(), exit_code, duration_ms, now_ms(), step_id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("Step {} is not running", step_id));
        }
        Ok(())
    }

    /// Cancel a step that is still `pending` (e.g. forbidden command blocked
    /// before execution, or a rejected high-risk command).
    pub fn cancel_pending_step(&self, step_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "UPDATE terminal_maintenance_steps SET status = 'cancelled', finished_at = ?1
                  WHERE id = ?2 AND status = 'pending'",
                params![now_ms(), step_id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("Step {} is not pending", step_id));
        }
        Ok(())
    }

    pub fn approve_steps(&self, task_id: &str, step_ids: &[String]) -> Result<(), String> {
        let now = now_ms();
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for id in step_ids {
            conn.execute(
                "UPDATE terminal_maintenance_steps SET approved_at = ?1
                  WHERE id = ?2 AND task_id = ?3 AND status = 'pending'",
                params![now, id, task_id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Re-verify gate: a task with executed changes may only succeed when a
    /// `verify` step succeeded after the last change step finished.
    fn check_finish_gate(&self, detail: &MaintenanceTaskDetail) -> Result<(), String> {
        let executed: Vec<&MaintenanceStep> = detail
            .steps
            .iter()
            .filter(|s| {
                matches!(
                    s.status,
                    StepStatus::Succeeded | StepStatus::Failed | StepStatus::Cancelled
                )
            })
            .collect();
        if executed.is_empty() {
            return Err("任务还没有任何实际执行的步骤".to_string());
        }
        if detail.steps.iter().any(|s| s.status == StepStatus::Running) {
            return Err("存在正在执行的步骤".to_string());
        }
        // Per-phase success check: each phase that has executed steps must
        // have at least one successful step. If all steps in a phase failed,
        // the task cannot be marked as succeeded.
        for kind in [StepKind::Inspect, StepKind::Change, StepKind::Verify] {
            let phase_steps: Vec<&MaintenanceStep> = executed
                .iter()
                .filter(|s| s.kind == kind)
                .copied()
                .collect();
            if !phase_steps.is_empty()
                && !phase_steps.iter().any(|s| s.status == StepStatus::Succeeded)
            {
                return Err(format!(
                    "{}阶段所有步骤均失败，无法确认结果",
                    match kind {
                        StepKind::Inspect => "检查",
                        StepKind::Change => "变更",
                        StepKind::Verify => "复检",
                    }
                ));
            }
        }
        let last_change_finish = detail
            .steps
            .iter()
            .filter(|s| s.kind == StepKind::Change && s.started_at.is_some())
            .filter_map(|s| s.finished_at)
            .max();
        if let Some(last_change) = last_change_finish {
            let verify_ok = detail.steps.iter().any(|s| {
                s.kind == StepKind::Verify
                    && s.status == StepStatus::Succeeded
                    && s.exit_code == Some(0)
                    && s.finished_at.map(|f| f >= last_change).unwrap_or(false)
            });
            if !verify_ok {
                return Err("发生变更后必须有一次晚于最后变更的成功复检".to_string());
            }
        }
        Ok(())
    }

    pub fn finish_task(
        &self,
        task_id: &str,
        diagnosis: &str,
        summary: &str,
    ) -> Result<MaintenanceTaskDetail, String> {
        let detail = self.get_task(task_id)?;
        if !detail.task.status.is_active() {
            return Err(format!("Task is already {}", detail.task.status.as_str()));
        }
        self.check_finish_gate(&detail)?;
        let has_changes = detail
            .steps
            .iter()
            .any(|s| s.kind == StepKind::Change && s.started_at.is_some());
        let resolution = if has_changes {
            TaskResolution::CompletedChanges
        } else {
            TaskResolution::NoChangesNeeded
        };
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE terminal_maintenance_tasks
                SET status = 'succeeded', diagnosis = ?1, summary = ?2, finished_at = ?3, resolution = ?4
              WHERE id = ?5",
            params![sanitize_text(diagnosis), sanitize_text(summary), now_ms(), resolution.as_str(), task_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE terminal_maintenance_steps SET status = 'skipped'
              WHERE task_id = ?1 AND status = 'pending'",
            params![task_id],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        self.get_task(task_id)
    }

    pub fn fail_task(&self, task_id: &str, error: &str) -> Result<MaintenanceTaskDetail, String> {
        let detail = self.get_task(task_id)?;
        if !detail.task.status.is_active() {
            return Err(format!("Task is already {}", detail.task.status.as_str()));
        }
        let any_succeeded = detail
            .steps
            .iter()
            .any(|s| s.status == StepStatus::Succeeded);
        let resolution = if any_succeeded {
            TaskResolution::Partial
        } else {
            TaskResolution::Failed
        };
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE terminal_maintenance_tasks
                SET status = 'failed', error = ?1, finished_at = ?2, resolution = ?3 WHERE id = ?4",
            params![sanitize_error(error), now_ms(), resolution.as_str(), task_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE terminal_maintenance_steps SET status = 'skipped'
              WHERE task_id = ?1 AND status = 'pending'",
            params![task_id],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        self.get_task(task_id)
    }

    pub fn cancel_task(&self, task_id: &str) -> Result<MaintenanceTaskDetail, String> {
        let detail = self.get_task(task_id)?;
        if !detail.task.status.is_active() {
            return Err(format!("Task is already {}", detail.task.status.as_str()));
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE terminal_maintenance_tasks
                SET status = 'cancelled', finished_at = ?1 WHERE id = ?2",
            params![now_ms(), task_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE terminal_maintenance_steps SET status = 'cancelled', finished_at = ?1
              WHERE task_id = ?2 AND status IN ('pending', 'running')",
            params![now_ms(), task_id],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        self.get_task(task_id)
    }

    /// Delete a finished task and its steps. Active tasks must be cancelled
    /// or finished first — deleting a running task would orphan its history.
    pub fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let status: String = conn
            .query_row(
                "SELECT status FROM terminal_maintenance_tasks WHERE id = ?1",
                params![task_id],
                |r| r.get(0),
            )
            .map_err(|_| format!("Task not found: {}", task_id))?;
        let status = TaskStatus::from_str(&status).ok_or("Invalid task status")?;
        if status.is_active() {
            return Err("任务仍在进行中，请先取消或等待结束".to_string());
        }
        conn.execute(
            "DELETE FROM terminal_maintenance_steps WHERE task_id = ?1",
            params![task_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM terminal_maintenance_tasks WHERE id = ?1",
            params![task_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MaintenanceStore {
        MaintenanceStore::new_in_memory().unwrap()
    }

    fn start(store: &MaintenanceStore, exec_mode: &str) -> MaintenanceTaskDetail {
        store
            .start_task(
                "sess-1",
                "cfg-1",
                "root@example.com:22",
                "检查并修复 nginx",
                exec_mode,
                &[("查看 nginx 状态".into(), StepKind::Inspect)],
            )
            .unwrap()
    }

    /// Plans are immutable once created: tests build multi-step tasks by
    /// passing the complete plan to `start_task`, exactly like the AI tool.
    fn start_with(store: &MaintenanceStore, steps: &[(&str, StepKind)]) -> MaintenanceTaskDetail {
        let plan: Vec<(String, StepKind)> = steps
            .iter()
            .map(|(t, k)| (t.to_string(), k.clone()))
            .collect();
        store
            .start_task("sess-1", "cfg-1", "root@example.com:22", "检查并修复 nginx", "auto", &plan)
            .unwrap()
    }

    #[test]
    fn start_task_persists_snapshot_and_steps() {
        let s = store();
        let d = start(&s, "auto");
        assert_eq!(d.task.status, TaskStatus::Planning);
        assert_eq!(d.task.target_label, "root@example.com:22");
        assert_eq!(d.steps.len(), 1);
        assert_eq!(d.steps[0].status, StepStatus::Pending);
    }

    #[test]
    fn start_requires_steps() {
        let s = store();
        assert!(s.start_task("s", "c", "t", "g", "auto", &[]).is_err());
    }

    #[test]
    fn step_running_only_from_pending() {
        let s = store();
        let d = start(&s, "auto");
        let step = &d.steps[0];
        s.set_step_running(&step.id, "systemctl status nginx").unwrap();
        // Second transition must fail.
        assert!(s.set_step_running(&step.id, "echo again").is_err());
        s.set_step_result(&step.id, StepStatus::Succeeded, Some(0), 12)
            .unwrap();
        assert!(s.set_step_running(&step.id, "echo third").is_err());
    }

    #[test]
    fn finish_without_executed_steps_is_rejected() {
        let s = store();
        let d = start(&s, "auto");
        assert!(s.finish_task(&d.task.id, "diag", "summary").is_err());
    }

    #[test]
    fn change_without_verify_cannot_succeed() {
        let s = store();
        let d = start_with(
            &s,
            &[
                ("查看 nginx 状态", StepKind::Inspect),
                ("重启 nginx", StepKind::Change),
            ],
        );
        let change = &d.steps[1];
        s.set_step_running(&change.id, "systemctl restart nginx").unwrap();
        s.set_step_result(&change.id, StepStatus::Succeeded, Some(0), 50)
            .unwrap();
        let err = s.finish_task(&d.task.id, "diag", "summary").unwrap_err();
        assert!(err.contains("复检"));
    }

    #[test]
    fn verify_earlier_than_last_change_cannot_succeed() {
        let s = store();
        let d = start_with(
            &s,
            &[
                ("查看 nginx 状态", StepKind::Inspect),
                ("变更前复检", StepKind::Verify),
                ("修改配置", StepKind::Change),
            ],
        );
        let verify = &d.steps[1];
        let change = &d.steps[2];
        s.set_step_running(&verify.id, "nginx -t").unwrap();
        s.set_step_result(&verify.id, StepStatus::Succeeded, Some(0), 10)
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        s.set_step_running(&change.id, "sed -i conf").unwrap();
        s.set_step_result(&change.id, StepStatus::Succeeded, Some(0), 10)
            .unwrap();
        assert!(s.finish_task(&d.task.id, "d", "s").is_err());
    }

    #[test]
    fn verify_after_last_change_succeeds() {
        let s = store();
        let d = start_with(
            &s,
            &[
                ("查看 nginx 状态", StepKind::Inspect),
                ("修改配置", StepKind::Change),
                ("复检", StepKind::Verify),
            ],
        );
        s.set_step_running(&d.steps[1].id, "sed -i conf").unwrap();
        s.set_step_result(&d.steps[1].id, StepStatus::Succeeded, Some(0), 10)
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        s.set_step_running(&d.steps[2].id, "nginx -t").unwrap();
        s.set_step_result(&d.steps[2].id, StepStatus::Succeeded, Some(0), 10)
            .unwrap();
        let done = s.finish_task(&d.task.id, "diag", "summary").unwrap();
        assert_eq!(done.task.status, TaskStatus::Succeeded);
        assert_eq!(done.task.diagnosis, "diag");
    }

    #[test]
    fn verify_with_nonzero_exit_does_not_count() {
        let s = store();
        let d = start_with(
            &s,
            &[
                ("查看 nginx 状态", StepKind::Inspect),
                ("修改配置", StepKind::Change),
                ("复检", StepKind::Verify),
            ],
        );
        s.set_step_running(&d.steps[1].id, "sed -i conf").unwrap();
        s.set_step_result(&d.steps[1].id, StepStatus::Succeeded, Some(0), 10)
            .unwrap();
        s.set_step_running(&d.steps[2].id, "nginx -t").unwrap();
        s.set_step_result(&d.steps[2].id, StepStatus::Failed, Some(1), 10)
            .unwrap();
        assert!(s.finish_task(&d.task.id, "d", "s").is_err());
    }

    #[test]
    fn inspect_only_task_can_succeed() {
        let s = store();
        let d = start(&s, "auto");
        s.set_step_running(&d.steps[0].id, "df -h").unwrap();
        s.set_step_result(&d.steps[0].id, StepStatus::Succeeded, Some(0), 5)
            .unwrap();
        assert!(s.finish_task(&d.task.id, "d", "s").is_ok());
    }

    #[test]
    fn cancel_blocks_further_execution_and_finish() {
        let s = store();
        let d = start_with(
            &s,
            &[("查看 nginx 状态", StepKind::Inspect), ("步骤2", StepKind::Inspect)],
        );
        s.cancel_task(&d.task.id).unwrap();
        assert!(s.set_step_running(&d.steps[0].id, "ls").is_err());
        assert!(s.finish_task(&d.task.id, "d", "s").is_err());
        let after = s.get_task(&d.task.id).unwrap();
        assert_eq!(after.task.status, TaskStatus::Cancelled);
        assert!(after
            .steps
            .iter()
            .all(|st| st.status == StepStatus::Cancelled));
    }

    #[test]
    fn pending_steps_become_skipped_on_finish_and_fail() {
        let s = store();
        let d = start_with(
            &s,
            &[("查看 nginx 状态", StepKind::Inspect), ("多余步骤", StepKind::Inspect)],
        );
        s.set_step_running(&d.steps[0].id, "ls").unwrap();
        s.set_step_result(&d.steps[0].id, StepStatus::Succeeded, Some(0), 5)
            .unwrap();
        let done = s.finish_task(&d.task.id, "d", "s").unwrap();
        assert_eq!(done.steps[1].status, StepStatus::Skipped);

        let d2 = start(&s, "auto");
        let failed = s.fail_task(&d2.task.id, "放弃").unwrap();
        assert_eq!(failed.task.status, TaskStatus::Failed);
        assert_eq!(failed.steps[0].status, StepStatus::Skipped);
    }

    #[test]
    fn delete_task_removes_record_and_blocks_active() {
        let s = store();
        let d = start(&s, "auto");
        // Active tasks cannot be deleted.
        assert!(s.delete_task(&d.task.id).is_err());
        s.fail_task(&d.task.id, "x").unwrap();
        s.delete_task(&d.task.id).unwrap();
        assert!(s.get_task(&d.task.id).is_err());
        assert!(s.list_tasks(None, None, 100).unwrap().is_empty());
        // Deleting twice reports not found.
        assert!(s.delete_task(&d.task.id).is_err());
    }

    #[test]
    fn active_task_lookup_only_returns_active() {
        let s = store();
        let d = start(&s, "auto");
        assert!(s.get_active_task("sess-1").unwrap().is_some());
        s.fail_task(&d.task.id, "x").unwrap();
        assert!(s.get_active_task("sess-1").unwrap().is_none());
    }

    #[test]
    fn list_tasks_filters_by_config_and_status() {
        let s = store();
        let d1 = start(&s, "auto");
        let _d2 = s
            .start_task("sess-2", "cfg-2", "u@h:22", "g", "auto", &[("s".into(), StepKind::Inspect)])
            .unwrap();
        s.fail_task(&d1.task.id, "x").unwrap();

        let all = s.list_tasks(None, None, 100).unwrap();
        assert_eq!(all.len(), 2);
        let cfg1 = s.list_tasks(Some("cfg-1"), None, 100).unwrap();
        assert_eq!(cfg1.len(), 1);
        let failed = s.list_tasks(None, Some("failed"), 100).unwrap();
        assert_eq!(failed.len(), 1);
        let active = s.list_tasks(None, Some("planning"), 100).unwrap();
        assert_eq!(active.len(), 1);
    }

    #[test]
    fn risk_classification_boundaries() {
        let dangerous = vec!["shutdown".to_string(), "chown -R".to_string()];
        assert_eq!(classify_command("rm -rf /", &dangerous), Risk::Forbidden);
        assert_eq!(classify_command("rm -rf /*", &dangerous), Risk::Forbidden);
        assert_eq!(
            classify_command(":(){ :|:& };:", &dangerous),
            Risk::Forbidden
        );
        assert_eq!(
            classify_command("dd of=/dev/sda", &dangerous),
            Risk::Forbidden
        );
        assert_eq!(
            classify_command("shutdown -h now", &dangerous),
            Risk::Dangerous
        );
        assert_eq!(
            classify_command("chown -R root:root /var", &dangerous),
            Risk::Dangerous
        );
        assert_eq!(classify_command("ls -la", &dangerous), Risk::Normal);
        assert_eq!(classify_command("RM -RF /", &dangerous), Risk::Forbidden);
        // whitespace variants of hyphenated patterns
        assert_eq!(
            classify_command("chown   -R root /x", &dangerous),
            Risk::Dangerous
        );
    }

    #[test]
    fn secrets_are_scrubbed_and_text_truncated() {
        let s = store();
        let d = s
            .start_task(
                "sess",
                "cfg",
                "t",
                "修复 password=hunter2 的服务",
                "auto",
                &[("s".into(), StepKind::Inspect)],
            )
            .unwrap();
        assert!(!d.task.goal.contains("hunter2"));
        assert!(d.task.goal.contains("password=***"));
    }

    #[test]
    fn all_failed_inspect_cannot_succeed() {
        let s = store();
        let d = start(&s, "auto");
        s.set_step_running(&d.steps[0].id, "bad-cmd").unwrap();
        s.set_step_result(&d.steps[0].id, StepStatus::Failed, Some(1), 5)
            .unwrap();
        let err = s.finish_task(&d.task.id, "d", "s").unwrap_err();
        assert!(err.contains("检查"));
        assert!(err.contains("失败"));
    }

    #[test]
    fn failed_step_recovered_by_remaining_planned_step() {
        // Recovery under a locked plan: the alternative check must have been
        // part of the original plan — plans cannot be extended after start.
        let s = store();
        let d = s
            .start_task(
                "sess-1",
                "cfg-1",
                "root@example.com:22",
                "检查 nginx",
                "auto",
                &[
                    ("检查 nginx 状态".into(), StepKind::Inspect),
                    ("换种方式检查".into(), StepKind::Inspect),
                ],
            )
            .unwrap();
        s.set_step_running(&d.steps[0].id, "bad-cmd").unwrap();
        s.set_step_result(&d.steps[0].id, StepStatus::Failed, Some(1), 5)
            .unwrap();
        s.set_step_running(&d.steps[1].id, "good-cmd").unwrap();
        s.set_step_result(&d.steps[1].id, StepStatus::Succeeded, Some(0), 5)
            .unwrap();
        let done = s.finish_task(&d.task.id, "d", "s").unwrap();
        assert_eq!(done.task.status, TaskStatus::Succeeded);
    }

    #[test]
    fn no_changes_resolution() {
        let s = store();
        let d = start(&s, "auto");
        s.set_step_running(&d.steps[0].id, "systemctl status nginx").unwrap();
        s.set_step_result(&d.steps[0].id, StepStatus::Succeeded, Some(0), 5)
            .unwrap();
        let done = s.finish_task(&d.task.id, "环境已符合", "无需变更").unwrap();
        assert_eq!(done.task.resolution, TaskResolution::NoChangesNeeded);
    }

    #[test]
    fn completed_changes_resolution() {
        let s = store();
        let d = start_with(
            &s,
            &[
                ("查看 nginx 状态", StepKind::Inspect),
                ("修改配置", StepKind::Change),
                ("复检", StepKind::Verify),
            ],
        );
        s.set_step_running(&d.steps[1].id, "sed -i conf").unwrap();
        s.set_step_result(&d.steps[1].id, StepStatus::Succeeded, Some(0), 10)
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        s.set_step_running(&d.steps[2].id, "nginx -t").unwrap();
        s.set_step_result(&d.steps[2].id, StepStatus::Succeeded, Some(0), 10)
            .unwrap();
        let done = s.finish_task(&d.task.id, "d", "s").unwrap();
        assert_eq!(done.task.resolution, TaskResolution::CompletedChanges);
    }

    #[test]
    fn partial_resolution_on_fail_with_some_success() {
        let s = store();
        let d = start(&s, "auto");
        s.set_step_running(&d.steps[0].id, "ls").unwrap();
        s.set_step_result(&d.steps[0].id, StepStatus::Succeeded, Some(0), 5)
            .unwrap();
        let failed = s.fail_task(&d.task.id, "无法继续").unwrap();
        assert_eq!(failed.task.resolution, TaskResolution::Partial);
    }

    #[test]
    fn failed_resolution_on_fail_with_no_success() {
        let s = store();
        let d = start(&s, "auto");
        let failed = s.fail_task(&d.task.id, "放弃").unwrap();
        assert_eq!(failed.task.resolution, TaskResolution::Failed);
    }
}
