use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{Emitter, State};
use tokio::sync::mpsc;
use tokio::time::{Duration, MissedTickBehavior};

const COMPLETED_LIMIT: usize = 64;
const REQUEST_TIMEOUT_SECS: u64 = 25;

fn prefer_canvas_response(first: Value, next: Option<Value>) -> Value {
    match next {
        Some(candidate) if candidate.get("ok").and_then(Value::as_bool) == Some(true) => candidate,
        _ => first,
    }
}

fn should_redispatch(request: &Value) -> bool {
    matches!(
        request.get("action").and_then(Value::as_str),
        Some("open")
    )
}

fn canvas_activation_payload(request: &Value) -> Option<Value> {
    let canvas_id = request.get("canvasId").and_then(Value::as_str)?;
    let path = request.get("path").and_then(Value::as_str);
    Some(serde_json::json!({ "canvasId": canvas_id, "path": path }))
}

/// Re-emitted with open requests so a listener mounted during session restore cannot miss activation.
fn activate_canvas_sidebar(app: &tauri::AppHandle, request: &Value) {
    let Some(payload) = canvas_activation_payload(request) else {
        return;
    };
    let _ = app.emit(
        "canvas-agent-activate-sidebar",
        payload,
    );
}

#[derive(Default)]
pub struct CanvasAgentBridgeState {
    pending: Mutex<HashMap<String, PendingCanvasRequest>>,
    completed: Mutex<HashMap<String, Value>>,
    completion_order: Mutex<VecDeque<String>>,
}

struct PendingCanvasRequest {
    sender: mpsc::UnboundedSender<Value>,
    stage: String,
    started: Instant,
}

impl CanvasAgentBridgeState {
    pub async fn submit(&self, app: &tauri::AppHandle, mut request: Value) -> Result<Value, String> {
        let request_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or("Missing requestId")?
            .to_string();

        if let Some(result) = self
            .completed
            .lock()
            .map_err(|error| error.to_string())?
            .get(&request_id)
            .cloned()
        {
            return Ok(result);
        }

        let (sender, mut receiver) = mpsc::unbounded_channel();
        {
            let mut pending = self.pending.lock().map_err(|error| error.to_string())?;
            if pending.contains_key(&request_id) {
                return Err(format!("Canvas request already pending: {request_id}"));
            }
            pending.insert(request_id.clone(), PendingCanvasRequest {
                sender,
                stage: "dispatch".into(),
                started: Instant::now(),
            });
        }

        let timeout_millis = request
            .get("timeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(REQUEST_TIMEOUT_SECS * 1000)
            .clamp(1_000, REQUEST_TIMEOUT_SECS * 1000);
        request["deadlineMs"] = Value::from(
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
                + timeout_millis,
        );
        log::info!("[canvas] request={} action={} stage=dispatch", request_id, request["action"]);
        if should_redispatch(&request) {
            activate_canvas_sidebar(app, &request);
        }
        if let Err(error) = app.emit("canvas-agent-request", &request) {
            self.pending
                .lock()
                .map_err(|lock_error| lock_error.to_string())?
                .remove(&request_id);
            return Err(format!("Failed to dispatch canvas request: {error}"));
        }

        let redispatch = should_redispatch(&request);
        let deadline = tokio::time::sleep(Duration::from_millis(timeout_millis));
        tokio::pin!(deadline);
        let mut retry_tick = tokio::time::interval(Duration::from_millis(400));
        retry_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        retry_tick.tick().await;
        let first = loop {
            tokio::select! {
                response = receiver.recv() => match response {
                    Some(result) => break result,
                    None => return Err("Canvas editor response channel closed".to_string()),
                },
                _ = retry_tick.tick(), if redispatch => {
                    let waiting = self.pending.lock().map_err(|e| e.to_string())?
                        .get(&request_id).is_some_and(|pending| pending.stage == "dispatch");
                    if waiting {
                        activate_canvas_sidebar(app, &request);
                        let _ = app.emit("canvas-agent-request", &request);
                    }
                },
                _ = &mut deadline => {
                    let pending = self.pending
                        .lock()
                        .map_err(|error| error.to_string())?
                        .remove(&request_id);
                    let stage = pending.map(|pending| pending.stage).unwrap_or_default();
                    let _ = app.emit("canvas-agent-cancel", serde_json::json!({"requestId": request_id}));
                    log::warn!("[canvas] request={} stage={} timeout_ms={}", request_id, stage, timeout_millis);
                    return Err(format!("Canvas request timed out at stage {stage}"));
                }
            }
        };
        let result = if first.get("ok").and_then(Value::as_bool) == Some(true) {
            first
        } else {
            let next = match tokio::time::timeout(
                std::time::Duration::from_millis(250),
                receiver.recv(),
            )
            .await
            {
                Ok(Some(next)) => Some(next),
                _ => None,
            };
            prefer_canvas_response(first, next)
        };
        let pending = self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&request_id);

        log::info!("[canvas] request={} stage=response status={} elapsed_ms={}", request_id,
            result["status"], pending.map(|p| p.started.elapsed().as_millis()).unwrap_or_default());

        // Image responses can be large and are never automatically replayed.
        if result.get("visualData").is_some() || result.get("data").is_some() {
            return Ok(result);
        }

        self.completed
            .lock()
            .map_err(|error| error.to_string())?
            .insert(request_id.clone(), result.clone());
        let evicted = {
            let mut order = self
                .completion_order
                .lock()
                .map_err(|error| error.to_string())?;
            order.push_back(request_id);
            if order.len() > COMPLETED_LIMIT {
                order.pop_front()
            } else {
                None
            }
        };
        if let Some(evicted) = evicted {
            self.completed
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&evicted);
        }
        Ok(result)
    }
}

#[tauri::command]
pub async fn canvas_agent_respond(
    state: State<'_, CanvasAgentBridgeState>,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    let sender = state
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .get(&request_id)
        .map(|pending| pending.sender.clone());
    if let Some(sender) = sender {
        let _ = sender.send(result);
    } else {
        log::debug!("[canvas] request={} late response ignored", request_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn canvas_agent_stage(
    state: State<'_, CanvasAgentBridgeState>,
    request_id: String,
    stage: String,
) -> Result<(), String> {
    if !matches!(stage.as_str(), "received" | "parsed" | "committed" | "inspect" | "export") {
        return Err("Unknown canvas request stage".into());
    }
    if let Some(pending) = state.pending.lock().map_err(|e| e.to_string())?.get_mut(&request_id) {
        pending.stage = stage;
        log::info!("[canvas] request={} stage={} elapsed_ms={}", request_id, pending.stage,
            pending.started.elapsed().as_millis());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_starts_empty() {
        let state = CanvasAgentBridgeState::default();
        assert!(state.pending.lock().unwrap().is_empty());
        assert!(state.completed.lock().unwrap().is_empty());
    }

    #[test]
    fn successful_editor_response_wins_over_early_conflict() {
        let conflict = serde_json::json!({"ok": false, "status": "conflict"});
        let applied = serde_json::json!({"ok": true, "status": "applied"});

        assert_eq!(prefer_canvas_response(conflict, Some(applied.clone())), applied);
    }

    #[test]
    fn only_open_is_redispatched_while_editor_mounts() {
        assert!(should_redispatch(&serde_json::json!({"action": "open"})));
        assert!(!should_redispatch(&serde_json::json!({"action": "inspect"})));
        assert!(!should_redispatch(&serde_json::json!({"action": "apply"})));
    }

    #[test]
    fn open_redispatch_carries_the_canvas_path_needed_to_restore_the_sidebar() {
        let payload = canvas_activation_payload(&serde_json::json!({
            "action": "open",
            "canvasId": "canvas-1",
            "path": "C:\\workspace\\canvases\\one.mona-canvas",
        })).unwrap();
        assert_eq!(payload["canvasId"], "canvas-1");
        assert_eq!(payload["path"], "C:\\workspace\\canvases\\one.mona-canvas");
    }
}
