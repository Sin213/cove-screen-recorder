#[cfg(target_os = "linux")]
pub mod pipewire;

#[cfg(unix)]
use tokio::sync::mpsc;

use crate::protocol::types::{
    CaptureSourceDescriptor, CursorMode, Rect, RequestSessionOpts,
};

// ── Frame types (Unix-only — DmaBufPlane uses std::os::fd::OwnedFd) ──────────

/// One DMA-BUF memory plane.  T-016a fills this out when negotiating DMA-BUF buffers.
#[cfg(unix)]
#[derive(Debug)]
pub struct DmaBufPlane {
    pub fd: std::os::fd::OwnedFd,
    pub offset: u32,
    pub stride: u32,
}

/// Payload carried by a captured frame.
#[cfg(unix)]
#[derive(Debug)]
pub enum FramePayload {
    DmaBuf {
        planes: Vec<DmaBufPlane>,
        width: u32,
        height: u32,
        /// DRM fourcc code (e.g. `DRM_FORMAT_NV12`)
        format: u32,
        modifier: u64,
    },
    Shm {
        data: Vec<u8>,
        width: u32,
        height: u32,
        format: u32,
        stride: u32,
    },
}

/// Cursor position and bitmap metadata embedded with the frame.
#[cfg(unix)]
#[derive(Debug)]
pub struct CursorMeta {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub hotspot_x: u32,
    pub hotspot_y: u32,
    /// RGBA bitmap; `None` when the cursor image is unchanged from the previous frame.
    pub bitmap: Option<Vec<u8>>,
}

/// A captured video frame.  Dropping `release` returns the backing PipeWire buffer.
#[cfg(unix)]
#[derive(Debug)]
pub struct FrameHandle {
    pub seq: u64,
    pub pts_ns: i64,
    pub payload: FramePayload,
    pub cursor: Option<CursorMeta>,
    pub release: ReleaseToken,
}

/// Drops the closure registered at construction, which re-queues the PipeWire buffer.
#[cfg(unix)]
pub struct ReleaseToken {
    inner: Option<Box<dyn FnOnce() + Send + 'static>>,
}

#[cfg(unix)]
impl ReleaseToken {
    pub fn new(f: impl FnOnce() + Send + 'static) -> Self {
        ReleaseToken { inner: Some(Box::new(f)) }
    }

    pub fn noop() -> Self {
        ReleaseToken { inner: None }
    }
}

#[cfg(unix)]
impl Drop for ReleaseToken {
    fn drop(&mut self) {
        if let Some(f) = self.inner.take() {
            f();
        }
    }
}

#[cfg(unix)]
impl std::fmt::Debug for ReleaseToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReleaseToken").finish_non_exhaustive()
    }
}

#[cfg(unix)]
pub type FrameSender = mpsc::Sender<FrameHandle>;
#[cfg(unix)]
pub type FrameReceiver = mpsc::Receiver<FrameHandle>;

#[cfg(unix)]
pub fn frame_channel(capacity: usize) -> (FrameSender, FrameReceiver) {
    mpsc::channel(capacity)
}

// ── Session lost reason ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionLostReason {
    UserRevoked,
    CompositorClosed,
    PipeWireDisconnected,
    PortalError(String),
    InternalError(String),
}

// ── CaptureSource trait ───────────────────────────────────────────────────────

/// Uniform interface for capture backends.
///
/// T-016 provides the PipeWire implementation skeleton.  T-016a completes it.
/// Each method reflects one `capture.*` RPC and mirrors the sim dispatcher pattern.
#[async_trait::async_trait]
pub trait CaptureSource: Send + Sync + 'static {
    /// Returns available capture modes and known restore tokens.
    async fn list_sources(&self) -> anyhow::Result<CaptureSourceDescriptor>;

    /// Runs the XDG portal session negotiation.  Fires no events; the session is
    /// stored internally.  Call `start_stream` next.
    async fn request_session(&self, opts: RequestSessionOpts) -> anyhow::Result<()>;

    /// Opens the PipeWire stream.  On real hardware, `capture.sessionReady` fires
    /// once the stream reaches the Streaming state (deferred to T-016a with format pods).
    async fn start_stream(&self) -> anyhow::Result<()>;

    async fn pause_stream(&self) -> anyhow::Result<()>;

    async fn resume_stream(&self) -> anyhow::Result<()>;

    async fn stop_session(&self) -> anyhow::Result<()>;

    async fn set_region(&self, region: Rect) -> anyhow::Result<()>;

    async fn set_framerate_hint(&self, fps: u32) -> anyhow::Result<()>;

    async fn set_cursor_mode(&self, mode: CursorMode) -> anyhow::Result<()>;
}
