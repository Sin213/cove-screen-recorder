use std::sync::{
    atomic::{AtomicBool, AtomicI64, AtomicU8, AtomicU32, AtomicU64, Ordering},
    Arc,
};

use serde_json::json;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::{
    capture::{
        CaptureSource, DmaBufPlane, FrameHandle, FramePayload, FrameSender, ReleaseToken,
    },
    engine::SharedState,
    protocol::{
        envelope::{Response, RpcError},
        events::{
            CaptureDiagnosticsEvent, FormatChangedEvent, SessionLostEvent, SessionReadyEvent,
            StreamPausedEvent, StreamResumedEvent,
        },
        types::{
            CaptureFormat, CaptureMode, CaptureSourceDescriptor, CursorMode, PersistMode, Rect,
            RequestSessionOpts, RestoreTokenInfo,
        },
    },
    transport::notifier::Notifier,
};

// ── Constants ────────────────────────────────────────────────────────────────

const FRAME_CHANNEL_CAPACITY: usize = 4;

// ── Internal event / command channels ────────────────────────────────────────

#[derive(Debug)]
enum PwEvent {
    FormatChanged {
        old: NegotiatedFormat,
        new: NegotiatedFormat,
    },
    Error(String),
    FormatRenegotiationFailed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BufferMemType {
    Unknown,
    DmaBuf,
    Shm,
}

impl BufferMemType {
    fn as_u8(self) -> u8 {
        match self {
            BufferMemType::Unknown => 0,
            BufferMemType::DmaBuf => 1,
            BufferMemType::Shm => 2,
        }
    }
    fn from_u8(v: u8) -> Self {
        match v {
            1 => BufferMemType::DmaBuf,
            2 => BufferMemType::Shm,
            _ => BufferMemType::Unknown,
        }
    }
}

impl std::fmt::Display for BufferMemType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BufferMemType::Unknown => write!(f, "unknown"),
            BufferMemType::DmaBuf => write!(f, "dmabuf"),
            BufferMemType::Shm => write!(f, "shm"),
        }
    }
}

#[derive(Debug, Clone)]
struct NegotiatedFormat {
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
    format: u32,
    modifier: u64,
    buffer_type: BufferMemType,
}

impl NegotiatedFormat {
    fn to_capture_format(&self) -> CaptureFormat {
        CaptureFormat {
            width: self.width,
            height: self.height,
            fps_num: self.fps_num,
            fps_den: self.fps_den,
            fourcc: spa_format_to_fourcc(self.format),
            modifier: if self.modifier != 0 {
                Some(format!("0x{:x}", self.modifier))
            } else {
                None
            },
            color_primaries: Some("bt709".into()),
            transfer: Some("bt709".into()),
            range: None,
        }
    }
}

fn is_supported_format(raw: u32) -> bool {
    use pipewire::spa::param::video::VideoFormat;
    let f = VideoFormat::from_raw(raw);
    matches!(f, VideoFormat::NV12 | VideoFormat::P010_10LE | VideoFormat::BGRx | VideoFormat::BGRA)
}

fn spa_format_to_fourcc(raw: u32) -> String {
    use pipewire::spa::param::video::VideoFormat;
    let f = VideoFormat::from_raw(raw);
    match f {
        VideoFormat::NV12 => "NV12".into(),
        VideoFormat::P010_10LE => "P010".into(),
        VideoFormat::BGRx => "XR24".into(),
        VideoFormat::BGRA => "AR24".into(),
        _ => unreachable!("unsupported format should be rejected before fourcc conversion"),
    }
}

const fn drm_fourcc(a: u8, b: u8, c: u8, d: u8) -> u32 {
    (a as u32) | ((b as u32) << 8) | ((c as u32) << 16) | ((d as u32) << 24)
}

fn drm_fourcc_to_str(v: u32) -> String {
    String::from_utf8_lossy(&[
        (v & 0xff) as u8,
        ((v >> 8) & 0xff) as u8,
        ((v >> 16) & 0xff) as u8,
        ((v >> 24) & 0xff) as u8,
    ])
    .trim_end_matches('\0')
    .to_string()
}

fn spa_to_drm_fourcc(raw: u32) -> u32 {
    use pipewire::spa::param::video::VideoFormat;
    let f = VideoFormat::from_raw(raw);
    match f {
        VideoFormat::NV12 => drm_fourcc(b'N', b'V', b'1', b'2'),
        VideoFormat::P010_10LE => drm_fourcc(b'P', b'0', b'1', b'0'),
        VideoFormat::BGRx => drm_fourcc(b'X', b'R', b'2', b'4'),
        VideoFormat::BGRA => drm_fourcc(b'A', b'R', b'2', b'4'),
        _ => unreachable!("unsupported format should be rejected before fourcc conversion"),
    }
}

struct PwBufPtr(*mut pipewire::sys::pw_buffer);
unsafe impl Send for PwBufPtr {}
impl std::fmt::Debug for PwBufPtr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PwBufPtr({:p})", self.0)
    }
}

#[derive(Debug)]
enum PwCommand {
    Pause,
    Resume,
    Quit,
    QueueBuffer(PwBufPtr),
    /// Issue #1 hard-fail recovery: DMA-BUF negotiation produced a stream error before any
    /// buffer was delivered. Disconnect the stream, set the SHM-fallback flag, and
    /// reconnect so the next `param_changed` advertises SHM-only buffer constraints.
    RetryShmAfterDmaBufFailure,
    /// T-016a: live framerate-hint update. The PW thread re-runs `update_params` with a
    /// freshly built format pod whose default rate matches the clamped hint (1..=240).
    UpdateFramerate(u32),
}

type PwCmdTx = pipewire::channel::Sender<PwCommand>;

// ── Shared diagnostics counters ──────────────────────────────────────────────

struct DiagCounters {
    total_produced: AtomicU64,
    dropped_since_last: AtomicU64,
    buffer_type: AtomicU8,
    /// Issue #2: live count of frames either queued in `frame_channel` or held downstream
    /// (DMA-BUF leased buffers until ReleaseToken runs / SHM owned frames until consumed).
    /// Incremented before `try_send`; decremented in the ReleaseToken closure regardless of
    /// whether the send succeeded, so dropped frames stay balanced and never inflate the
    /// counter.
    in_flight: AtomicI64,
    /// Issue #1: set by the cmd handler after DMA-BUF negotiation hard-fails, so the next
    /// `param_changed` advertises SHM-only `SPA_PARAM_BUFFERS_dataType` instead of DMA-BUF.
    /// Sticky for the rest of the session once set.
    force_shm_on_negotiation: AtomicBool,
    /// T-016a: live PipeWire framerate hint shared with the PW thread. `0` means
    /// "no caller-supplied hint" and the format pod falls back to its 60/1 default.
    /// `set_framerate_hint` clamps to 1..=240 before writing.
    framerate_hint: AtomicU32,
}

impl DiagCounters {
    fn new() -> Self {
        DiagCounters {
            total_produced: AtomicU64::new(0),
            dropped_since_last: AtomicU64::new(0),
            buffer_type: AtomicU8::new(0),
            in_flight: AtomicI64::new(0),
            force_shm_on_negotiation: AtomicBool::new(false),
            framerate_hint: AtomicU32::new(0),
        }
    }
}

/// Stable terminal reason string for the "neither DMA-BUF nor SHM could be brought up"
/// failure. Used both as the `PwEvent::Error` message body and as the `anyhow` payload
/// pushed through the readiness channel; `start_stream()` matches on this exact string
/// when categorising pre-ready errors.
const REASON_NO_ACCEPTABLE_BUFFER_TYPE: &str = "no-acceptable-buffer-type";

/// Issue #2: how many consecutive DMA-BUF payload-extraction failures we tolerate during
/// `DmaBufAttempted` before declaring "DMA-BUF arrived but is unusable" and triggering
/// the SHM fallback. Keeps a single bad frame from forcing fallback while still bounding
/// how long we wait before giving up on a driver/compositor that delivers DMA-BUF
/// buffer descriptors we can't extract from.
const DMABUF_UNUSABLE_THRESHOLD: u32 = 3;

/// Shared `ready_tx` handle so both `state_changed` (success path) and the cmd handler
/// (terminal-fail path) can fulfil the same one-shot. Mutex is enough because all
/// PipeWire callbacks and the cmd handler run on the same single-threaded PW main loop.
type SharedReadyTx = Arc<
    std::sync::Mutex<
        Option<tokio::sync::oneshot::Sender<anyhow::Result<NegotiatedFormat>>>,
    >,
>;

/// Issue #1: deterministic terminal-fail routing. Sends the `reason` through the
/// readiness channel (so pre-ready callers awaiting `ready_rx` see it instead of the
/// generic `pipewire-thread-exited`) AND through `event_tx` (so a post-ready event loop
/// still receives `capture.sessionLost`). Sets the quit flag last.
///
/// `try_send` is used instead of `blocking_send` so the helper is safe to invoke from
/// both the PW main loop thread (where blocking would also be fine) and an async test
/// runtime (where `blocking_send` panics with "Cannot block the current thread from
/// within a runtime"). The capacity of `event_tx` is large enough that a single
/// terminal error message will not be dropped in practice; the readiness channel is
/// the primary delivery path anyway.
fn signal_terminal_fail(
    ready_tx: &SharedReadyTx,
    event_tx: &tokio::sync::mpsc::Sender<PwEvent>,
    quit_flag: &Arc<AtomicBool>,
    reason: &str,
) {
    if let Ok(mut guard) = ready_tx.lock() {
        if let Some(tx) = guard.take() {
            let _ = tx.send(Err(anyhow::anyhow!("{reason}")));
        }
    }
    let _ = event_tx.try_send(PwEvent::Error(reason.to_string()));
    quit_flag.store(true, Ordering::Relaxed);
}

/// Issue #2: phase-aware decision for what to do with a buffer BEFORE attempting payload
/// extraction. Pure function for unit-testability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreBuildAction {
    /// Proceed to payload extraction.
    Proceed,
    /// Compositor delivered a non-DMA-BUF buffer despite our DMA-BUF-only constraint
    /// (soft fallback): re-issue SHM-only buffer params, transition to ShmAttempted,
    /// queue this buffer back without forwarding a frame.
    TriggerShmSoftFallback,
    /// Compositor delivered a DMA-BUF buffer while we're already in the SHM-only
    /// fallback attempt — reject it, count toward `consecutive_frame_failures`, do not
    /// settle, do not forward.
    RejectDmaBufInShm,
}

fn pre_build_action(phase: BufferNegotiationPhase, is_dmabuf: bool) -> PreBuildAction {
    match (phase, is_dmabuf) {
        (BufferNegotiationPhase::DmaBufAttempted, true) => PreBuildAction::Proceed,
        (BufferNegotiationPhase::DmaBufAttempted, false) => {
            PreBuildAction::TriggerShmSoftFallback
        }
        (BufferNegotiationPhase::ShmAttempted, true) => PreBuildAction::RejectDmaBufInShm,
        (BufferNegotiationPhase::ShmAttempted, false) => PreBuildAction::Proceed,
        (BufferNegotiationPhase::Settled(_), _) => PreBuildAction::Proceed,
    }
}

/// Issue #2: phase-aware decision for what to do when `build_frame_payload()` returned
/// `None`. Pure function for unit-testability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PayloadFailAction {
    /// In `DmaBufAttempted` and the running failure counter is still below the
    /// `DMABUF_UNUSABLE_THRESHOLD` — treat as transient, queue back, try next buffer.
    DmaBufTransientRetry,
    /// In `DmaBufAttempted` and the counter has hit the threshold — DMA-BUF arrived but
    /// is unusable. Trigger the SHM fallback path *before* declaring terminal failure.
    TriggerShmFallbackOnUnusableDmaBuf,
    /// In `ShmAttempted` or `Settled` — count toward `consecutive_frame_failures`. When
    /// that counter hits 30 the caller emits `no-acceptable-buffer-type`.
    CountTowardTerminalFailure,
}

fn payload_fail_action(
    phase: BufferNegotiationPhase,
    dmabuf_attempt_failures: u32,
    threshold: u32,
) -> PayloadFailAction {
    if matches!(phase, BufferNegotiationPhase::DmaBufAttempted) {
        if dmabuf_attempt_failures >= threshold {
            PayloadFailAction::TriggerShmFallbackOnUnusableDmaBuf
        } else {
            PayloadFailAction::DmaBufTransientRetry
        }
    } else {
        PayloadFailAction::CountTowardTerminalFailure
    }
}

/// Issue #1: stable categorisation of a pre-ready negotiation error into a
/// `capture.sessionLost` `reason` code. Pulled out so the match arm in
/// `start_stream()` is unit-testable.
fn categorize_pre_ready_error(detail: &str) -> &'static str {
    if detail == REASON_NO_ACCEPTABLE_BUFFER_TYPE
        || detail.contains(REASON_NO_ACCEPTABLE_BUFFER_TYPE)
    {
        REASON_NO_ACCEPTABLE_BUFFER_TYPE
    } else if detail.contains("unsupported") {
        "format-negotiation-failed"
    } else {
        "stream-negotiation-failed"
    }
}

// Issue #1: deterministic DMA-BUF-first / SHM-fallback negotiation state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BufferNegotiationPhase {
    /// Sent `SPA_PARAM_BUFFERS_dataType = DMA-BUF only`. Waiting for either a DMA-BUF
    /// buffer (success) or a non-DMA-BUF buffer / state error (fallback trigger).
    DmaBufAttempted,
    /// Sent `SPA_PARAM_BUFFERS_dataType = MemFd | MemPtr`. Waiting for a SHM (or any)
    /// buffer; if none arrives or `consecutive_frame_failures` accumulates, the session
    /// is failed with `no-acceptable-buffer-type`.
    ShmAttempted,
    /// Negotiation has settled on a usable buffer transport.
    Settled(BufferMemType),
}

const SPA_DATA_MEM_FD: u32 = pipewire::spa::sys::SPA_DATA_MemFd;
const SPA_DATA_MEM_PTR: u32 = pipewire::spa::sys::SPA_DATA_MemPtr;
const SPA_DATA_DMA_BUF: u32 = pipewire::spa::sys::SPA_DATA_DmaBuf;

fn dmabuf_only_mask() -> u32 {
    1u32 << SPA_DATA_DMA_BUF
}

fn shm_only_mask() -> u32 {
    (1u32 << SPA_DATA_MEM_FD) | (1u32 << SPA_DATA_MEM_PTR)
}

/// Build a serialized `ObjectParamBuffers` pod carrying a single `SPA_PARAM_BUFFERS_dataType`
/// property with the requested mask. Used at every renegotiation point.
fn build_buffer_datatype_pod(mask: u32) -> anyhow::Result<Vec<u8>> {
    use pipewire::spa::{
        param::ParamType,
        pod::{self, Property, PropertyFlags, Value},
        sys as spa_sys,
        utils::SpaTypes,
    };
    let obj = pod::Object {
        type_: SpaTypes::ObjectParamBuffers.as_raw(),
        id: ParamType::Buffers.as_raw(),
        properties: vec![Property {
            key: spa_sys::SPA_PARAM_BUFFERS_dataType,
            flags: PropertyFlags::empty(),
            value: Value::Int(mask as i32),
        }],
    };
    let bytes = pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &Value::Object(obj),
    )
    .map_err(|e| anyhow::anyhow!("serialize ObjectParamBuffers pod: {e}"))?
    .0
    .into_inner();
    Ok(bytes)
}

/// Build the serialized `EnumFormat` pod used at `stream.connect()` time. Factored out so
/// the cmd handler can rebuild it for the DMA-BUF→SHM reconnect retry path.
///
/// T-016a: accepts a caller-supplied framerate hint (clamped to 1..=240) which becomes the
/// pod's default rate. When `framerate_hint` is `None`, the default is 60 fps. The range
/// always spans 1/1..=240/1 so the compositor can still pick a different rate inside that
/// window.
fn build_format_enum_pod(framerate_hint: Option<u32>) -> anyhow::Result<Vec<u8>> {
    use pipewire::spa::{
        param::{
            format::{FormatProperties, MediaSubtype, MediaType},
            video::VideoFormat,
            ParamType,
        },
        pod::{self, Value},
        utils::{Fraction, Rectangle, SpaTypes},
    };
    let default_rate = framerate_hint.unwrap_or(60).clamp(1, 240);
    let obj = pipewire::spa::pod::object!(
        SpaTypes::ObjectParamFormat,
        ParamType::EnumFormat,
        pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        pod::property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::NV12,
            VideoFormat::NV12,
            VideoFormat::P010_10LE,
            VideoFormat::BGRx,
            VideoFormat::BGRA
        ),
        pod::property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            Rectangle { width: 1920, height: 1080 },
            Rectangle { width: 1, height: 1 },
            Rectangle { width: 8192, height: 4320 }
        ),
        pod::property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            Fraction { num: default_rate, denom: 1 },
            Fraction { num: 1, denom: 1 },
            Fraction { num: 240, denom: 1 }
        ),
    );
    let bytes = pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &Value::Object(obj),
    )
    .map_err(|e| anyhow::anyhow!("serialize EnumFormat pod: {e}"))?
    .0
    .into_inner();
    Ok(bytes)
}

/// T-016a legacy permissive fallback pod. Kept verbatim from the pre-T-016a shape (default
/// and min `Fraction { num: 0, denom: 1 }`, max `240/1`) so we can retry `stream.connect`
/// once if a compositor rejects the nonzero-rate pod produced by `build_format_enum_pod`.
fn build_format_enum_pod_legacy_permissive() -> anyhow::Result<Vec<u8>> {
    use pipewire::spa::{
        param::{
            format::{FormatProperties, MediaSubtype, MediaType},
            video::VideoFormat,
            ParamType,
        },
        pod::{self, Value},
        utils::{Fraction, Rectangle, SpaTypes},
    };
    let obj = pipewire::spa::pod::object!(
        SpaTypes::ObjectParamFormat,
        ParamType::EnumFormat,
        pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        pod::property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::NV12,
            VideoFormat::NV12,
            VideoFormat::P010_10LE,
            VideoFormat::BGRx,
            VideoFormat::BGRA
        ),
        pod::property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            Rectangle { width: 1920, height: 1080 },
            Rectangle { width: 1, height: 1 },
            Rectangle { width: 8192, height: 4320 }
        ),
        pod::property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            Fraction { num: 0, denom: 1 },
            Fraction { num: 0, denom: 1 },
            Fraction { num: 240, denom: 1 }
        ),
    );
    let bytes = pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &Value::Object(obj),
    )
    .map_err(|e| anyhow::anyhow!("serialize legacy EnumFormat pod: {e}"))?
    .0
    .into_inner();
    Ok(bytes)
}

// ── Restore-token persistence ─────────────────────────────────────────────────

struct RestoreStore {
    path: std::path::PathBuf,
}

impl RestoreStore {
    fn new() -> Self {
        let base = std::env::var("XDG_STATE_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                std::path::PathBuf::from(home).join(".local").join("state")
            });
        RestoreStore { path: base.join("cove-screen-recorder").join("portal-restore.json") }
    }

    fn load(&self) -> anyhow::Result<Option<String>> {
        let s = match std::fs::read_to_string(&self.path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let v: serde_json::Value = serde_json::from_str(&s)?;
        Ok(v.get("token").and_then(|t| t.as_str()).map(str::to_owned))
    }

    fn save(&self, token: &str) -> anyhow::Result<()> {
        use std::io::Write as _;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
            // Tighten app-specific state directory to owner-only; best-effort.
            let _ = std::fs::set_permissions(
                dir,
                std::fs::Permissions::from_mode(0o700),
            );
        }
        let content = serde_json::to_vec_pretty(&json!({ "token": token }))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&self.path)?;
        file.write_all(&content)?;
        // Re-tighten in case the file pre-existed with broader permissions.
        let _ = std::fs::set_permissions(
            &self.path,
            std::fs::Permissions::from_mode(0o600),
        );
        Ok(())
    }

    fn list_tokens(&self) -> Vec<RestoreTokenInfo> {
        match self.load() {
            Ok(Some(token)) => vec![RestoreTokenInfo {
                token,
                label: "last session".into(),
                last_used_at: 0,
            }],
            _ => vec![],
        }
    }
}

// ── State machine ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum PwPhase {
    Idle,
    /// Portal negotiated; `pw_fd` stored; waiting for `start_stream`.
    SessionRequested,
    /// PW thread running; stream not yet in Streaming state.
    Streaming,
    /// PW stream reached Streaming state; frames flowing.
    Recording,
}

struct PwInner {
    phase: PwPhase,
    session_id: Option<String>,
    stream_id: Option<String>,
    portal_close_tx: Option<tokio::sync::oneshot::Sender<()>>,
    pw_fd: Option<std::os::fd::OwnedFd>,
    pw_node_id: Option<u32>,
    pw_quit: Option<Arc<AtomicBool>>,
    pw_cmd_tx: Option<PwCmdTx>,
    session_cancel_tx: Option<tokio::sync::watch::Sender<bool>>,
    diag_cancel_tx: Option<tokio::sync::watch::Sender<bool>>,
    diag_counters: Option<Arc<DiagCounters>>,
    negotiated_format: Option<CaptureFormat>,
    stream_paused: bool,
    /// T-016a: most recent caller-supplied framerate hint for this session. `None`
    /// means "use the format pod default" (currently 60 fps). Mirrored into
    /// `DiagCounters::framerate_hint` once the PW thread is live so the cmd handler
    /// can read it without re-locking `inner`.
    framerate_hint: Option<u32>,
}

// ── PipeWireSource ────────────────────────────────────────────────────────────

pub struct PipeWireSource {
    notifier: Notifier,
    restore_store: RestoreStore,
    inner: Arc<Mutex<PwInner>>,
    session_counter: AtomicU32,
    stream_counter: AtomicU32,
    state: crate::engine::SharedState,
}

impl PipeWireSource {
    pub fn new(notifier: Notifier, state: crate::engine::SharedState) -> Self {
        PipeWireSource {
            notifier,
            restore_store: RestoreStore::new(),
            inner: Arc::new(Mutex::new(PwInner {
                phase: PwPhase::Idle,
                session_id: None,
                stream_id: None,
                portal_close_tx: None,
                pw_fd: None,
                pw_node_id: None,
                pw_quit: None,
                pw_cmd_tx: None,
                session_cancel_tx: None,
                diag_cancel_tx: None,
                diag_counters: None,
                negotiated_format: None,
                stream_paused: false,
                framerate_hint: None,
            })),
            session_counter: AtomicU32::new(0),
            stream_counter: AtomicU32::new(0),
            state,
        }
    }

    fn reset_inner_locked(inner: &mut PwInner) {
        if let Some(ref q) = inner.pw_quit {
            q.store(true, Ordering::Relaxed);
        }
        if let Some(ref tx) = inner.pw_cmd_tx {
            let _ = tx.send(PwCommand::Quit);
        }
        if let Some(ref tx) = inner.session_cancel_tx {
            let _ = tx.send(true);
        }
        if let Some(ref tx) = inner.diag_cancel_tx {
            let _ = tx.send(true);
        }
        let _ = inner.portal_close_tx.take();
        inner.session_id = None;
        inner.stream_id = None;
        inner.pw_fd = None;
        inner.pw_node_id = None;
        inner.pw_quit = None;
        inner.pw_cmd_tx = None;
        inner.session_cancel_tx = None;
        inner.diag_cancel_tx = None;
        inner.diag_counters = None;
        inner.negotiated_format = None;
        inner.stream_paused = false;
        inner.framerate_hint = None;
        inner.phase = PwPhase::Idle;
    }

    /// Runs the full XDG Screencast portal negotiation.
    /// Returns (fd, node_id, restore_token, portal_close_tx).
    /// Each of the three portal steps is raced against `cancel_rx`; on cancellation
    /// the portal session is closed and an error is returned.
    async fn run_portal_flow(
        &self,
        opts: &RequestSessionOpts,
        mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    ) -> anyhow::Result<(
        std::os::fd::OwnedFd,
        u32,
        Option<String>,
        tokio::sync::oneshot::Sender<()>,
    )> {
        use ashpd::{
            desktop::{
                PersistMode as AshpdPersistMode,
                screencast::{
                    CursorMode as AshpdCursorMode, Screencast, SelectSourcesOptions, SourceType,
                },
            },
            enumflags2::BitFlags,
        };

        let proxy = Screencast::new()
            .await
            .map_err(|e| anyhow::anyhow!("portal proxy: {e}"))?;

        let session = proxy
            .create_session(Default::default())
            .await
            .map_err(|e| anyhow::anyhow!("create_session: {e}"))?;

        // Map protocol CaptureMode → portal SourceType bitflags.
        // Region is a post-stream crop (T-016a); present all source types so the portal
        // picker is not artificially limited before the user selects a source.
        let source_types: BitFlags<SourceType> = match opts.mode {
            CaptureMode::Monitor => SourceType::Monitor.into(),
            CaptureMode::Window => SourceType::Window.into(),
            CaptureMode::Region => SourceType::Monitor | SourceType::Window,
        };

        // Map protocol CursorMode → portal CursorMode (variant names are 1:1).
        let cursor_mode = match opts.cursor_mode {
            CursorMode::Hidden => AshpdCursorMode::Hidden,
            CursorMode::Embedded => AshpdCursorMode::Embedded,
            CursorMode::Metadata => AshpdCursorMode::Metadata,
        };

        // Map protocol PersistMode → portal PersistMode.
        // Note: ashpd PersistMode::DoNot exists but is not a protocol option — the
        // caller must explicitly choose Transient or Permanent.
        let persist_mode = match opts.persist {
            PersistMode::Transient => AshpdPersistMode::Application,
            PersistMode::Permanent => AshpdPersistMode::ExplicitlyRevoked,
        };

        // Resolve restore token: client-provided token takes priority; fall back to
        // the most-recently saved token on disk (if any).
        let effective_restore_token: Option<String> = opts
            .restore_token
            .clone()
            .or_else(|| self.restore_store.load().ok().flatten());

        let source_opts = SelectSourcesOptions::default()
            .set_sources(source_types)
            .set_cursor_mode(cursor_mode)
            .set_persist_mode(persist_mode)
            .set_restore_token(effective_restore_token.as_deref());

        // Step 1: select_sources — race against cancellation.
        let r = tokio::select! {
            r = proxy.select_sources(&session, source_opts) => r,
            _ = cancel_rx.changed() => {
                if let Err(ce) = session.close().await {
                    warn!("portal session close on cancel (select_sources): {ce}");
                }
                return Err(anyhow::anyhow!("negotiation cancelled"));
            }
        };
        if let Err(e) = r {
            if let Err(ce) = session.close().await {
                warn!("portal session close on negotiation failure: {ce}");
            }
            return Err(anyhow::anyhow!("select_sources: {e}"));
        }

        // Step 2: start — race against cancellation.
        let start_result = tokio::select! {
            r = proxy.start(&session, None, Default::default()) => r,
            _ = cancel_rx.changed() => {
                if let Err(ce) = session.close().await {
                    warn!("portal session close on cancel (start): {ce}");
                }
                return Err(anyhow::anyhow!("negotiation cancelled"));
            }
        };
        let streams = match start_result {
            Err(e) => {
                if let Err(ce) = session.close().await {
                    warn!("portal session close on negotiation failure: {ce}");
                }
                return Err(anyhow::anyhow!("portal start: {e}"));
            }
            Ok(r) => match r.response() {
                Err(e) => {
                    if let Err(ce) = session.close().await {
                        warn!("portal session close on negotiation failure: {ce}");
                    }
                    return Err(anyhow::anyhow!("portal response: {e}"));
                }
                Ok(s) => s,
            },
        };

        let node_id = match streams.streams().first() {
            Some(s) => s.pipe_wire_node_id(),
            None => {
                if let Err(ce) = session.close().await {
                    warn!("portal session close on empty streams: {ce}");
                }
                return Err(anyhow::anyhow!("portal returned no streams"));
            }
        };

        let restore_token = streams.restore_token().map(|s| s.to_owned());
        if let Some(ref token) = restore_token {
            self.restore_store.save(token).ok();
        }

        // Step 3: open_pipe_wire_remote — race against cancellation.
        let fd_result = tokio::select! {
            r = proxy.open_pipe_wire_remote(&session, Default::default()) => r,
            _ = cancel_rx.changed() => {
                if let Err(ce) = session.close().await {
                    warn!("portal session close on cancel (open_pipe_wire_remote): {ce}");
                }
                return Err(anyhow::anyhow!("negotiation cancelled"));
            }
        };
        let fd: std::os::fd::OwnedFd = match fd_result {
            Err(e) => {
                if let Err(ce) = session.close().await {
                    warn!("portal session close on negotiation failure: {ce}");
                }
                return Err(anyhow::anyhow!("open_pipe_wire_remote: {e}"));
            }
            Ok(r) => r.into(),
        };

        // Keep the portal session alive; explicitly close it when stop_session signals.
        let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let _ = close_rx.await;
            if let Err(e) = session.close().await {
                warn!("portal session close failed: {e}");
            }
        });

        Ok((fd, node_id, restore_token, close_tx))
    }

    /// Like `request_session` but accepts a cancellation watch channel.  Used by the
    /// transport layer so an in-flight portal negotiation can be cancelled when the
    /// client disconnects.  Not part of the `CaptureSource` trait.
    pub(crate) async fn request_session_cancellable(
        &self,
        opts: RequestSessionOpts,
        cancel_rx: tokio::sync::watch::Receiver<bool>,
    ) -> anyhow::Result<()> {
        {
            let inner = self.inner.lock().await;
            if inner.phase != PwPhase::Idle {
                anyhow::bail!("session already active");
            }
        }

        let (fd, node_id, _restore_token, close_tx) =
            self.run_portal_flow(&opts, cancel_rx).await?;

        let seq = self.session_counter.fetch_add(1, Ordering::SeqCst);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let pid = std::process::id();
        let session_id = format!("pw-session-{seq:04}-{pid}-{ts}");

        let mut inner = self.inner.lock().await;
        inner.session_id = Some(session_id.clone());
        inner.pw_fd = Some(fd);
        inner.pw_node_id = Some(node_id);
        inner.portal_close_tx = Some(close_tx);
        inner.framerate_hint = opts.framerate_hint.map(|fps| fps.clamp(1, 240));
        inner.phase = PwPhase::SessionRequested;
        info!(session_id, node_id, "portal session established");
        Ok(())
    }
}

#[async_trait::async_trait]
impl CaptureSource for PipeWireSource {
    async fn list_sources(&self) -> anyhow::Result<CaptureSourceDescriptor> {
        Ok(CaptureSourceDescriptor {
            modes: vec![CaptureMode::Monitor, CaptureMode::Window],
            known_restore_tokens: self.restore_store.list_tokens(),
        })
    }

    async fn request_session(&self, opts: RequestSessionOpts) -> anyhow::Result<()> {
        let (_tx, cancel_rx) = tokio::sync::watch::channel(false);
        self.request_session_cancellable(opts, cancel_rx).await
    }

    async fn start_stream(&self) -> anyhow::Result<()> {
        let (fd, node_id, session_id, stream_id) = {
            let mut inner = self.inner.lock().await;
            if inner.phase != PwPhase::SessionRequested {
                anyhow::bail!("start_stream requires SessionRequested phase");
            }
            let fd = inner
                .pw_fd
                .take()
                .ok_or_else(|| anyhow::anyhow!("no PW fd available"))?;
            let node_id = inner
                .pw_node_id
                .ok_or_else(|| anyhow::anyhow!("no PW node_id"))?;
            let session_id = inner.session_id.clone().unwrap_or_default();
            let stream_id = format!(
                "pw-stream-{:04}",
                self.stream_counter.fetch_add(1, Ordering::SeqCst),
            );
            inner.stream_id = Some(stream_id.clone());
            inner.phase = PwPhase::Streaming;
            (fd, node_id, session_id, stream_id)
        };

        let counters = Arc::new(DiagCounters::new());
        let (ready_tx, ready_rx) =
            tokio::sync::oneshot::channel::<anyhow::Result<NegotiatedFormat>>();
        let (frame_tx, frame_rx) = crate::capture::frame_channel(FRAME_CHANNEL_CAPACITY);
        let (event_tx, event_rx) = tokio::sync::mpsc::channel::<PwEvent>(32);
        let (cmd_tx, cmd_rx) = pipewire::channel::channel::<PwCommand>();
        let quit_flag = Arc::new(AtomicBool::new(false));

        let cmd_tx_thread = cmd_tx.clone();

        {
            // T-016a: install the live cmd_tx + counters AND seed the framerate-hint
            // atomic from `inner.framerate_hint` in the SAME critical section. This
            // closes a startup race where a concurrent `set_framerate_hint` (which is
            // allowed once `phase != Idle`) would see no counters/cmd_tx, persist its
            // value into `inner.framerate_hint`, and never reach the PW thread.
            let mut inner = self.inner.lock().await;
            inner.pw_quit = Some(Arc::clone(&quit_flag));
            inner.pw_cmd_tx = Some(cmd_tx);
            inner.diag_counters = Some(Arc::clone(&counters));
            counters
                .framerate_hint
                .store(inner.framerate_hint.unwrap_or(0), Ordering::Relaxed);
        }

        let counters_c = Arc::clone(&counters);
        let quit_c = Arc::clone(&quit_flag);
        if let Err(e) = std::thread::Builder::new()
            .name("pw-capture".into())
            .spawn(move || {
                pw_thread_main(fd, node_id, frame_tx, event_tx, ready_tx, quit_c, cmd_tx_thread, cmd_rx, counters_c);
            })
        {
            let mut inner = self.inner.lock().await;
            Self::reset_inner_locked(&mut inner);
            return Err(anyhow::anyhow!("failed to spawn PW thread: {e}"));
        }

        let ready_result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            ready_rx,
        )
        .await;

        let format = match ready_result {
            Ok(Ok(Ok(f))) => f,
            other => {
                quit_flag.store(true, Ordering::Relaxed);
                let (reason, details): (String, String) = match other {
                    Ok(Ok(Err(e))) => {
                        // Issue #1: pre-ready errors now include
                        // `no-acceptable-buffer-type` routed via the cmd handler's
                        // terminal-fail path. `categorize_pre_ready_error` recognises
                        // that exact string and surfaces it as the sessionLost reason
                        // instead of the previous generic
                        // `stream-negotiation-failed` / `pipewire-thread-exited`.
                        let detail = e.to_string();
                        (
                            categorize_pre_ready_error(&detail).to_string(),
                            detail,
                        )
                    }
                    Ok(Err(_)) => ("pipewire-thread-exited".into(), String::new()),
                    Err(_) => ("stream-ready-timeout".into(), String::new()),
                    Ok(Ok(Ok(_))) => unreachable!(),
                };
                warn!(session_id, stream_id, %reason, %details, "start_stream failed");
                {
                    let mut inner = self.inner.lock().await;
                    Self::reset_inner_locked(&mut inner);
                }
                let lost_event = SessionLostEvent {
                    session_id: session_id.clone(),
                    stream_id: Some(stream_id.clone()),
                    reason: reason.clone(),
                    details,
                    diagnostics_path: String::new(),
                };
                if let Ok(v) = serde_json::to_value(lost_event) {
                    let _ = self.notifier.notify("capture.sessionLost", v).await;
                }
                anyhow::bail!("{reason}");
            }
        };

        let capture_format = format.to_capture_format();
        info!(
            session_id,
            stream_id,
            width = capture_format.width,
            height = capture_format.height,
            fourcc = %capture_format.fourcc,
            "PW stream ready"
        );

        // Evict any stale buffer from a previous session before advertising
        // readiness, so replay.save cannot pin the wrong session's segments
        // during the window before the encoder task installs the new buffer.
        *self.state.active_segment_buffer.lock().await = None;

        let ready_event = SessionReadyEvent {
            session_id: session_id.clone(),
            stream_id: stream_id.clone(),
            format: capture_format.clone(),
            restore_token: None,
            compositor_name: "pipewire".into(),
        };
        let _ = self
            .notifier
            .notify("capture.sessionReady", serde_json::to_value(ready_event)?)
            .await;

        let capture_format_for_enc = capture_format.clone();
        {
            let mut inner = self.inner.lock().await;
            inner.phase = PwPhase::Recording;
            inner.negotiated_format = Some(capture_format);
        }

        let (diag_cancel_tx, diag_cancel_rx) = tokio::sync::watch::channel(false);
        let (format_tx, format_rx) = tokio::sync::watch::channel(format.clone());
        {
            let mut inner = self.inner.lock().await;
            inner.diag_cancel_tx = Some(diag_cancel_tx);
        }

        let counters_diag = Arc::clone(&counters);
        let notifier_diag = self.notifier.clone();
        let stream_id_diag = stream_id.clone();
        tokio::spawn(async move {
            run_diagnostics_loop(
                stream_id_diag,
                notifier_diag,
                diag_cancel_rx,
                counters_diag,
                format_rx,
            )
            .await;
        });

        let notifier_enc = self.notifier.clone();
        let stream_id_enc = stream_id.clone();
        let session_id_enc = session_id.clone();
        let state_enc = std::sync::Arc::clone(&self.state);
        tokio::spawn(async move {
            crate::encoder::run_session(
                frame_rx,
                notifier_enc,
                stream_id_enc,
                session_id_enc,
                capture_format_for_enc,
                state_enc,
            )
            .await;
        });

        let notifier_evt = self.notifier.clone();
        let session_id_evt = session_id;
        let stream_id_evt = stream_id;
        let inner_evt = Arc::clone(&self.inner);
        tokio::spawn(async move {
            pw_event_loop(event_rx, notifier_evt, session_id_evt, stream_id_evt, inner_evt, format_tx).await;
        });

        Ok(())
    }

    async fn pause_stream(&self) -> anyhow::Result<()> {
        let notifier_c = self.notifier.clone();
        let stream_id_owned = {
            let mut inner = self.inner.lock().await;
            if !matches!(inner.phase, PwPhase::Streaming | PwPhase::Recording) {
                anyhow::bail!("no active stream");
            }
            let stream_id = inner
                .stream_id
                .clone()
                .ok_or_else(|| anyhow::anyhow!("no active stream"))?;
            if inner.stream_paused {
                anyhow::bail!("stream already paused");
            }
            inner.stream_paused = true;
            if let Some(ref tx) = inner.pw_cmd_tx {
                let _ = tx.send(PwCommand::Pause);
            }
            stream_id
        };

        let event = StreamPausedEvent { stream_id: stream_id_owned, reason: "client-request".into() };
        let _ = notifier_c
            .notify("capture.streamPaused", serde_json::to_value(event)?)
            .await;
        Ok(())
    }

    async fn resume_stream(&self) -> anyhow::Result<()> {
        let notifier_c = self.notifier.clone();
        let stream_id_owned = {
            let mut inner = self.inner.lock().await;
            if !matches!(inner.phase, PwPhase::Streaming | PwPhase::Recording) {
                anyhow::bail!("no active stream");
            }
            let stream_id = inner
                .stream_id
                .clone()
                .ok_or_else(|| anyhow::anyhow!("no active stream"))?;
            if !inner.stream_paused {
                anyhow::bail!("stream not paused");
            }
            inner.stream_paused = false;
            if let Some(ref tx) = inner.pw_cmd_tx {
                let _ = tx.send(PwCommand::Resume);
            }
            stream_id
        };

        let event = StreamResumedEvent { stream_id: stream_id_owned };
        let _ = notifier_c
            .notify("capture.streamResumed", serde_json::to_value(event)?)
            .await;
        Ok(())
    }

    async fn stop_session(&self) -> anyhow::Result<()> {
        let (session_id_owned, stream_id_owned) = {
            let mut inner = self.inner.lock().await;
            if inner.phase == PwPhase::Idle || inner.session_id.is_none() {
                anyhow::bail!("no active session");
            }
            let session_id_owned = inner.session_id.clone().unwrap_or_default();
            let stream_id_owned = inner.stream_id.clone();
            Self::reset_inner_locked(&mut inner);
            (session_id_owned, stream_id_owned)
        };

        let event = SessionLostEvent {
            session_id: session_id_owned,
            stream_id: stream_id_owned,
            reason: "user-stopped".into(),
            details: String::new(),
            diagnostics_path: String::new(),
        };
        let _ = self
            .notifier
            .notify("capture.sessionLost", serde_json::to_value(event)?)
            .await;
        Ok(())
    }

    async fn set_region(&self, _region: Rect) -> anyhow::Result<()> {
        let inner = self.inner.lock().await;
        if inner.phase == PwPhase::Idle {
            anyhow::bail!("no active session");
        }
        // TODO T-016a: forward to PW stream crop/scale params
        Ok(())
    }

    async fn set_framerate_hint(&self, fps: u32) -> anyhow::Result<()> {
        // T-016a: persist the clamped hint on `PwInner`, mirror it into the live
        // `DiagCounters` atomic, and (when a PW stream is up) push a fresh format pod
        // through `update_params` so the compositor sees the new default rate.
        let mut inner = self.inner.lock().await;
        if inner.phase == PwPhase::Idle {
            anyhow::bail!("no active session");
        }
        let clamped = fps.clamp(1, 240);
        inner.framerate_hint = Some(clamped);
        if let Some(ref counters) = inner.diag_counters {
            counters.framerate_hint.store(clamped, Ordering::Relaxed);
        }
        if let Some(ref tx) = inner.pw_cmd_tx {
            let _ = tx.send(PwCommand::UpdateFramerate(clamped));
        }
        Ok(())
    }

    async fn set_cursor_mode(&self, _mode: CursorMode) -> anyhow::Result<()> {
        let inner = self.inner.lock().await;
        if inner.phase == PwPhase::Idle {
            anyhow::bail!("no active session");
        }
        // TODO T-016a: forward to PW cursor metadata params
        Ok(())
    }
}

// ── PW thread ─────────────────────────────────────────────────────────────────

fn pw_thread_main(
    fd: std::os::fd::OwnedFd,
    node_id: u32,
    frame_tx: FrameSender,
    event_tx: tokio::sync::mpsc::Sender<PwEvent>,
    ready_tx: tokio::sync::oneshot::Sender<anyhow::Result<NegotiatedFormat>>,
    quit_flag: Arc<AtomicBool>,
    cmd_tx: PwCmdTx,
    cmd_rx: pipewire::channel::Receiver<PwCommand>,
    counters: Arc<DiagCounters>,
) {
    if let Err(e) = pw_thread_run(fd, node_id, frame_tx, &event_tx, ready_tx, &quit_flag, cmd_tx, cmd_rx, &counters) {
        let _ = event_tx.blocking_send(PwEvent::Error(e.to_string()));
    }
}

struct PwUserData {
    format: pipewire::spa::param::video::VideoInfoRaw,
    format_valid: bool,
    negotiated: Option<NegotiatedFormat>,
    streaming: bool,
    // Issue #1: shared with cmd handler so its terminal-fail path can fulfil the same
    // one-shot that the Streaming-state success path would have. See `SharedReadyTx`.
    ready_tx: SharedReadyTx,
    frame_tx: FrameSender,
    event_tx: tokio::sync::mpsc::Sender<PwEvent>,
    pw_cmd_tx: PwCmdTx,
    counters: Arc<DiagCounters>,
    seq: u64,
    stream_start: std::time::Instant,
    consecutive_frame_failures: u32,
    /// Issue #2: running count of payload-extraction failures observed while phase is
    /// `DmaBufAttempted`. Resets on a successful build. When it crosses
    /// `DMABUF_UNUSABLE_THRESHOLD` we declare DMA-BUF unusable (despite the data-type
    /// header saying DmaBuf) and trigger the SHM fallback path before any terminal
    /// `no-acceptable-buffer-type` is emitted.
    dmabuf_attempt_failures: u32,
    buffer_type_observed: BufferMemType,
    /// Issue #1: which buffer-transport negotiation attempt we're currently in.
    /// Initialised on each `param_changed`; transitions on observed buffer types
    /// (soft fallback) or stream-state errors (hard fallback through `pw_cmd_tx`).
    negotiation_phase: BufferNegotiationPhase,
    /// Set when a mid-stream format change fires but the frame channel was full at the
    /// time. The `process` callback retries the sentinel before each subsequent frame so
    /// no post-change frame can be enqueued ahead of the marker. Both sends use
    /// `try_send` — the PipeWire callback thread never blocks on the Tokio channel.
    format_changed_pending: bool,
}

fn pw_thread_run(
    fd: std::os::fd::OwnedFd,
    node_id: u32,
    frame_tx: FrameSender,
    event_tx: &tokio::sync::mpsc::Sender<PwEvent>,
    ready_tx: tokio::sync::oneshot::Sender<anyhow::Result<NegotiatedFormat>>,
    quit_flag: &Arc<AtomicBool>,
    cmd_tx: PwCmdTx,
    cmd_rx: pipewire::channel::Receiver<PwCommand>,
    counters: &Arc<DiagCounters>,
) -> anyhow::Result<()> {
    use pipewire::{
        context::ContextRc,
        main_loop::MainLoopRc,
        properties::properties,
        spa::{param::ParamType, pod::Pod, utils::Direction},
        stream::StreamFlags,
    };
    // FormatProperties/MediaSubtype/MediaType/VideoFormat/Fraction/Rectangle/SpaTypes/
    // spa_sys have moved into `build_format_enum_pod` / `build_buffer_datatype_pod` so
    // they're imported there instead of here.

    pipewire::init();

    let main_loop =
        MainLoopRc::new(None).map_err(|e| anyhow::anyhow!("pw mainloop: {e}"))?;

    let context =
        ContextRc::new(&main_loop, None).map_err(|e| anyhow::anyhow!("pw context: {e}"))?;

    let core = context
        .connect_fd_rc(fd, None)
        .map_err(|e| anyhow::anyhow!("pw connect_fd_rc: {e}"))?;

    let stream = pipewire::stream::StreamRc::new(
        core,
        "cove-capture",
        properties! {
            *pipewire::keys::MEDIA_TYPE => "Video",
            *pipewire::keys::MEDIA_CATEGORY => "Capture",
            *pipewire::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| anyhow::anyhow!("pw stream: {e}"))?;

    // Issue #1: wrap ready_tx in a shared Arc<Mutex<Option<...>>> so the cmd handler's
    // terminal-fail path can fulfil it from outside the listener. Single PW main loop
    // means a std::sync::Mutex is enough — no async contention.
    let ready_tx_shared: SharedReadyTx =
        Arc::new(std::sync::Mutex::new(Some(ready_tx)));

    let user_data = PwUserData {
        format: Default::default(),
        format_valid: false,
        negotiated: None,
        streaming: false,
        ready_tx: Arc::clone(&ready_tx_shared),
        frame_tx,
        event_tx: event_tx.clone(),
        pw_cmd_tx: cmd_tx,
        counters: Arc::clone(counters),
        seq: 0,
        stream_start: std::time::Instant::now(),
        consecutive_frame_failures: 0,
        dmabuf_attempt_failures: 0,
        buffer_type_observed: BufferMemType::Unknown,
        // Issue #1: every fresh session starts in the DMA-BUF attempt phase. The
        // first `param_changed` will reset this based on `force_shm_on_negotiation`.
        negotiation_phase: BufferNegotiationPhase::DmaBufAttempted,
        format_changed_pending: false,
    };

    let quit_on_err = quit_flag.clone();
    let event_tx_err = event_tx.clone();
    // Issue #2: the process callback now needs to fire `signal_terminal_fail` when the
    // 30-frame `consecutive_frame_failures` threshold trips while in ShmAttempted (or
    // when ShmAttempted keeps receiving DMA-BUF buffers). Clone the quit flag for that
    // path; the rest of the callback uses `ud.event_tx` / `ud.ready_tx`.
    let quit_on_frame_err = quit_flag.clone();

    let _listener = stream
        .add_local_listener_with_user_data(user_data)
        .state_changed(move |_stream, ud, old, new| {
            use pipewire::stream::StreamState;
            match new {
                StreamState::Error(msg) => {
                    // Issue #1: hard-fail recovery — if we error out during the DMA-BUF
                    // attempt before any buffer has been observed (negotiation_phase still
                    // DmaBufAttempted), don't propagate as a fatal session loss. Instead
                    // route a RetryShm command to the cmd handler, which will disconnect
                    // and reconnect the stream with the SHM-only fallback flag set.
                    if matches!(ud.negotiation_phase, BufferNegotiationPhase::DmaBufAttempted) {
                        warn!(
                            "PW stream errored during DMA-BUF-only negotiation: {msg}; triggering SHM-only fallback retry"
                        );
                        let _ = ud.pw_cmd_tx.send(PwCommand::RetryShmAfterDmaBufFailure);
                        return;
                    }
                    let _ = event_tx_err
                        .blocking_send(PwEvent::Error(msg.to_string()));
                    quit_on_err.store(true, Ordering::Relaxed);
                }
                StreamState::Streaming => {
                    tracing::debug!(?old, ?new, "PW stream state change");
                    ud.streaming = true;
                    if let Some(neg) = ud.negotiated.as_ref() {
                        if let Ok(mut guard) = ud.ready_tx.lock() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(Ok(neg.clone()));
                            }
                        }
                    }
                }
                _ => {
                    tracing::debug!(
                        ?old, ?new,
                        "PW stream state change"
                    );
                }
            }
        })
        .param_changed(|stream, ud, id, param| {
            let Some(param) = param else { return };
            if id != ParamType::Format.as_raw() {
                return;
            }
            if ud.format.parse(param).is_err() {
                return;
            }

            let raw_fmt = ud.format.format().as_raw();
            if !is_supported_format(raw_fmt) {
                warn!(spa_raw = raw_fmt, "unsupported negotiated format — rejecting");
                ud.format_valid = false;
                ud.negotiated = None;
                let mut delivered_via_ready = false;
                if let Ok(mut guard) = ud.ready_tx.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(Err(anyhow::anyhow!(
                            "unsupported negotiated format: SPA raw {}",
                            raw_fmt
                        )));
                        delivered_via_ready = true;
                    }
                }
                if !delivered_via_ready {
                    let _ = ud.event_tx.blocking_send(PwEvent::FormatRenegotiationFailed(
                        format!("unsupported format renegotiated: SPA raw {raw_fmt}"),
                    ));
                }
                return;
            }

            ud.format_valid = true;

            // Issue #1: deterministic buffer-transport negotiation. We never advertise
            // DMA-BUF and SHM together as one combined mask, which would let the
            // compositor silently pick SHM whenever it felt like it. Instead:
            //   - First attempt of a session: `SPA_PARAM_BUFFERS_dataType = DMA-BUF only`.
            //   - After a confirmed DMA-BUF failure (soft fallback from the process
            //     callback, or hard fallback from the state Error → RetryShm cmd handler
            //     path), `force_shm_on_negotiation` is sticky-true and this branch issues
            //     `SPA_PARAM_BUFFERS_dataType = MemFd | MemPtr` instead.
            let force_shm = ud
                .counters
                .force_shm_on_negotiation
                .load(Ordering::Relaxed);
            let (mask, phase, mask_label) = if force_shm {
                (
                    shm_only_mask(),
                    BufferNegotiationPhase::ShmAttempted,
                    "SHM-only (MemFd|MemPtr) — DMA-BUF fallback",
                )
            } else {
                (
                    dmabuf_only_mask(),
                    BufferNegotiationPhase::DmaBufAttempted,
                    "DMA-BUF-only first attempt",
                )
            };
            match build_buffer_datatype_pod(mask) {
                Ok(buf_bytes) => {
                    if let Some(buf_pod) = Pod::from_bytes(&buf_bytes) {
                        let _ = stream.update_params(&mut [buf_pod]);
                        debug!(
                            data_type_mask = mask,
                            phase = ?phase,
                            "Issue #1 buffer constraint: {}",
                            mask_label
                        );
                    }
                }
                Err(e) => {
                    warn!(
                        "failed to build Buffers pod for mask {mask:#x}: {e}; falling back to no constraint"
                    );
                }
            }
            ud.negotiation_phase = phase;
            ud.buffer_type_observed = BufferMemType::Unknown;
            ud.counters
                .buffer_type
                .store(BufferMemType::Unknown.as_u8(), Ordering::Relaxed);

            let neg = NegotiatedFormat {
                width: ud.format.size().width,
                height: ud.format.size().height,
                fps_num: ud.format.framerate().num,
                fps_den: ud.format.framerate().denom,
                format: raw_fmt,
                modifier: ud.format.modifier(),
                buffer_type: BufferMemType::Unknown,
            };

            let old_format = ud.negotiated.replace(neg.clone());

            if ud.streaming {
                let mut delivered_via_ready = false;
                if let Ok(mut guard) = ud.ready_tx.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(Ok(neg.clone()));
                        delivered_via_ready = true;
                    }
                }
                if !delivered_via_ready {
                    if let Some(old) = old_format {
                        let _ = ud.event_tx.blocking_send(PwEvent::FormatChanged {
                            old,
                            new: neg,
                        });
                        // Inject an in-band sentinel so the encoder sees the
                        // format change before any frame that follows it on the
                        // same channel. Use try_send so the PW thread never
                        // blocks; if the channel is full, set the pending flag
                        // so process() retries before the next frame.
                        if ud.frame_tx.try_send(
                            crate::capture::FrameOrControl::FormatChanged,
                        ).is_err() {
                            ud.format_changed_pending = true;
                        }
                    }
                }
            }
        })
        .process(move |stream, ud| {
            let raw_buf = unsafe { stream.dequeue_raw_buffer() };
            if raw_buf.is_null() {
                return;
            }
            // Retry a pending format-change sentinel before processing any frame.
            // If the retry fails (channel still full), drop this frame so no
            // post-change frame can precede the sentinel in the encoder's queue.
            if ud.format_changed_pending {
                match ud.frame_tx.try_send(crate::capture::FrameOrControl::FormatChanged) {
                    Ok(()) => ud.format_changed_pending = false,
                    Err(_) => {
                        unsafe { stream.queue_raw_buffer(raw_buf); }
                        return;
                    }
                }
            }
            if !ud.format_valid {
                unsafe { stream.queue_raw_buffer(raw_buf); }
                return;
            }

            let pw_buf = unsafe { &*raw_buf };
            if pw_buf.buffer.is_null() {
                unsafe { stream.queue_raw_buffer(raw_buf); }
                return;
            }
            let spa_buf = unsafe { &*pw_buf.buffer };
            let n_datas = spa_buf.n_datas as usize;
            if n_datas == 0 {
                unsafe { stream.queue_raw_buffer(raw_buf); }
                return;
            }
            let datas_slice: &mut [pipewire::spa::buffer::Data] = unsafe {
                std::slice::from_raw_parts_mut(
                    spa_buf.datas.cast::<pipewire::spa::buffer::Data>(),
                    n_datas,
                )
            };

            let width = ud.format.size().width;
            let height = ud.format.size().height;
            let drm_format = spa_to_drm_fourcc(ud.format.format().as_raw());
            let modifier = ud.format.modifier();

            let buf_data_type = datas_slice[0].type_();
            let is_dmabuf = buf_data_type == pipewire::spa::buffer::DataType::DmaBuf;

            // Issue #2 (pre-payload phase decision): the data-type header alone is NOT
            // proof of usability. We use the buffer-type bit only to detect compositor
            // non-compliance (downgrade / wrong-transport) and either reject the buffer
            // outright (ShmAttempted + DMA-BUF) or trigger the soft fallback
            // (DmaBufAttempted + non-DMA-BUF). Settling on a `BufferMemType` is deferred
            // until `build_frame_payload()` proves the payload is actually extractable.
            match pre_build_action(ud.negotiation_phase, is_dmabuf) {
                PreBuildAction::Proceed => {}
                PreBuildAction::TriggerShmSoftFallback => {
                    debug!(
                        ?buf_data_type,
                        "Issue #1 soft fallback: compositor delivered non-DMA-BUF buffer despite DMA-BUF-only constraint; switching to SHM-only"
                    );
                    match build_buffer_datatype_pod(shm_only_mask()) {
                        Ok(buf_bytes) => {
                            if let Some(buf_pod) = Pod::from_bytes(&buf_bytes) {
                                let _ = stream.update_params(&mut [buf_pod]);
                            }
                        }
                        Err(e) => warn!("failed to build SHM-only Buffers pod: {e}"),
                    }
                    ud.counters
                        .force_shm_on_negotiation
                        .store(true, Ordering::Relaxed);
                    ud.negotiation_phase = BufferNegotiationPhase::ShmAttempted;
                    ud.dmabuf_attempt_failures = 0;
                    unsafe { stream.queue_raw_buffer(raw_buf); }
                    return;
                }
                PreBuildAction::RejectDmaBufInShm => {
                    // Issue #2: ShmAttempted accepts only MemFd/MemPtr buffers as the
                    // fallback success condition. A DMA-BUF buffer arriving here means
                    // the compositor ignored our SHM-only constraint; we never settle
                    // on DMA-BUF as "SHM fallback success" and we count this toward
                    // the terminal `no-acceptable-buffer-type` failure path.
                    warn!(
                        ?buf_data_type,
                        "Issue #2: compositor delivered DMA-BUF buffer while in ShmAttempted; rejecting (SHM-only required for fallback success)"
                    );
                    ud.consecutive_frame_failures += 1;
                    if ud.consecutive_frame_failures >= 30 {
                        signal_terminal_fail(
                            &ud.ready_tx,
                            &ud.event_tx,
                            &quit_on_frame_err,
                            REASON_NO_ACCEPTABLE_BUFFER_TYPE,
                        );
                    }
                    unsafe { stream.queue_raw_buffer(raw_buf); }
                    return;
                }
            }

            let payload = build_frame_payload(datas_slice, width, height, drm_format, modifier);
            let Some(payload) = payload else {
                // Issue #2: a `None` from `build_frame_payload()` is what actually proves
                // a transport unusable. If we're still in DmaBufAttempted we treat it as
                // DMA-BUF failure and either retry (transient) or trigger the SHM
                // fallback path BEFORE any terminal `no-acceptable-buffer-type` is
                // emitted. Outside DmaBufAttempted (i.e. ShmAttempted/Settled), payload
                // failures count toward the 30-frame terminal threshold as before.
                match payload_fail_action(
                    ud.negotiation_phase,
                    ud.dmabuf_attempt_failures.saturating_add(1),
                    DMABUF_UNUSABLE_THRESHOLD,
                ) {
                    PayloadFailAction::DmaBufTransientRetry => {
                        ud.dmabuf_attempt_failures =
                            ud.dmabuf_attempt_failures.saturating_add(1);
                        unsafe { stream.queue_raw_buffer(raw_buf); }
                        return;
                    }
                    PayloadFailAction::TriggerShmFallbackOnUnusableDmaBuf => {
                        warn!(
                            "Issue #2: DMA-BUF payload extraction failed {} consecutive times; triggering SHM fallback",
                            ud.dmabuf_attempt_failures.saturating_add(1)
                        );
                        match build_buffer_datatype_pod(shm_only_mask()) {
                            Ok(buf_bytes) => {
                                if let Some(buf_pod) = Pod::from_bytes(&buf_bytes) {
                                    let _ = stream.update_params(&mut [buf_pod]);
                                }
                            }
                            Err(e) => warn!("failed to build SHM-only Buffers pod: {e}"),
                        }
                        ud.counters
                            .force_shm_on_negotiation
                            .store(true, Ordering::Relaxed);
                        ud.negotiation_phase = BufferNegotiationPhase::ShmAttempted;
                        ud.dmabuf_attempt_failures = 0;
                        unsafe { stream.queue_raw_buffer(raw_buf); }
                        return;
                    }
                    PayloadFailAction::CountTowardTerminalFailure => {
                        ud.consecutive_frame_failures += 1;
                        if ud.consecutive_frame_failures >= 30 {
                            signal_terminal_fail(
                                &ud.ready_tx,
                                &ud.event_tx,
                                &quit_on_frame_err,
                                REASON_NO_ACCEPTABLE_BUFFER_TYPE,
                            );
                        }
                        unsafe { stream.queue_raw_buffer(raw_buf); }
                        return;
                    }
                }
            };
            ud.consecutive_frame_failures = 0;
            ud.dmabuf_attempt_failures = 0;

            let capture_stride = datas_slice[0].chunk().stride();
            if ud.seq == 0 {
                info!(
                    seq = ud.seq + 1,
                    fourcc = %drm_fourcc_to_str(drm_format),
                    width,
                    height,
                    modifier,
                    capture_stride,
                    buffer_type = if is_dmabuf { "DmaBuf" } else { "Shm" },
                    "[iss-014][encode-boundary] capture frame",
                );
            } else if (ud.seq + 1) % 300 == 0 {
                debug!(
                    seq = ud.seq + 1,
                    fourcc = %drm_fourcc_to_str(drm_format),
                    width,
                    height,
                    modifier,
                    capture_stride,
                    buffer_type = if is_dmabuf { "DmaBuf" } else { "Shm" },
                    "[iss-014][encode-boundary] capture frame",
                );
            }

            // Issue #2: with a usable payload in hand, settle the negotiation phase if
            // we hadn't already. Diagnostics' `buffers.buffer_type` flips from Unknown
            // to the actual settled transport only on this proven-usable path.
            match ud.negotiation_phase {
                BufferNegotiationPhase::DmaBufAttempted => {
                    ud.negotiation_phase =
                        BufferNegotiationPhase::Settled(BufferMemType::DmaBuf);
                    ud.buffer_type_observed = BufferMemType::DmaBuf;
                    if let Some(neg) = ud.negotiated.as_mut() {
                        neg.buffer_type = BufferMemType::DmaBuf;
                    }
                    ud.counters
                        .buffer_type
                        .store(BufferMemType::DmaBuf.as_u8(), Ordering::Relaxed);
                    debug!("Issue #2: DMA-BUF settled (usable payload built)");
                }
                BufferNegotiationPhase::ShmAttempted => {
                    ud.negotiation_phase =
                        BufferNegotiationPhase::Settled(BufferMemType::Shm);
                    ud.buffer_type_observed = BufferMemType::Shm;
                    if let Some(neg) = ud.negotiated.as_mut() {
                        neg.buffer_type = BufferMemType::Shm;
                    }
                    ud.counters
                        .buffer_type
                        .store(BufferMemType::Shm.as_u8(), Ordering::Relaxed);
                    debug!("Issue #2: SHM-fallback settled (usable payload built)");
                }
                BufferNegotiationPhase::Settled(_) => {}
            }

            ud.seq += 1;
            ud.counters
                .total_produced
                .fetch_add(1, Ordering::Relaxed);
            let pts_ns = ud.stream_start.elapsed().as_nanos() as i64;

            let frame_seq = ud.seq;

            // Issue #2: every successfully-built frame contributes to `in_flight`.
            // We pre-increment so the counter reflects "this frame is owned by either
            // the channel or downstream code". Every ReleaseToken built below carries a
            // matching decrement. If `try_send` fails the handle is dropped immediately
            // and its ReleaseToken fires straight away, balancing the increment so
            // dropped frames don't inflate `in_flight`. (Drop frames still bump
            // `dropped_since_last`, so back-pressure remains observable separately.)
            ud.counters.in_flight.fetch_add(1, Ordering::Relaxed);

            // ReleaseToken owns the PW buffer lifetime and the `in_flight` decrement.
            // For DMA-BUF: hold raw buffer checked out; ReleaseToken sends it back via
            // PW command channel and decrements `in_flight` at the same time.
            // For SHM: data is already copied into FramePayload, the PW buffer is
            // returned immediately; the decrement still fires when the owned frame
            // (or the unsent handle) is dropped.
            let release = if is_dmabuf {
                let buf_ptr = PwBufPtr(raw_buf);
                let cmd_tx = ud.pw_cmd_tx.clone();
                let counters_release = Arc::clone(&ud.counters);
                ReleaseToken::new(move || {
                    let _ = cmd_tx.send(PwCommand::QueueBuffer(buf_ptr));
                    counters_release
                        .in_flight
                        .fetch_sub(1, Ordering::Relaxed);
                    tracing::trace!(seq = frame_seq, "dmabuf buffer returned to PW");
                })
            } else {
                unsafe { stream.queue_raw_buffer(raw_buf); }
                let counters_release = Arc::clone(&ud.counters);
                ReleaseToken::new(move || {
                    counters_release
                        .in_flight
                        .fetch_sub(1, Ordering::Relaxed);
                    tracing::trace!(seq = frame_seq, "shm frame released");
                })
            };

            let handle = FrameHandle {
                seq: frame_seq,
                pts_ns,
                payload,
                cursor: None,
                release,
            };

            match ud.frame_tx.try_send(crate::capture::FrameOrControl::Frame(handle)) {
                Ok(()) => {}
                Err(tokio::sync::mpsc::error::TrySendError::Full(dropped)) => {
                    // Dropping `dropped` fires its ReleaseToken, which decrements
                    // `in_flight` — balancing the pre-increment above.
                    drop(dropped);
                    ud.counters
                        .dropped_since_last
                        .fetch_add(1, Ordering::Relaxed);
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(dropped)) => {
                    drop(dropped);
                }
            }
        })
        .register()
        .map_err(|e| anyhow::anyhow!("pw listener register: {e}"))?;

    // T-016a: prefer the nonzero-rate pod whose default fraction is the (clamped)
    // caller-supplied framerate hint. Fall back exactly once to the legacy permissive
    // pod (default/min 0/1, max 240/1) if the compositor rejects the primary pod.
    let primary_hint = {
        let raw = counters.framerate_hint.load(Ordering::Relaxed);
        if raw == 0 { None } else { Some(raw) }
    };
    let primary_bytes = build_format_enum_pod(primary_hint)?;
    let mut primary_params = [Pod::from_bytes(&primary_bytes)
        .ok_or_else(|| anyhow::anyhow!("pod from_bytes failed"))?];

    let connect_flags = StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS;
    if let Err(e_primary) = stream.connect(
        Direction::Input,
        Some(node_id),
        connect_flags,
        &mut primary_params,
    ) {
        warn!(
            "PW stream connect rejected nonzero-rate format pod ({e_primary}); retrying with legacy permissive pod"
        );
        let _ = stream.disconnect();
        let legacy_bytes = build_format_enum_pod_legacy_permissive()?;
        let mut legacy_params = [Pod::from_bytes(&legacy_bytes)
            .ok_or_else(|| anyhow::anyhow!("legacy pod from_bytes failed"))?];
        stream
            .connect(
                Direction::Input,
                Some(node_id),
                connect_flags,
                &mut legacy_params,
            )
            .map_err(|e| anyhow::anyhow!("pw stream connect (legacy fallback): {e}"))?;
    }

    let loop_ref = main_loop.loop_();

    let stream_cmd = stream.clone();
    let quit_cmd = quit_flag.clone();
    let counters_cmd = Arc::clone(counters);
    let event_tx_cmd = event_tx.clone();
    // Issue #1: cmd handler also needs the shared `ready_tx` so its terminal-fail paths
    // can short-circuit the pre-ready wait in `start_stream()` with the real reason.
    let ready_tx_cmd: SharedReadyTx = Arc::clone(&ready_tx_shared);
    let _cmd_listener = cmd_rx.attach(loop_ref, move |cmd| {
        match cmd {
            PwCommand::Pause => {
                let _ = stream_cmd.set_active(false);
            }
            PwCommand::Resume => {
                let _ = stream_cmd.set_active(true);
            }
            PwCommand::Quit => {
                quit_cmd.store(true, Ordering::Relaxed);
            }
            PwCommand::QueueBuffer(buf_ptr) => {
                unsafe { stream_cmd.queue_raw_buffer(buf_ptr.0); }
            }
            // Issue #1 hard-fail recovery path. DMA-BUF-only negotiation produced a
            // stream-state error before any buffer was delivered, so we sticky-set
            // `force_shm_on_negotiation` (which makes the next `param_changed` advertise
            // SHM-only) and reconnect the stream with a fresh format pod. If the
            // reconnect itself fails, route `no-acceptable-buffer-type` through both
            // `ready_tx` (pre-ready) and `event_tx` (post-ready) so neither caller path
            // collapses the reason into `pipewire-thread-exited`.
            PwCommand::RetryShmAfterDmaBufFailure => {
                if counters_cmd
                    .force_shm_on_negotiation
                    .swap(true, Ordering::Relaxed)
                {
                    // Already retried once; don't loop. Fail the session through both
                    // routing channels.
                    signal_terminal_fail(
                        &ready_tx_cmd,
                        &event_tx_cmd,
                        &quit_cmd,
                        REASON_NO_ACCEPTABLE_BUFFER_TYPE,
                    );
                    return;
                }
                info!("PW: DMA-BUF negotiation hard-failed; reconnecting with SHM-only fallback");
                let _ = stream_cmd.disconnect();
                match build_format_enum_pod_legacy_permissive() {
                    Ok(bytes) => match Pod::from_bytes(&bytes) {
                        Some(format_pod) => {
                            let mut retry_params = [format_pod];
                            if let Err(e) = stream_cmd.connect(
                                Direction::Input,
                                Some(node_id),
                                connect_flags,
                                &mut retry_params,
                            ) {
                                warn!("PW SHM-fallback reconnect failed: {e}");
                                signal_terminal_fail(
                                    &ready_tx_cmd,
                                    &event_tx_cmd,
                                    &quit_cmd,
                                    REASON_NO_ACCEPTABLE_BUFFER_TYPE,
                                );
                            }
                        }
                        None => {
                            warn!("PW SHM-fallback: rebuilt format pod failed validation");
                            signal_terminal_fail(
                                &ready_tx_cmd,
                                &event_tx_cmd,
                                &quit_cmd,
                                REASON_NO_ACCEPTABLE_BUFFER_TYPE,
                            );
                        }
                    },
                    Err(e) => {
                        warn!("PW SHM-fallback: failed to rebuild format pod: {e}");
                        signal_terminal_fail(
                            &ready_tx_cmd,
                            &event_tx_cmd,
                            &quit_cmd,
                            REASON_NO_ACCEPTABLE_BUFFER_TYPE,
                        );
                    }
                }
            }
            // T-016a: live framerate-hint refresh. The async caller has already clamped
            // `fps` to 1..=240 and updated `counters.framerate_hint`; here we rebuild
            // the format pod and push it via `update_params` so the compositor sees the
            // new default rate without a full session restart.
            PwCommand::UpdateFramerate(fps) => {
                counters_cmd.framerate_hint.store(fps, Ordering::Relaxed);
                match build_format_enum_pod(Some(fps)) {
                    Ok(bytes) => match Pod::from_bytes(&bytes) {
                        Some(format_pod) => {
                            let _ = stream_cmd.update_params(&mut [format_pod]);
                        }
                        None => warn!(
                            "PW framerate update: rebuilt format pod failed validation"
                        ),
                    },
                    Err(e) => warn!("PW framerate update: failed to rebuild format pod: {e}"),
                }
            }
        }
    });

    while !quit_flag.load(Ordering::Relaxed) {
        loop_ref.iterate(std::time::Duration::from_millis(100));
    }

    Ok(())
}

// ── Frame payload extraction ─────────────────────────────────────────────────

fn build_frame_payload(
    datas: &mut [pipewire::spa::buffer::Data],
    width: u32,
    height: u32,
    drm_format: u32,
    modifier: u64,
) -> Option<FramePayload> {
    use pipewire::spa::buffer::DataType;

    if datas.is_empty() {
        return None;
    }

    let dt = datas[0].type_();

    match dt {
        DataType::DmaBuf => {
            let mut planes = Vec::with_capacity(datas.len());
            for d in datas.iter() {
                let raw_fd = d.fd();
                if raw_fd < 0 {
                    return None;
                }
                let duped = unsafe { libc::dup(raw_fd) };
                if duped < 0 {
                    return None;
                }
                let owned = unsafe {
                    <std::os::fd::OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(duped)
                };
                planes.push(DmaBufPlane {
                    fd: owned,
                    offset: d.chunk().offset(),
                    stride: d.chunk().stride() as u32,
                });
            }
            Some(FramePayload::DmaBuf {
                planes,
                width,
                height,
                format: drm_format,
                modifier,
            })
        }
        DataType::MemFd | DataType::MemPtr => {
            let d = &mut datas[0];
            let offset = d.chunk().offset() as usize;
            let size = d.chunk().size() as usize;
            let stride = d.chunk().stride() as u32;
            let bytes = d.data()?;
            if size == 0 {
                return None;
            }
            let end = offset.checked_add(size)?;
            if end > bytes.len() {
                warn!(offset, size, buf_len = bytes.len(), "SHM chunk out of bounds");
                return None;
            }
            Some(FramePayload::Shm {
                data: bytes[offset..end].to_vec(),
                width,
                height,
                format: drm_format,
                stride,
            })
        }
        _ => {
            warn!(?dt, "unsupported PipeWire buffer data type");
            None
        }
    }
}

// ── Tokio PW-event handler ────────────────────────────────────────────────────

async fn pw_event_loop(
    mut event_rx: tokio::sync::mpsc::Receiver<PwEvent>,
    notifier: Notifier,
    session_id: String,
    stream_id: String,
    inner: Arc<Mutex<PwInner>>,
    format_tx: tokio::sync::watch::Sender<NegotiatedFormat>,
) {
    while let Some(event) = event_rx.recv().await {
        match event {
            PwEvent::FormatChanged { old, new } => {
                debug!(session_id, "mid-stream format change");
                let _ = format_tx.send(new.clone());
                let ev = FormatChangedEvent {
                    stream_id: stream_id.clone(),
                    old_format: old.to_capture_format(),
                    new_format: new.to_capture_format(),
                };
                if let Ok(v) = serde_json::to_value(ev) {
                    let _ = notifier.notify("capture.formatChanged", v).await;
                }
            }
            PwEvent::Error(msg) => {
                let reason = if msg == "no-acceptable-buffer-type" {
                    "no-acceptable-buffer-type"
                } else {
                    "pipewire-state-error"
                };
                warn!(session_id, %reason, "PW fatal: {msg}");
                let ev = SessionLostEvent {
                    session_id: session_id.clone(),
                    stream_id: Some(stream_id.clone()),
                    reason: reason.into(),
                    details: msg,
                    diagnostics_path: String::new(),
                };
                if let Ok(v) = serde_json::to_value(ev) {
                    let _ = notifier.notify("capture.sessionLost", v).await;
                }
                PipeWireSource::reset_inner_locked(&mut *inner.lock().await);
                break;
            }
            PwEvent::FormatRenegotiationFailed(details) => {
                warn!(session_id, "mid-stream format renegotiation failed: {details}");
                let ev = SessionLostEvent {
                    session_id: session_id.clone(),
                    stream_id: Some(stream_id.clone()),
                    reason: "format-renegotiation-failed".into(),
                    details,
                    diagnostics_path: String::new(),
                };
                if let Ok(v) = serde_json::to_value(ev) {
                    let _ = notifier.notify("capture.sessionLost", v).await;
                }
                PipeWireSource::reset_inner_locked(&mut *inner.lock().await);
                break;
            }
        }
    }
}

// ── 1 Hz diagnostics loop ─────────────────────────────────────────────────────

async fn run_diagnostics_loop(
    stream_id: String,
    notifier: Notifier,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    counters: Arc<DiagCounters>,
    format_rx: tokio::sync::watch::Receiver<NegotiatedFormat>,
) {
    let start = std::time::Instant::now();
    let mut prev_total: u64 = 0;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
            _ = cancel_rx.changed() => return,
        }

        let total = counters.total_produced.load(Ordering::Relaxed);
        let dropped = counters.dropped_since_last.swap(0, Ordering::Relaxed);
        let fps_observed = (total - prev_total) as f64;
        prev_total = total;

        let neg_format = format_rx.borrow().clone();
        let cap_format = neg_format.to_capture_format();
        let observed_buf_type = BufferMemType::from_u8(
            counters.buffer_type.load(Ordering::Relaxed),
        );
        // Issue #2: real in-flight gauge — pre-increment in the process callback,
        // ReleaseToken decrement on consume/release/drop, so this reflects buffers
        // currently sitting in the bounded frame channel plus those leased to
        // downstream owners (DMA-BUF until ReleaseToken returns, SHM until the
        // owned-copy FrameHandle is dropped). Clamped to 0 in the report so a
        // pathological double-decrement bug never surfaces as a negative number.
        let in_flight_raw = counters.in_flight.load(Ordering::Relaxed);
        let in_flight = in_flight_raw.max(0) as u64;
        let diag = CaptureDiagnosticsEvent {
            stream_id: stream_id.clone(),
            state: "active".into(),
            format: cap_format,
            buffers: json!({
                "negotiated": FRAME_CHANNEL_CAPACITY,
                "in_flight": in_flight,
                "dropped_since_last": dropped,
                "total_produced": total,
                "buffer_type": observed_buf_type.to_string(),
            }),
            cadence: json!({
                "observed_fps": fps_observed,
                "target_fps_hint": 0,
            }),
            cursor_mode: "embedded".into(),
            compositor: "pipewire".into(),
            pipewire: json!({}),
            last_negotiation_ms: 0,
            uptime_ms: start.elapsed().as_millis() as u64,
        };
        if let Ok(v) = serde_json::to_value(diag) {
            let _ = notifier.notify("capture.diagnostics", v).await;
        }
    }
}

// ── RPC dispatcher (called from transport::dispatcher) ───────────────────────

/// Handles all `capture.*` RPC methods on Linux.
pub async fn dispatch_capture(
    req: crate::protocol::envelope::Request,
    state: &SharedState,
    notifier: &Notifier,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Response {
    let id = req.id.clone();
    let method = req.method.as_str();

    match method {
        "capture.listSources" => {
            // Side-effect-free: reads restore tokens from disk only; does not
            // create or touch state.active_capture.
            let desc = CaptureSourceDescriptor {
                modes: vec![CaptureMode::Monitor, CaptureMode::Window],
                known_restore_tokens: RestoreStore::new().list_tokens(),
            };
            Response::result(id, serde_json::to_value(desc).unwrap_or(json!(null)))
        }

        "capture.requestSession" => {
            let opts: RequestSessionOpts = match parse_params(req.params) {
                Ok(o) => o,
                Err(e) => return Response::error(id, RpcError::invalid_request(e.to_string())),
            };
            // Reject duplicate: do not replace or clear the existing capture.
            if get_active_capture(state).await.is_some() {
                return Response::error(
                    id,
                    RpcError::invalid_request("session already active"),
                );
            }
            let capture = Arc::new(PipeWireSource::new(notifier.clone(), std::sync::Arc::clone(state)));
            match capture.request_session_cancellable(opts, cancel_rx.clone()).await {
                Ok(()) => {
                    // Post-negotiation cancel check: don't install for a dead client.
                    if *cancel_rx.borrow() {
                        if let Err(e) = capture.stop_session().await {
                            warn!("stop_session on post-negotiation cancel: {e}");
                        }
                        return Response::error(
                            id,
                            RpcError::invalid_request("session cancelled: connection closed"),
                        );
                    }
                    *state.active_capture.lock().await = Some(Arc::clone(&capture));
                    Response::result(id, json!({ "ok": true }))
                }
                Err(e) => Response::error(id, RpcError::invalid_request(e.to_string())),
            }
        }

        "capture.startStream" => {
            match get_active_capture(state).await {
                Some(c) => match c.start_stream().await {
                    Ok(()) => Response::result(id, json!({ "ok": true })),
                    Err(e) => {
                        if c.inner.lock().await.phase == PwPhase::Idle {
                            *state.active_capture.lock().await = None;
                        }
                        Response::error(
                            id,
                            RpcError {
                                code: serde_json::Value::String("not-implemented".into()),
                                message: e.to_string(),
                                data: None,
                            },
                        )
                    }
                },
                None => Response::error(id, RpcError::invalid_request("no active session")),
            }
        }

        "capture.pauseStream" => {
            match get_active_capture(state).await {
                Some(c) => match c.pause_stream().await {
                    Ok(()) => Response::result(id, json!({ "ok": true })),
                    Err(e) => Response::error(id, RpcError::invalid_request(e.to_string())),
                },
                None => Response::error(id, RpcError::invalid_request("no active session")),
            }
        }

        "capture.resumeStream" => {
            match get_active_capture(state).await {
                Some(c) => match c.resume_stream().await {
                    Ok(()) => Response::result(id, json!({ "ok": true })),
                    Err(e) => Response::error(id, RpcError::invalid_request(e.to_string())),
                },
                None => Response::error(id, RpcError::invalid_request("no active session")),
            }
        }

        "capture.stopSession" => {
            match get_active_capture(state).await {
                Some(c) => {
                    // Mark the active buffer as closing before signalling PipeWire
                    // so that any concurrent replay.save waits for the tail segment
                    // during the full stop→finalize window.
                    if let Some(buf_info) = state.active_segment_buffer.lock().await.as_ref() {
                        buf_info.buffer.mark_closing();
                    }
                    let result = c.stop_session().await;
                    *state.active_capture.lock().await = None;
                    match result {
                        Ok(()) => Response::result(id, json!({ "ok": true })),
                        Err(e) => Response::error(id, RpcError::invalid_request(e.to_string())),
                    }
                }
                None => Response::error(id, RpcError::invalid_request("no active session")),
            }
        }

        "capture.setRegion" => {
            let region: Rect = match parse_params(req.params) {
                Ok(r) => r,
                Err(e) => return Response::error(id, RpcError::invalid_request(e.to_string())),
            };
            match get_active_capture(state).await {
                Some(c) => match c.set_region(region).await {
                    Ok(()) => Response::result(id, json!({ "ok": true })),
                    Err(e) => Response::error(id, RpcError::invalid_request(e.to_string())),
                },
                None => Response::error(id, RpcError::invalid_request("no active session")),
            }
        }

        "capture.setFramerateHint" => {
            let fps = match parse_params::<SetFramerateHintParams>(req.params) {
                Ok(p) => p.fps,
                Err(e) => return Response::error(id, RpcError::invalid_request(e.to_string())),
            };
            if fps == 0 || fps > 360 {
                return Response::error(
                    id,
                    RpcError::invalid_request("fps must be in range 1–360"),
                );
            }
            match get_active_capture(state).await {
                Some(c) => match c.set_framerate_hint(fps).await {
                    Ok(()) => Response::result(id, json!({ "ok": true })),
                    Err(e) => Response::error(id, RpcError::invalid_request(e.to_string())),
                },
                None => Response::error(id, RpcError::invalid_request("no active session")),
            }
        }

        "capture.setCursorMode" => {
            let mode = match parse_params::<SetCursorModeParams>(req.params) {
                Ok(p) => p.mode,
                Err(e) => return Response::error(id, RpcError::invalid_request(e.to_string())),
            };
            match get_active_capture(state).await {
                Some(c) => match c.set_cursor_mode(mode).await {
                    Ok(()) => Response::result(id, json!({ "ok": true })),
                    Err(e) => Response::error(id, RpcError::invalid_request(e.to_string())),
                },
                None => Response::error(id, RpcError::invalid_request("no active session")),
            }
        }

        _ => Response::error(id, RpcError::method_not_found()),
    }
}

async fn get_active_capture(state: &SharedState) -> Option<Arc<PipeWireSource>> {
    let mut guard = state.active_capture.lock().await;
    if let Some(ref capture) = *guard {
        if capture.inner.lock().await.phase == PwPhase::Idle {
            *guard = None;
            return None;
        }
    }
    guard.clone()
}

fn parse_params<T: serde::de::DeserializeOwned>(
    params: Option<serde_json::Value>,
) -> anyhow::Result<T> {
    serde_json::from_value(params.unwrap_or(serde_json::Value::Null))
        .map_err(|e| anyhow::anyhow!("invalid params: {e}"))
}

#[derive(serde::Deserialize)]
struct SetFramerateHintParams {
    fps: u32,
}

#[derive(serde::Deserialize)]
struct SetCursorModeParams {
    mode: CursorMode,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_mem_type_round_trips_through_u8() {
        for ty in [BufferMemType::Unknown, BufferMemType::DmaBuf, BufferMemType::Shm] {
            assert_eq!(BufferMemType::from_u8(ty.as_u8()), ty);
        }
        assert_eq!(BufferMemType::from_u8(255), BufferMemType::Unknown);
    }

    #[test]
    fn diag_counters_propagate_buffer_type() {
        let counters = Arc::new(DiagCounters::new());
        assert_eq!(
            BufferMemType::from_u8(counters.buffer_type.load(Ordering::Relaxed)),
            BufferMemType::Unknown,
        );

        counters.buffer_type.store(BufferMemType::DmaBuf.as_u8(), Ordering::Relaxed);
        assert_eq!(
            BufferMemType::from_u8(counters.buffer_type.load(Ordering::Relaxed)),
            BufferMemType::DmaBuf,
        );

        counters.buffer_type.store(BufferMemType::Shm.as_u8(), Ordering::Relaxed);
        assert_eq!(
            BufferMemType::from_u8(counters.buffer_type.load(Ordering::Relaxed)),
            BufferMemType::Shm,
        );
    }

    // ---- Issue #1 ----------------------------------------------------------

    #[test]
    fn dmabuf_mask_excludes_shm_and_vice_versa() {
        // The whole point of Issue #1: the two masks must never alias. If they did the
        // compositor could "satisfy" DMA-BUF by handing back SHM.
        let dmabuf = dmabuf_only_mask();
        let shm = shm_only_mask();
        assert_ne!(dmabuf, 0, "dmabuf mask must be non-empty");
        assert_ne!(shm, 0, "shm mask must be non-empty");
        assert_eq!(
            dmabuf & shm,
            0,
            "dmabuf-only and shm-only masks must not share bits (avoids silent compositor downgrade)"
        );
        // Sanity-check the bits.
        assert_eq!(dmabuf, 1u32 << SPA_DATA_DMA_BUF);
        assert_eq!(shm, (1u32 << SPA_DATA_MEM_FD) | (1u32 << SPA_DATA_MEM_PTR));
    }

    #[test]
    fn buffer_datatype_pod_round_trips_for_each_mask() {
        // The serialized Buffers pod must be non-empty for both masks — this is what
        // `update_params` ships to the compositor and `connect()` retries with.
        let dmabuf_bytes = build_buffer_datatype_pod(dmabuf_only_mask())
            .expect("dmabuf-only pod serializes");
        let shm_bytes = build_buffer_datatype_pod(shm_only_mask())
            .expect("shm-only pod serializes");
        assert!(!dmabuf_bytes.is_empty());
        assert!(!shm_bytes.is_empty());
        // The two serializations must differ — otherwise the compositor would receive
        // identical constraints on the fallback retry.
        assert_ne!(
            dmabuf_bytes, shm_bytes,
            "dmabuf-only and shm-only pods must serialize to different bytes",
        );
    }

    #[test]
    fn format_enum_pod_builds() {
        // Used for the first-connect primary pod. Verified separately from the
        // retry-reconnect path, which now uses build_format_enum_pod_legacy_permissive.
        let bytes = build_format_enum_pod(None).expect("format enum pod serializes");
        assert!(!bytes.is_empty());
    }

    #[test]
    fn retry_shm_reconnect_uses_legacy_permissive_pod() {
        // RetryShmAfterDmaBufFailure must reconnect with the legacy permissive pod
        // (VideoFramerate min=0/1) not the primary nonzero-rate pod (min=1/1).
        // KDE Wayland proposes 0/1 (variable rate) during format negotiation;
        // the primary pod rejects 0/1 (below min=1/1) causing a second failure
        // and triggering the second-fire guard → no-acceptable-buffer-type.
        // This test pins which builder the retry path calls.
        let legacy =
            build_format_enum_pod_legacy_permissive().expect("legacy pod serializes");
        let primary = build_format_enum_pod(None).expect("primary pod serializes");
        // The retry must use the legacy pod — if both pods were identical the fix
        // would be a no-op and the root cause would remain unfixed.
        assert_ne!(
            legacy, primary,
            "retry must use legacy permissive pod (min=0/1), not primary (min=1/1)"
        );
        // The legacy pod must be non-empty so stream.connect() gets valid params.
        assert!(!legacy.is_empty(), "legacy permissive pod must be non-empty");
    }

    // ---- T-016a: framerate hint ------------------------------------------------

    #[test]
    fn format_enum_pod_default_matches_explicit_60() {
        // `None` must produce the same pod as an explicit 60 fps hint. This pins the
        // 60/1 default; any drift would silently change the format the compositor sees.
        let default_bytes = build_format_enum_pod(None).expect("default pod serializes");
        let explicit_bytes =
            build_format_enum_pod(Some(60)).expect("explicit 60 pod serializes");
        assert_eq!(
            default_bytes, explicit_bytes,
            "default hint must serialize identically to Some(60)"
        );
    }

    #[test]
    fn format_enum_pod_clamps_low_hint_to_one() {
        // Hints below 1 fps are clamped up to 1 fps before they reach the pod.
        let clamped = build_format_enum_pod(Some(0)).expect("clamp-low pod serializes");
        let floor = build_format_enum_pod(Some(1)).expect("explicit 1 pod serializes");
        assert_eq!(
            clamped, floor,
            "fps=0 must clamp to fps=1 (matches range floor 1/1)"
        );
    }

    #[test]
    fn format_enum_pod_clamps_high_hint_to_240() {
        // Hints above 240 fps are clamped down to 240 fps before they reach the pod.
        let clamped =
            build_format_enum_pod(Some(9_999)).expect("clamp-high pod serializes");
        let ceiling =
            build_format_enum_pod(Some(240)).expect("explicit 240 pod serializes");
        assert_eq!(
            clamped, ceiling,
            "fps=9999 must clamp to fps=240 (matches range ceiling 240/1)"
        );
    }

    #[test]
    fn legacy_permissive_pod_differs_from_default_60() {
        // The legacy permissive fallback (default/min 0/1) must serialize cleanly and
        // produce a different byte sequence from the new nonzero-rate default pod so
        // that the connect-retry path actually sends different constraints.
        let new_default =
            build_format_enum_pod(None).expect("nonzero-rate default pod serializes");
        let legacy =
            build_format_enum_pod_legacy_permissive().expect("legacy pod serializes");
        assert!(!legacy.is_empty(), "legacy permissive pod must be non-empty");
        assert_ne!(
            new_default, legacy,
            "legacy permissive pod must differ from the nonzero-rate default pod"
        );
    }

    #[test]
    fn force_shm_flag_defaults_off_and_is_sticky_once_set() {
        // First session attempt must be DMA-BUF — flag starts false.
        let counters = DiagCounters::new();
        assert!(!counters.force_shm_on_negotiation.load(Ordering::Relaxed));

        // Soft-fallback path flips it via `store`.
        counters
            .force_shm_on_negotiation
            .store(true, Ordering::Relaxed);
        assert!(counters.force_shm_on_negotiation.load(Ordering::Relaxed));

        // Hard-fail handler uses `swap(true)` to detect a second-time retry and bail
        // out with no-acceptable-buffer-type rather than looping. Verify swap semantics.
        let was_set = counters
            .force_shm_on_negotiation
            .swap(true, Ordering::Relaxed);
        assert!(
            was_set,
            "second retry must see the sticky flag and bail out (no infinite loop)"
        );
    }

    // ---- Issue #2 ----------------------------------------------------------

    #[test]
    fn in_flight_counter_round_trips_through_release_token() {
        // Simulate the process-callback contract: pre-increment before try_send, and
        // the ReleaseToken closure decrements when fired (whether via consumer drop or
        // immediate drop on a Full/Closed channel).
        let counters = Arc::new(DiagCounters::new());
        assert_eq!(counters.in_flight.load(Ordering::Relaxed), 0);

        // "Successful enqueue + downstream consume" — one round trip.
        counters.in_flight.fetch_add(1, Ordering::Relaxed);
        assert_eq!(counters.in_flight.load(Ordering::Relaxed), 1);

        let counters_in_release = Arc::clone(&counters);
        let release = ReleaseToken::new(move || {
            counters_in_release
                .in_flight
                .fetch_sub(1, Ordering::Relaxed);
        });
        drop(release);
        assert_eq!(
            counters.in_flight.load(Ordering::Relaxed),
            0,
            "ReleaseToken decrement must balance the pre-increment"
        );
    }

    #[test]
    fn in_flight_balances_on_back_pressure_drop() {
        // When the bounded frame channel is full, the process callback drops the
        // freshly-built FrameHandle. Its ReleaseToken fires immediately, decrementing
        // the counter so the dropped frame doesn't inflate `in_flight`. The
        // `dropped_since_last` counter is bumped separately so back-pressure stays
        // observable in diagnostics.
        let counters = Arc::new(DiagCounters::new());

        // Simulate three successful enqueues...
        for _ in 0..3 {
            counters.in_flight.fetch_add(1, Ordering::Relaxed);
        }
        assert_eq!(counters.in_flight.load(Ordering::Relaxed), 3);

        // ...followed by a dropped frame (pre-increment, then immediate ReleaseToken
        // fire because the channel rejected the handle).
        counters.in_flight.fetch_add(1, Ordering::Relaxed);
        let counters_drop = Arc::clone(&counters);
        let drop_release = ReleaseToken::new(move || {
            counters_drop.in_flight.fetch_sub(1, Ordering::Relaxed);
        });
        drop(drop_release);
        counters
            .dropped_since_last
            .fetch_add(1, Ordering::Relaxed);

        assert_eq!(
            counters.in_flight.load(Ordering::Relaxed),
            3,
            "dropped frames must not inflate in_flight"
        );
        assert_eq!(
            counters.dropped_since_last.load(Ordering::Relaxed),
            1,
            "dropped frames must still surface in dropped_since_last"
        );
    }

    #[test]
    fn in_flight_decrements_in_release_order_independent_of_consume_order() {
        // Three frames in flight, released in the opposite order from how they were
        // produced — counter still ends at zero.
        let counters = Arc::new(DiagCounters::new());
        let mut tokens = Vec::new();
        for _ in 0..3 {
            counters.in_flight.fetch_add(1, Ordering::Relaxed);
            let c = Arc::clone(&counters);
            tokens.push(ReleaseToken::new(move || {
                c.in_flight.fetch_sub(1, Ordering::Relaxed);
            }));
        }
        assert_eq!(counters.in_flight.load(Ordering::Relaxed), 3);
        // Release in reverse.
        while let Some(t) = tokens.pop() {
            drop(t);
        }
        assert_eq!(counters.in_flight.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn buffer_negotiation_phase_transitions_match_issue_1_contract() {
        // Pure state-machine sanity for the soft-fallback path: DmaBufAttempted →
        // Settled(DmaBuf) on a DMA-BUF buffer; DmaBufAttempted → ShmAttempted on a
        // non-DMA-BUF buffer; ShmAttempted → Settled(Shm) on a SHM buffer; transitions
        // stop once Settled.
        let mut phase = BufferNegotiationPhase::DmaBufAttempted;

        // Compositor honors DMA-BUF on first attempt.
        if matches!(phase, BufferNegotiationPhase::DmaBufAttempted) {
            phase = BufferNegotiationPhase::Settled(BufferMemType::DmaBuf);
        }
        assert_eq!(phase, BufferNegotiationPhase::Settled(BufferMemType::DmaBuf));

        // Fresh session, compositor downgrades.
        let phase = BufferNegotiationPhase::DmaBufAttempted;
        assert!(matches!(phase, BufferNegotiationPhase::DmaBufAttempted));
        // Non-DMA-BUF observed: switch to SHM-attempted.
        let phase = BufferNegotiationPhase::ShmAttempted;
        assert_eq!(phase, BufferNegotiationPhase::ShmAttempted);
        // SHM buffer observed: settle on SHM.
        let phase = BufferNegotiationPhase::Settled(BufferMemType::Shm);
        assert_eq!(phase, BufferNegotiationPhase::Settled(BufferMemType::Shm));
    }

    // ---- Issue #1 / #2 round 3: pre-ready terminal-fail routing & phase decisions ----

    #[test]
    fn categorize_pre_ready_error_recognises_no_acceptable_buffer_type() {
        // Bare exact match (what the cmd handler actually emits).
        assert_eq!(
            categorize_pre_ready_error(REASON_NO_ACCEPTABLE_BUFFER_TYPE),
            REASON_NO_ACCEPTABLE_BUFFER_TYPE,
        );
        // anyhow chains may add prefixes — the reason must still be recognised.
        assert_eq!(
            categorize_pre_ready_error(&format!("wrapped: {REASON_NO_ACCEPTABLE_BUFFER_TYPE}")),
            REASON_NO_ACCEPTABLE_BUFFER_TYPE,
        );
        // Unsupported-format detail still flows to its dedicated reason.
        assert_eq!(
            categorize_pre_ready_error("unsupported negotiated format: SPA raw 99"),
            "format-negotiation-failed",
        );
        // Everything else falls through to the generic stream-negotiation-failed bucket.
        assert_eq!(
            categorize_pre_ready_error("something else entirely"),
            "stream-negotiation-failed",
        );
    }

    #[tokio::test]
    async fn signal_terminal_fail_routes_through_ready_tx_and_event_tx() {
        // The whole point of Issue #1 round 3: a pre-ready terminal error must reach
        // `ready_rx` AND `event_rx`, so neither caller path collapses the reason into
        // `pipewire-thread-exited`.
        let (ready_tx, ready_rx) =
            tokio::sync::oneshot::channel::<anyhow::Result<NegotiatedFormat>>();
        let ready: SharedReadyTx = Arc::new(std::sync::Mutex::new(Some(ready_tx)));
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<PwEvent>(8);
        let quit_flag = Arc::new(AtomicBool::new(false));

        signal_terminal_fail(&ready, &event_tx, &quit_flag, REASON_NO_ACCEPTABLE_BUFFER_TYPE);

        assert!(
            quit_flag.load(Ordering::Relaxed),
            "quit flag must be set so the PW thread exits"
        );

        // Ready channel carries the categorisable reason.
        let ready_result = ready_rx.await.expect("ready_tx must have been fulfilled");
        let err = ready_result.expect_err("must be Err — DMA-BUF + SHM both failed");
        assert_eq!(err.to_string(), REASON_NO_ACCEPTABLE_BUFFER_TYPE);
        assert_eq!(
            categorize_pre_ready_error(&err.to_string()),
            REASON_NO_ACCEPTABLE_BUFFER_TYPE,
            "start_stream must see the exact sessionLost reason, not a generic bucket"
        );

        // Event channel also carries the reason for any post-ready event loop.
        let ev = event_rx.try_recv().expect("event_tx must have received the error");
        match ev {
            PwEvent::Error(msg) => assert_eq!(msg, REASON_NO_ACCEPTABLE_BUFFER_TYPE),
            other => panic!("expected PwEvent::Error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn signal_terminal_fail_is_idempotent_after_ready_consumed() {
        // After the Streaming-state success path has already taken `ready_tx`, a
        // subsequent terminal-fail call must still set quit_flag and emit the event,
        // without panicking on the missing sender.
        let (ready_tx, _ready_rx) =
            tokio::sync::oneshot::channel::<anyhow::Result<NegotiatedFormat>>();
        let ready: SharedReadyTx = Arc::new(std::sync::Mutex::new(Some(ready_tx)));
        // Simulate state_changed taking the sender first.
        let _consumed = ready.lock().unwrap().take().unwrap();
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<PwEvent>(8);
        let quit_flag = Arc::new(AtomicBool::new(false));

        signal_terminal_fail(&ready, &event_tx, &quit_flag, REASON_NO_ACCEPTABLE_BUFFER_TYPE);
        assert!(quit_flag.load(Ordering::Relaxed));
        let ev = event_rx.try_recv().unwrap();
        assert!(matches!(ev, PwEvent::Error(m) if m == REASON_NO_ACCEPTABLE_BUFFER_TYPE));
    }

    // ---- Issue #2 round 3: pre-build phase decision ----

    #[test]
    fn pre_build_action_dmabuf_attempted_proceeds_on_dmabuf_only() {
        // Buffer-type bit is necessary but NOT sufficient — we still proceed to payload
        // extraction without settling. The "Proceed" action is the contract here.
        assert_eq!(
            pre_build_action(BufferNegotiationPhase::DmaBufAttempted, true),
            PreBuildAction::Proceed,
        );
    }

    #[test]
    fn pre_build_action_dmabuf_attempted_falls_back_on_non_dmabuf() {
        // Compositor downgrade: DMA-BUF-only mask ignored, SHM buffer arrived. Soft
        // fallback must be triggered, not settled-as-SHM.
        assert_eq!(
            pre_build_action(BufferNegotiationPhase::DmaBufAttempted, false),
            PreBuildAction::TriggerShmSoftFallback,
        );
    }

    #[test]
    fn pre_build_action_shm_attempted_rejects_dmabuf() {
        // Issue #2: ShmAttempted accepts only SHM (MemFd/MemPtr) buffers as fallback
        // success. A DMA-BUF buffer here is the compositor going rogue; we must reject
        // it, NOT settle as if SHM fallback worked.
        assert_eq!(
            pre_build_action(BufferNegotiationPhase::ShmAttempted, true),
            PreBuildAction::RejectDmaBufInShm,
        );
    }

    #[test]
    fn pre_build_action_shm_attempted_proceeds_on_shm_only() {
        assert_eq!(
            pre_build_action(BufferNegotiationPhase::ShmAttempted, false),
            PreBuildAction::Proceed,
        );
    }

    #[test]
    fn pre_build_action_settled_proceeds_unconditionally() {
        // After settle, both transports just flow through.
        assert_eq!(
            pre_build_action(BufferNegotiationPhase::Settled(BufferMemType::DmaBuf), true),
            PreBuildAction::Proceed,
        );
        assert_eq!(
            pre_build_action(BufferNegotiationPhase::Settled(BufferMemType::Shm), false),
            PreBuildAction::Proceed,
        );
    }

    // ---- Issue #2 round 3: payload-failure phase decision ----

    #[test]
    fn payload_fail_action_dmabuf_below_threshold_is_transient() {
        // Single bad DMA-BUF frame must not trip SHM fallback.
        for failures in 1..DMABUF_UNUSABLE_THRESHOLD {
            assert_eq!(
                payload_fail_action(
                    BufferNegotiationPhase::DmaBufAttempted,
                    failures,
                    DMABUF_UNUSABLE_THRESHOLD,
                ),
                PayloadFailAction::DmaBufTransientRetry,
                "failures={failures} should still be transient",
            );
        }
    }

    #[test]
    fn payload_fail_action_dmabuf_at_threshold_triggers_shm_fallback() {
        // Threshold reached → SHM fallback before any terminal failure is emitted.
        assert_eq!(
            payload_fail_action(
                BufferNegotiationPhase::DmaBufAttempted,
                DMABUF_UNUSABLE_THRESHOLD,
                DMABUF_UNUSABLE_THRESHOLD,
            ),
            PayloadFailAction::TriggerShmFallbackOnUnusableDmaBuf,
        );
        // Above threshold is also fallback (defensive).
        assert_eq!(
            payload_fail_action(
                BufferNegotiationPhase::DmaBufAttempted,
                DMABUF_UNUSABLE_THRESHOLD + 5,
                DMABUF_UNUSABLE_THRESHOLD,
            ),
            PayloadFailAction::TriggerShmFallbackOnUnusableDmaBuf,
        );
    }

    #[test]
    fn payload_fail_action_outside_dmabuf_counts_toward_terminal_failure() {
        // In ShmAttempted or Settled, payload failures only feed the 30-frame
        // `consecutive_frame_failures` counter — they don't try DMA-BUF again.
        for phase in [
            BufferNegotiationPhase::ShmAttempted,
            BufferNegotiationPhase::Settled(BufferMemType::DmaBuf),
            BufferNegotiationPhase::Settled(BufferMemType::Shm),
        ] {
            assert_eq!(
                payload_fail_action(phase, 0, DMABUF_UNUSABLE_THRESHOLD),
                PayloadFailAction::CountTowardTerminalFailure,
                "phase {phase:?} must not retry DMA-BUF on payload failure",
            );
            assert_eq!(
                payload_fail_action(phase, 999, DMABUF_UNUSABLE_THRESHOLD),
                PayloadFailAction::CountTowardTerminalFailure,
                "phase {phase:?} ignores dmabuf_attempt_failures (only DmaBufAttempted uses it)",
            );
        }
    }

    #[test]
    fn dmabuf_failure_path_only_terminates_after_shm_also_fails() {
        // End-to-end logical chain — proves the contract Codex called out:
        // 1. DmaBufAttempted + unusable payload at threshold → SHM fallback
        // 2. ShmAttempted + payload still unusable → counts toward terminal failure
        //    (never circles back to "no-acceptable-buffer-type" before SHM is tried).
        let step1 = payload_fail_action(
            BufferNegotiationPhase::DmaBufAttempted,
            DMABUF_UNUSABLE_THRESHOLD,
            DMABUF_UNUSABLE_THRESHOLD,
        );
        assert_eq!(step1, PayloadFailAction::TriggerShmFallbackOnUnusableDmaBuf);

        // After SHM fallback is triggered, phase becomes ShmAttempted. Any subsequent
        // failure now feeds the terminal-failure counter, NOT the SHM-fallback trigger.
        let step2 = payload_fail_action(
            BufferNegotiationPhase::ShmAttempted,
            0,
            DMABUF_UNUSABLE_THRESHOLD,
        );
        assert_eq!(step2, PayloadFailAction::CountTowardTerminalFailure);
    }
}
