//! `EncoderSession` — runs one selected encoder backend for the lifetime of
//! a capture stream.
//!
//! The session owns:
//!
//! - the [`EncoderBackend`] that was selected by the probe orchestrator;
//! - the [`FragmentSink`] that terminates encoded fMP4 fragments (T-018 will
//!   replace the default counting sink with the rolling segment buffer);
//! - per-session counters used by `encoder.diagnostics`;
//! - a back-pressure tracker that times sustained windows of
//!   [`EncoderError::BackPressure`] from `push_frame`.
//!
//! The session honours N-008 §6.8 — there is **no mid-session encoder
//! switching**.  Any terminal error from the backend ends the session, emits
//! `encoder.runtimeError`, drains the receiver to release in-flight PipeWire
//! buffers, and tears the backend down.  A subsequent capture session re-runs
//! the probe sequence from scratch.
//!
//! In the current T-017 production state, both NVENC and libx264 stubs probe
//! `not-implemented-yet` so no backend is ever selected and this code path is
//! exercised only by the test-only fake backends in `tests/encoder_session.rs`.
//! When real bindings land in the final T-017 slice, this driver is the
//! integration seam.

use std::time::{Duration, Instant};

use crate::capture::{FrameOrControl, FrameReceiver};
use crate::protocol::events::{
    EncoderBackPressureEvent, EncoderDiagnosticsEvent, EncoderRuntimeErrorEvent,
};
use crate::transport::notifier::Notifier;

use super::backend::{EncoderBackend, EncoderConfig, EncoderError};
use super::fragment::{EncodedFragment, FragmentSink, FragmentSinkError};

/// Default cadence for `encoder.diagnostics`.  N-007 §6 specifies ~1 Hz.
pub const DEFAULT_DIAGNOSTICS_PERIOD: Duration = Duration::from_millis(1000);

/// Minimum dwell time before a sustained back-pressure window is reported.
/// Single-frame back-pressure blips don't trip the event.
pub const BACKPRESSURE_REPORT_DWELL: Duration = Duration::from_millis(50);

/// How many bounded retries the EOF `final_drain` performs before giving up
/// and emitting `encoder.runtimeError`.  Each retry awaits
/// [`DEFAULT_EOF_DRAIN_BACKOFF`] before re-attempting backend.drain / sink.push.
pub const DEFAULT_EOF_DRAIN_MAX_ITERS: usize = 16;

/// Backoff between EOF drain retries.  Short enough that bounded retries
/// finish within a few hundred milliseconds, long enough to let a real
/// downstream sink make progress.
pub const DEFAULT_EOF_DRAIN_BACKOFF: Duration = Duration::from_millis(20);

/// How many encoded fragments may sit in the session's retry queue waiting
/// for a sink that is currently back-pressured.  If `pending_fragments`
/// exceeds this cap mid-session the encoder treats the sink as unrecoverable
/// and emits `encoder.runtimeError`.  At ~500 ms per fMP4 fragment, 64
/// fragments ≈ 32 s of buffered output — more than enough to absorb a
/// transient writer stall without growing unbounded.
pub const DEFAULT_PENDING_FRAGMENTS_CAP: usize = 64;

/// Diagnostic state name shipped in `encoder.diagnostics.state`.  N-007 §6
/// uses these strings.
pub mod state {
    pub const STARTING: &str = "starting";
    pub const ACTIVE: &str = "active";
    pub const BACKPRESSURED: &str = "backpressured";
    pub const ERRORED: &str = "errored";
    pub const STOPPED: &str = "stopped";
}

/// Terminal-failure description handed back from `drain_fragments` to
/// `run_loop` so the caller can drain the receiver *before* emitting the
/// `encoder.runtimeError` event.
struct TerminalReason {
    code: &'static str,
    details: String,
}

impl TerminalReason {
    fn new(code: &'static str, details: String) -> Self {
        Self { code, details }
    }
}

/// Outcome of one session run.  Returned by [`EncoderSession::run`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionExit {
    /// FrameReceiver closed cleanly — capture stopped.
    StreamEnded,
    /// Backend returned `EncoderError::Runtime(...)` and the session ended.
    /// `encoder.runtimeError` was already emitted; no further events should
    /// fire on this session.
    RuntimeError,
    /// `configure()` failed before the encode loop started.
    ConfigureFailed,
}

/// Counters surfaced through `encoder.diagnostics`.
#[derive(Debug, Default, Clone, Copy)]
pub struct SessionCounters {
    pub frames_in: u64,
    pub frames_encoded: u64,
    pub frames_dropped: u64,
    pub fragments_emitted: u64,
    pub bytes_emitted: u64,
    pub encode_latency_total_ns: u128,
    pub encode_latency_samples: u64,
    pub dmabuf_imports: u64,
    pub shm_copy_bytes: u64,
    pub hwenc_runtime_errors: u64,
}

impl SessionCounters {
    fn mean_latency_ms(&self) -> f64 {
        if self.encode_latency_samples == 0 {
            return 0.0;
        }
        let total_ms = self.encode_latency_total_ns as f64 / 1_000_000.0;
        total_ms / self.encode_latency_samples as f64
    }
}

/// Driver for one encoder session.
///
/// Owns the selected backend and the fragment sink, and runs the encode loop
/// until the FrameReceiver closes, the backend returns a terminal error, or
/// `configure()` fails up front.
pub struct EncoderSession<S: FragmentSink> {
    backend: Box<dyn EncoderBackend>,
    sink: S,
    notifier: Notifier,
    config: EncoderConfig,
    counters: SessionCounters,
    bytes_window: WindowBytes,
    backpressure: BackPressureTracker,
    diagnostics_period: Duration,
    backpressure_dwell: Duration,
    eof_drain_max_iters: usize,
    eof_drain_backoff: Duration,
    /// Retry queue for fragments the sink rejected with `BackPressure`.
    /// Codex review 2026-05-16_20-25-29 Issue #1: mid-session sink BP must
    /// preserve the fragment for retry on the next `drain_fragments` round
    /// rather than silently dropping it.  `final_drain` shares this queue
    /// so any held fragments are flushed at EOF.
    pending_fragments: std::collections::VecDeque<EncodedFragment>,
    pending_fragments_cap: usize,
    /// Set once `sink.set_init_segment` succeeds.  Retried after each
    /// successful `drain_fragments` because NVENC extracts SPS/PPS from the
    /// first IDR frame during drain, not during `push_frame` — so the early
    /// `backend.init_segment()` call in `run()` returns `None` and must be
    /// retried here.
    init_persisted: bool,
}

/// Outcome of one [`EncoderSession::try_flush_pending`] sweep.
enum FlushOutcome {
    /// `pending_fragments` is empty — every queued fragment was delivered.
    Complete,
    /// Sink returned `BackPressure`; the front of `pending_fragments` is
    /// retained for retry.  `pending_fragments` may still have shrunk if
    /// some fragments were accepted before the BP.
    BackPressure,
    /// Sink terminal error — propagate up.
    Terminal(TerminalReason),
}

/// Tracks how many bytes were emitted in the last diagnostics window so the
/// bitrate field reflects observed throughput rather than a session average.
#[derive(Debug, Default, Clone, Copy)]
struct WindowBytes {
    last_tick: Option<Instant>,
    bytes_at_last_tick: u64,
}

impl WindowBytes {
    fn observe(&mut self, now: Instant, total_bytes: u64) -> f64 {
        let last_tick = self.last_tick.replace(now);
        let last_bytes = std::mem::replace(&mut self.bytes_at_last_tick, total_bytes);
        let elapsed = match last_tick {
            Some(prev) => now.saturating_duration_since(prev),
            None => return 0.0,
        };
        if elapsed.is_zero() {
            return 0.0;
        }
        let delta_bytes = total_bytes.saturating_sub(last_bytes) as f64;
        let elapsed_secs = elapsed.as_secs_f64();
        if elapsed_secs <= 0.0 {
            return 0.0;
        }
        (delta_bytes * 8.0) / elapsed_secs
    }
}

/// Records sustained back-pressure windows.  A "window" starts on the first
/// `push_frame` → `EncoderError::BackPressure` and stays open until the next
/// successful `push_frame`.  Windows shorter than `dwell` are observed for
/// counters but do **not** fire `encoder.backPressure`.
#[derive(Debug, Default)]
struct BackPressureTracker {
    window_started: Option<Instant>,
    dropped_in_window: u64,
    reported_for_window: bool,
}

impl BackPressureTracker {
    fn on_drop(&mut self, now: Instant) {
        if self.window_started.is_none() {
            self.window_started = Some(now);
            self.reported_for_window = false;
        }
        self.dropped_in_window = self.dropped_in_window.saturating_add(1);
    }

    fn on_progress(&mut self) {
        self.window_started = None;
        self.dropped_in_window = 0;
        self.reported_for_window = false;
    }

    /// Returns `Some((sustained_ms, dropped_since_last))` when a sustained
    /// window has exceeded `dwell` and has not yet been reported.  Marks the
    /// current window as reported so the event fires at most once per window.
    fn take_report(&mut self, now: Instant, dwell: Duration) -> Option<(u64, u64)> {
        let started = self.window_started?;
        if self.reported_for_window {
            return None;
        }
        let sustained = now.saturating_duration_since(started);
        if sustained < dwell {
            return None;
        }
        self.reported_for_window = true;
        Some((sustained.as_millis() as u64, self.dropped_in_window))
    }
}

impl<S: FragmentSink> EncoderSession<S> {
    pub fn new(
        backend: Box<dyn EncoderBackend>,
        sink: S,
        notifier: Notifier,
        config: EncoderConfig,
    ) -> Self {
        Self {
            backend,
            sink,
            notifier,
            config,
            counters: SessionCounters::default(),
            bytes_window: WindowBytes::default(),
            backpressure: BackPressureTracker::default(),
            diagnostics_period: DEFAULT_DIAGNOSTICS_PERIOD,
            backpressure_dwell: BACKPRESSURE_REPORT_DWELL,
            eof_drain_max_iters: DEFAULT_EOF_DRAIN_MAX_ITERS,
            eof_drain_backoff: DEFAULT_EOF_DRAIN_BACKOFF,
            pending_fragments: std::collections::VecDeque::new(),
            pending_fragments_cap: DEFAULT_PENDING_FRAGMENTS_CAP,
            init_persisted: false,
        }
    }

    pub fn with_diagnostics_period(mut self, period: Duration) -> Self {
        self.diagnostics_period = period;
        self
    }

    pub fn with_backpressure_dwell(mut self, dwell: Duration) -> Self {
        self.backpressure_dwell = dwell;
        self
    }

    pub fn with_eof_drain_max_iters(mut self, n: usize) -> Self {
        self.eof_drain_max_iters = n;
        self
    }

    pub fn with_eof_drain_backoff(mut self, d: Duration) -> Self {
        self.eof_drain_backoff = d;
        self
    }

    pub fn with_pending_fragments_cap(mut self, n: usize) -> Self {
        self.pending_fragments_cap = n;
        self
    }

    pub fn counters(&self) -> SessionCounters {
        self.counters
    }

    /// Configure the backend, then run the encode loop until exit.  Always
    /// calls `backend.teardown()` before returning.
    ///
    /// Terminal cleanup ordering is load-bearing across every failure path
    /// (configure failure, push_frame Runtime, drain Runtime, sink Closed,
    /// sink Internal, NotImplementedYet defensive guards):
    /// 1. **Drain the receiver first** via `drain_remaining(rx)` —
    ///    `rx.close()` so the producer's `try_send` returns `Closed` (and
    ///    `pipewire.rs:1605` drops the handle, firing its `ReleaseToken`),
    ///    then drain whatever is buffered.
    /// 2. **Emit `encoder.runtimeError` non-blocking** via
    ///    `Notifier::try_notify`.  Cleanup MUST NOT await transport
    ///    progress — a stalled writer would otherwise defer
    ///    `backend.teardown()` indefinitely (Codex review
    ///    2026-05-16_11-39-52 Issue #1).
    /// 3. **`teardown()`** the backend.
    pub async fn run(mut self, rx: FrameReceiver) -> SessionExit {
        let exit = match self.backend.configure(self.config.clone()).await {
            Ok(()) => {
                if let Some(init) = self.backend.init_segment() {
                    if let Err(e) = self.sink.set_init_segment(init).await {
                        self.drain_remaining(rx).await;
                        self.emit_runtime_error("init-segment-failed", &e.to_string());
                        return {
                            let _ = self.sink.finalize().await;
                            let _ = self.backend.teardown().await;
                            SessionExit::RuntimeError
                        };
                    }
                    self.init_persisted = true;
                }
                self.run_loop(rx).await
            }
            Err(err) => {
                // Drain BEFORE emit so receiver close cannot be deferred
                // by a stalled notifier (terminal cleanup ordering rule).
                self.drain_remaining(rx).await;
                self.emit_runtime_error("configure-failed", &err.to_string());
                SessionExit::ConfigureFailed
            }
        };
        self.sink.set_closing();
        let exit = match self.sink.finalize().await {
            Ok(()) => exit,
            Err(e) if exit == SessionExit::StreamEnded => {
                self.emit_runtime_error("finalize-failed", &e.to_string());
                SessionExit::RuntimeError
            }
            Err(_) => exit,
        };
        let _ = self.backend.teardown().await;
        exit
    }

    async fn run_loop(&mut self, mut rx: FrameReceiver) -> SessionExit {
        let backend_name = self.backend.name().to_string();
        self.bytes_window = WindowBytes::default();
        self.backpressure = BackPressureTracker::default();

        let mut diag_ticker = tokio::time::interval(self.diagnostics_period);
        // First tick fires immediately; we want the first emission only after a
        // full period has elapsed so counters have something to report.
        diag_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        diag_ticker.tick().await;

        loop {
            tokio::select! {
                maybe_item = rx.recv() => {
                    let Some(item) = maybe_item else {
                        // Receiver closed cleanly.  `drain_fragments` (the
                        // mid-session helper) collapses backend/sink back-pressure
                        // into "try again on the next push" — but at EOF there
                        // *is* no next push, so we must distinguish complete
                        // success from retryable back-pressure or we silently
                        // discard tail output.  `final_drain` runs a bounded
                        // retry loop and converts unresolved back-pressure into
                        // a terminal runtime error.  The receiver is already
                        // exhausted, so no extra close/drain pass is needed.
                        if let Some(reason) = self.final_drain().await {
                            self.emit_runtime_error(&reason.code, &reason.details);
                            return SessionExit::RuntimeError;
                        }
                        return SessionExit::StreamEnded;
                    };
                    match item {
                        FrameOrControl::FormatChanged => {
                            if let Err(e) = self.sink.notify_format_change().await {
                                match e {
                                    FragmentSinkError::Closed => {
                                        self.drain_remaining(rx).await;
                                        self.emit_runtime_error("fragment-sink-closed", "sink closed on format change");
                                        return SessionExit::RuntimeError;
                                    }
                                    FragmentSinkError::Internal(msg) => {
                                        self.drain_remaining(rx).await;
                                        self.emit_runtime_error("format-change-commit-failed", &msg);
                                        return SessionExit::RuntimeError;
                                    }
                                    FragmentSinkError::BackPressure => {}
                                }
                            }
                        }
                        FrameOrControl::Frame(frame) => {
                            self.counters.frames_in = self.counters.frames_in.saturating_add(1);
                            let push_started = Instant::now();
                            let push_result = self.backend.push_frame(frame).await;
                            let push_elapsed = push_started.elapsed();
                            self.counters.encode_latency_total_ns =
                                self.counters.encode_latency_total_ns.saturating_add(push_elapsed.as_nanos());
                            self.counters.encode_latency_samples =
                                self.counters.encode_latency_samples.saturating_add(1);

                            match push_result {
                                Ok(()) => {
                                    self.counters.frames_encoded =
                                        self.counters.frames_encoded.saturating_add(1);
                                    self.backpressure.on_progress();
                                    if let Some(reason) = self.drain_fragments().await {
                                        // Terminal cleanup: drain BEFORE emit so the
                                        // notifier never gates receiver close.
                                        self.drain_remaining(rx).await;
                                        self.emit_runtime_error(&reason.code, &reason.details);
                                        return SessionExit::RuntimeError;
                                    }
                                    if !self.init_persisted {
                                        if let Some(init) = self.backend.init_segment() {
                                            match self.sink.set_init_segment(init).await {
                                                Ok(()) => {
                                                    self.init_persisted = true;
                                                }
                                                Err(FragmentSinkError::BackPressure) => {}
                                                Err(e) => {
                                                    self.drain_remaining(rx).await;
                                                    self.emit_runtime_error(
                                                        "init-segment-failed",
                                                        &e.to_string(),
                                                    );
                                                    return SessionExit::RuntimeError;
                                                }
                                            }
                                        }
                                    }
                                }
                                Err(EncoderError::BackPressure) => {
                                    self.counters.frames_dropped =
                                        self.counters.frames_dropped.saturating_add(1);
                                    let now = Instant::now();
                                    self.backpressure.on_drop(now);
                                    if let Some((sustained_ms, dropped)) =
                                        self.backpressure.take_report(now, self.backpressure_dwell)
                                    {
                                        self.emit_back_pressure(&backend_name, sustained_ms, dropped);
                                    }
                                }
                                Err(EncoderError::Runtime(reason)) => {
                                    self.counters.hwenc_runtime_errors =
                                        self.counters.hwenc_runtime_errors.saturating_add(1);
                                    // Drain BEFORE emit (terminal cleanup ordering).
                                    self.drain_remaining(rx).await;
                                    self.emit_runtime_error("push-frame-runtime", &reason);
                                    return SessionExit::RuntimeError;
                                }
                                Err(EncoderError::NotImplementedYet(what)) => {
                                    // Defensive: probe should have prevented selection of an
                                    // unimplemented backend.  Treat as terminal.
                                    self.drain_remaining(rx).await;
                                    self.emit_runtime_error(
                                        "backend-not-implemented",
                                        &format!("push_frame: {what}"),
                                    );
                                    return SessionExit::RuntimeError;
                                }
                            }
                        }
                    }
                }
                _ = diag_ticker.tick() => {
                    self.emit_diagnostics(&backend_name);
                }
            }
        }
    }

    /// Push pending fragments to the sink until either the queue is empty,
    /// the sink BackPressures (the front fragment is **retained**), or a
    /// terminal sink error fires.  Cloning the front entry lets us retry
    /// the same fragment on the next sweep without changing the
    /// `FragmentSink` trait surface.
    async fn try_flush_pending(&mut self) -> FlushOutcome {
        while let Some(frag_ref) = self.pending_fragments.front() {
            let frag = frag_ref.clone();
            let bytes_len = frag.bytes.len() as u64;
            match self.sink.push(frag).await {
                Ok(()) => {
                    self.pending_fragments.pop_front();
                    self.counters.fragments_emitted =
                        self.counters.fragments_emitted.saturating_add(1);
                    self.counters.bytes_emitted =
                        self.counters.bytes_emitted.saturating_add(bytes_len);
                }
                Err(FragmentSinkError::Closed) => {
                    return FlushOutcome::Terminal(TerminalReason::new(
                        "fragment-sink-closed",
                        "sink closed".to_string(),
                    ));
                }
                Err(FragmentSinkError::BackPressure) => {
                    return FlushOutcome::BackPressure;
                }
                Err(FragmentSinkError::Internal(e)) => {
                    return FlushOutcome::Terminal(TerminalReason::new(
                        "fragment-sink-internal",
                        e,
                    ));
                }
            }
        }
        FlushOutcome::Complete
    }

    /// Mid-session drain helper called after every successful `push_frame`.
    /// Pulls the latest output from the backend, appends it to the session's
    /// retry queue, and tries to flush.  On sink back-pressure the queued
    /// fragments are **retained** for the next round (Codex review
    /// 2026-05-16_20-25-29 Issue #1: no silent mid-session data loss).  The
    /// `pending_fragments_cap` bounds queue growth — exceeding it surfaces
    /// `encoder.runtimeError` with `sink-back-pressure-unbounded` so the
    /// session ends cleanly rather than buffering forever.
    ///
    /// Returns `Some(TerminalReason)` if the session must end.  Does NOT
    /// emit any events — the caller does that *after* draining the receiver,
    /// so notifier delivery can never defer receiver close / `teardown`
    /// (Codex review 2026-05-16_11-39-52).
    async fn drain_fragments(&mut self) -> Option<TerminalReason> {
        match self.backend.drain().await {
            Ok(frags) => self.pending_fragments.extend(frags),
            Err(EncoderError::BackPressure) => {
                // Backend deferred; we still attempt to flush anything left
                // over from a previous sink back-pressure.
            }
            Err(EncoderError::Runtime(reason)) => {
                self.counters.hwenc_runtime_errors =
                    self.counters.hwenc_runtime_errors.saturating_add(1);
                return Some(TerminalReason::new("drain-runtime", reason));
            }
            Err(EncoderError::NotImplementedYet(what)) => {
                return Some(TerminalReason::new(
                    "backend-not-implemented",
                    format!("drain: {what}"),
                ));
            }
        }
        match self.try_flush_pending().await {
            FlushOutcome::Complete => None,
            FlushOutcome::BackPressure => {
                if self.pending_fragments.len() > self.pending_fragments_cap {
                    Some(TerminalReason::new(
                        "sink-back-pressure-unbounded",
                        format!(
                            "pending fragments ({}) exceeded cap ({})",
                            self.pending_fragments.len(),
                            self.pending_fragments_cap
                        ),
                    ))
                } else {
                    None
                }
            }
            FlushOutcome::Terminal(r) => Some(r),
        }
    }

    /// Final drain executed once on clean stream end.  Unlike
    /// [`drain_fragments`](Self::drain_fragments) — which is happy to defer
    /// back-pressure to the next push — this method retries with a small
    /// backoff so a real encoder can flush its tail buffer and a sink can
    /// finish absorbing the last fragments.
    ///
    /// Retry budget semantics (Codex review 2026-05-16_18-59-21 Issue #1):
    /// the budget applies to **consecutive stalled iterations** — iterations
    /// in which neither the backend produced output nor the sink accepted a
    /// fragment.  Any progress resets the counter, so a successful flush on
    /// the last "allowed" iteration is not mistaken for unresolved
    /// back-pressure.  A separate, much larger safety cap guards against a
    /// truly runaway backend that keeps producing fragments forever.
    ///
    /// `StreamEnded` is only reachable when `backend.drain()` returns
    /// `Ok(empty)` AND `pending` is empty — i.e. the backend has confirmed
    /// it has no more output and every fragment has been delivered to the
    /// sink.
    async fn final_drain(&mut self) -> Option<TerminalReason> {
        // Shared retry queue with mid-session `drain_fragments`.  Any
        // fragments left over from a sink BackPressure during the live
        // capture session are picked up here automatically.
        let mut consecutive_stalled: usize = 0;
        let mut total_iters: usize = 0;
        let max_stalled = self.eof_drain_max_iters.max(1);
        // Defensive safety cap: a buggy backend that keeps producing fragments
        // forever shouldn't hang the helper.  Generous multiplier so the
        // common case (a few tail fragments, a few BP rounds) never trips it.
        let safety_cap = max_stalled.saturating_mul(64).max(64);

        loop {
            if total_iters >= safety_cap {
                return Some(TerminalReason::new(
                    "drain-runaway-at-eof",
                    format!(
                        "final drain ran {total_iters} iterations without converging (pending fragments: {})",
                        self.pending_fragments.len()
                    ),
                ));
            }
            total_iters += 1;

            // Pull more output from the backend whenever we're not in the
            // middle of flushing sink-deferred fragments.
            if self.pending_fragments.is_empty() {
                match self.backend.drain().await {
                    Ok(frags) => {
                        if frags.is_empty() {
                            // Backend confirms no more output AND nothing is
                            // queued for the sink → clean final-drain success.
                            return None;
                        }
                        self.pending_fragments.extend(frags);
                        consecutive_stalled = 0; // backend made progress
                        continue;
                    }
                    Err(EncoderError::BackPressure) => {
                        consecutive_stalled = consecutive_stalled.saturating_add(1);
                        if consecutive_stalled >= max_stalled {
                            return Some(TerminalReason::new(
                                "drain-backpressure-unresolved-at-eof",
                                format!(
                                    "backend.drain still back-pressured after {max_stalled} consecutive retries"
                                ),
                            ));
                        }
                        tokio::time::sleep(self.eof_drain_backoff).await;
                        continue;
                    }
                    Err(EncoderError::Runtime(reason)) => {
                        self.counters.hwenc_runtime_errors =
                            self.counters.hwenc_runtime_errors.saturating_add(1);
                        return Some(TerminalReason::new("drain-runtime", reason));
                    }
                    Err(EncoderError::NotImplementedYet(what)) => {
                        return Some(TerminalReason::new(
                            "backend-not-implemented",
                            format!("drain: {what}"),
                        ));
                    }
                }
            }

            let len_before = self.pending_fragments.len();
            match self.try_flush_pending().await {
                FlushOutcome::Complete => {
                    consecutive_stalled = 0;
                    if !self.init_persisted {
                        if let Some(init) = self.backend.init_segment() {
                            match self.sink.set_init_segment(init).await {
                                Ok(()) => {
                                    self.init_persisted = true;
                                }
                                Err(FragmentSinkError::BackPressure) => {}
                                Err(e) => {
                                    return Some(TerminalReason::new(
                                        "init-segment-failed",
                                        e.to_string(),
                                    ));
                                }
                            }
                        }
                    }
                    // Loop continues; next iter's empty check will ask
                    // backend.drain() for the final empty confirmation.
                }
                FlushOutcome::BackPressure => {
                    let progressed = self.pending_fragments.len() < len_before;
                    if progressed {
                        consecutive_stalled = 0;
                    } else {
                        consecutive_stalled = consecutive_stalled.saturating_add(1);
                        if consecutive_stalled >= max_stalled {
                            return Some(TerminalReason::new(
                                "drain-backpressure-unresolved-at-eof",
                                format!(
                                    "sink still back-pressured after {max_stalled} consecutive retries (pending fragments: {})",
                                    self.pending_fragments.len()
                                ),
                            ));
                        }
                    }
                    tokio::time::sleep(self.eof_drain_backoff).await;
                }
                FlushOutcome::Terminal(reason) => return Some(reason),
            }
        }
    }

    /// Terminate consumption after a terminal encoder error.  We MUST NOT
    /// keep accepting new frames — in the live PipeWire path the capture
    /// thread still owns a `FrameSender` until `capture.stopSession` (or
    /// disconnect / shutdown) runs, so waiting for the sender to drop would
    /// hang the session and delay `backend.teardown()` indefinitely.
    ///
    /// Order of operations is load-bearing:
    /// 1. `rx.close()` — flips the receiver into "closed" state.  Subsequent
    ///    `try_send` on the PW side returns `TrySendError::Closed`, which
    ///    pipewire.rs handles by dropping the `FrameHandle` (firing its
    ///    `ReleaseToken`) — so no PW buffer leaks even though the encoder
    ///    has bailed.
    /// 2. Drain whatever is *already buffered* in the channel.  `recv()`
    ///    on a closed receiver returns each queued item and then `None`,
    ///    so this loop terminates promptly.  Dropping each `FrameHandle`
    ///    fires its `ReleaseToken`, preserving the T-022 release invariant
    ///    for queued frames.
    async fn drain_remaining(&mut self, mut rx: FrameReceiver) {
        rx.close();
        while rx.recv().await.is_some() {}
    }

    /// Non-blocking emission for `encoder.diagnostics`.  Advisory telemetry —
    /// must never block the encode loop on transport progress.  If the
    /// notifier's bounded channel is full, this diagnostics tick is silently
    /// coalesced (the next tick re-emits a fresh snapshot).  Codex review
    /// 2026-05-16_12-39-06 Issue #2.
    fn emit_diagnostics(&mut self, backend_name: &str) {
        let now = Instant::now();
        let bitrate = self.bytes_window.observe(now, self.counters.bytes_emitted);
        let state = if self.backpressure.window_started.is_some() {
            state::BACKPRESSURED
        } else if self.counters.frames_encoded == 0 {
            state::STARTING
        } else {
            state::ACTIVE
        };
        let evt = EncoderDiagnosticsEvent {
            backend: backend_name.to_string(),
            state: state.to_string(),
            frames_in: self.counters.frames_in,
            frames_encoded: self.counters.frames_encoded,
            frames_dropped: self.counters.frames_dropped,
            encode_latency_ms: self.counters.mean_latency_ms(),
            bitrate_observed: bitrate,
            vbv_underruns: 0,
            dmabuf_imports: self.counters.dmabuf_imports,
            shm_copy_bytes: self.counters.shm_copy_bytes,
            hwenc_runtime_errors: self.counters.hwenc_runtime_errors,
        };
        if let Ok(v) = serde_json::to_value(&evt) {
            let _ = self.notifier.try_notify("encoder.diagnostics", v);
        }
    }

    /// Non-blocking emission for `encoder.backPressure`.  Advisory event —
    /// dropped on a full transport channel so a stalled writer cannot stall
    /// the encode loop.  Codex review 2026-05-16_12-39-06 Issue #2.
    fn emit_back_pressure(&self, backend_name: &str, sustained_ms: u64, dropped_since_last: u64) {
        let evt = EncoderBackPressureEvent {
            backend: backend_name.to_string(),
            sustained_ms,
            dropped_since_last,
        };
        if let Ok(v) = serde_json::to_value(&evt) {
            let _ = self.notifier.try_notify("encoder.backPressure", v);
        }
    }

    /// Non-blocking emission for `encoder.runtimeError`.  Uses
    /// `Notifier::try_notify`, so a stalled / saturated transport channel
    /// cannot defer terminal cleanup.  If the channel is full the event is
    /// dropped silently — the renderer can recover (the session ends
    /// regardless) and the cleanup invariants (receiver close, ReleaseToken
    /// drain, backend teardown) are preserved.
    fn emit_runtime_error(&self, reason_code: &str, details: &str) {
        let evt = EncoderRuntimeErrorEvent {
            backend: self.backend.name().to_string(),
            reason_code: reason_code.to_string(),
            details: details.to_string(),
            diagnostics_path: String::new(),
        };
        if let Ok(v) = serde_json::to_value(&evt) {
            let _ = self.notifier.try_notify("encoder.runtimeError", v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_bytes_first_observe_is_zero() {
        let mut w = WindowBytes::default();
        let bitrate = w.observe(Instant::now(), 1024);
        assert_eq!(bitrate, 0.0);
    }

    #[test]
    fn window_bytes_returns_positive_bitrate_for_growth() {
        let mut w = WindowBytes::default();
        let t0 = Instant::now();
        let _ = w.observe(t0, 0);
        let t1 = t0 + Duration::from_millis(1000);
        let bitrate = w.observe(t1, 125_000);
        // 125_000 bytes / 1 s = 1 Mbit/s
        assert!((bitrate - 1_000_000.0).abs() < 1.0, "got {bitrate}");
    }

    #[test]
    fn backpressure_tracker_reports_once_after_dwell() {
        let mut tr = BackPressureTracker::default();
        let t0 = Instant::now();
        tr.on_drop(t0);
        // Below dwell → no report.
        assert!(tr
            .take_report(t0 + Duration::from_millis(10), Duration::from_millis(50))
            .is_none());
        // Past dwell → one report.
        let report = tr
            .take_report(t0 + Duration::from_millis(60), Duration::from_millis(50))
            .expect("report should fire after dwell");
        assert!(report.0 >= 50);
        assert_eq!(report.1, 1);
        // Same window must not re-report.
        assert!(tr
            .take_report(t0 + Duration::from_millis(120), Duration::from_millis(50))
            .is_none());
    }

    #[test]
    fn backpressure_tracker_resets_on_progress() {
        let mut tr = BackPressureTracker::default();
        let t0 = Instant::now();
        tr.on_drop(t0);
        tr.on_progress();
        assert!(tr
            .take_report(t0 + Duration::from_secs(1), Duration::from_millis(50))
            .is_none());
        // New window can fire again.
        let t1 = t0 + Duration::from_secs(2);
        tr.on_drop(t1);
        let report = tr.take_report(t1 + Duration::from_millis(100), Duration::from_millis(50));
        assert!(report.is_some());
    }

    #[test]
    fn session_counters_mean_latency_handles_zero_samples() {
        let c = SessionCounters::default();
        assert_eq!(c.mean_latency_ms(), 0.0);
    }
}
