use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc,
};

use serde_json::json;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::{
    capture::CaptureSource,
    engine::SharedState,
    protocol::{
        envelope::{Response, RpcError},
        events::{
            CaptureDiagnosticsEvent, SessionLostEvent, StreamPausedEvent, StreamResumedEvent,
        },
        types::{
            CaptureFormat, CaptureMode, CaptureSourceDescriptor, CursorMode, PersistMode, Rect,
            RequestSessionOpts, RestoreTokenInfo,
        },
    },
    transport::notifier::Notifier,
};

// ── Internal event / command channels ────────────────────────────────────────

#[derive(Debug)]
#[allow(dead_code)] // StateChanged/ParamChanged fired in T-016a via PW stream callbacks
enum PwEvent {
    StateChanged(u32),
    ParamChanged(u32),
    Error(String),
}

#[derive(Debug)]
enum PwCommand {
    Pause,
    Resume,
    Quit,
}

type PwEventTx = std::sync::mpsc::SyncSender<PwEvent>;
#[allow(dead_code)] // used in T-016a stream processing
type PwEventRx = std::sync::mpsc::Receiver<PwEvent>;
type PwCmdTx = pipewire::channel::Sender<PwCommand>;

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
#[allow(dead_code)] // Recording is set in T-016a when PW stream reaches Streaming state
enum PwPhase {
    Idle,
    /// Portal negotiated; `pw_fd` stored; waiting for `start_stream`.
    SessionRequested,
    /// PW thread running; stream not yet in Streaming state.
    Streaming,
    /// PW stream reached Streaming state (wired in T-016a).
    Recording,
}

struct PwInner {
    phase: PwPhase,
    session_id: Option<String>,
    stream_id: Option<String>,
    /// Dropping this tx closes the portal session background task.
    portal_close_tx: Option<tokio::sync::oneshot::Sender<()>>,
    /// PipeWire fd for `start_stream` to consume.
    pw_fd: Option<std::os::fd::OwnedFd>,
    /// Set true to stop the PW poll loop.
    pw_quit: Option<Arc<AtomicBool>>,
    pw_cmd_tx: Option<PwCmdTx>,
    session_cancel_tx: Option<tokio::sync::watch::Sender<bool>>,
    stream_paused: bool,
}

// ── PipeWireSource ────────────────────────────────────────────────────────────

pub struct PipeWireSource {
    notifier: Notifier,
    restore_store: RestoreStore,
    inner: Mutex<PwInner>,
    session_counter: AtomicU32,
    stream_counter: AtomicU32,
}

impl PipeWireSource {
    pub fn new(notifier: Notifier) -> Self {
        PipeWireSource {
            notifier,
            restore_store: RestoreStore::new(),
            inner: Mutex::new(PwInner {
                phase: PwPhase::Idle,
                session_id: None,
                stream_id: None,
                portal_close_tx: None,
                pw_fd: None,
                pw_quit: None,
                pw_cmd_tx: None,
                session_cancel_tx: None,
                stream_paused: false,
            }),
            session_counter: AtomicU32::new(0),
            stream_counter: AtomicU32::new(0),
        }
    }

    /// Runs the full XDG Screencast portal negotiation.
    /// Returns (fd, restore_token, portal_close_tx).
    /// Each of the three portal steps is raced against `cancel_rx`; on cancellation
    /// the portal session is closed and an error is returned.
    async fn run_portal_flow(
        &self,
        opts: &RequestSessionOpts,
        mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    ) -> anyhow::Result<(
        std::os::fd::OwnedFd,
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

        Ok((fd, restore_token, close_tx))
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

        let (fd, _restore_token, close_tx) = self.run_portal_flow(&opts, cancel_rx).await?;

        let session_id = format!(
            "pw-session-{:04}",
            self.session_counter.fetch_add(1, Ordering::SeqCst)
        );

        let mut inner = self.inner.lock().await;
        inner.session_id = Some(session_id.clone());
        inner.pw_fd = Some(fd);
        inner.portal_close_tx = Some(close_tx);
        inner.phase = PwPhase::SessionRequested;
        info!(session_id, "portal session established");
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
        {
            let inner = self.inner.lock().await;
            if inner.phase != PwPhase::SessionRequested {
                anyhow::bail!("start_stream requires SessionRequested phase");
            }
        }
        // T-016a: PipeWire stream creation, format pod negotiation, DMA-BUF/SHM buffer
        // loop, and the capture.sessionReady event are deferred to T-016a.
        anyhow::bail!("not-implemented: PipeWire stream creation and capture.sessionReady deferred to T-016a");
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
            if let Some(ref q) = inner.pw_quit {
                q.store(true, Ordering::Relaxed);
            }
            if let Some(ref tx) = inner.pw_cmd_tx {
                let _ = tx.send(PwCommand::Quit);
            }
            if let Some(ref tx) = inner.session_cancel_tx {
                let _ = tx.send(true);
            }
            let _ = inner.portal_close_tx.take(); // drops the keeper task → portal session closes

            let session_id_owned = inner.session_id.take().unwrap_or_default();
            let stream_id_owned = inner.stream_id.take();
            inner.pw_quit = None;
            inner.pw_cmd_tx = None;
            inner.session_cancel_tx = None;
            inner.stream_paused = false;
            inner.phase = PwPhase::Idle;
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

    async fn set_framerate_hint(&self, _fps: u32) -> anyhow::Result<()> {
        let inner = self.inner.lock().await;
        if inner.phase == PwPhase::Idle {
            anyhow::bail!("no active session");
        }
        // TODO T-016a: forward to encoder framerate hint
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

#[allow(dead_code)]
fn pw_thread_main(
    fd: std::os::fd::OwnedFd,
    event_tx: PwEventTx,
    quit_flag: Arc<AtomicBool>,
    _cmd_rx: pipewire::channel::Receiver<PwCommand>,
) {
    // All PipeWire objects are !Send — must stay on this thread.
    if let Err(e) = pw_thread_run(fd, &quit_flag) {
        let _ = event_tx.send(PwEvent::Error(e.to_string()));
    }
}

#[allow(dead_code)]
fn pw_thread_run(
    fd: std::os::fd::OwnedFd,
    quit_flag: &Arc<AtomicBool>,
) -> anyhow::Result<()> {
    use pipewire::{context::ContextRc, main_loop::MainLoopRc};

    pipewire::init();

    let main_loop = MainLoopRc::new(None)
        .map_err(|e| anyhow::anyhow!("pw mainloop: {e}"))?;

    let context = ContextRc::new(&main_loop, None)
        .map_err(|e| anyhow::anyhow!("pw context: {e}"))?;

    let _core = context
        .connect_fd_rc(fd, None)
        .map_err(|e| anyhow::anyhow!("pw connect_fd_rc: {e}"))?;
    // _core kept alive to maintain the PipeWire connection.

    // TODO T-016a: create StreamBox, attach _cmd_rx listener, connect with SPA format pods.
    // With empty params the stream will not reach Streaming state on real hardware;
    // sessionReady is therefore deferred to T-016a.

    let loop_ = main_loop.loop_();
    while !quit_flag.load(Ordering::Relaxed) {
        loop_.iterate(std::time::Duration::from_millis(100));
    }
    Ok(())
}

// ── Tokio PW-event handler ────────────────────────────────────────────────────

#[allow(dead_code)]
async fn pw_event_loop(
    mut event_rx: tokio::sync::mpsc::Receiver<PwEvent>,
    notifier: Notifier,
    session_id: String,
    stream_id: String,
) {
    while let Some(event) = event_rx.recv().await {
        match event {
            PwEvent::StateChanged(_state_id) => {
                // TODO T-016a: when state == pw::stream::State::Streaming,
                // parse negotiated format and fire capture.sessionReady
            }
            PwEvent::ParamChanged(_param_id) => {
                // TODO T-016a: parse SPA Video format pod, fire capture.formatChanged
            }
            PwEvent::Error(msg) => {
                warn!(session_id, "PW thread error: {msg}");
                let ev = SessionLostEvent {
                    session_id: session_id.clone(),
                    stream_id: Some(stream_id.clone()),
                    reason: "pipewire-error".into(),
                    details: msg,
                    diagnostics_path: String::new(),
                };
                if let Ok(v) = serde_json::to_value(ev) {
                    let _ = notifier.notify("capture.sessionLost", v).await;
                }
                break;
            }
        }
    }
}

// ── 1 Hz diagnostics loop ─────────────────────────────────────────────────────

#[allow(dead_code)]
async fn run_diagnostics_loop(
    stream_id: String,
    notifier: Notifier,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    let start = std::time::Instant::now();
    loop {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
            _ = cancel_rx.changed() => return,
        }
        let diag = CaptureDiagnosticsEvent {
            stream_id: stream_id.clone(),
            // "initializing" until T-016a updates this to "active" on sessionReady
            state: "initializing".into(),
            format: CaptureFormat {
                width: 0,
                height: 0,
                fps_num: 0,
                fps_den: 1,
                fourcc: "unknown".into(),
                modifier: None,
                color_primaries: None,
                transfer: None,
                range: None,
            },
            buffers: json!({}),
            cadence: json!({}),
            cursor_mode: "unknown".into(),
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
            let capture = Arc::new(PipeWireSource::new(notifier.clone()));
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
                    Err(e) => Response::error(
                        id,
                        RpcError {
                            code: serde_json::Value::String("not-implemented".into()),
                            message: e.to_string(),
                            data: None,
                        },
                    ),
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
    state.active_capture.lock().await.clone()
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
