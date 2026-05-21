// Event payload structs per N-007 §6.
// Field names are snake_case (helper wire format); main re-keys to camelCase for renderer.
// All structs are Serialize-only (the helper emits events; it does not receive them).

use serde::Serialize;

use super::types::{CaptureFormat, PlanReport, RecoverableSession};

// ── Capture events (N-003 §2) ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct SessionReadyEvent {
    pub session_id: String,
    pub stream_id: String,
    pub format: CaptureFormat,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_token: Option<String>,
    pub compositor_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FormatChangedEvent {
    pub stream_id: String,
    pub old_format: CaptureFormat,
    pub new_format: CaptureFormat,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamPausedEvent {
    pub stream_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamResumedEvent {
    pub stream_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionLostEvent {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    pub reason: String,
    pub details: String,
    pub diagnostics_path: String,
}

/// Emitted at ~1 Hz while a session is active.
#[derive(Debug, Clone, Serialize)]
pub struct CaptureDiagnosticsEvent {
    pub stream_id: String,
    pub state: String,
    pub format: CaptureFormat,
    pub buffers: serde_json::Value,
    pub cadence: serde_json::Value,
    pub cursor_mode: String,
    pub compositor: String,
    pub pipewire: serde_json::Value,
    pub last_negotiation_ms: u64,
    pub uptime_ms: u64,
}

// ── Encoder events (N-004 §16, §17) ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct BackendProbe {
    pub backend: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EncoderProbeResultEvent {
    pub backends: Vec<BackendProbe>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EncoderSelectedEvent {
    pub backend: String,
    pub codec: String,
    pub parameters: serde_json::Value,
    pub reason_for_choice: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EncoderFallbackEvent {
    /// "no-hw-vendor" | "probe-failed" | "shm-forced" | "negative-cache-hit" | "windows-amd-deferred"
    pub reason: String,
    pub from_backend: String,
    pub to_backend: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EncoderRuntimeErrorEvent {
    pub backend: String,
    pub reason_code: String,
    pub details: String,
    pub diagnostics_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EncoderBackPressureEvent {
    pub backend: String,
    pub sustained_ms: u64,
    pub dropped_since_last: u64,
}

/// Emitted at ~1 Hz while encoding.
#[derive(Debug, Clone, Serialize)]
pub struct EncoderDiagnosticsEvent {
    pub backend: String,
    pub state: String,
    pub frames_in: u64,
    pub frames_encoded: u64,
    pub frames_dropped: u64,
    pub encode_latency_ms: f64,
    pub bitrate_observed: f64,
    pub vbv_underruns: u64,
    pub dmabuf_imports: u64,
    pub shm_copy_bytes: u64,
    pub hwenc_runtime_errors: u64,
}

// ── Segment buffer events (N-005 §14) ─────────────────────────────────────────

/// Emitted at ~1 Hz while a session is active.
#[derive(Debug, Clone, Serialize)]
pub struct SegmentDiagnosticsEvent {
    pub session_dir: String,
    pub state: String,
    pub current_segment_index: u32,
    pub fragments_received: u64,
    pub segments_committed: u64,
    pub segments_evicted: u64,
    pub segments_pinned: u64,
    pub bytes_on_disk: u64,
    pub disk_write_latency_ms: f64,
    pub fsync_latency_ms: f64,
    pub rename_latency_ms: f64,
    pub back_pressure_sustained_ms: u64,
    pub partial_segment_recovered: bool,
    pub formatchange_segments: u64,
    pub buffer_window_seconds_observed: f64,
    pub buffer_bytes_pct_of_cap: f64,
    pub keyframes_seen: u64,
    pub duration_eligible: bool,
    pub pending_duration_90k: u64,
    pub pending_bytes: u64,
    pub last_keyframe_age_ms: u64,
    // ISS-005 H1a/H1b diagnostics — additive, default-safe, do not gate behaviour.
    pub last_fragment_idr_nal_count: u32,
    pub last_fragment_non_idr_slice_count: u32,
    pub last_fragment_sps_count: u32,
    pub last_fragment_pps_count: u32,
    pub last_fragment_sei_count: u32,
    pub last_fragment_other_nal_count: u32,
    pub last_fragment_picture_type: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryAvailableEvent {
    pub sessions: Vec<RecoverableSession>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotPinnedEvent {
    pub snapshot_id: String,
    pub session_id: String,
    pub segments_count: u32,
    pub bytes_pinned: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnapshotReleasedEvent {
    pub snapshot_id: String,
    pub age_ms: u64,
}

// ── Export events (N-006 §17) ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ExportQueuedEvent {
    pub export_id: String,
    pub snapshot_id: String,
    pub requested_duration_s: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportStartedEvent {
    pub export_id: String,
    pub mode: String,
    pub plan: PlanReport,
    pub est_duration_s: f64,
    pub est_output_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportProgressEvent {
    pub export_id: String,
    pub stage: String,
    pub pct: f32,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub samples_processed: u64,
    pub samples_total: u64,
    pub eta_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportStalledEvent {
    pub export_id: String,
    pub stage: String,
    pub last_progress_ms_ago: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportCompletedEvent {
    pub export_id: String,
    pub final_path: String,
    pub bytes: u64,
    pub sha256: String,
    pub duration_s: f64,
    pub mode: String,
    pub fps_observed_out: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportFailedEvent {
    pub export_id: String,
    pub stage: String,
    pub reason_code: String,
    pub details: String,
    pub diagnostics_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportCancelledEvent {
    pub export_id: String,
    pub stage: String,
    pub partial_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportRejectedEvent {
    pub export_id: String,
    /// "queue-full"
    pub reason: String,
}

// ── Engine lifecycle events (T-008 §9, §10) ───────────────────────────────────

/// Sent immediately after client connects, before reading any request.
#[derive(Debug, Clone, Serialize)]
pub struct EngineReadyEvent {
    pub helper_version: String,
    pub protocol_version: u32,
    pub pid: u32,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineShutdownStartedEvent {
    pub reason: String,
    pub deadline_ms: u64,
}

/// Only emitted when diagnostics verbosity >= helper threshold.
#[derive(Debug, Clone, Serialize)]
pub struct EngineLogLineEvent {
    pub level: String,
    pub ts_ns: u64,
    pub target: String,
    pub message: String,
}
