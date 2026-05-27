// Protocol type definitions per N-007 §7.
// Wire format: snake_case (helper → main). Main re-keys to camelCase for the renderer.
// All enums use #[serde(rename_all = ...)] so variant names produce the documented wire strings.

use serde::{Deserialize, Serialize};

// ── §7.1 Capture ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Monitor,
    Window,
    Region,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorMode {
    Hidden,
    Embedded,
    Metadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PixelRange {
    Limited,
    Full,
}

/// Wire format of a live capture stream's video parameters.
/// All field names emit as snake_case; main re-keys to camelCase.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureFormat {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// "NV12" | "P010" | "XR24" | "AR24"
    pub fourcc: String,
    /// hex DRM modifier (e.g. "0x100000000000002")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modifier: Option<String>,
    /// "bt709" | "bt2020"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_primaries: Option<String>,
    /// "bt709" | "pq" | "hlg"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<PixelRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreTokenInfo {
    pub token: String,
    pub label: String,
    pub last_used_at: u64,
}

/// Returned by capture.listSources (N-007 §5.1 / §7.1).
/// Not a real source enumeration; returns available modes and known restore tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureSourceDescriptor {
    pub modes: Vec<CaptureMode>,
    pub known_restore_tokens: Vec<RestoreTokenInfo>,
    /// Per-monitor DXGI metadata. Populated on Windows when enumeration is available; always empty on Linux.
    #[serde(default)]
    pub monitors: Vec<WindowsMonitorInfo>,
}

/// Per-monitor metadata from DXGI adapter enumeration.
/// Fields are zero-valued until real DXGI enumeration lands (T-051).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WindowsMonitorInfo {
    /// DXGI_OUTPUT_DESC DeviceName, e.g. `\\.\DISPLAY1`
    pub device_name: String,
    /// IDXGIFactory::EnumAdapters ordinal
    pub adapter_index: u32,
    /// IDXGIAdapter::EnumOutputs ordinal
    pub output_index: u32,
    pub width_px: u32,
    pub height_px: u32,
    /// Rational refresh rate numerator (e.g. 60000 for 59.97 Hz)
    pub refresh_rate_num: u32,
    /// Rational refresh rate denominator (e.g. 1001 for 59.97 Hz)
    pub refresh_rate_den: u32,
    pub is_primary: bool,
    /// DPI scale: 1.0 = 96 DPI (100%), 1.5 = 144 DPI (150%), etc.
    pub scale_factor: f64,
    pub hdr_capable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistMode {
    Transient,
    Permanent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestSessionOpts {
    pub mode: CaptureMode,
    pub cursor_mode: CursorMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub framerate_hint: Option<u32>,
    /// Required when mode == region
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<Rect>,
    /// Helper-issued; persisted across launches
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_token: Option<String>,
    pub persist: PersistMode,
}

// ── §7.2 Replay snapshot ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    H264,
    Hevc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentRef {
    pub index: u32,
    pub path: String,
    pub pts_start_90k: i64,
    pub pts_end_90k: i64,
    pub duration_90k: i64,
    pub byte_size: u64,
    pub is_keyframe_first: bool,
    pub discontinuity: bool,
    pub fragment_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaySnapshot {
    pub snapshot_id: String,
    pub session_id: String,
    pub init_segment_path: String,
    pub init_segment_bytes: u64,
    pub segments: Vec<SegmentRef>,
    pub trim_start_pts_90k: i64,
    pub trim_end_pts_90k: i64,
    pub codec: VideoCodec,
    /// Always 90000 in v2.0.0
    pub timescale: u32,
    pub width: u32,
    pub height: u32,
    pub framerate_hint: u32,
    pub has_discontinuity: bool,
    pub discontinuity_at_pts_90k: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoverableSession {
    pub session_id: String,
    /// Unix timestamp in milliseconds
    pub started_at: u64,
    pub duration_s: f64,
    pub bytes_on_disk: u64,
    pub segments_count: u32,
    pub has_discontinuity: bool,
}

// ── §7.3 Export ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioMode {
    Default,
    Mute,
    Passthrough,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    pub max_compat: bool,
    pub audio_mode: AudioMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtsRange {
    pub start_pts_90k: i64,
    pub end_pts_90k: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportMode {
    Fast,
    LeadReencode,
    Discontinuity,
    FullReencode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanReport {
    pub mode: ExportMode,
    pub copy_ranges: Vec<PtsRange>,
    pub reencode_ranges: Vec<PtsRange>,
    pub est_output_bytes: u64,
    pub est_duration_s: f64,
    pub expected_fps: f64,
}

// ── §7.4 Engine health ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineState {
    Booting,
    Ready,
    Recording,
    Saving,
    Exporting,
    Degraded,
    Restarting,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LastError {
    pub code: String,
    pub message: String,
    pub ts_ns: u64,
}

/// Returned by engine.status() (renderer-facing, via main bridge).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStatus {
    pub state: EngineState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub helper_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub helper_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<LastError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

/// Returned by engine.health() (N-007 §5.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineHealth {
    pub state: EngineState,
    pub uptime_ms: u64,
    pub active_sessions: u32,
    pub active_snapshots: u32,
    pub active_exports: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_ts: Option<u64>,
    pub diagnostics_dir: String,
    pub rolling_buffer_bytes: u64,
}
