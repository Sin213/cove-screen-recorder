pub mod dispatch;

use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc,
};
use tokio::sync::Mutex;

/// Supported failure-injection targets for --simulate-fail.
pub const SUPPORTED_FAIL_TARGETS: &[&str] =
    &["capture.startStream", "encoder.probe", "export", "segment"];

/// Failure specs stored in order so repeated same-target entries are preserved.
/// Note: not Clone — use Arc<SimState> to share.
#[derive(Debug)]
pub struct SimConfig {
    pub encoder: String,
    /// Ordered failure specs consumed front-to-back per target.
    /// Wrapped in a std::sync::Mutex so fail_for can consume without &mut self.
    pub fail_specs: std::sync::Mutex<Vec<(String, String)>>,
}

impl SimConfig {
    /// Consume and return the reason code for the first pending failure spec
    /// matching `target`, in arrival order.  Returns None if no spec is queued.
    pub fn fail_for(&self, target: &str) -> Option<String> {
        let mut specs = self.fail_specs.lock().unwrap();
        let pos = specs.iter().position(|(t, _)| t == target)?;
        Some(specs.remove(pos).1)
    }
}

impl Default for SimConfig {
    fn default() -> Self {
        SimConfig {
            encoder: "nvenc".to_string(),
            fail_specs: std::sync::Mutex::new(vec![]),
        }
    }
}

/// Parse repeated --simulate-fail target=reason specs into an ordered list.
/// Order is preserved; same-target entries stack in declaration order.
/// Returns an error if any spec is malformed or the target is not supported.
pub fn parse_fail_specs(specs: &[String]) -> anyhow::Result<Vec<(String, String)>> {
    let mut list = Vec::new();
    for s in specs {
        let (target, reason) = s
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("--simulate-fail must be target=reason, got {s:?}"))?;
        if !SUPPORTED_FAIL_TARGETS.contains(&target) {
            anyhow::bail!(
                "--simulate-fail: unknown target {target:?}. Supported: {SUPPORTED_FAIL_TARGETS:?}"
            );
        }
        list.push((target.to_string(), reason.to_string()));
    }
    Ok(list)
}

/// FSM phases for the simulator. Ordered: Idle → SessionRequested → Streaming → Recording
/// → Saving → Idle (and Idle → Exporting → Idle for export).
#[derive(Debug, Clone, PartialEq)]
pub enum FsmPhase {
    Idle,
    /// capture.requestSession accepted; capture.startStream not yet called.
    SessionRequested,
    /// capture.startStream called; capture.sessionReady not yet fired.
    Streaming,
    /// Fully recording; stream active.
    Recording,
    /// capture.stopSession called; replay.save not yet called.
    Saving,
    /// replay.export_start accepted; export task running.
    Exporting,
}

pub struct SimInner {
    pub phase: FsmPhase,
    pub session_id: Option<String>,
    pub stream_id: Option<String>,
    pub snapshot_id: Option<String>,
    pub export_id: Option<String>,
    pub stream_paused: bool,
    /// Cancels the session background task (diagnostics loop, etc.).
    pub session_cancel_tx: Option<tokio::sync::watch::Sender<bool>>,
    /// Cancels only the export progress task.
    pub export_cancel_tx: Option<tokio::sync::watch::Sender<bool>>,
}

pub struct SimState {
    pub config: SimConfig,
    pub inner: Mutex<SimInner>,
    session_counter: AtomicU32,
    stream_counter: AtomicU32,
    export_counter: AtomicU32,
    snapshot_counter: AtomicU32,
}

impl SimState {
    pub fn new(config: SimConfig) -> Arc<Self> {
        Arc::new(SimState {
            config,
            inner: Mutex::new(SimInner {
                phase: FsmPhase::Idle,
                session_id: None,
                stream_id: None,
                snapshot_id: None,
                export_id: None,
                stream_paused: false,
                session_cancel_tx: None,
                export_cancel_tx: None,
            }),
            session_counter: AtomicU32::new(0),
            stream_counter: AtomicU32::new(0),
            export_counter: AtomicU32::new(0),
            snapshot_counter: AtomicU32::new(0),
        })
    }

    pub fn next_session_id(&self) -> String {
        format!("sim-session-{:04}", self.session_counter.fetch_add(1, Ordering::SeqCst))
    }

    pub fn next_stream_id(&self) -> String {
        format!("sim-stream-{:04}", self.stream_counter.fetch_add(1, Ordering::SeqCst))
    }

    pub fn next_export_id(&self) -> String {
        format!("sim-export-{:04}", self.export_counter.fetch_add(1, Ordering::SeqCst))
    }

    pub fn next_snapshot_id(&self) -> String {
        format!("sim-snapshot-{:04}", self.snapshot_counter.fetch_add(1, Ordering::SeqCst))
    }
}
