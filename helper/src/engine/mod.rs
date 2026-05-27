use std::collections::HashMap;
use std::sync::{
    atomic::AtomicBool,
    Arc,
};
use tokio::sync::watch;

use crate::protocol::types::ReplaySnapshot;
use crate::segment::buffer::SegmentBuffer;
use crate::segment::recovery::RecoverableSessionInfo;
use crate::SetLevelFn;

/// Encoder session metadata + shared buffer handle stored while a capture
/// session is active. The buffer is intentionally NOT cleared when the
/// encoder session ends so that `replay.save` can access committed segments
/// after `capture.stopSession`.
pub struct SessionBufferInfo {
    pub buffer: SegmentBuffer,
    pub session_id: String,
    pub codec: crate::protocol::types::VideoCodec,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
}

/// A pinned snapshot together with the buffer handle needed to release it.
/// `buffer` is `None` for snapshots restored from a crashed-session recovery
/// (the original encoder session is gone; segments are already on disk).
/// `recovered_session` is `Some` for restored recovery snapshots; it is used
/// to clean up the backing segment directory when the snapshot is released.
pub struct PinnedSnapshot {
    pub snapshot: ReplaySnapshot,
    pub buffer: Option<SegmentBuffer>,
    pub recovered_session: Option<crate::segment::recovery::RecoverableSessionInfo>,
}

/// Tracks an in-flight export task so it can be cancelled.
pub struct ExportHandle {
    pub cancel_tx: watch::Sender<bool>,
    /// Set to `true` when the ffmpeg subprocess has exited and we are in the
    /// post-copy rename/sha256 phase. Cancel is rejected (returns `ok: false`)
    /// when this flag is set, but the terminal event is still emitted.
    pub in_muxing: Arc<AtomicBool>,
    /// The snapshot this export is reading. Checked in `replay.snapshot_release`
    /// to prevent eviction of segment files while ffmpeg is still running.
    pub snapshot_id: String,
}

pub struct HelperState {
    pub start_time: std::time::Instant,
    pub set_level: SetLevelFn,
    pub shutdown_tx: Arc<watch::Sender<bool>>,
    /// False if ffmpeg was not found at boot. `replay.export_start` returns
    /// an error immediately when this is false.
    pub ffmpeg_available: bool,
    #[cfg(target_os = "linux")]
    pub active_capture: tokio::sync::Mutex<
        Option<std::sync::Arc<crate::capture::pipewire::PipeWireSource>>,
    >,
    #[cfg(windows)]
    pub active_capture_windows: tokio::sync::Mutex<
        Option<Box<dyn crate::capture::CaptureSource>>,
    >,
    pub recoverable_sessions: tokio::sync::Mutex<Vec<RecoverableSessionInfo>>,
    /// Buffer from the most-recently-started encoder session. Kept alive after
    /// the encoder session ends so `replay.save` can still pin segments.
    pub active_segment_buffer: tokio::sync::Mutex<Option<SessionBufferInfo>>,
    /// Snapshots pinned by `replay.save` / `replay.restore_recovered_session`.
    pub active_snapshots: tokio::sync::Mutex<HashMap<String, PinnedSnapshot>>,
    /// In-flight export tasks, keyed by export_id.
    pub active_exports: tokio::sync::Mutex<HashMap<String, ExportHandle>>,
}

pub type SharedState = Arc<HelperState>;
