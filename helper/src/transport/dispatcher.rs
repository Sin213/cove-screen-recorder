use anyhow::Result;
use serde_json::json;
use tokio::sync::mpsc;

use crate::engine::SharedState;
use crate::protocol::{
    envelope::{Notification, Request, Response, RpcError},
    events::EngineReadyEvent,
    types::{EngineHealth, EngineState},
    version::{HELPER_VERSION, PROTOCOL_VERSION},
};

#[derive(Clone)]
pub struct Notifier {
    tx: mpsc::Sender<Vec<u8>>,
}

impl Notifier {
    pub fn new() -> (Self, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel(64);
        (Notifier { tx }, rx)
    }

    pub async fn notify(&self, method: &str, params: serde_json::Value) -> Result<()> {
        let n = Notification::new(method, Some(params));
        let bytes = serde_json::to_vec(&n)?;
        self.tx.send(bytes).await?;
        Ok(())
    }

    pub async fn send_response(&self, response: Response) -> Result<()> {
        let bytes = serde_json::to_vec(&response)?;
        self.tx.send(bytes).await?;
        Ok(())
    }

    /// Fires the `engine.ready` notification immediately after a client connects.
    pub async fn send_engine_ready(&self) -> Result<()> {
        let event = EngineReadyEvent {
            helper_version: HELPER_VERSION.to_string(),
            protocol_version: PROTOCOL_VERSION,
            pid: std::process::id(),
            capabilities: vec![],
        };
        self.notify("engine.ready", serde_json::to_value(event)?).await
    }
}

/// Dispatch a request and return Some(response) to send, or None when the
/// response has already been queued (engine.shutdown only).
pub async fn dispatch(req: Request, state: &SharedState, notifier: &Notifier) -> Option<Response> {
    let id = req.id.clone();
    match req.method.as_str() {
        "engine.version" => Some(handle_engine_version(id)),
        "engine.health" => Some(handle_engine_health(id, state)),
        "engine.setLogLevel" => Some(handle_set_log_level(id, req.params, state)),
        "engine.shutdown" => {
            handle_shutdown(id, notifier, state).await;
            None
        }
        method => Some(stub_or_unknown(id, method)),
    }
}

fn handle_engine_version(id: Option<serde_json::Value>) -> Response {
    Response::result(
        id,
        json!({
            "helper_version": HELPER_VERSION,
            "protocol_version": PROTOCOL_VERSION,
        }),
    )
}

fn handle_engine_health(id: Option<serde_json::Value>, state: &SharedState) -> Response {
    let health = EngineHealth {
        state: EngineState::Ready,
        uptime_ms: state.start_time.elapsed().as_millis() as u64,
        active_sessions: 0,
        active_snapshots: 0,
        active_exports: 0,
        last_error_ts: None,
        diagnostics_dir: String::new(),
        rolling_buffer_bytes: 0,
    };
    Response::result(id, serde_json::to_value(health).unwrap_or(json!(null)))
}

fn handle_set_log_level(
    id: Option<serde_json::Value>,
    params: Option<serde_json::Value>,
    state: &SharedState,
) -> Response {
    let level_str = params
        .as_ref()
        .and_then(|p| p.get("level"))
        .and_then(|v| v.as_str())
        .unwrap_or("info");

    let level: tracing::Level = match level_str.parse() {
        Ok(l) => l,
        Err(_) => {
            return Response::error(
                id,
                RpcError::invalid_request(format!("invalid log level: {level_str}")),
            )
        }
    };

    match (state.set_level)(level) {
        Ok(()) => Response::result(id, json!(null)),
        Err(e) => Response::error(id, RpcError::invalid_request(e.to_string())),
    }
}

/// Queues the shutdown response, signals shutdown, then returns so caller breaks.
async fn handle_shutdown(
    id: Option<serde_json::Value>,
    notifier: &Notifier,
    state: &SharedState,
) {
    let resp = Response::result(id, json!({ "ok": true }));
    let _ = notifier.send_response(resp).await;
    let _ = state.shutdown_tx.send(true);
}

fn stub_or_unknown(id: Option<serde_json::Value>, method: &str) -> Response {
    const STUBS: &[&str] = &[
        "engine.diagnosticsBundlePath",
        "capture.listSources",
        "capture.requestSession",
        "capture.startStream",
        "capture.pauseStream",
        "capture.resumeStream",
        "capture.stopSession",
        "capture.setRegion",
        "capture.setFramerateHint",
        "capture.setCursorMode",
        "replay.save",
        "replay.snapshot_release",
        "replay.recoverable_sessions",
        "replay.discard_recovered_session",
        "replay.restore_recovered_session",
        "replay.export_start",
        "replay.export_cancel",
    ];

    if STUBS.contains(&method) {
        Response::error(
            id,
            RpcError {
                code: serde_json::Value::String("not-implemented".into()),
                message: format!("{method}: stub"),
                data: None,
            },
        )
    } else {
        Response::error(id, RpcError::method_not_found())
    }
}
