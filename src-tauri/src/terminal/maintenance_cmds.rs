//! Maintenance task executor (the only execution entry for AI maintenance)
//! plus the frontend query/control Tauri commands.
//!
//! Flow per step: validate task/step → final risk adjudication → plan-level
//! approval gate (approval mode) → mark running → structured SSH execution
//! with timeout/cancel → persist real result → emit full task snapshot.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use crate::terminal::approval::ApprovalVerdict;
use crate::terminal::maintenance::{
    self, MaintenanceEvent, MaintenanceStep, MaintenanceTask, MaintenanceTaskDetail, Risk,
    StepKind, StepStatus, TaskStatus,
};
use crate::terminal::session::SessionHandle;
use crate::terminal::ssh::client::SshClient;
use crate::terminal::TerminalState;

const DEFAULT_STEP_TIMEOUT_SECS: u64 = 120;
const MAX_STEP_TIMEOUT_SECS: u64 = 1800;
const PLAN_APPROVAL_WAIT_SECS: u64 = 300;

/// Commands that pause for explicit per-command approval in every exec mode.
/// Final adjudication happens here at the Rust boundary — the Python side
/// only forwards the exec mode and the command.
const DANGEROUS_PATTERNS: [&str; 7] = [
    "mkfs",
    "dd if=",
    "dd of=",
    "chown -R",
    "shutdown",
    "reboot",
    "init 0",
];

fn dangerous_patterns() -> Vec<String> {
    DANGEROUS_PATTERNS.iter().map(|s| s.to_string()).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStepExecResult {
    pub task_id: String,
    pub step_id: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub cancelled: bool,
}

pub fn emit_task_event(app_handle: &AppHandle, session_id: &str, detail: &MaintenanceTaskDetail) {
    let _ = app_handle.emit(
        "terminal-maintenance-updated",
        MaintenanceEvent {
            session_id: session_id.to_string(),
            task: detail.clone(),
        },
    );
}

fn refresh_and_emit(app_handle: &AppHandle, state: &TerminalState, task_id: &str, session_id: &str) {
    if let Ok(detail) = state.maintenance.get_task(task_id) {
        emit_task_event(app_handle, session_id, &detail);
    }
}

/// Append text to the visible terminal (scroll buffer + live event). Output
/// is shown to the user but never persisted in the maintenance database.
fn echo_to_terminal(app_handle: &AppHandle, client: &SshClient, session_id: &str, data: &str) {
    client.append_buffer(data.to_string());
    let _ = app_handle.emit(
        "terminal-output",
        serde_json::json!({ "sessionId": session_id, "data": data }),
    );
}

// ─── Agent-facing bridge operations ─────────────────────────────────────────

pub async fn bridge_start(
    app_handle: &AppHandle,
    state: &TerminalState,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let session_id = args
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or("Missing sessionId")?;
    let goal = args
        .get("goal")
        .and_then(|v| v.as_str())
        .ok_or("Missing goal")?;
    let exec_mode = args
        .get("execMode")
        .and_then(|v| v.as_str())
        .unwrap_or("auto");
    let steps = parse_steps(args)?;

    let session = state
        .manager
        .get(session_id)
        .await
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    // Only one active task per session — finish/fail/cancel the previous one
    // before starting a new maintenance run.
    if let Some(active) = state.maintenance.get_active_task(session_id)? {
        let _ = state
            .maintenance
            .fail_task(&active.task.id, "被新的维护任务取代");
        emit_task_event(app_handle, session_id, &state.maintenance.get_task(&active.task.id)?);
    }

    let detail = state.maintenance.start_task(
        session_id,
        &session.config_id,
        &session.target_label,
        goal,
        exec_mode,
        &steps,
    )?;
    emit_task_event(app_handle, session_id, &detail);

    Ok(serde_json::json!({
        "taskId": detail.task.id,
        "stepIds": detail.steps.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
    }))
}

pub async fn bridge_finish(
    app_handle: &AppHandle,
    state: &TerminalState,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let task_id = args
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or("Missing taskId")?;
    let diagnosis = args
        .get("diagnosis")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let summary = args
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let detail = state.maintenance.finish_task(task_id, diagnosis, summary)?;
    emit_task_event(app_handle, &detail.task.session_id, &detail);
    Ok(serde_json::json!({ "status": "succeeded" }))
}

pub async fn bridge_fail(
    app_handle: &AppHandle,
    state: &TerminalState,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let task_id = args
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or("Missing taskId")?;
    let error = args
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("AI 放弃继续处理");
    let detail = state.maintenance.fail_task(task_id, error)?;
    emit_task_event(app_handle, &detail.task.session_id, &detail);
    Ok(serde_json::json!({ "status": "failed" }))
}

fn parse_steps(args: &serde_json::Value) -> Result<Vec<(String, StepKind)>, String> {
    let raw = args
        .get("steps")
        .and_then(|v| v.as_array())
        .ok_or("Missing steps array")?;
    let mut out = Vec::with_capacity(raw.len());
    for item in raw {
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or("Step missing title")?
            .to_string();
        let kind = match item.get("kind").and_then(|v| v.as_str()).unwrap_or("inspect") {
            "inspect" => StepKind::Inspect,
            "change" => StepKind::Change,
            "verify" => StepKind::Verify,
            other => return Err(format!("Invalid step kind: {}", other)),
        };
        out.push((title, kind));
    }
    Ok(out)
}

struct StepValidation {
    session_id: String,
    client: Arc<SshClient>,
    step: MaintenanceStep,
    exec_mode: String,
}

/// Validate task ownership, step state and session liveness. Shared by the
/// command and upload execution paths.
async fn validate_step(
    state: &TerminalState,
    task_id: &str,
    step_id: &str,
) -> Result<StepValidation, String> {
    let detail = state.maintenance.get_task(task_id)?;
    if !detail.task.status.is_active() {
        return Err(format!(
            "维护任务已结束（{}），不能继续执行步骤",
            detail.task.status.as_str()
        ));
    }
    let step = detail
        .steps
        .iter()
        .find(|s| s.id == step_id)
        .ok_or_else(|| format!("Step {} not found in task {}", step_id, task_id))?;
    if step.status != StepStatus::Pending {
        return Err("步骤已开始或已结束，不能重复执行".to_string());
    }
    let session_id = detail.task.session_id.clone();
    let client = match state.manager.get_handle(&session_id).await {
        Some(SessionHandle::Ssh(c)) | Some(SessionHandle::Desktop(c)) => c,
        Some(_) => {
            return Err("只有 SSH 和桌面会话支持结构化维护执行（Local Shell 暂未实现）".to_string())
        }
        None => return Err(format!("终端会话 {} 已断开", session_id)),
    };
    Ok(StepValidation {
        session_id,
        client,
        step: step.clone(),
        exec_mode: detail.task.exec_mode.clone(),
    })
}

/// Approval-mode gate: change/verify steps need one plan-level approval
/// (per batch of pending steps) before they may run. Blocks until the user
/// approves via `terminal_maintenance_authorize`, the task is cancelled, or
/// the wait times out.
async fn plan_approval_gate(
    app_handle: &AppHandle,
    state: &TerminalState,
    task_id: &str,
    step_id: &str,
    session_id: &str,
) -> Result<(), String> {
    state
        .maintenance
        .set_task_status(task_id, TaskStatus::WaitingApproval)?;
    refresh_and_emit(app_handle, state, task_id, session_id);

    let deadline = Instant::now() + Duration::from_secs(PLAN_APPROVAL_WAIT_SECS);
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let detail = state.maintenance.get_task(task_id)?;
        if !detail.task.status.is_active() {
            refresh_and_emit(app_handle, state, task_id, session_id);
            return Err("维护任务已取消，步骤不再执行".to_string());
        }
        let approved = detail
            .steps
            .iter()
            .find(|s| s.id == step_id)
            .map(|s| s.approved_at.is_some())
            .unwrap_or(false);
        if approved {
            break;
        }
        if Instant::now() >= deadline {
            return Err("等待变更计划审批超时".to_string());
        }
    }
    state
        .maintenance
        .set_task_status(task_id, TaskStatus::Running)?;
    Ok(())
}

pub async fn bridge_execute_step(
    app_handle: &AppHandle,
    state: &TerminalState,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let task_id = args
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or("Missing taskId")?;
    let step_id = args
        .get("stepId")
        .and_then(|v| v.as_str())
        .ok_or("Missing stepId")?;
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or("Missing command")?;
    let timeout_secs = args.get("timeoutSecs").and_then(|v| v.as_u64());

    let result = execute_step_inner(app_handle, state, task_id, step_id, command, timeout_secs).await?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}

async fn execute_step_inner(
    app_handle: &AppHandle,
    state: &TerminalState,
    task_id: &str,
    step_id: &str,
    command: &str,
    timeout_secs: Option<u64>,
) -> Result<TerminalStepExecResult, String> {
    let v = validate_step(state, task_id, step_id).await?;

    // Final risk adjudication at the Rust execution boundary.
    match maintenance::classify_command(command, &dangerous_patterns()) {
        Risk::Forbidden => {
            let _ = state.maintenance.cancel_pending_step(step_id);
            refresh_and_emit(app_handle, state, task_id, &v.session_id);
            return Err("命令命中禁止规则，已直接阻断".to_string());
        }
        Risk::Dangerous => {
            let (pending, rx) = state
                .approval
                .manager
                .submit(
                    v.session_id.clone(),
                    command.to_string(),
                    "AI Agent".to_string(),
                )
                .await;
            let _ = app_handle.emit(
                "terminal-exec-request",
                serde_json::json!({
                    "requestId": pending.request_id,
                    "sessionId": pending.session_id,
                    "command": pending.command,
                    "source": pending.source,
                }),
            );
            match rx.await {
                Ok(ApprovalVerdict::Approved) => {}
                Ok(ApprovalVerdict::Rejected { reason }) => {
                    let _ = state.maintenance.cancel_pending_step(step_id);
                    refresh_and_emit(app_handle, state, task_id, &v.session_id);
                    return Err(format!("高风险命令被用户拒绝: {}", reason));
                }
                Err(_) => return Err("审批通道已关闭".to_string()),
            }
        }
        Risk::Normal => {}
    }

    // Plan-level approval: change/verify steps in approval mode.
    if v.exec_mode == "approval"
        && v.step.kind != StepKind::Inspect
        && v.step.approved_at.is_none()
    {
        plan_approval_gate(app_handle, state, task_id, step_id, &v.session_id).await?;
    }

    // Mark running (executor-only transition).
    state.maintenance.set_step_running(step_id, command)?;
    state
        .maintenance
        .set_task_status(task_id, TaskStatus::Running)?;
    refresh_and_emit(app_handle, state, task_id, &v.session_id);

    let token = CancellationToken::new();
    state
        .maintenance_cancels
        .write()
        .await
        .insert(task_id.to_string(), token.clone());

    echo_to_terminal(
        app_handle,
        &v.client,
        &v.session_id,
        &format!("\r\n\x1b[36m$ {}\x1b[0m\r\n", command),
    );

    let timeout = Duration::from_secs(
        timeout_secs
            .unwrap_or(DEFAULT_STEP_TIMEOUT_SECS)
            .clamp(1, MAX_STEP_TIMEOUT_SECS),
    );
    let started = Instant::now();
    let exec = match v
        .client
        .exec_command_structured(command, timeout, token, |chunk| {
            echo_to_terminal(
                app_handle,
                &v.client,
                &v.session_id,
                &chunk.replace('\n', "\r\n"),
            );
        })
        .await
    {
        Ok(r) => r,
        Err(e) => {
            state
                .maintenance_cancels
                .write()
                .await
                .remove(task_id);
            let _ = state.maintenance.set_step_result(
                step_id,
                StepStatus::Failed,
                None,
                started.elapsed().as_millis() as i64,
            );
            refresh_and_emit(app_handle, state, task_id, &v.session_id);
            return Err(format!("执行通道错误: {}", e));
        }
    };
    state
        .maintenance_cancels
        .write()
        .await
        .remove(task_id);

    // Only a real exit status of 0 counts as success — timeout, cancel,
    // missing exit code and non-zero exits all fail the step.
    let final_status = if exec.cancelled {
        StepStatus::Cancelled
    } else if exec.timed_out || exec.exit_code != Some(0) {
        StepStatus::Failed
    } else {
        StepStatus::Succeeded
    };
    // After a user cancel the store already finalised the step; ignore the
    // "not running" error in that race.
    let _ = state.maintenance.set_step_result(
        step_id,
        final_status,
        exec.exit_code.map(|c| c as i64),
        exec.duration_ms as i64,
    );
    refresh_and_emit(app_handle, state, task_id, &v.session_id);

    Ok(TerminalStepExecResult {
        task_id: task_id.to_string(),
        step_id: step_id.to_string(),
        stdout: exec.stdout,
        stderr: exec.stderr,
        exit_code: exec.exit_code,
        duration_ms: exec.duration_ms,
        timed_out: exec.timed_out,
        cancelled: exec.cancelled,
    })
}

pub async fn bridge_execute_upload(
    app_handle: &AppHandle,
    state: &TerminalState,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let task_id = args
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or("Missing taskId")?;
    let step_id = args
        .get("stepId")
        .and_then(|v| v.as_str())
        .ok_or("Missing stepId")?;
    let remote_path = args
        .get("remotePath")
        .and_then(|v| v.as_str())
        .ok_or("Missing remotePath")?;
    let content_b64 = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("Missing content (base64)")?;

    let data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, content_b64)
        .map_err(|e| format!("Invalid base64 content: {}", e))?;

    let v = validate_step(state, task_id, step_id).await?;

    if v.exec_mode == "approval"
        && v.step.kind != StepKind::Inspect
        && v.step.approved_at.is_none()
    {
        plan_approval_gate(app_handle, state, task_id, step_id, &v.session_id).await?;
    }

    state
        .maintenance
        .set_step_running(step_id, &format!("upload:{}", remote_path))?;
    state
        .maintenance
        .set_task_status(task_id, TaskStatus::Running)?;
    refresh_and_emit(app_handle, state, task_id, &v.session_id);

    echo_to_terminal(
        app_handle,
        &v.client,
        &v.session_id,
        &format!("\r\n\x1b[36m[upload] → {}\x1b[0m\r\n", remote_path),
    );

    let started = Instant::now();
    let result = async {
        let sftp = v.client.open_sftp().await.map_err(|e| e.to_string())?;
        sftp.write(remote_path, &data)
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    let duration_ms = started.elapsed().as_millis() as i64;

    match result {
        Ok(()) => {
            let _ = state.maintenance.set_step_result(
                step_id,
                StepStatus::Succeeded,
                Some(0),
                duration_ms,
            );
            refresh_and_emit(app_handle, state, task_id, &v.session_id);
            Ok(serde_json::json!({
                "taskId": task_id,
                "stepId": step_id,
                "status": "uploaded",
                "remotePath": remote_path,
                "bytes": data.len(),
                "exitCode": 0,
                "durationMs": duration_ms,
            }))
        }
        Err(e) => {
            let _ = state.maintenance.set_step_result(
                step_id,
                StepStatus::Failed,
                None,
                duration_ms,
            );
            refresh_and_emit(app_handle, state, task_id, &v.session_id);
            Err(format!("上传失败: {}", e))
        }
    }
}

// ─── Frontend query & control commands ──────────────────────────────────────

#[tauri::command]
pub async fn terminal_maintenance_get_active(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<Option<MaintenanceTaskDetail>, String> {
    state.maintenance.get_active_task(&session_id)
}

#[tauri::command]
pub async fn terminal_maintenance_list(
    state: State<'_, TerminalState>,
    config_id: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<MaintenanceTask>, String> {
    state.maintenance.list_tasks(
        config_id.as_deref(),
        status.as_deref(),
        limit.unwrap_or(100),
    )
}

#[tauri::command]
pub async fn terminal_maintenance_get(
    state: State<'_, TerminalState>,
    task_id: String,
) -> Result<MaintenanceTaskDetail, String> {
    state.maintenance.get_task(&task_id)
}

#[tauri::command]
pub async fn terminal_maintenance_authorize(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    task_id: String,
    step_ids: Vec<String>,
) -> Result<MaintenanceTaskDetail, String> {
    state.maintenance.approve_steps(&task_id, &step_ids)?;
    let detail = state.maintenance.get_task(&task_id)?;
    emit_task_event(&app_handle, &detail.task.session_id, &detail);
    Ok(detail)
}

#[tauri::command]
pub async fn terminal_maintenance_cancel(
    app_handle: AppHandle,
    state: State<'_, TerminalState>,
    task_id: String,
) -> Result<MaintenanceTaskDetail, String> {
    let detail = state.maintenance.cancel_task(&task_id)?;
    if let Some(token) = state.maintenance_cancels.write().await.remove(&task_id) {
        token.cancel();
    }
    emit_task_event(&app_handle, &detail.task.session_id, &detail);
    Ok(detail)
}

#[tauri::command]
pub async fn terminal_maintenance_delete(
    state: State<'_, TerminalState>,
    task_id: String,
) -> Result<(), String> {
    state.maintenance.delete_task(&task_id)
}
