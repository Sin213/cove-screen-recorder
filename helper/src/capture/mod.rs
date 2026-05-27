#[cfg(target_os = "linux")]
pub mod pipewire;
pub mod dxgi;
pub mod wgc;

use tokio::sync::mpsc;

use crate::protocol::types::{
    CaptureSourceDescriptor, CursorMode, Rect, RequestSessionOpts,
};

// ── Frame types ───────────────────────────────────────────────────────────────

/// One DMA-BUF memory plane.  Unix-only — uses OwnedFd.
#[cfg(unix)]
#[derive(Debug)]
pub struct DmaBufPlane {
    pub fd: std::os::fd::OwnedFd,
    pub offset: u32,
    pub stride: u32,
}

/// Payload carried by a captured frame.
#[derive(Debug)]
pub enum FramePayload {
    Shm {
        data: Vec<u8>,
        width: u32,
        height: u32,
        format: u32,
        stride: u32,
    },
    #[cfg(unix)]
    DmaBuf {
        planes: Vec<DmaBufPlane>,
        width: u32,
        height: u32,
        /// DRM fourcc code (e.g. `DRM_FORMAT_NV12`)
        format: u32,
        modifier: u64,
    },
    #[cfg(windows)]
    D3D11Texture {
        /// Raw *mut ID3D11Texture2D. Valid only while the FrameHandle is alive.
        /// The encoder must register or copy it before push_frame returns.
        texture_ptr: *mut std::ffi::c_void,
        width: u32,
        height: u32,
        /// DXGI_FORMAT integer (e.g. DXGI_FORMAT_B8G8R8A8_UNORM = 87)
        dxgi_format: u32,
        /// Subresource index within the texture array
        subresource: u32,
    },
}

// SAFETY: `D3D11Texture::texture_ptr` is a raw pointer to an ID3D11Texture2D created
// and owned by the DXGI capture backend. The backend guarantees:
//   1. The texture is kept alive until `ReleaseToken` fires (RAII drop on FrameHandle).
//   2. The D3D11 device was created with D3D11_CREATE_DEVICE_BGRA_SUPPORT and the
//      default multi-threaded protection flag, making concurrent reads safe.
//   3. Only one thread (the encoder) calls push_frame at a time; no aliased mutation.
// `Shm` and `DmaBuf` variants are trivially Send/Sync and would derive it were it not
// for the raw pointer in this variant. Adding the impl for the whole enum is the
// standard pattern when a raw-pointer variant is known-safe under stated invariants.
#[cfg(windows)]
unsafe impl Send for FramePayload {}
#[cfg(windows)]
unsafe impl Sync for FramePayload {}

/// Cursor position and bitmap metadata embedded with the frame.
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

/// A captured video frame.  Dropping `release` returns the backing capture buffer.
#[derive(Debug)]
pub struct FrameHandle {
    pub seq: u64,
    pub pts_ns: i64,
    pub payload: FramePayload,
    pub cursor: Option<CursorMeta>,
    pub release: ReleaseToken,
}

/// Drops the closure registered at construction, which re-queues the capture buffer.
pub struct ReleaseToken {
    inner: Option<Box<dyn FnOnce() + Send + 'static>>,
}

impl ReleaseToken {
    pub fn new(f: impl FnOnce() + Send + 'static) -> Self {
        ReleaseToken { inner: Some(Box::new(f)) }
    }

    pub fn noop() -> Self {
        ReleaseToken { inner: None }
    }
}

impl Drop for ReleaseToken {
    fn drop(&mut self) {
        if let Some(f) = self.inner.take() {
            f();
        }
    }
}

impl std::fmt::Debug for ReleaseToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReleaseToken").finish_non_exhaustive()
    }
}

/// Multiplexes video frames and in-band control markers on the same ordered
/// channel so the encoder always sees format changes in causal order relative
/// to the frames that follow them.
#[derive(Debug)]
pub enum FrameOrControl {
    Frame(FrameHandle),
    FormatChanged,
}

pub type FrameSender = mpsc::Sender<FrameOrControl>;
pub type FrameReceiver = mpsc::Receiver<FrameOrControl>;

pub fn frame_channel(capacity: usize) -> (FrameSender, FrameReceiver) {
    mpsc::channel(capacity)
}

// ── Session lost reason ───────────────────────────────────────────────────────

// NOTE: `SessionLostReason` has platform-gated variants. Any `match` on this type in
// cross-platform code must either use a catch-all arm or duplicate `#[cfg]` guards on
// match arms to stay exhaustive on all platforms (e.g. Linux code won't see DxgiAccessLost).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionLostReason {
    UserRevoked,
    CompositorClosed,
    #[cfg(target_os = "linux")]
    PipeWireDisconnected,
    #[cfg(windows)]
    DxgiAccessLost,
    #[cfg(windows)]
    WgcSessionEnded,
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

    /// Opens the capture stream.  On Linux, `capture.sessionReady` fires once the
    /// PipeWire stream reaches Streaming state.
    async fn start_stream(&self) -> anyhow::Result<()>;

    async fn pause_stream(&self) -> anyhow::Result<()>;

    async fn resume_stream(&self) -> anyhow::Result<()>;

    async fn stop_session(&self) -> anyhow::Result<()>;

    async fn set_region(&self, region: Rect) -> anyhow::Result<()>;

    async fn set_framerate_hint(&self, fps: u32) -> anyhow::Result<()>;

    async fn set_cursor_mode(&self, mode: CursorMode) -> anyhow::Result<()>;
}
