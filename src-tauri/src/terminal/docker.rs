use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use dashmap::{mapref::entry::Entry, DashMap};
use russh::{client, ChannelMsg, ChannelWriteHalf};

use crate::terminal::approval::ApprovalVerdict;
use crate::terminal::maintenance::{StepKind, StepStatus, TaskStatus};
use crate::terminal::session::{SessionHandle, SessionStatus, SessionType};
use crate::terminal::ssh::client::{ExecOutputStream, SshClient, StructuredExecResult};
use crate::terminal::TerminalState;

const QUERY_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_QUERY_BYTES: usize = 2 * 1024 * 1024;
const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_COMPOSE_FILE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Default)]
pub struct DockerState {
    targets: Arc<RwLock<HashMap<String, DockerTarget>>>,
    subscriptions: Arc<RwLock<HashMap<String, DockerSubscription>>>,
    terminals: Arc<RwLock<HashMap<String, DockerTerminal>>>,
    active_operations: Arc<DashMap<String, CancellationToken>>,
}

impl DockerState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn cancel_session(&self, session_id: &str) {
        let subscriptions = {
            let mut guard = self.subscriptions.write().await;
            let ids: Vec<String> = guard
                .iter()
                .filter(|(_, subscription)| subscription.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| guard.remove(&id))
                .collect::<Vec<_>>()
        };
        for subscription in subscriptions {
            subscription.token.cancel();
        }
        let terminals = {
            let mut guard = self.terminals.write().await;
            let ids: Vec<String> = guard
                .iter()
                .filter(|(_, terminal)| terminal.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| guard.remove(&id))
                .collect::<Vec<_>>()
        };
        for terminal in terminals {
            if let Some(writer) = terminal.writer.lock().await.as_ref() {
                let _ = writer.close().await;
            }
        }
        self.targets.write().await.remove(session_id);
        if let Some(operation) = self.active_operations.get(session_id) {
            operation.cancel();
        }
    }

    fn acquire_operation(&self, session_id: &str) -> Result<DockerOperationLease, String> {
        let token = CancellationToken::new();
        match self.active_operations.entry(session_id.to_string()) {
            Entry::Occupied(_) => return Err("当前 SSH 会话已有 Docker 变更正在执行".to_string()),
            Entry::Vacant(entry) => {
                entry.insert(token.clone());
            }
        }
        Ok(DockerOperationLease {
            state: self.clone(),
            session_id: session_id.to_string(),
            token,
        })
    }
}

struct DockerOperationLease {
    state: DockerState,
    session_id: String,
    token: CancellationToken,
}

impl DockerOperationLease {
    fn cancel_token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for DockerOperationLease {
    fn drop(&mut self) {
        self.state.active_operations.remove(&self.session_id);
    }
}

#[derive(Clone)]
struct DockerSubscription {
    session_id: String,
    token: CancellationToken,
}

#[derive(Clone)]
struct DockerTerminal {
    session_id: String,
    writer: Arc<Mutex<Option<ChannelWriteHalf<client::Msg>>>>,
}

struct DockerOperationRecord {
    app_handle: AppHandle,
    maintenance: Arc<crate::terminal::maintenance::MaintenanceStore>,
    session_id: String,
    task_id: String,
    change_step_id: String,
    verify_step_id: String,
    cancel: CancellationToken,
    cancels: Arc<RwLock<HashMap<String, CancellationToken>>>,
}

impl Drop for DockerOperationRecord {
    fn drop(&mut self) {
        let cancels = self.cancels.clone();
        let task_id = self.task_id.clone();
        tokio::spawn(async move {
            cancels.write().await.remove(&task_id);
        });
    }
}

impl DockerOperationRecord {
    async fn start(
        app_handle: &AppHandle,
        state: &TerminalState,
        client: &SshClient,
        session_id: &str,
        goal: &str,
        inspect_command: &str,
        cancel: CancellationToken,
    ) -> Result<Self, String> {
        if state.maintenance.get_active_task(session_id)?.is_some() {
            return Err("当前 SSH 会话已有维护任务正在执行".to_string());
        }
        let session = state
            .manager
            .get(session_id)
            .await
            .ok_or_else(|| format!("SSH 会话不存在: {session_id}"))?;
        let detail = state.maintenance.start_task(
            session_id,
            &session.config_id,
            &session.target_label,
            goal,
            "auto",
            &[
                ("检查 Docker 目标".to_string(), StepKind::Inspect),
                ("执行 Docker 变更".to_string(), StepKind::Change),
                ("复检 Docker 状态".to_string(), StepKind::Verify),
            ],
        )?;
        let inspect_step_id = detail
            .steps
            .first()
            .ok_or("维护任务缺少检查步骤")?
            .id
            .clone();
        let change_step_id = detail
            .steps
            .get(1)
            .ok_or("维护任务缺少变更步骤")?
            .id
            .clone();
        let verify_step_id = detail
            .steps
            .get(2)
            .ok_or("维护任务缺少复检步骤")?
            .id
            .clone();
        let record = Self {
            app_handle: app_handle.clone(),
            maintenance: state.maintenance.clone(),
            session_id: session_id.to_string(),
            task_id: detail.task.id,
            change_step_id,
            verify_step_id,
            cancel: cancel.clone(),
            cancels: state.maintenance_cancels.clone(),
        };
        state
            .maintenance_cancels
            .write()
            .await
            .insert(record.task_id.clone(), cancel.clone());
        state
            .maintenance
            .set_task_status(&record.task_id, TaskStatus::Running)?;
        state
            .maintenance
            .set_step_running(&inspect_step_id, inspect_command)?;
        let inspect =
            match exec_with_cancel(client, inspect_command, QUERY_TIMEOUT, cancel.clone()).await {
                Ok(result) => result,
                Err(error) => {
                    let _ = state.maintenance.set_step_result(
                        &inspect_step_id,
                        StepStatus::Failed,
                        None,
                        0,
                    );
                    record.fail(&error);
                    return Err(error);
                }
            };
        let inspect_cancelled = cancel.is_cancelled() || inspect.cancelled;
        let step_result = state.maintenance.set_step_result(
            &inspect_step_id,
            if successful(&inspect) {
                StepStatus::Succeeded
            } else if inspect_cancelled {
                StepStatus::Cancelled
            } else {
                StepStatus::Failed
            },
            inspect.exit_code.map(i64::from),
            inspect.duration_ms as i64,
        );
        if inspect_cancelled {
            record.mark_cancelled();
            return Err("命令已取消；远端操作可能已经开始，请刷新确认实际状态".to_string());
        }
        step_result?;
        if !successful(&inspect) {
            let error = failure_message(&inspect);
            record.fail(&error);
            return Err(error);
        }
        record.emit();
        Ok(record)
    }

    fn emit(&self) {
        if let Ok(detail) = self.maintenance.get_task(&self.task_id) {
            crate::terminal::maintenance_cmds::emit_task_event(
                &self.app_handle,
                &self.session_id,
                &detail,
            );
        }
    }

    fn mark_cancelled(&self) {
        let _ = self.maintenance.cancel_task(&self.task_id);
        self.emit();
    }

    fn start_change(&self, command: &str) -> Result<(), String> {
        self.maintenance
            .set_step_running(&self.change_step_id, command)?;
        self.emit();
        Ok(())
    }

    fn finish_change(&self, result: &StructuredExecResult) -> Result<(), String> {
        let cancelled = self.cancel.is_cancelled() || result.cancelled;
        let status = if successful(result) {
            StepStatus::Succeeded
        } else if cancelled {
            StepStatus::Cancelled
        } else {
            StepStatus::Failed
        };
        let step_result = self.maintenance.set_step_result(
            &self.change_step_id,
            status,
            result.exit_code.map(i64::from),
            result.duration_ms as i64,
        );
        if cancelled {
            self.mark_cancelled();
            return Err("命令已取消；远端操作可能已经开始，请刷新确认实际状态".to_string());
        }
        self.emit();
        step_result?;
        Ok(())
    }

    fn start_verify(&self, command: &str) -> Result<(), String> {
        self.maintenance
            .set_step_running(&self.verify_step_id, command)?;
        self.emit();
        Ok(())
    }

    fn finish_verify(&self, succeeded: bool, exit_code: Option<u32>) -> Result<(), String> {
        let cancelled = self.cancel.is_cancelled();
        let step_result = self.maintenance.set_step_result(
            &self.verify_step_id,
            if cancelled {
                StepStatus::Cancelled
            } else if succeeded {
                StepStatus::Succeeded
            } else {
                StepStatus::Failed
            },
            exit_code.map(i64::from),
            0,
        );
        if cancelled {
            self.mark_cancelled();
            return Err("命令已取消；远端操作可能已经开始，请刷新确认实际状态".to_string());
        }
        self.emit();
        step_result?;
        Ok(())
    }

    fn succeed(&self, summary: &str) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            self.mark_cancelled();
            return Err("命令已取消；远端操作可能已经开始，请刷新确认实际状态".to_string());
        }
        self.maintenance
            .finish_task(&self.task_id, "Docker 操作与复检已完成", summary)?;
        self.emit();
        Ok(())
    }

    fn fail(&self, error: &str) {
        let _ = self.maintenance.fail_task(&self.task_id, error);
        self.emit();
    }

    fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DockerPermissionMode {
    Direct,
    SudoNonInteractive,
}

#[derive(Debug, Clone)]
struct DockerTarget {
    session_id: String,
    connection_generation: i64,
    endpoint: String,
    engine_id: String,
    permission_mode: DockerPermissionMode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerProbe {
    pub available: bool,
    pub issue: Option<String>,
    pub docker_version: Option<String>,
    pub server_version: Option<String>,
    pub compose_version: Option<String>,
    pub engine_id: Option<String>,
    pub endpoint: Option<String>,
    pub operating_system: Option<String>,
    pub architecture: Option<String>,
    pub permission_mode: Option<DockerPermissionMode>,
    pub podman_available: bool,
    pub target_label: String,
    pub probed_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub mounts: String,
    pub networks: String,
    pub created_at: String,
    pub running_for: String,
    pub size: String,
    pub command: String,
    pub compose_project: Option<String>,
    pub cpu_percent: Option<String>,
    pub memory_usage: Option<String>,
    pub memory_percent: Option<String>,
    pub net_io: Option<String>,
    pub block_io: Option<String>,
    pub pids: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerSnapshot {
    pub containers: Vec<DockerContainer>,
    pub captured_at: i64,
    pub stats_available: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerMountDetail {
    pub kind: String,
    pub source: String,
    pub destination: String,
    pub mode: String,
    pub read_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetworkDetail {
    pub name: String,
    pub ip_address: String,
    pub gateway: String,
    pub mac_address: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerDetail {
    pub id: String,
    pub name: String,
    pub image: String,
    pub image_id: String,
    pub created_at: String,
    pub platform: String,
    pub state: String,
    pub status: String,
    pub health: Option<String>,
    pub exit_code: i64,
    pub oom_killed: bool,
    pub restart_count: i64,
    pub error: String,
    pub started_at: String,
    pub finished_at: String,
    pub restart_policy: String,
    pub privileged: bool,
    pub network_mode: String,
    pub pid_mode: String,
    pub memory_limit: i64,
    pub cpu_quota: i64,
    pub command: Vec<String>,
    pub environment_names: Vec<String>,
    pub label_names: Vec<String>,
    pub mounts: Vec<DockerMountDetail>,
    pub networks: Vec<DockerNetworkDetail>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerLogsResult {
    pub stdout: String,
    pub stderr: String,
    pub tail: u32,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProject {
    pub name: String,
    pub status: String,
    pub config_file: Option<String>,
    pub manageable: bool,
    pub limitation: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub repository: String,
    pub tag: String,
    pub digest: String,
    pub id: String,
    pub created_since: String,
    pub size: String,
    pub containers: String,
    pub shared_size: String,
    pub unique_size: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub mountpoint: String,
    pub size: String,
    pub links: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerDiskUsageItem {
    pub kind: String,
    pub total_count: String,
    pub active: String,
    pub size: String,
    pub reclaimable: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerResourceSnapshot {
    pub images: Vec<DockerImage>,
    pub volumes: Vec<DockerVolume>,
    pub disk_usage: Vec<DockerDiskUsageItem>,
    pub captured_at: i64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerResourceRemoveResult {
    pub kind: String,
    pub resource_id: String,
    pub verification: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeFileContent {
    pub path: String,
    pub resolved_path: String,
    pub working_directory: String,
    pub content: String,
    pub sha256: String,
    pub size: usize,
    pub permissions: Option<u32>,
    pub owner_uid: Option<u32>,
    pub owner_gid: Option<u32>,
    pub input_fingerprint: String,
    pub unsupported_features: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeValidation {
    pub valid: bool,
    pub error: Option<String>,
    pub services: Vec<String>,
    pub images: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeActionResult {
    pub action: String,
    pub project_name: String,
    pub config_file: String,
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    pub verification: String,
    pub output: String,
    pub output_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerImageUpdate {
    pub reference: String,
    pub status: String,
    pub local_digests: Vec<String>,
    pub remote_digest: Option<String>,
    pub reason: Option<String>,
    pub checked_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerActionResult {
    pub action: String,
    pub container_id: String,
    pub container_name: String,
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    pub verification: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DockerLogEvent {
    subscription_id: String,
    session_id: String,
    container_id: String,
    stream: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DockerComposeEvent {
    subscription_id: String,
    session_id: String,
    project_name: String,
    stream: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DockerTerminalEvent {
    terminal_id: String,
    session_id: String,
    container_id: String,
    data: String,
}

async fn ssh_client(
    state: &TerminalState,
    session_id: &str,
) -> Result<(Arc<SshClient>, i64, String), String> {
    let session = state
        .manager
        .get(session_id)
        .await
        .ok_or_else(|| format!("SSH 会话不存在: {session_id}"))?;
    if session.session_type != SessionType::Ssh {
        return Err("Docker 管理只能绑定 SSH 会话".to_string());
    }
    if session.status != SessionStatus::Connected {
        return Err("SSH 会话未连接".to_string());
    }
    let client = match state.manager.get_handle(session_id).await {
        Some(SessionHandle::Ssh(client)) => client,
        _ => return Err("SSH 会话执行通道不可用".to_string()),
    };
    Ok((
        client,
        session.created_at.timestamp_millis(),
        session.target_label,
    ))
}

async fn exec(
    client: &SshClient,
    command: &str,
    timeout: Duration,
) -> Result<StructuredExecResult, String> {
    exec_with_cancel(client, command, timeout, CancellationToken::new()).await
}

async fn exec_with_cancel(
    client: &SshClient,
    command: &str,
    timeout: Duration,
    cancel: CancellationToken,
) -> Result<StructuredExecResult, String> {
    client
        .exec_command_structured_bounded(command, timeout, cancel, MAX_QUERY_BYTES, |_| {})
        .await
        .map_err(|error| format!("SSH 执行失败: {error}"))
}

fn successful(result: &StructuredExecResult) -> bool {
    !result.timed_out && !result.cancelled && result.exit_code == Some(0)
}

fn failure_message(result: &StructuredExecResult) -> String {
    if result.timed_out {
        return "命令执行超时".to_string();
    }
    if result.cancelled {
        return "命令已取消；远端操作可能已经开始，请刷新确认实际状态".to_string();
    }
    let message = if result.stderr.trim().is_empty() {
        result.stdout.trim()
    } else {
        result.stderr.trim()
    };
    let message = strip_ansi(message);
    let message = truncate_utf8(&message, 500).0;
    if message.is_empty() {
        format!("远端命令失败，退出码: {:?}", result.exit_code)
    } else {
        message
    }
}

fn reports_not_found(result: &StructuredExecResult) -> bool {
    if result.timed_out
        || result.cancelled
        || result.exit_code.is_none()
        || result.exit_code == Some(0)
    {
        return false;
    }
    let output = format!("{}\n{}", result.stdout, result.stderr).to_ascii_lowercase();
    output.contains("no such object")
        || output.contains("no such container")
        || output.contains("no such image")
        || output.contains("no such volume")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn docker_command(target: &DockerTarget, arguments: &[&str]) -> String {
    let mut command = match target.permission_mode {
        DockerPermissionMode::Direct => "docker".to_string(),
        DockerPermissionMode::SudoNonInteractive => "sudo -n docker".to_string(),
    };
    command.push_str(" --host ");
    command.push_str(&shell_quote(&target.endpoint));
    for argument in arguments {
        command.push(' ');
        command.push_str(&shell_quote(argument));
    }
    command
}

fn value_string(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn nested_string(value: &Value, path: &[&str]) -> String {
    let mut current = value;
    for key in path {
        current = match current.get(*key) {
            Some(next) => next,
            None => return String::new(),
        };
    }
    current.as_str().unwrap_or_default().to_string()
}

fn nested_i64(value: &Value, path: &[&str]) -> i64 {
    let mut current = value;
    for key in path {
        current = match current.get(*key) {
            Some(next) => next,
            None => return 0,
        };
    }
    current.as_i64().unwrap_or_default()
}

fn compose_project_from_labels(labels: &str) -> Option<String> {
    labels.split(',').find_map(|item| {
        item.strip_prefix("com.docker.compose.project=")
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn parse_json_lines(output: &str) -> Result<Vec<Value>, String> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line)
                .map_err(|error| format!("Docker 返回了无法解析的数据: {error}"))
        })
        .collect()
}

fn parse_json_array_or_lines(output: &str) -> Result<Vec<Value>, String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Array(values)) => Ok(values),
        Ok(value @ Value::Object(_)) => Ok(vec![value]),
        Ok(_) => Err("Docker 返回了意外的数据结构".to_string()),
        Err(_) => parse_json_lines(output),
    }
}

enum ComposePostcondition {
    Satisfied(String),
    Pending(String),
    Failed(String),
}

fn evaluate_compose_postcondition(
    action: &str,
    output: &str,
) -> Result<ComposePostcondition, String> {
    let rows = parse_json_array_or_lines(output)?;
    if action == "down" {
        return Ok(if rows.is_empty() {
            ComposePostcondition::Satisfied("项目容器已移除".to_string())
        } else {
            ComposePostcondition::Pending(format!("仍有 {} 个项目容器", rows.len()))
        });
    }
    if action == "stop" {
        let active: Vec<String> = rows
            .iter()
            .filter(|row| {
                matches!(
                    value_string(row, "State").to_ascii_lowercase().as_str(),
                    "running" | "restarting" | "paused"
                )
            })
            .map(|row| {
                let name = value_string(row, "Name");
                if name.is_empty() {
                    value_string(row, "Service")
                } else {
                    name
                }
            })
            .collect();
        return Ok(if active.is_empty() {
            ComposePostcondition::Satisfied(format!("项目容器已停止：{} 个", rows.len()))
        } else {
            ComposePostcondition::Pending(format!("仍在运行：{}", active.join(", ")))
        });
    }

    let mut pending = Vec::new();
    let mut healthy = 0usize;
    let mut without_healthcheck = 0usize;
    for row in &rows {
        let mut name = value_string(row, "Name");
        if name.is_empty() {
            name = value_string(row, "Service");
        }
        let state = value_string(row, "State").to_ascii_lowercase();
        let health = value_string(row, "Health").to_ascii_lowercase();
        if health == "unhealthy" {
            return Ok(ComposePostcondition::Failed(format!(
                "容器 {name} 健康检查失败"
            )));
        }
        if matches!(state.as_str(), "exited" | "dead") {
            let exit_code = value_string(row, "ExitCode");
            return Ok(ComposePostcondition::Failed(format!(
                "容器 {name} 已退出{}",
                if exit_code.is_empty() {
                    String::new()
                } else {
                    format!("（退出码 {exit_code}）")
                }
            )));
        }
        if state != "running" || health == "starting" {
            pending.push(if name.is_empty() { state } else { name });
            continue;
        }
        if health == "healthy" {
            healthy += 1;
        } else {
            without_healthcheck += 1;
        }
    }
    if rows.is_empty() {
        return Ok(ComposePostcondition::Failed(
            "Compose 操作后未发现项目容器".to_string(),
        ));
    }
    Ok(if pending.is_empty() {
        ComposePostcondition::Satisfied(format!(
            "运行 {}，健康 {}，未配置健康检查 {}",
            rows.len(),
            healthy,
            without_healthcheck
        ))
    } else {
        ComposePostcondition::Pending(format!("等待容器就绪：{}", pending.join(", ")))
    })
}

async fn wait_for_compose_postcondition(
    client: &SshClient,
    command: &str,
    action: &str,
    cancel: CancellationToken,
) -> Result<(StructuredExecResult, String), String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let result =
            exec_with_cancel(client, command, Duration::from_secs(10), cancel.clone()).await?;
        if !successful(&result) {
            return Err(failure_message(&result));
        }
        match evaluate_compose_postcondition(action, &result.stdout)? {
            ComposePostcondition::Satisfied(summary) => return Ok((result, summary)),
            ComposePostcondition::Failed(error) => return Err(error),
            ComposePostcondition::Pending(status) => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!("Compose 状态复检超时：{status}"));
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            _ = cancel.cancelled() => {
                return Err("命令已取消；远端操作可能已经开始，请刷新确认实际状态".to_string());
            }
        }
    }
}

fn parse_containers(output: &str) -> Result<Vec<DockerContainer>, String> {
    parse_json_lines(output)?
        .into_iter()
        .map(|value| {
            let labels = value_string(&value, "Labels");
            let status = value_string(&value, "Status");
            let state = value_string(&value, "State");
            let state = if state.is_empty() {
                let normalized_status = status.to_ascii_lowercase();
                if normalized_status.starts_with("up") {
                    "running"
                } else if normalized_status.starts_with("exited") {
                    "exited"
                } else if normalized_status.starts_with("created") {
                    "created"
                } else if normalized_status.starts_with("paused") {
                    "paused"
                } else if normalized_status.starts_with("restarting") {
                    "restarting"
                } else if normalized_status.starts_with("dead") {
                    "dead"
                } else {
                    "unknown"
                }
                .to_string()
            } else {
                state
            };
            Ok(DockerContainer {
                id: value_string(&value, "ID"),
                name: value_string(&value, "Names"),
                image: value_string(&value, "Image"),
                state,
                status,
                ports: value_string(&value, "Ports"),
                mounts: value_string(&value, "Mounts"),
                networks: value_string(&value, "Networks"),
                created_at: value_string(&value, "CreatedAt"),
                running_for: value_string(&value, "RunningFor"),
                size: value_string(&value, "Size"),
                // Container commands can contain credentials; the default
                // list response does not return command arguments.
                command: String::new(),
                compose_project: compose_project_from_labels(&labels),
                cpu_percent: None,
                memory_usage: None,
                memory_percent: None,
                net_io: None,
                block_io: None,
                pids: None,
            })
        })
        .collect()
}

fn apply_stats(containers: &mut [DockerContainer], output: &str) -> Result<(), String> {
    let rows = parse_json_lines(output)?;
    let mut stats = HashMap::new();
    for row in rows {
        let id = value_string(&row, "Container");
        let name = value_string(&row, "Name");
        if !id.is_empty() {
            stats.insert(id, row.clone());
        }
        if !name.is_empty() {
            stats.insert(name, row);
        }
    }
    for container in containers {
        let row = stats
            .get(&container.id)
            .or_else(|| stats.get(&container.name));
        if let Some(row) = row {
            container.cpu_percent = Some(value_string(row, "CPUPerc"));
            container.memory_usage = Some(value_string(row, "MemUsage"));
            container.memory_percent = Some(value_string(row, "MemPerc"));
            container.net_io = Some(value_string(row, "NetIO"));
            container.block_io = Some(value_string(row, "BlockIO"));
            container.pids = Some(value_string(row, "PIDs"));
        }
    }
    Ok(())
}

fn parse_endpoint(output: &str) -> Result<String, String> {
    let raw = output
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let endpoint =
        serde_json::from_str::<String>(raw.trim()).unwrap_or_else(|_| raw.trim().to_string());
    if !endpoint.starts_with("unix://") {
        return Err(format!(
            "当前 Docker context 指向非本机 Unix 引擎: {endpoint}"
        ));
    }
    Ok(endpoint)
}

fn parse_version(value: &Value, path: &[&str]) -> Option<String> {
    let value = nested_string(value, path);
    (!value.is_empty()).then_some(value)
}

async fn cached_target(state: &TerminalState, session_id: &str) -> Result<DockerTarget, String> {
    let (_, connection_generation, _) = ssh_client(state, session_id).await?;
    let target = state
        .docker
        .targets
        .read()
        .await
        .get(session_id)
        .cloned()
        .ok_or("请先重新探测 Docker 环境")?;
    if target.session_id != session_id || target.connection_generation != connection_generation {
        state.docker.targets.write().await.remove(session_id);
        return Err("SSH 连接已变化，请重新探测 Docker 环境".to_string());
    }
    Ok(target)
}

async fn verify_engine(client: &SshClient, target: &DockerTarget) -> Result<(), String> {
    let result = exec(
        client,
        &docker_command(target, &["info", "--format", "{{json .ID}}"]),
        QUERY_TIMEOUT,
    )
    .await?;
    if !successful(&result) {
        return Err(failure_message(&result));
    }
    let actual = serde_json::from_str::<String>(result.stdout.trim())
        .unwrap_or_else(|_| result.stdout.trim().to_string());
    if actual != target.engine_id {
        return Err("Docker Engine 身份已变化，请重新探测后再操作".to_string());
    }
    Ok(())
}

fn validate_container_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
    {
        return Err("容器标识无效".to_string());
    }
    Ok(())
}

fn validate_resource_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 512
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':' | '@'))
    {
        return Err("Docker 资源标识无效".to_string());
    }
    Ok(())
}

fn validate_compose_path(path: &str) -> Result<(), String> {
    let lower = path.to_ascii_lowercase();
    if !path.starts_with('/')
        || path.len() > 4096
        || path.contains('\0')
        || path.contains('\n')
        || path.contains('\r')
        || !(lower.ends_with(".yaml") || lower.ends_with(".yml"))
    {
        return Err("请选择远程主机上的绝对 Compose YAML 路径".to_string());
    }
    Ok(())
}

fn remote_parent(path: &str) -> Result<&str, String> {
    let (parent, name) = path.rsplit_once('/').ok_or("Compose 文件路径缺少父目录")?;
    if name.is_empty() {
        return Err("Compose 文件路径无效".to_string());
    }
    Ok(if parent.is_empty() { "/" } else { parent })
}

fn sha256_text(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

fn unsupported_compose_features(content: &str) -> Vec<String> {
    let mut features = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((raw_key, _)) = trimmed.split_once(':') else {
            continue;
        };
        let key = raw_key
            .trim()
            .trim_matches(|character| character == '\'' || character == '"');
        let label = match key {
            "include" => Some("include"),
            "extends" => Some("extends"),
            "profiles" => Some("profiles"),
            "env_file" => Some("env_file"),
            "build" => Some("build"),
            _ => None,
        };
        if let Some(label) = label {
            if !features.iter().any(|item| item == label) {
                features.push(label.to_string());
            }
        }
    }
    features
}

fn remote_join(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    }
}

async fn enrich_compose_file(
    client: &SshClient,
    mut file: ComposeFileContent,
) -> Result<ComposeFileContent, String> {
    file.unsupported_features = unsupported_compose_features(&file.content);
    let env_path = remote_join(&file.working_directory, ".env");
    let quoted = shell_quote(&env_path);
    let env_result = exec(
        client,
        &format!(
            "if [ -f {quoted} ]; then cksum < {quoted}; elif [ -e {quoted} ]; then exit 2; else printf 'missing\\n'; fi"
        ),
        QUERY_TIMEOUT,
    )
    .await?;
    if !successful(&env_result) {
        return Err(format!(
            "无法确认 Compose .env 版本: {}",
            failure_message(&env_result)
        ));
    }
    file.input_fingerprint =
        sha256_text(format!("{}|{}", file.sha256, env_result.stdout.trim()).as_bytes());
    Ok(file)
}

async fn read_compose_file_from_sftp(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<ComposeFileContent, String> {
    validate_compose_path(path)?;
    let requested_parent = remote_parent(path)?;
    let resolved_parent = sftp
        .canonicalize(requested_parent)
        .await
        .map_err(|error| format!("无法解析 Compose 目录: {error}"))?;
    let resolved_path = sftp
        .canonicalize(path)
        .await
        .map_err(|error| format!("无法解析 Compose 文件: {error}"))?;
    if remote_parent(&resolved_path)? != resolved_parent {
        return Err("Compose 文件通过链接指向所选目录之外".to_string());
    }
    let metadata = sftp
        .metadata(&resolved_path)
        .await
        .map_err(|error| format!("无法读取 Compose 文件属性: {error}"))?;
    if metadata
        .permissions
        .map(|mode| mode & 0o170000 == 0o040000)
        .unwrap_or(false)
    {
        return Err("Compose 路径指向目录而不是文件".to_string());
    }
    let declared_size = metadata.size.unwrap_or(0) as usize;
    if declared_size > MAX_COMPOSE_FILE_BYTES {
        return Err("Compose 文件超过 1 MiB，当前版本不支持编辑".to_string());
    }
    let data = sftp
        .read(&resolved_path)
        .await
        .map_err(|error| format!("无法读取 Compose 文件: {error}"))?;
    if data.len() > MAX_COMPOSE_FILE_BYTES {
        return Err("Compose 文件超过 1 MiB，当前版本不支持编辑".to_string());
    }
    let content =
        String::from_utf8(data.clone()).map_err(|_| "Compose 文件不是 UTF-8 文本".to_string())?;
    Ok(ComposeFileContent {
        path: path.to_string(),
        resolved_path,
        working_directory: resolved_parent,
        content,
        sha256: sha256_text(&data),
        size: data.len(),
        permissions: metadata.permissions.map(|mode| mode & 0o7777),
        owner_uid: metadata.uid,
        owner_gid: metadata.gid,
        input_fingerprint: String::new(),
        unsupported_features: Vec::new(),
    })
}

async fn write_compose_draft(
    sftp: &russh_sftp::client::SftpSession,
    working_directory: &str,
    content: &str,
    _permissions: Option<u32>,
) -> Result<String, String> {
    if content.len() > MAX_COMPOSE_FILE_BYTES {
        return Err("Compose 文件超过 1 MiB，当前版本不支持编辑".to_string());
    }
    let separator = if working_directory == "/" { "" } else { "/" };
    let draft_path = format!(
        "{working_directory}{separator}.mona-compose-{}.yaml",
        uuid::Uuid::new_v4()
    );
    let mut file = sftp
        .create(&draft_path)
        .await
        .map_err(|error| format!("无法创建 Compose 临时文件: {error}"))?;
    let mut attributes = russh_sftp::protocol::FileAttributes::empty();
    attributes.permissions = Some(0o600);
    if let Err(error) = sftp.set_metadata(&draft_path, attributes).await {
        let _ = sftp.remove_file(&draft_path).await;
        return Err(format!("无法设置 Compose 临时文件权限: {error}"));
    }
    if let Err(error) = file.write_all(content.as_bytes()).await {
        let _ = sftp.remove_file(&draft_path).await;
        return Err(format!("无法写入 Compose 临时文件: {error}"));
    }
    if let Err(error) = file.shutdown().await {
        let _ = sftp.remove_file(&draft_path).await;
        return Err(format!("无法关闭 Compose 临时文件: {error}"));
    }
    Ok(draft_path)
}

async fn validate_compose_draft(
    client: &SshClient,
    target: &DockerTarget,
    working_directory: &str,
    draft_path: &str,
) -> Result<ComposeValidation, String> {
    let base = [
        "compose",
        "--project-directory",
        working_directory,
        "-f",
        draft_path,
        "config",
    ];
    let quiet = exec(
        client,
        &docker_command(target, &[&base[..], &["--quiet"]].concat()),
        Duration::from_secs(30),
    )
    .await?;
    if !successful(&quiet) {
        return Ok(ComposeValidation {
            valid: false,
            error: Some(failure_message(&quiet)),
            services: Vec::new(),
            images: Vec::new(),
        });
    }
    let services_result = exec(
        client,
        &docker_command(target, &[&base[..], &["--services"]].concat()),
        Duration::from_secs(30),
    )
    .await?;
    let images_result = exec(
        client,
        &docker_command(target, &[&base[..], &["--images"]].concat()),
        Duration::from_secs(30),
    )
    .await?;
    Ok(ComposeValidation {
        valid: true,
        error: None,
        services: if successful(&services_result) {
            services_result
                .stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        } else {
            Vec::new()
        },
        images: if successful(&images_result) {
            images_result
                .stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect()
        } else {
            Vec::new()
        },
    })
}

fn truncate_utf8(value: &str, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value.to_string(), false);
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn strip_ansi(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        } else {
            output.push(ch);
        }
    }
    output
}

#[tauri::command]
pub async fn docker_probe(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<DockerProbe, String> {
    let (client, connection_generation, target_label) = ssh_client(&state, &session_id).await?;
    let probed_at = chrono::Utc::now().timestamp_millis();

    let podman = exec(&client, "command -v podman >/dev/null 2>&1", QUERY_TIMEOUT).await?;
    let podman_available = successful(&podman);
    let docker_exists = exec(&client, "command -v docker >/dev/null 2>&1", QUERY_TIMEOUT).await?;
    if !successful(&docker_exists) {
        state.docker.targets.write().await.remove(&session_id);
        return Ok(DockerProbe {
            available: false,
            issue: Some("远程主机未安装 Docker CLI".to_string()),
            docker_version: None,
            server_version: None,
            compose_version: None,
            engine_id: None,
            endpoint: None,
            operating_system: None,
            architecture: None,
            permission_mode: None,
            podman_available,
            target_label,
            probed_at,
        });
    }

    let context = exec(
        &client,
        "docker context inspect --format '{{json .Endpoints.docker.Host}}' \"$(docker context show)\"",
        QUERY_TIMEOUT,
    )
    .await?;
    let endpoint = if successful(&context) {
        match parse_endpoint(&context.stdout) {
            Ok(endpoint) => endpoint,
            Err(issue) => {
                state.docker.targets.write().await.remove(&session_id);
                return Ok(DockerProbe {
                    available: false,
                    issue: Some(issue),
                    docker_version: None,
                    server_version: None,
                    compose_version: None,
                    engine_id: None,
                    endpoint: None,
                    operating_system: None,
                    architecture: None,
                    permission_mode: None,
                    podman_available,
                    target_label,
                    probed_at,
                });
            }
        }
    } else {
        "unix:///var/run/docker.sock".to_string()
    };

    let direct = DockerTarget {
        session_id: session_id.clone(),
        connection_generation,
        endpoint: endpoint.clone(),
        engine_id: String::new(),
        permission_mode: DockerPermissionMode::Direct,
    };
    let version_args = ["version", "--format", "{{json .}}"];
    let mut permission_mode = DockerPermissionMode::Direct;
    let mut version = exec(
        &client,
        &docker_command(&direct, &version_args),
        QUERY_TIMEOUT,
    )
    .await?;
    if !successful(&version) {
        let sudo = DockerTarget {
            permission_mode: DockerPermissionMode::SudoNonInteractive,
            ..direct.clone()
        };
        let sudo_version = exec(
            &client,
            &docker_command(&sudo, &version_args),
            QUERY_TIMEOUT,
        )
        .await?;
        if successful(&sudo_version) {
            permission_mode = DockerPermissionMode::SudoNonInteractive;
            version = sudo_version;
        } else {
            state.docker.targets.write().await.remove(&session_id);
            return Ok(DockerProbe {
                available: false,
                issue: Some(format!(
                    "Docker Engine 不可访问；直接访问: {}；sudo -n: {}",
                    failure_message(&version),
                    failure_message(&sudo_version)
                )),
                docker_version: None,
                server_version: None,
                compose_version: None,
                engine_id: None,
                endpoint: Some(endpoint),
                operating_system: None,
                architecture: None,
                permission_mode: None,
                podman_available,
                target_label,
                probed_at,
            });
        }
    }

    let version_json: Value = serde_json::from_str(version.stdout.trim())
        .map_err(|error| format!("无法解析 Docker 版本信息: {error}"))?;
    let target_without_id = DockerTarget {
        session_id: session_id.clone(),
        connection_generation,
        endpoint: endpoint.clone(),
        engine_id: String::new(),
        permission_mode,
    };
    let info = exec(
        &client,
        &docker_command(&target_without_id, &["info", "--format", "{{json .}}"]),
        QUERY_TIMEOUT,
    )
    .await?;
    if !successful(&info) {
        return Err(failure_message(&info));
    }
    if info.truncated || version.truncated {
        return Err("Docker 探测输出超过安全上限".to_string());
    }
    let info_json: Value = serde_json::from_str(info.stdout.trim())
        .map_err(|error| format!("无法解析 Docker Engine 信息: {error}"))?;
    let engine_id = value_string(&info_json, "ID");
    if engine_id.is_empty() {
        return Err("Docker Engine 未返回可识别的 ID".to_string());
    }

    let target = DockerTarget {
        engine_id: engine_id.clone(),
        ..target_without_id
    };
    let compose = exec(
        &client,
        &docker_command(&target, &["compose", "version", "--short"]),
        QUERY_TIMEOUT,
    )
    .await?;
    let compose_version = successful(&compose)
        .then(|| compose.stdout.trim().to_string())
        .filter(|value| !value.is_empty());
    state
        .docker
        .targets
        .write()
        .await
        .insert(session_id, target.clone());

    Ok(DockerProbe {
        available: true,
        issue: None,
        docker_version: parse_version(&version_json, &["Client", "Version"]),
        server_version: parse_version(&version_json, &["Server", "Version"]),
        compose_version,
        engine_id: Some(engine_id),
        endpoint: Some(endpoint),
        operating_system: Some(value_string(&info_json, "OperatingSystem"))
            .filter(|value| !value.is_empty()),
        architecture: Some(value_string(&info_json, "Architecture"))
            .filter(|value| !value.is_empty()),
        permission_mode: Some(permission_mode),
        podman_available,
        target_label,
        probed_at,
    })
}

#[tauri::command]
pub async fn docker_list_containers(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<DockerSnapshot, String> {
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    let result = exec(
        &client,
        &docker_command(
            &target,
            &["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
        ),
        QUERY_TIMEOUT,
    )
    .await?;
    if !successful(&result) {
        log::warn!(
            "[docker] container list failed session={} timed_out={} cancelled={} exit_code={:?} duration_ms={}",
            session_id,
            result.timed_out,
            result.cancelled,
            result.exit_code,
            result.duration_ms,
        );
        return Err(failure_message(&result));
    }
    if result.truncated {
        return Err("容器列表过大，请在主机上减少返回规模后重试".to_string());
    }
    let mut containers = parse_containers(&result.stdout)?;
    let mut warnings = Vec::new();
    let stats = exec(
        &client,
        &docker_command(
            &target,
            &[
                "stats",
                "--no-stream",
                "--no-trunc",
                "--format",
                "{{json .}}",
            ],
        ),
        QUERY_TIMEOUT,
    )
    .await?;
    let stats_available = successful(&stats) && !stats.truncated;
    if stats_available {
        if let Err(error) = apply_stats(&mut containers, &stats.stdout) {
            warnings.push(error);
        }
    } else {
        log::warn!(
            "[docker] container stats unavailable session={} timed_out={} cancelled={} exit_code={:?} duration_ms={}",
            session_id,
            stats.timed_out,
            stats.cancelled,
            stats.exit_code,
            stats.duration_ms,
        );
        warnings.push(format!("资源统计不可用: {}", failure_message(&stats)));
    }
    Ok(DockerSnapshot {
        containers,
        captured_at: chrono::Utc::now().timestamp_millis(),
        stats_available,
        warnings,
    })
}

#[tauri::command]
pub async fn docker_inspect_container(
    state: State<'_, TerminalState>,
    session_id: String,
    container_id: String,
) -> Result<DockerContainerDetail, String> {
    validate_container_id(&container_id)?;
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    let result = exec(
        &client,
        &docker_command(&target, &["inspect", "--type", "container", &container_id]),
        QUERY_TIMEOUT,
    )
    .await?;
    if !successful(&result) {
        return Err(failure_message(&result));
    }
    if result.truncated {
        return Err("容器详情过大，无法安全展示".to_string());
    }
    let documents: Vec<Value> = serde_json::from_str(&result.stdout)
        .map_err(|error| format!("无法解析容器详情: {error}"))?;
    let value = documents.first().ok_or("Docker 未返回容器详情")?;

    let environment_names = value
        .pointer("/Config/Env")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|item| item.split_once('=').map(|(name, _)| name.to_string()))
        .collect();
    let label_names = value
        .pointer("/Config/Labels")
        .and_then(Value::as_object)
        .map(|labels| labels.keys().cloned().collect())
        .unwrap_or_default();
    let mounts = value
        .get("Mounts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|mount| DockerMountDetail {
            kind: value_string(mount, "Type"),
            source: value_string(mount, "Source"),
            destination: value_string(mount, "Destination"),
            mode: value_string(mount, "Mode"),
            read_only: !mount.get("RW").and_then(Value::as_bool).unwrap_or(false),
        })
        .collect();
    let networks = value
        .pointer("/NetworkSettings/Networks")
        .and_then(Value::as_object)
        .map(|networks| {
            networks
                .iter()
                .map(|(name, network)| DockerNetworkDetail {
                    name: name.clone(),
                    ip_address: value_string(network, "IPAddress"),
                    gateway: value_string(network, "Gateway"),
                    mac_address: value_string(network, "MacAddress"),
                })
                .collect()
        })
        .unwrap_or_default();
    let mut command = Vec::new();
    let path = value_string(value, "Path");
    if !path.is_empty() {
        command.push(path);
    }
    // Arguments are intentionally omitted because they can contain secrets.

    Ok(DockerContainerDetail {
        id: value_string(value, "Id"),
        name: value_string(value, "Name")
            .trim_start_matches('/')
            .to_string(),
        image: nested_string(value, &["Config", "Image"]),
        image_id: value_string(value, "Image"),
        created_at: value_string(value, "Created"),
        platform: value_string(value, "Platform"),
        state: nested_string(value, &["State", "Status"]),
        status: nested_string(value, &["State", "Status"]),
        health: Some(nested_string(value, &["State", "Health", "Status"]))
            .filter(|item| !item.is_empty()),
        exit_code: nested_i64(value, &["State", "ExitCode"]),
        oom_killed: value
            .pointer("/State/OOMKilled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        restart_count: value
            .get("RestartCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        error: nested_string(value, &["State", "Error"]),
        started_at: nested_string(value, &["State", "StartedAt"]),
        finished_at: nested_string(value, &["State", "FinishedAt"]),
        restart_policy: nested_string(value, &["HostConfig", "RestartPolicy", "Name"]),
        privileged: value
            .pointer("/HostConfig/Privileged")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        network_mode: nested_string(value, &["HostConfig", "NetworkMode"]),
        pid_mode: nested_string(value, &["HostConfig", "PidMode"]),
        memory_limit: nested_i64(value, &["HostConfig", "Memory"]),
        cpu_quota: nested_i64(value, &["HostConfig", "CpuQuota"]),
        command,
        environment_names,
        label_names,
        mounts,
        networks,
    })
}

#[tauri::command]
pub async fn docker_container_logs(
    state: State<'_, TerminalState>,
    session_id: String,
    container_id: String,
    tail: Option<u32>,
) -> Result<DockerLogsResult, String> {
    validate_container_id(&container_id)?;
    let tail = tail.unwrap_or(200).clamp(1, 5_000);
    let tail_text = tail.to_string();
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    let result = exec(
        &client,
        &docker_command(
            &target,
            &["logs", "--timestamps", "--tail", &tail_text, &container_id],
        ),
        QUERY_TIMEOUT,
    )
    .await?;
    if !successful(&result) {
        return Err(failure_message(&result));
    }
    let (stdout, stdout_truncated) = truncate_utf8(&result.stdout, MAX_LOG_BYTES);
    let (stderr, stderr_truncated) = truncate_utf8(&result.stderr, MAX_LOG_BYTES);
    Ok(DockerLogsResult {
        stdout,
        stderr,
        tail,
        truncated: result.truncated || stdout_truncated || stderr_truncated,
    })
}

#[tauri::command]
pub async fn docker_list_compose_projects(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<Vec<ComposeProject>, String> {
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    let result = exec(
        &client,
        &docker_command(&target, &["compose", "ls", "--all", "--format", "json"]),
        QUERY_TIMEOUT,
    )
    .await?;
    if !successful(&result) {
        return Err(failure_message(&result));
    }
    if result.truncated {
        return Err("Compose 项目列表过大，无法安全展示".to_string());
    }
    let values: Vec<Value> = match serde_json::from_str(result.stdout.trim()) {
        Ok(values) => values,
        Err(_) => parse_json_lines(&result.stdout)?,
    };
    Ok(values
        .into_iter()
        .map(|value| {
            let config_files = value_string(&value, "ConfigFiles");
            let files: Vec<_> = config_files
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .collect();
            let manageable = files.len() == 1;
            ComposeProject {
                name: value_string(&value, "Name"),
                status: value_string(&value, "Status"),
                config_file: (files.len() == 1).then(|| files[0].to_string()),
                manageable,
                limitation: (!manageable).then(|| {
                    if files.is_empty() {
                        "未找到可关联的 Compose 文件".to_string()
                    } else {
                        "多 Compose 文件项目当前仅支持查看".to_string()
                    }
                }),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn docker_read_compose_file(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
) -> Result<ComposeFileContent, String> {
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    cached_target(&state, &session_id).await?;
    let sftp = client
        .open_sftp()
        .await
        .map_err(|error| format!("无法打开 SFTP 通道: {error}"))?;
    let file = read_compose_file_from_sftp(&sftp, &path).await?;
    enrich_compose_file(&client, file).await
}

#[tauri::command]
pub async fn docker_validate_compose_file(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<ComposeValidation, String> {
    let unsupported = unsupported_compose_features(&content);
    if !unsupported.is_empty() {
        return Ok(ComposeValidation {
            valid: false,
            error: Some(format!(
                "当前版本仅查看包含以下配置的项目: {}",
                unsupported.join(", ")
            )),
            services: Vec::new(),
            images: Vec::new(),
        });
    }
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    let sftp = client
        .open_sftp()
        .await
        .map_err(|error| format!("无法打开 SFTP 通道: {error}"))?;
    let current = read_compose_file_from_sftp(&sftp, &path).await?;
    let draft = write_compose_draft(
        &sftp,
        &current.working_directory,
        &content,
        current.permissions,
    )
    .await?;
    let validation =
        validate_compose_draft(&client, &target, &current.working_directory, &draft).await;
    let _ = sftp.remove_file(&draft).await;
    validation
}

#[tauri::command]
pub async fn docker_save_compose_file(
    state: State<'_, TerminalState>,
    session_id: String,
    path: String,
    expected_sha256: String,
    expected_input_fingerprint: String,
    content: String,
) -> Result<ComposeFileContent, String> {
    if expected_sha256.len() != 64 || !expected_sha256.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Compose 文件版本无效，请重新读取".to_string());
    }
    if expected_input_fingerprint.len() != 64
        || !expected_input_fingerprint
            .chars()
            .all(|ch| ch.is_ascii_hexdigit())
    {
        return Err("Compose 输入版本无效，请重新读取".to_string());
    }
    let unsupported = unsupported_compose_features(&content);
    if !unsupported.is_empty() {
        return Err(format!(
            "当前版本不能保存或部署包含以下配置的项目: {}",
            unsupported.join(", ")
        ));
    }
    let _operation_lease = state.docker.acquire_operation(&session_id)?;
    if state.maintenance.get_active_task(&session_id)?.is_some() {
        return Err("当前 SSH 会话已有维护任务正在执行".to_string());
    }
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    verify_engine(&client, &target).await?;
    let sftp = client
        .open_sftp()
        .await
        .map_err(|error| format!("无法打开 SFTP 通道: {error}"))?;
    let current =
        enrich_compose_file(&client, read_compose_file_from_sftp(&sftp, &path).await?).await?;
    if !current.unsupported_features.is_empty() {
        return Err(format!(
            "当前版本不能保存包含以下配置的项目: {}",
            current.unsupported_features.join(", ")
        ));
    }
    if !current.sha256.eq_ignore_ascii_case(&expected_sha256) {
        return Err("Compose 文件已被其他程序修改，请重新读取后再保存".to_string());
    }
    if !current
        .input_fingerprint
        .eq_ignore_ascii_case(&expected_input_fingerprint)
    {
        return Err("Compose .env 已变化，请重新读取并确认".to_string());
    }
    let uid = exec(&client, "id -u", QUERY_TIMEOUT).await?;
    if !successful(&uid) {
        return Err(failure_message(&uid));
    }
    let current_uid = uid
        .stdout
        .trim()
        .parse::<u32>()
        .map_err(|_| "无法识别远程用户 ID".to_string())?;
    if current.owner_uid.is_some_and(|owner| owner != current_uid) {
        return Err(
            "Compose 文件不属于当前 SSH 用户，为避免改变所有权，请在终端中编辑".to_string(),
        );
    }
    let draft = write_compose_draft(
        &sftp,
        &current.working_directory,
        &content,
        current.permissions,
    )
    .await?;
    let validation =
        validate_compose_draft(&client, &target, &current.working_directory, &draft).await;
    match validation {
        Ok(ComposeValidation { valid: true, .. }) => {}
        Ok(ComposeValidation { error, .. }) => {
            let _ = sftp.remove_file(&draft).await;
            return Err(error.unwrap_or_else(|| "Compose 配置校验失败".to_string()));
        }
        Err(error) => {
            let _ = sftp.remove_file(&draft).await;
            return Err(error);
        }
    }
    let current_again = match read_compose_file_from_sftp(&sftp, &path).await {
        Ok(current) => match enrich_compose_file(&client, current).await {
            Ok(current) => current,
            Err(error) => {
                let _ = sftp.remove_file(&draft).await;
                return Err(error);
            }
        },
        Err(error) => {
            let _ = sftp.remove_file(&draft).await;
            return Err(error);
        }
    };
    if !current_again.sha256.eq_ignore_ascii_case(&expected_sha256) {
        let _ = sftp.remove_file(&draft).await;
        return Err("Compose 文件在校验期间发生变化，保存已取消".to_string());
    }
    if !current_again
        .input_fingerprint
        .eq_ignore_ascii_case(&expected_input_fingerprint)
    {
        let _ = sftp.remove_file(&draft).await;
        return Err("Compose .env 在校验期间发生变化，保存已取消".to_string());
    }
    let mut final_attributes = russh_sftp::protocol::FileAttributes::empty();
    final_attributes.permissions = Some(current.permissions.unwrap_or(0o600));
    final_attributes.gid = current.owner_gid;
    if let Err(error) = sftp.set_metadata(&draft, final_attributes).await {
        let _ = sftp.remove_file(&draft).await;
        return Err(format!("无法保留 Compose 文件权限: {error}"));
    }
    let move_result = match exec(
        &client,
        &format!(
            "mv -f -- {} {}",
            shell_quote(&draft),
            shell_quote(&current.resolved_path)
        ),
        QUERY_TIMEOUT,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let _ = sftp.remove_file(&draft).await;
            return Err(error);
        }
    };
    if !successful(&move_result) {
        let _ = sftp.remove_file(&draft).await;
        return Err(failure_message(&move_result));
    }
    let saved = enrich_compose_file(
        &client,
        read_compose_file_from_sftp(&sftp, &current.resolved_path).await?,
    )
    .await?;
    if saved.sha256 != sha256_text(content.as_bytes()) {
        return Err("Compose 文件写入后校验不一致".to_string());
    }
    Ok(ComposeFileContent { path, ..saved })
}

fn compose_prefix<'a>(
    working_directory: &'a str,
    config_file: &'a str,
    project_name: Option<&'a str>,
) -> Vec<&'a str> {
    let mut arguments = vec![
        "compose",
        "--project-directory",
        working_directory,
        "-f",
        config_file,
    ];
    if let Some(project_name) = project_name {
        arguments.extend(["--project-name", project_name]);
    }
    arguments
}

#[tauri::command]
pub async fn docker_compose_action(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    config_file: String,
    expected_sha256: String,
    expected_input_fingerprint: String,
    project_name: Option<String>,
    action: String,
) -> Result<ComposeActionResult, String> {
    if let Some(name) = project_name.as_deref() {
        validate_resource_id(name)?;
    }
    let operation_lease = state.docker.acquire_operation(&session_id)?;
    if state.maintenance.get_active_task(&session_id)?.is_some() {
        return Err("当前 SSH 会话已有维护任务正在执行".to_string());
    }
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    verify_engine(&client, &target).await?;
    let sftp = client
        .open_sftp()
        .await
        .map_err(|error| format!("无法打开 SFTP 通道: {error}"))?;
    let current = enrich_compose_file(
        &client,
        read_compose_file_from_sftp(&sftp, &config_file).await?,
    )
    .await?;
    if !current.unsupported_features.is_empty() {
        return Err(format!(
            "当前版本仅查看包含以下配置的项目: {}",
            current.unsupported_features.join(", ")
        ));
    }
    if !current.sha256.eq_ignore_ascii_case(&expected_sha256) {
        return Err("Compose 文件已变化，请重新读取并确认".to_string());
    }
    if !current
        .input_fingerprint
        .eq_ignore_ascii_case(&expected_input_fingerprint)
    {
        return Err("Compose .env 已变化，请重新读取并确认".to_string());
    }
    let mut arguments = compose_prefix(
        &current.working_directory,
        &current.resolved_path,
        project_name.as_deref(),
    );
    match action.as_str() {
        "pull" => arguments.push("pull"),
        "up" => arguments.extend(["up", "--detach", "--no-build", "--pull", "never"]),
        "stop" => arguments.push("stop"),
        "restart" => arguments.push("restart"),
        "recreate" => arguments.extend([
            "up",
            "--detach",
            "--force-recreate",
            "--no-build",
            "--pull",
            "never",
        ]),
        "down" => arguments.push("down"),
        _ => return Err("不支持的 Compose 操作".to_string()),
    }
    let command = docker_command(&target, &arguments);
    if action != "pull" {
        request_approval(
            &app_handle,
            &state,
            &session_id,
            &command,
            &format!(
                "Docker Compose · {} · {}",
                action,
                project_name.as_deref().unwrap_or(&current.resolved_path)
            ),
            operation_lease.cancel_token(),
        )
        .await?;
        verify_engine(&client, &target).await?;
        let newest = enrich_compose_file(
            &client,
            read_compose_file_from_sftp(&sftp, &config_file).await?,
        )
        .await?;
        if !newest.sha256.eq_ignore_ascii_case(&expected_sha256) {
            return Err("Compose 文件在确认期间发生变化，操作已取消".to_string());
        }
        if !newest
            .input_fingerprint
            .eq_ignore_ascii_case(&expected_input_fingerprint)
        {
            return Err("Compose .env 在确认期间发生变化，操作已取消".to_string());
        }
    }
    let inspect_command = docker_command(
        &target,
        &[
            &compose_prefix(
                &current.working_directory,
                &current.resolved_path,
                project_name.as_deref(),
            )[..],
            &["config", "--quiet"],
        ]
        .concat(),
    );
    let record = DockerOperationRecord::start(
        &app_handle,
        &state,
        &client,
        &session_id,
        &format!(
            "Docker Compose {}: {}",
            action,
            project_name.as_deref().unwrap_or(&current.resolved_path)
        ),
        &inspect_command,
        operation_lease.cancel_token(),
    )
    .await?;
    let operation_cancel = record.cancel_token();
    record.start_change(&command)?;
    let result = match exec_with_cancel(
        &client,
        &command,
        Duration::from_secs(600),
        operation_cancel.clone(),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            record.fail(&error);
            return Err(error);
        }
    };
    record.finish_change(&result)?;
    if !successful(&result) {
        let error = failure_message(&result);
        record.fail(&error);
        return Err(error);
    }

    let mut check_args = compose_prefix(
        &current.working_directory,
        &current.resolved_path,
        project_name.as_deref(),
    );
    if action == "pull" {
        check_args.extend(["config", "--images"]);
    } else {
        check_args.extend(["ps", "--all", "--format", "json"]);
    }
    let check_command = docker_command(&target, &check_args);
    record.start_verify(&check_command)?;
    let verification = if action == "pull" {
        let check = match exec_with_cancel(
            &client,
            &check_command,
            Duration::from_secs(30),
            operation_cancel.clone(),
        )
        .await
        {
            Ok(check) => check,
            Err(error) => {
                let _ = record.finish_verify(false, None);
                record.fail(&error);
                return Err(error);
            }
        };
        if !successful(&check) {
            let error = format!("镜像拉取复检失败: {}", failure_message(&check));
            let _ = record.finish_verify(false, check.exit_code);
            record.fail(&error);
            return Err(error);
        }
        for image in check
            .stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if let Err(error) = validate_resource_id(image) {
                let _ = record.finish_verify(false, None);
                record.fail(&error);
                return Err(error);
            }
            let image_check = match exec_with_cancel(
                &client,
                &docker_command(&target, &["image", "inspect", image]),
                QUERY_TIMEOUT,
                operation_cancel.clone(),
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    let _ = record.finish_verify(false, None);
                    record.fail(&error);
                    return Err(error);
                }
            };
            if !successful(&image_check) {
                let error = format!("镜像拉取后未能复检本地镜像 {image}");
                let _ = record.finish_verify(false, image_check.exit_code);
                record.fail(&error);
                return Err(error);
            }
        }
        record.finish_verify(true, check.exit_code)?;
        "镜像拉取完成，运行中的容器尚未重建".to_string()
    } else {
        let (check, summary) = match wait_for_compose_postcondition(
            &client,
            &check_command,
            &action,
            operation_cancel.clone(),
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                let _ = record.finish_verify(false, None);
                record.fail(&error);
                return Err(error);
            }
        };
        record.finish_verify(true, check.exit_code)?;
        summary
    };
    record.succeed(&verification)?;
    let combined = if result.stderr.trim().is_empty() {
        result.stdout
    } else {
        format!("{}\n{}", result.stdout, result.stderr)
    };
    let (output, locally_truncated) = truncate_utf8(&strip_ansi(&combined), 64 * 1024);
    Ok(ComposeActionResult {
        action,
        project_name: project_name.unwrap_or_default(),
        config_file: current.resolved_path,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        verification,
        output,
        output_truncated: result.truncated || locally_truncated,
    })
}

#[tauri::command]
pub async fn docker_list_resources(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<DockerResourceSnapshot, String> {
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    let images_result = exec(
        &client,
        &docker_command(
            &target,
            &[
                "image",
                "ls",
                "--no-trunc",
                "--digests",
                "--format",
                "{{json .}}",
            ],
        ),
        QUERY_TIMEOUT,
    )
    .await?;
    if !successful(&images_result) {
        return Err(failure_message(&images_result));
    }
    if images_result.truncated {
        return Err("镜像列表过大，无法安全展示".to_string());
    }
    let images = parse_json_lines(&images_result.stdout)?
        .into_iter()
        .map(|value| DockerImage {
            repository: value_string(&value, "Repository"),
            tag: value_string(&value, "Tag"),
            digest: value_string(&value, "Digest"),
            id: value_string(&value, "ID"),
            created_since: value_string(&value, "CreatedSince"),
            size: value_string(&value, "Size"),
            containers: value_string(&value, "Containers"),
            shared_size: value_string(&value, "SharedSize"),
            unique_size: value_string(&value, "UniqueSize"),
        })
        .collect();

    let mut warnings = Vec::new();
    let volumes_result = exec(
        &client,
        &docker_command(&target, &["volume", "ls", "--format", "{{json .}}"]),
        QUERY_TIMEOUT,
    )
    .await?;
    let volumes = if successful(&volumes_result) && !volumes_result.truncated {
        parse_json_lines(&volumes_result.stdout)?
            .into_iter()
            .map(|value| DockerVolume {
                name: value_string(&value, "Name"),
                driver: value_string(&value, "Driver"),
                scope: value_string(&value, "Scope"),
                mountpoint: value_string(&value, "Mountpoint"),
                size: value_string(&value, "Size"),
                links: value_string(&value, "Links"),
            })
            .collect()
    } else {
        warnings.push(if volumes_result.truncated {
            "卷列表超过安全上限".to_string()
        } else {
            format!("卷列表不可用: {}", failure_message(&volumes_result))
        });
        Vec::new()
    };

    let disk_result = exec(
        &client,
        &docker_command(&target, &["system", "df", "--format", "{{json .}}"]),
        QUERY_TIMEOUT,
    )
    .await?;
    let disk_usage = if successful(&disk_result) && !disk_result.truncated {
        parse_json_lines(&disk_result.stdout)?
            .into_iter()
            .map(|value| DockerDiskUsageItem {
                kind: value_string(&value, "Type"),
                total_count: value_string(&value, "TotalCount"),
                active: value_string(&value, "Active"),
                size: value_string(&value, "Size"),
                reclaimable: value_string(&value, "Reclaimable"),
            })
            .collect()
    } else {
        warnings.push(if disk_result.truncated {
            "空间统计超过安全上限".to_string()
        } else {
            format!("空间统计不可用: {}", failure_message(&disk_result))
        });
        Vec::new()
    };

    Ok(DockerResourceSnapshot {
        images,
        volumes,
        disk_usage,
        captured_at: chrono::Utc::now().timestamp_millis(),
        warnings,
    })
}

#[tauri::command]
pub async fn docker_check_image_update(
    state: State<'_, TerminalState>,
    session_id: String,
    image_reference: String,
) -> Result<DockerImageUpdate, String> {
    validate_resource_id(&image_reference)?;
    let checked_at = chrono::Utc::now().timestamp_millis();
    if image_reference.starts_with("sha256:") || image_reference.contains("@sha256:") {
        return Ok(DockerImageUpdate {
            reference: image_reference,
            status: "current".to_string(),
            local_digests: Vec::new(),
            remote_digest: None,
            reason: Some("镜像已固定 digest".to_string()),
            checked_at,
        });
    }
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    let local = exec(
        &client,
        &docker_command(
            &target,
            &[
                "image",
                "inspect",
                "--format",
                "{{json .RepoDigests}}",
                &image_reference,
            ],
        ),
        QUERY_TIMEOUT,
    )
    .await?;
    if !successful(&local) {
        return Ok(DockerImageUpdate {
            reference: image_reference,
            status: "unknown".to_string(),
            local_digests: Vec::new(),
            remote_digest: None,
            reason: Some(failure_message(&local)),
            checked_at,
        });
    }
    let local_digests: Vec<String> = serde_json::from_str(local.stdout.trim()).unwrap_or_default();
    if local_digests.is_empty() {
        return Ok(DockerImageUpdate {
            reference: image_reference,
            status: "unknown".to_string(),
            local_digests,
            remote_digest: None,
            reason: Some("本地镜像没有可比较的仓库 digest，可能由本机构建".to_string()),
            checked_at,
        });
    }
    let remote = exec(
        &client,
        &docker_command(
            &target,
            &[
                "buildx",
                "imagetools",
                "inspect",
                &image_reference,
                "--format",
                "{{json .Manifest}}",
            ],
        ),
        Duration::from_secs(60),
    )
    .await?;
    if !successful(&remote) {
        return Ok(DockerImageUpdate {
            reference: image_reference,
            status: "unknown".to_string(),
            local_digests,
            remote_digest: None,
            reason: Some(format!(
                "无法读取镜像仓库元数据: {}",
                failure_message(&remote)
            )),
            checked_at,
        });
    }
    let manifest: Value = match serde_json::from_str(remote.stdout.trim()) {
        Ok(value) => value,
        Err(error) => {
            return Ok(DockerImageUpdate {
                reference: image_reference,
                status: "unknown".to_string(),
                local_digests,
                remote_digest: None,
                reason: Some(format!("无法解析镜像仓库元数据: {error}")),
                checked_at,
            });
        }
    };
    let remote_digest = manifest
        .get("digest")
        .or_else(|| manifest.get("Digest"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(remote_digest) = remote_digest else {
        return Ok(DockerImageUpdate {
            reference: image_reference,
            status: "unknown".to_string(),
            local_digests,
            remote_digest: None,
            reason: Some("仓库未返回可比较的 manifest digest".to_string()),
            checked_at,
        });
    };
    let current = local_digests
        .iter()
        .any(|digest| digest.ends_with(&format!("@{remote_digest}")));
    Ok(DockerImageUpdate {
        reference: image_reference,
        status: if current {
            "current"
        } else {
            "updateAvailable"
        }
        .to_string(),
        local_digests,
        remote_digest: Some(remote_digest),
        reason: None,
        checked_at,
    })
}

#[tauri::command]
pub async fn docker_remove_resource(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    kind: String,
    resource_id: String,
) -> Result<DockerResourceRemoveResult, String> {
    validate_resource_id(&resource_id)?;
    let operation_lease = state.docker.acquire_operation(&session_id)?;
    if state.maintenance.get_active_task(&session_id)?.is_some() {
        return Err("当前 SSH 会话已有维护任务正在执行".to_string());
    }
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    verify_engine(&client, &target).await?;

    let (resolved_id, reference_command, remove_arguments, noun) = match kind.as_str() {
        "image" => {
            let inspect = exec(
                &client,
                &docker_command(&target, &["image", "inspect", &resource_id]),
                QUERY_TIMEOUT,
            )
            .await?;
            if !successful(&inspect) {
                return Err(failure_message(&inspect));
            }
            let values: Vec<Value> = serde_json::from_str(&inspect.stdout)
                .map_err(|error| format!("无法解析镜像详情: {error}"))?;
            let id = values
                .first()
                .map(|value| value_string(value, "Id"))
                .unwrap_or_default();
            validate_resource_id(&id)?;
            (
                id.clone(),
                docker_command(
                    &target,
                    &[
                        "ps",
                        "-a",
                        "--filter",
                        &format!("ancestor={id}"),
                        "--format",
                        "{{.ID}}",
                    ],
                ),
                vec!["image".to_string(), "rm".to_string(), id],
                "镜像",
            )
        }
        "volume" => {
            let inspect = exec(
                &client,
                &docker_command(&target, &["volume", "inspect", &resource_id]),
                QUERY_TIMEOUT,
            )
            .await?;
            if !successful(&inspect) {
                return Err(failure_message(&inspect));
            }
            let values: Vec<Value> = serde_json::from_str(&inspect.stdout)
                .map_err(|error| format!("无法解析卷详情: {error}"))?;
            let name = values
                .first()
                .map(|value| value_string(value, "Name"))
                .unwrap_or_default();
            validate_resource_id(&name)?;
            (
                name.clone(),
                docker_command(
                    &target,
                    &[
                        "ps",
                        "-a",
                        "--filter",
                        &format!("volume={name}"),
                        "--format",
                        "{{.ID}}",
                    ],
                ),
                vec!["volume".to_string(), "rm".to_string(), name],
                "卷",
            )
        }
        _ => return Err("仅支持删除明确选择的镜像或卷".to_string()),
    };
    let references = exec(&client, &reference_command, QUERY_TIMEOUT).await?;
    if !successful(&references) {
        return Err(failure_message(&references));
    }
    if !references.stdout.trim().is_empty() {
        return Err(format!("{noun}仍被容器引用，不能删除"));
    }
    let argument_refs: Vec<&str> = remove_arguments.iter().map(String::as_str).collect();
    let command = docker_command(&target, &argument_refs);
    request_approval(
        &app_handle,
        &state,
        &session_id,
        &command,
        &if kind == "volume" {
            format!("Docker 管理 · 删除卷（未挂载仍可能含业务数据） · {resolved_id}")
        } else {
            format!("Docker 管理 · 删除{noun} · {resolved_id}")
        },
        operation_lease.cancel_token(),
    )
    .await?;
    verify_engine(&client, &target).await?;
    let references = exec(&client, &reference_command, QUERY_TIMEOUT).await?;
    if !successful(&references) || !references.stdout.trim().is_empty() {
        return Err(format!("{noun}引用在确认期间发生变化，删除已取消"));
    }
    let inspect_command = if kind == "image" {
        docker_command(&target, &["image", "inspect", &resolved_id])
    } else {
        docker_command(&target, &["volume", "inspect", &resolved_id])
    };
    let record = DockerOperationRecord::start(
        &app_handle,
        &state,
        &client,
        &session_id,
        &format!("删除 Docker {noun}: {resolved_id}"),
        &inspect_command,
        operation_lease.cancel_token(),
    )
    .await?;
    let operation_cancel = record.cancel_token();
    record.start_change(&command)?;
    let result = match exec_with_cancel(
        &client,
        &command,
        Duration::from_secs(120),
        operation_cancel.clone(),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            record.fail(&error);
            return Err(error);
        }
    };
    record.finish_change(&result)?;
    if !successful(&result) {
        let error = failure_message(&result);
        record.fail(&error);
        return Err(error);
    }
    record.start_verify(&inspect_command)?;
    let inspect_arguments = if kind == "image" {
        vec!["image", "inspect", resolved_id.as_str()]
    } else {
        vec!["volume", "inspect", resolved_id.as_str()]
    };
    let check = exec_with_cancel(
        &client,
        &docker_command(&target, &inspect_arguments),
        QUERY_TIMEOUT,
        operation_cancel.clone(),
    )
    .await
    .map_err(|error| {
        let _ = record.finish_verify(false, None);
        record.fail(&error);
        error
    })?;
    if !reports_not_found(&check) {
        let error = if successful(&check) {
            format!("删除命令已完成，但{noun}仍然存在")
        } else {
            format!("删除后无法确认{noun}状态: {}", failure_message(&check))
        };
        let _ = record.finish_verify(false, check.exit_code);
        record.fail(&error);
        return Err(error);
    }
    record.finish_verify(true, Some(0))?;
    let verification = format!("{noun}已不存在");
    record.succeed(&verification)?;
    Ok(DockerResourceRemoveResult {
        kind,
        resource_id: resolved_id,
        verification,
    })
}

async fn inspect_container_value(
    client: &SshClient,
    target: &DockerTarget,
    container_id: &str,
) -> Result<Value, String> {
    inspect_container_value_with_cancel(client, target, container_id, CancellationToken::new())
        .await
}

async fn inspect_container_value_with_cancel(
    client: &SshClient,
    target: &DockerTarget,
    container_id: &str,
    cancel: CancellationToken,
) -> Result<Value, String> {
    let result = exec_with_cancel(
        client,
        &docker_command(target, &["inspect", "--type", "container", container_id]),
        QUERY_TIMEOUT,
        cancel,
    )
    .await?;
    if !successful(&result) {
        return Err(failure_message(&result));
    }
    if result.truncated {
        return Err("容器详情过大，无法安全展示".to_string());
    }
    let documents: Vec<Value> = serde_json::from_str(&result.stdout)
        .map_err(|error| format!("无法解析容器详情: {error}"))?;
    documents
        .into_iter()
        .next()
        .ok_or_else(|| "Docker 未返回容器详情".to_string())
}

async fn request_approval(
    app_handle: &AppHandle,
    state: &TerminalState,
    session_id: &str,
    command: &str,
    source: &str,
    cancel: CancellationToken,
) -> Result<(), String> {
    let (pending, rx) = state
        .approval
        .manager
        .submit_deferred(
            session_id.to_string(),
            command.to_string(),
            source.to_string(),
        )
        .await;
    let request_id = pending.request_id.clone();
    if let Err(error) = app_handle.emit(
        "terminal-exec-request",
        serde_json::json!({
            "requestId": pending.request_id,
            "sessionId": pending.session_id,
            "command": pending.command,
            "source": pending.source,
        }),
    ) {
        let _ = state
            .approval
            .manager
            .respond(
                &request_id,
                ApprovalVerdict::Rejected {
                    reason: "无法打开确认窗口".to_string(),
                },
            )
            .await;
        return Err(format!("无法打开操作确认: {error}"));
    }
    tokio::select! {
        verdict = rx => match verdict {
            Ok(ApprovalVerdict::Approved) => Ok(()),
            Ok(ApprovalVerdict::Rejected { reason }) => Err(format!("Docker 操作已拒绝: {reason}")),
            Err(_) => Err("Docker 操作确认通道已关闭".to_string()),
        },
        _ = tokio::time::sleep(Duration::from_secs(300)) => {
            let _ = state
                .approval
                .manager
                .respond(
                    &request_id,
                    ApprovalVerdict::Rejected {
                        reason: "确认超时".to_string(),
                    },
                )
                .await;
            Err("等待 Docker 操作确认超时".to_string())
        }
        _ = cancel.cancelled() => {
            let _ = state
                .approval
                .manager
                .respond(
                    &request_id,
                    ApprovalVerdict::Rejected {
                        reason: "SSH 会话已断开".to_string(),
                    },
                )
                .await;
            Err("SSH 会话已断开，Docker 操作已取消".to_string())
        }
    }
}

#[tauri::command]
pub async fn docker_container_action(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    container_id: String,
    action: String,
) -> Result<DockerActionResult, String> {
    validate_container_id(&container_id)?;
    let operation_lease = state.docker.acquire_operation(&session_id)?;
    if state.maintenance.get_active_task(&session_id)?.is_some() {
        return Err("当前 SSH 会话已有维护任务正在执行".to_string());
    }
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    verify_engine(&client, &target).await?;

    let before = inspect_container_value(&client, &target, &container_id).await?;
    let full_id = value_string(&before, "Id");
    let name = value_string(&before, "Name")
        .trim_start_matches('/')
        .to_string();
    validate_container_id(&full_id)?;
    let running = before
        .pointer("/State/Running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if action == "remove" && running {
        return Err("运行中的容器不能直接删除，请先停止容器".to_string());
    }

    let arguments: Vec<&str> = match action.as_str() {
        "start" => vec!["start", &full_id],
        "stop" => vec!["stop", "--time", "10", &full_id],
        "restart" => vec!["restart", "--time", "10", &full_id],
        "remove" => vec!["rm", &full_id],
        _ => return Err("不支持的容器操作".to_string()),
    };
    let command = docker_command(&target, &arguments);
    if matches!(action.as_str(), "stop" | "restart" | "remove") {
        request_approval(
            &app_handle,
            &state,
            &session_id,
            &command,
            &format!("Docker 管理 · {action} · {name}"),
            operation_lease.cancel_token(),
        )
        .await?;
        verify_engine(&client, &target).await?;
        let current = inspect_container_value(&client, &target, &full_id).await?;
        if value_string(&current, "Id") != full_id {
            return Err("容器目标已变化，请刷新后重试".to_string());
        }
        if action == "remove"
            && current
                .pointer("/State/Running")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err("容器在确认期间已启动，删除已取消".to_string());
        }
    }

    let inspect_command = docker_command(&target, &["inspect", "--type", "container", &full_id]);
    let record = DockerOperationRecord::start(
        &app_handle,
        &state,
        &client,
        &session_id,
        &format!("Docker 容器 {action}: {name}"),
        &inspect_command,
        operation_lease.cancel_token(),
    )
    .await?;
    let operation_cancel = record.cancel_token();
    record.start_change(&command)?;
    let result = match exec_with_cancel(
        &client,
        &command,
        Duration::from_secs(120),
        operation_cancel.clone(),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            record.fail(&error);
            return Err(error);
        }
    };
    record.finish_change(&result)?;
    if !successful(&result) {
        let error = failure_message(&result);
        record.fail(&error);
        return Err(error);
    }
    record.start_verify(&inspect_command)?;
    let verification = if action == "remove" {
        let check = match exec_with_cancel(
            &client,
            &inspect_command,
            QUERY_TIMEOUT,
            operation_cancel.clone(),
        )
        .await
        {
            Ok(check) => check,
            Err(error) => {
                let _ = record.finish_verify(false, None);
                record.fail(&error);
                return Err(error);
            }
        };
        if !reports_not_found(&check) {
            let error = if successful(&check) {
                "删除命令已完成，但容器仍然存在".to_string()
            } else {
                format!("删除后无法确认容器状态: {}", failure_message(&check))
            };
            let _ = record.finish_verify(false, check.exit_code);
            record.fail(&error);
            return Err(error);
        }
        record.finish_verify(true, Some(0))?;
        "容器已不存在".to_string()
    } else {
        let after = match inspect_container_value_with_cancel(
            &client,
            &target,
            &full_id,
            operation_cancel.clone(),
        )
        .await
        {
            Ok(after) => after,
            Err(error) => {
                let _ = record.finish_verify(false, None);
                record.fail(&error);
                return Err(error);
            }
        };
        let after_running = after
            .pointer("/State/Running")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let expected_running = action != "stop";
        if after_running != expected_running {
            let error = "Docker 命令退出成功，但容器状态复检未通过".to_string();
            let _ = record.finish_verify(false, Some(0));
            record.fail(&error);
            return Err(error);
        }
        record.finish_verify(true, Some(0))?;
        if after_running {
            "容器正在运行".to_string()
        } else {
            "容器已停止".to_string()
        }
    };
    record.succeed(&verification)?;
    Ok(DockerActionResult {
        action,
        container_id: full_id,
        container_name: name,
        exit_code: result.exit_code,
        duration_ms: result.duration_ms,
        verification,
    })
}

#[tauri::command]
pub async fn docker_subscribe_logs(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    container_id: String,
    tail: Option<u32>,
) -> Result<String, String> {
    validate_container_id(&container_id)?;
    let tail = tail.unwrap_or(200).clamp(1, 5_000).to_string();
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    let full_id = value_string(
        &inspect_container_value(&client, &target, &container_id).await?,
        "Id",
    );
    let subscription_id = uuid::Uuid::new_v4().to_string();
    let token = CancellationToken::new();
    state.docker.subscriptions.write().await.insert(
        subscription_id.clone(),
        DockerSubscription {
            session_id: session_id.clone(),
            token: token.clone(),
        },
    );
    let command = docker_command(
        &target,
        &[
            "logs",
            "--timestamps",
            "--follow",
            "--tail",
            &tail,
            &full_id,
        ],
    );
    let docker_state = state.docker.clone();
    let app = app_handle.clone();
    let emitted_subscription_id = subscription_id.clone();
    tokio::spawn(async move {
        let _ = client
            .exec_command_streaming(
                &command,
                Duration::from_secs(24 * 60 * 60),
                token,
                |stream, data| {
                    let _ = app.emit(
                        "docker-log-output",
                        DockerLogEvent {
                            subscription_id: emitted_subscription_id.clone(),
                            session_id: session_id.clone(),
                            container_id: full_id.clone(),
                            stream: match stream {
                                ExecOutputStream::Stdout => "stdout".to_string(),
                                ExecOutputStream::Stderr => "stderr".to_string(),
                            },
                            data: data.to_string(),
                        },
                    );
                },
            )
            .await;
        docker_state
            .subscriptions
            .write()
            .await
            .remove(&emitted_subscription_id);
        let _ = app.emit(
            "docker-log-ended",
            serde_json::json!({ "subscriptionId": emitted_subscription_id }),
        );
    });
    Ok(subscription_id)
}

#[tauri::command]
pub async fn docker_unsubscribe_logs(
    state: State<'_, TerminalState>,
    subscription_id: String,
) -> Result<(), String> {
    let subscription = state
        .docker
        .subscriptions
        .write()
        .await
        .remove(&subscription_id)
        .ok_or("日志订阅不存在或已结束")?;
    subscription.token.cancel();
    Ok(())
}

#[tauri::command]
pub async fn docker_subscribe_compose_events(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    config_file: String,
    project_name: Option<String>,
) -> Result<String, String> {
    if let Some(name) = project_name.as_deref() {
        validate_resource_id(name)?;
    }
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    let sftp = client
        .open_sftp()
        .await
        .map_err(|error| format!("无法打开 SFTP 通道: {error}"))?;
    let current = read_compose_file_from_sftp(&sftp, &config_file).await?;
    let mut arguments = compose_prefix(
        &current.working_directory,
        &current.resolved_path,
        project_name.as_deref(),
    );
    arguments.extend(["events", "--json"]);
    let command = docker_command(&target, &arguments);
    let subscription_id = uuid::Uuid::new_v4().to_string();
    let token = CancellationToken::new();
    state.docker.subscriptions.write().await.insert(
        subscription_id.clone(),
        DockerSubscription {
            session_id: session_id.clone(),
            token: token.clone(),
        },
    );
    let docker_state = state.docker.clone();
    let app = app_handle.clone();
    let emitted_subscription_id = subscription_id.clone();
    let event_project_name = project_name.unwrap_or_default();
    tokio::spawn(async move {
        let _ = client
            .exec_command_streaming(
                &command,
                Duration::from_secs(24 * 60 * 60),
                token,
                |stream, data| {
                    let _ = app.emit(
                        "docker-compose-event",
                        DockerComposeEvent {
                            subscription_id: emitted_subscription_id.clone(),
                            session_id: session_id.clone(),
                            project_name: event_project_name.clone(),
                            stream: match stream {
                                ExecOutputStream::Stdout => "stdout".to_string(),
                                ExecOutputStream::Stderr => "stderr".to_string(),
                            },
                            data: data.to_string(),
                        },
                    );
                },
            )
            .await;
        docker_state
            .subscriptions
            .write()
            .await
            .remove(&emitted_subscription_id);
        let _ = app.emit(
            "docker-compose-event-ended",
            serde_json::json!({ "subscriptionId": emitted_subscription_id }),
        );
    });
    Ok(subscription_id)
}

#[tauri::command]
pub async fn docker_unsubscribe_stream(
    state: State<'_, TerminalState>,
    subscription_id: String,
) -> Result<(), String> {
    docker_unsubscribe_logs(state, subscription_id).await
}

#[tauri::command]
pub async fn docker_open_container_terminal(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    container_id: String,
    cols: u32,
    rows: u32,
) -> Result<String, String> {
    validate_container_id(&container_id)?;
    let (client, _, _) = ssh_client(&state, &session_id).await?;
    let target = cached_target(&state, &session_id).await?;
    verify_engine(&client, &target).await?;
    let inspected = inspect_container_value(&client, &target, &container_id).await?;
    if !inspected
        .pointer("/State/Running")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("只能进入运行中的容器".to_string());
    }
    let full_id = value_string(&inspected, "Id");
    validate_container_id(&full_id)?;
    let bash = exec(
        &client,
        &docker_command(&target, &["exec", &full_id, "/bin/bash", "-lc", "exit 0"]),
        QUERY_TIMEOUT,
    )
    .await?;
    let shell = if successful(&bash) {
        "/bin/bash"
    } else {
        let sh = exec(
            &client,
            &docker_command(&target, &["exec", &full_id, "/bin/sh", "-lc", "exit 0"]),
            QUERY_TIMEOUT,
        )
        .await?;
        if !successful(&sh) {
            return Err("容器未提供可用的 bash 或 sh".to_string());
        }
        "/bin/sh"
    };
    let command = docker_command(
        &target,
        &["exec", "--interactive", "--tty", &full_id, shell],
    );
    let channel = client
        .handle
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(|error| format!("无法打开容器终端通道: {error}"))?;
    channel
        .request_pty(
            false,
            "xterm-256color",
            cols.clamp(2, 500),
            rows.clamp(2, 500),
            0,
            0,
            &[],
        )
        .await
        .map_err(|error| format!("无法初始化容器终端: {error}"))?;
    channel
        .exec(true, command)
        .await
        .map_err(|error| format!("无法进入容器终端: {error}"))?;
    let (read_half, write_half) = channel.split();
    let terminal_id = uuid::Uuid::new_v4().to_string();
    let writer = Arc::new(Mutex::new(Some(write_half)));
    state.docker.terminals.write().await.insert(
        terminal_id.clone(),
        DockerTerminal {
            session_id: session_id.clone(),
            writer,
        },
    );
    let app = app_handle.clone();
    let docker_state = state.docker.clone();
    let emitted_terminal_id = terminal_id.clone();
    tokio::spawn(async move {
        let mut reader = read_half;
        let mut exit_code = None;
        loop {
            match reader.wait().await {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let _ = app.emit(
                        "docker-terminal-output",
                        DockerTerminalEvent {
                            terminal_id: emitted_terminal_id.clone(),
                            session_id: session_id.clone(),
                            container_id: full_id.clone(),
                            data: String::from_utf8_lossy(&data).to_string(),
                        },
                    );
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
        docker_state
            .terminals
            .write()
            .await
            .remove(&emitted_terminal_id);
        let _ = app.emit(
            "docker-terminal-ended",
            serde_json::json!({
                "terminalId": emitted_terminal_id,
                "exitCode": exit_code,
            }),
        );
    });
    Ok(terminal_id)
}

#[tauri::command]
pub async fn docker_write_container_terminal(
    state: State<'_, TerminalState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > 64 * 1024 {
        return Err("单次容器终端输入过大".to_string());
    }
    let terminal = state
        .docker
        .terminals
        .read()
        .await
        .get(&terminal_id)
        .cloned()
        .ok_or("容器终端已关闭")?;
    let guard = terminal.writer.lock().await;
    let writer = guard.as_ref().ok_or("容器终端已关闭")?;
    writer
        .data_bytes(data.into_bytes())
        .await
        .map_err(|error| format!("容器终端写入失败: {error}"))
}

#[tauri::command]
pub async fn docker_resize_container_terminal(
    state: State<'_, TerminalState>,
    terminal_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let terminal = state
        .docker
        .terminals
        .read()
        .await
        .get(&terminal_id)
        .cloned()
        .ok_or("容器终端已关闭")?;
    let guard = terminal.writer.lock().await;
    let writer = guard.as_ref().ok_or("容器终端已关闭")?;
    writer
        .window_change(cols.clamp(2, 500), rows.clamp(2, 500), 0, 0)
        .await
        .map_err(|error| format!("容器终端调整失败: {error}"))
}

#[tauri::command]
pub async fn docker_close_container_terminal(
    state: State<'_, TerminalState>,
    terminal_id: String,
) -> Result<(), String> {
    let terminal = state
        .docker
        .terminals
        .write()
        .await
        .remove(&terminal_id)
        .ok_or("容器终端已关闭")?;
    if let Some(writer) = terminal.writer.lock().await.as_ref() {
        writer
            .close()
            .await
            .map_err(|error| format!("关闭容器终端失败: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_shell_arguments_without_leaking_metacharacters() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("a'b;$(touch x)"), "'a'\"'\"'b;$(touch x)'");
    }

    #[test]
    fn parses_container_rows_and_keeps_only_compose_project_label() {
        let input = r#"{"ID":"abc","Names":"web","Image":"nginx:1","Status":"Up 1m","Ports":"80/tcp","Mounts":"data","Networks":"app","CreatedAt":"today","RunningFor":"1m","Command":"nginx","Labels":"secret=value,com.docker.compose.project=demo"}"#;
        let rows = parse_containers(input).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].compose_project.as_deref(), Some("demo"));
        assert_eq!(rows[0].name, "web");
        assert_eq!(rows[0].state, "running");
        assert!(rows[0].size.is_empty());
    }

    #[test]
    fn rejects_non_local_docker_contexts() {
        assert_eq!(
            parse_endpoint("\"unix:///var/run/docker.sock\"\n").unwrap(),
            "unix:///var/run/docker.sock"
        );
        assert!(parse_endpoint("\"ssh://other-host\"").is_err());
        assert!(parse_endpoint("\"tcp://10.0.0.2:2376\"").is_err());
    }

    #[test]
    fn truncates_at_a_utf8_boundary() {
        let (value, truncated) = truncate_utf8("你好abc", 5);
        assert_eq!(value, "你");
        assert!(truncated);
    }

    #[test]
    fn validates_container_identifiers() {
        assert!(validate_container_id("web-1.example").is_ok());
        assert!(validate_container_id("web; rm -rf /").is_err());
    }

    #[test]
    fn validates_linux_compose_paths_on_windows_builds() {
        assert!(validate_compose_path("/opt/app/compose.yaml").is_ok());
        assert_eq!(remote_parent("/opt/app/compose.yaml").unwrap(), "/opt/app");
        assert_eq!(remote_parent("/compose.yml").unwrap(), "/");
        assert!(validate_compose_path("C:\\app\\compose.yaml").is_err());
        assert!(validate_compose_path("/opt/app/compose.txt").is_err());
        assert!(validate_compose_path("/opt/app/compose.yaml\nrm -rf /").is_err());
    }

    #[test]
    fn validates_precise_resource_ids() {
        assert!(validate_resource_id("docker.io/library/nginx:1.27@sha256:abc").is_ok());
        assert!(validate_resource_id("name; docker system prune").is_err());
    }

    #[test]
    fn deletion_verification_requires_an_explicit_not_found_response() {
        let result = |exit_code, stderr: &str| StructuredExecResult {
            stdout: String::new(),
            stderr: stderr.to_string(),
            exit_code,
            duration_ms: 1,
            timed_out: false,
            cancelled: false,
            truncated: false,
        };
        assert!(reports_not_found(&result(
            Some(1),
            "Error: No such container: abc"
        )));
        assert!(!reports_not_found(&result(None, "connection closed")));
        assert!(!reports_not_found(&result(Some(1), "permission denied")));
    }

    #[test]
    fn compose_postconditions_reject_failed_or_unready_services() {
        let running = r#"[{"Name":"web","State":"running","Health":"healthy"}]"#;
        assert!(matches!(
            evaluate_compose_postcondition("up", running).unwrap(),
            ComposePostcondition::Satisfied(_)
        ));
        let exited = r#"[{"Name":"web","State":"exited","ExitCode":1}]"#;
        assert!(matches!(
            evaluate_compose_postcondition("up", exited).unwrap(),
            ComposePostcondition::Failed(_)
        ));
        let starting = r#"[{"Name":"web","State":"running","Health":"starting"}]"#;
        assert!(matches!(
            evaluate_compose_postcondition("up", starting).unwrap(),
            ComposePostcondition::Pending(_)
        ));
        assert!(matches!(
            evaluate_compose_postcondition("down", "[]").unwrap(),
            ComposePostcondition::Satisfied(_)
        ));
        assert!(matches!(
            evaluate_compose_postcondition("up", "[]").unwrap(),
            ComposePostcondition::Failed(_)
        ));
        let stopped = r#"[{"Name":"web","State":"exited","ExitCode":0}]"#;
        assert!(matches!(
            evaluate_compose_postcondition("stop", stopped).unwrap(),
            ComposePostcondition::Satisfied(_)
        ));
        assert!(matches!(
            evaluate_compose_postcondition("stop", running).unwrap(),
            ComposePostcondition::Pending(_)
        ));
    }

    #[test]
    fn complex_compose_features_are_read_only() {
        let features = unsupported_compose_features(
            "services:\n  web:\n    build: .\n    profiles: [dev]\n    env_file: .env.prod\n",
        );
        assert_eq!(features, vec!["build", "profiles", "env_file"]);
    }

    #[tokio::test]
    async fn cancelling_a_session_signals_the_active_operation_without_unlocking_early() {
        let state = DockerState::new();
        let lease = state.acquire_operation("session-1").unwrap();
        let token = lease.cancel_token();

        state.cancel_session("session-1").await;

        assert!(token.is_cancelled());
        assert!(state.acquire_operation("session-1").is_err());
        drop(lease);
        assert!(state.acquire_operation("session-1").is_ok());
    }
}
