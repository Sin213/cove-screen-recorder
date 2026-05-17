use serde_json::json;

use crate::engine::SharedState;
use crate::protocol::{
    envelope::{Request, Response, RpcError},
    types::{EngineHealth, EngineState},
    version::{HELPER_VERSION, PROTOCOL_VERSION},
};

pub use super::notifier::Notifier;

/// Dispatch a request and return Some(response) to send, or None when the
/// response has already been queued (engine.shutdown only).
pub async fn dispatch(
    req: Request,
    state: &SharedState,
    notifier: &Notifier,
    sim: Option<&std::sync::Arc<crate::sim::SimState>>,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Option<Response> {
    let id = req.id.clone();
    // Engine lifecycle methods work the same regardless of sim mode.
    match req.method.as_str() {
        "engine.version" => return Some(handle_engine_version(id)),
        "engine.health" => return Some(handle_engine_health(id, state).await),
        "engine.setLogLevel" => return Some(handle_set_log_level(id, req.params, state)),
        "engine.shutdown" => {
            handle_shutdown(id, notifier, state).await;
            return None;
        }
        _ => {}
    }
    if let Some(sim) = sim {
        return crate::sim::dispatch::dispatch_sim(req, state, notifier, sim).await;
    }
    #[cfg(target_os = "linux")]
    if req.method.starts_with("capture.") {
        return Some(
            crate::capture::pipewire::dispatch_capture(req, state, notifier, cancel_rx).await,
        );
    }
    if req.method.starts_with("replay.") {
        return Some(crate::export::dispatch_replay(req, state, notifier).await);
    }
    Some(stub_or_unknown(id, &req.method))
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

async fn handle_engine_health(id: Option<serde_json::Value>, state: &SharedState) -> Response {
    let active_snapshots = state.active_snapshots.lock().await.len() as u32;
    let active_exports = state.active_exports.lock().await.len() as u32;
    let health = EngineHealth {
        state: EngineState::Ready,
        uptime_ms: state.start_time.elapsed().as_millis() as u64,
        active_sessions: 0,
        active_snapshots,
        active_exports,
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
