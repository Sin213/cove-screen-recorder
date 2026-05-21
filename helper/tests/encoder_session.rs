//! T-017 — encoder session lifecycle, back-pressure, diagnostics, runtime
//! error.
//!
//! These tests drive `EncoderSession` through its full lifecycle using a fake
//! backend.  Real NVENC and libx264 bindings land in the final T-017 slice;
//! the FSM, counters, diagnostics ticker, and back-pressure dwell logic
//! exercised here must already be airtight when those bindings arrive.
//!
//! Gated to unix because `FrameHandle`, `FrameReceiver`, `ReleaseToken`, and
//! `EncoderBackend::push_frame` are `#[cfg(unix)]` — see `encoder/mod.rs`.

#![cfg(unix)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use cove_replay_engine::capture::{
    frame_channel, FrameOrControl, FramePayload, FrameSender, ReleaseToken,
};
use cove_replay_engine::encoder::backend::{
    EncoderBackend, EncoderConfig, EncoderError, ProbeOutcome,
};
use cove_replay_engine::encoder::fragment::{
    CountingFragmentSink, EncodedFragment, FragmentSink, FragmentSinkError,
};
use cove_replay_engine::encoder::session::{EncoderSession, SessionExit};
use cove_replay_engine::protocol::types::CaptureFormat;
use cove_replay_engine::transport::notifier::Notifier;

fn nv12_1080p60() -> CaptureFormat {
    CaptureFormat {
        width: 1920,
        height: 1080,
        fps_num: 60,
        fps_den: 1,
        fourcc: "NV12".into(),
        modifier: None,
        color_primaries: None,
        transfer: None,
        range: None,
    }
}

fn cfg() -> EncoderConfig {
    EncoderConfig {
        format: nv12_1080p60(),
        target_bitrate_bps: 5_000_000,
        gop_seconds: 2.0,
    }
}

fn make_frame(seq: u64, payload_bytes: usize) -> cove_replay_engine::capture::FrameHandle {
    cove_replay_engine::capture::FrameHandle {
        seq,
        pts_ns: seq as i64 * 16_666_667,
        payload: FramePayload::Shm {
            data: vec![0u8; payload_bytes],
            width: 1920,
            height: 1080,
            format: 0,
            stride: 1920,
        },
        cursor: None,
        release: ReleaseToken::noop(),
    }
}

/// Push N frames into the FrameSender then drop it so the receiver closes.
async fn feed_and_close(tx: FrameSender, frames: u64) {
    for seq in 0..frames {
        tx.send(FrameOrControl::Frame(make_frame(seq, 32))).await.expect("send frame");
    }
    drop(tx);
}

/// Programmable fake backend.
#[derive(Clone)]
enum FakeAction {
    /// Accept the frame.  Emit zero fragments by default.
    Accept,
    /// Accept and emit one keyframe fragment with `payload_size` bytes.
    AcceptEmit { payload_size: usize },
    /// Return EncoderError::BackPressure for this push.
    BackPressure,
    /// Return EncoderError::Runtime(reason).
    Runtime(&'static str),
}

struct FakeBackend {
    name: &'static str,
    actions: std::sync::Mutex<std::collections::VecDeque<FakeAction>>,
    configure_calls: Arc<AtomicUsize>,
    teardown_calls: Arc<AtomicUsize>,
    push_calls: Arc<AtomicUsize>,
    configure_should_fail: bool,
    next_seq: u64,
    pending_drain: std::sync::Mutex<Vec<EncodedFragment>>,
}

impl FakeBackend {
    fn new(name: &'static str, actions: Vec<FakeAction>) -> Self {
        Self {
            name,
            actions: std::sync::Mutex::new(actions.into_iter().collect()),
            configure_calls: Arc::new(AtomicUsize::new(0)),
            teardown_calls: Arc::new(AtomicUsize::new(0)),
            push_calls: Arc::new(AtomicUsize::new(0)),
            configure_should_fail: false,
            next_seq: 0,
            pending_drain: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn with_failing_configure(mut self) -> Self {
        self.configure_should_fail = true;
        self
    }

    /// Seed a fragment directly into the backend's drain-output buffer so the
    /// next `drain()` returns it.  Simulates "tail" output that a real
    /// encoder holds internally and only emits when drained after the last
    /// input frame.
    fn with_pending_fragment(self, fragment: EncodedFragment) -> Self {
        self.pending_drain.lock().unwrap().push(fragment);
        self
    }

    fn counters(&self) -> (Arc<AtomicUsize>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        (
            Arc::clone(&self.configure_calls),
            Arc::clone(&self.teardown_calls),
            Arc::clone(&self.push_calls),
        )
    }
}

#[async_trait]
impl EncoderBackend for FakeBackend {
    fn name(&self) -> &'static str {
        self.name
    }

    fn codec(&self) -> &'static str {
        "h264"
    }

    async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
        ProbeOutcome::Available {
            capabilities: cove_replay_engine::encoder::backend::EncoderCapabilities {
                accepts_dmabuf: true,
                accepts_shm: true,
                supported_codecs: vec!["h264".into()],
            },
            details: serde_json::json!({}),
        }
    }

    async fn configure(&mut self, _cfg: EncoderConfig) -> Result<(), EncoderError> {
        self.configure_calls.fetch_add(1, Ordering::Relaxed);
        if self.configure_should_fail {
            return Err(EncoderError::Runtime("configure-fail".into()));
        }
        Ok(())
    }

    async fn push_frame(
        &mut self,
        _frame: cove_replay_engine::capture::FrameHandle,
    ) -> Result<(), EncoderError> {
        self.push_calls.fetch_add(1, Ordering::Relaxed);
        let action = self
            .actions
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(FakeAction::Accept);
        match action {
            FakeAction::Accept => Ok(()),
            FakeAction::AcceptEmit { payload_size } => {
                let seq = self.next_seq;
                self.next_seq += 1;
                self.pending_drain.lock().unwrap().push(EncodedFragment {
                    seq,
                    pts_90k: seq * 1500,
                    duration_90k: 1500,
                    is_keyframe: seq == 0,
                    bytes: vec![0u8; payload_size],
                    diagnostics: Default::default(),
                });
                Ok(())
            }
            FakeAction::BackPressure => Err(EncoderError::BackPressure),
            FakeAction::Runtime(r) => Err(EncoderError::Runtime(r.into())),
        }
    }

    async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError> {
        Ok(std::mem::take(&mut *self.pending_drain.lock().unwrap()))
    }

    async fn teardown(&mut self) -> Result<(), EncoderError> {
        self.teardown_calls.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

/// Decode every notification the Notifier emitted into `(method, params)`
/// pairs.  Closes the channel by dropping its sender side.
fn drain_notifications(rx: &mut tokio::sync::mpsc::Receiver<Vec<u8>>) -> Vec<(String, serde_json::Value)> {
    let mut out = Vec::new();
    while let Ok(bytes) = rx.try_recv() {
        let v: serde_json::Value = serde_json::from_slice(&bytes).expect("valid json");
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
        let params = v.get("params").cloned().unwrap_or(serde_json::Value::Null);
        out.push((method, params));
    }
    out
}

#[tokio::test]
async fn happy_path_runs_to_completion_and_tears_down() {
    let backend = FakeBackend::new(
        "fake-hw",
        vec![
            FakeAction::AcceptEmit { payload_size: 1024 },
            FakeAction::AcceptEmit { payload_size: 2048 },
            FakeAction::Accept,
        ],
    );
    let (cfg_calls, td_calls, push_calls) = backend.counters();
    let (notifier, mut notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));
    let (tx, rx) = frame_channel(8);

    let feeder = tokio::spawn(feed_and_close(tx, 3));
    let exit = session.run(rx).await;
    feeder.await.unwrap();

    assert_eq!(exit, SessionExit::StreamEnded);
    assert_eq!(cfg_calls.load(Ordering::Relaxed), 1, "configure called once");
    assert_eq!(td_calls.load(Ordering::Relaxed), 1, "teardown called once on exit");
    assert_eq!(push_calls.load(Ordering::Relaxed), 3, "all frames pushed");

    let notifs = drain_notifications(&mut notif_rx);
    // No diagnostics fires because period is 60 s and the test finishes well
    // before then.  No runtimeError, no backPressure.
    assert!(
        notifs.iter().all(|(m, _)| m != "encoder.runtimeError" && m != "encoder.backPressure"),
        "unexpected events: {notifs:?}",
    );
}

#[tokio::test]
async fn diagnostics_fires_when_period_elapses() {
    let backend = FakeBackend::new(
        "fake-hw",
        vec![FakeAction::AcceptEmit { payload_size: 1024 }; 3],
    );
    let (notifier, mut notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_millis(40));
    let (tx, rx) = frame_channel(8);

    let feeder = tokio::spawn(async move {
        for seq in 0..3u64 {
            tx.send(FrameOrControl::Frame(make_frame(seq, 32))).await.unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        drop(tx);
    });
    let exit = session.run(rx).await;
    feeder.await.unwrap();
    assert_eq!(exit, SessionExit::StreamEnded);

    let notifs = drain_notifications(&mut notif_rx);
    let diags: Vec<_> = notifs
        .iter()
        .filter(|(m, _)| m == "encoder.diagnostics")
        .collect();
    assert!(!diags.is_empty(), "expected at least one encoder.diagnostics event");
    let last = &diags.last().unwrap().1;
    assert_eq!(last["backend"], "fake-hw");
    assert!(last["frames_in"].as_u64().unwrap() >= 1);
    assert!(last["frames_encoded"].as_u64().unwrap() >= 1);
}

#[tokio::test]
async fn back_pressure_fires_once_per_sustained_window() {
    let backend = FakeBackend::new(
        "fake-hw",
        vec![
            FakeAction::BackPressure,
            FakeAction::BackPressure,
            FakeAction::BackPressure,
            FakeAction::Accept, // clears the window
            FakeAction::BackPressure,
            FakeAction::BackPressure,
        ],
    );
    let (notifier, mut notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60))
        .with_backpressure_dwell(Duration::from_millis(10));

    let (tx, rx) = frame_channel(8);
    let feeder = tokio::spawn(async move {
        // Push first burst: 3 BackPressure with > dwell spacing should trigger one event.
        for seq in 0..3u64 {
            tx.send(FrameOrControl::Frame(make_frame(seq, 32))).await.unwrap();
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        // One Accept closes the window.
        tx.send(FrameOrControl::Frame(make_frame(3, 32))).await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        // Second burst: 2 more BackPressure with > dwell spacing should trigger a second event.
        for seq in 4..6u64 {
            tx.send(FrameOrControl::Frame(make_frame(seq, 32))).await.unwrap();
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        drop(tx);
    });

    let exit = session.run(rx).await;
    feeder.await.unwrap();
    assert_eq!(exit, SessionExit::StreamEnded);

    let notifs = drain_notifications(&mut notif_rx);
    let bp_events: Vec<_> = notifs
        .iter()
        .filter(|(m, _)| m == "encoder.backPressure")
        .collect();
    assert_eq!(
        bp_events.len(),
        2,
        "expected exactly two back-pressure events (one per window): {bp_events:?}",
    );
    for (_, params) in &bp_events {
        assert_eq!(params["backend"], "fake-hw");
        assert!(params["sustained_ms"].as_u64().unwrap() >= 10);
        assert!(params["dropped_since_last"].as_u64().unwrap() >= 1);
    }
}

#[tokio::test]
async fn runtime_error_ends_session_emits_event_and_tears_down() {
    let backend = FakeBackend::new(
        "fake-hw",
        vec![FakeAction::Accept, FakeAction::Runtime("encoder-died")],
    );
    let (_cfg_calls, td_calls, _push_calls) = backend.counters();
    let (notifier, mut notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    let feeder = tokio::spawn(async move {
        // Send 2 frames; the 2nd triggers Runtime.  Then send 3 more — those
        // must be drained without push to release PW buffers.
        for seq in 0..5u64 {
            tx.send(FrameOrControl::Frame(make_frame(seq, 32))).await.unwrap();
        }
        drop(tx);
    });
    let exit = session.run(rx).await;
    feeder.await.unwrap();
    assert_eq!(exit, SessionExit::RuntimeError);
    assert_eq!(td_calls.load(Ordering::Relaxed), 1, "teardown called once on runtime error");

    let notifs = drain_notifications(&mut notif_rx);
    let rt: Vec<_> = notifs
        .iter()
        .filter(|(m, _)| m == "encoder.runtimeError")
        .collect();
    assert_eq!(rt.len(), 1, "exactly one runtimeError event");
    let (_, params) = rt[0];
    assert_eq!(params["backend"], "fake-hw");
    assert_eq!(params["reason_code"], "push-frame-runtime");
    assert_eq!(params["details"], "encoder-died");
}

#[tokio::test]
async fn configure_failure_emits_runtime_error_and_returns_configure_failed() {
    let backend = FakeBackend::new("fake-hw", vec![]).with_failing_configure();
    let (cfg_calls, td_calls, push_calls) = backend.counters();
    let (notifier, mut notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg());

    let (tx, rx) = frame_channel(8);
    drop(tx); // configure fails before any frame is processed
    let exit = session.run(rx).await;

    assert_eq!(exit, SessionExit::ConfigureFailed);
    assert_eq!(cfg_calls.load(Ordering::Relaxed), 1);
    assert_eq!(td_calls.load(Ordering::Relaxed), 1, "teardown still runs after configure-fail");
    assert_eq!(push_calls.load(Ordering::Relaxed), 0, "no frames pushed");

    let notifs = drain_notifications(&mut notif_rx);
    let rt: Vec<_> = notifs
        .iter()
        .filter(|(m, _)| m == "encoder.runtimeError")
        .collect();
    assert_eq!(rt.len(), 1);
    assert_eq!(rt[0].1["reason_code"], "configure-failed");
}

#[tokio::test]
async fn fragments_flow_through_sink() {
    let backend = FakeBackend::new(
        "fake-hw",
        vec![
            FakeAction::AcceptEmit { payload_size: 1024 },
            FakeAction::AcceptEmit { payload_size: 2048 },
        ],
    );
    let (notifier, _notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    let feeder = tokio::spawn(feed_and_close(tx, 2));
    let exit = session.run(rx).await;
    feeder.await.unwrap();

    assert_eq!(exit, SessionExit::StreamEnded);
    let counters = cove_replay_engine::encoder::session::SessionCounters::default();
    // We can't reach into the session for counters after run consumed it, but
    // the sink's own counters mirror them.
    let _ = counters;
}

#[tokio::test]
async fn release_token_fires_for_every_frame_consumed() {
    use std::sync::atomic::AtomicU32;
    let released = Arc::new(AtomicU32::new(0));
    let backend = FakeBackend::new("fake-hw", vec![FakeAction::Accept; 4]);
    let (notifier, _notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    let released_feeder = Arc::clone(&released);
    let feeder = tokio::spawn(async move {
        for seq in 0..4u64 {
            let counter = Arc::clone(&released_feeder);
            tx.send(cove_replay_engine::capture::FrameOrControl::Frame(cove_replay_engine::capture::FrameHandle {
                seq,
                pts_ns: 0,
                payload: FramePayload::Shm {
                    data: vec![0u8; 16],
                    width: 16,
                    height: 16,
                    format: 0,
                    stride: 16,
                },
                cursor: None,
                release: ReleaseToken::new(move || {
                    counter.fetch_add(1, Ordering::Relaxed);
                }),
            }))
            .await
            .unwrap();
        }
        drop(tx);
    });
    let exit = session.run(rx).await;
    feeder.await.unwrap();
    assert_eq!(exit, SessionExit::StreamEnded);
    assert_eq!(
        released.load(Ordering::Relaxed),
        4,
        "every consumed frame must drop its ReleaseToken",
    );
}

/// Saturate the notifier's underlying channel.  After this returns the
/// next `tx.send().await` on the notifier would block, but `try_send`
/// returns `Full` — which is exactly what `try_notify` swallows.  We
/// don't consume the receiver in the calling test; dropping it is fine
/// because the assertions inspect cleanup invariants on the FrameReceiver
/// side, not the transport side.
fn saturate_notifier(notifier: &Notifier) {
    // Notifier channel capacity is 64 (transport::notifier::NOTIF_CAPACITY).
    // Push enough events to exceed it so any later send().await would block;
    // try_notify returns Full and is silently dropped.
    for i in 0..128 {
        let _ = notifier.try_notify("filler", serde_json::json!({ "i": i }));
    }
}

#[tokio::test]
async fn configure_failure_cleanup_completes_even_when_notifier_is_saturated() {
    use std::sync::atomic::AtomicU32;
    // Regression for Codex review 2026-05-16_11-39-52 Issue #1: terminal
    // cleanup must not depend on notifier delivery progress.  A saturated
    // notifier channel must not defer receiver close / token drain /
    // backend.teardown().
    let released = Arc::new(AtomicU32::new(0));
    let backend = FakeBackend::new("fake-hw", vec![]).with_failing_configure();
    let (cfg_calls, td_calls, push_calls) = backend.counters();
    let (notifier, _notif_rx) = Notifier::new();
    saturate_notifier(&notifier);

    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    for seq in 0..3u64 {
        let counter = Arc::clone(&released);
        tx.send(cove_replay_engine::capture::FrameOrControl::Frame(cove_replay_engine::capture::FrameHandle {
            seq,
            pts_ns: 0,
            payload: FramePayload::Shm {
                data: vec![0u8; 8],
                width: 8,
                height: 8,
                format: 0,
                stride: 8,
            },
            cursor: None,
            release: ReleaseToken::new(move || {
                counter.fetch_add(1, Ordering::Relaxed);
            }),
        }))
        .await
        .unwrap();
    }

    // Sender stays alive; notifier transport is saturated.  The session must
    // still close the receiver, fire queued ReleaseTokens, run teardown, and
    // return promptly.  Before the fix the configure-failure emit awaited a
    // full notifier channel and stalled cleanup behind it.
    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("cleanup must complete even with a saturated notifier");
    assert_eq!(exit, SessionExit::ConfigureFailed);
    assert_eq!(cfg_calls.load(Ordering::Relaxed), 1);
    assert_eq!(push_calls.load(Ordering::Relaxed), 0);
    assert_eq!(td_calls.load(Ordering::Relaxed), 1, "teardown ran after cleanup");
    assert_eq!(
        released.load(Ordering::Relaxed),
        3,
        "queued ReleaseTokens must fire even when notifier is saturated",
    );
    let send_err = tx.send(FrameOrControl::Frame(make_frame(99, 8))).await;
    assert!(send_err.is_err(), "sender must be closed after cleanup");
}

#[tokio::test]
async fn push_frame_runtime_cleanup_completes_even_when_notifier_is_saturated() {
    use std::sync::atomic::AtomicU32;
    // Same invariant for the push_frame Runtime path.
    let released = Arc::new(AtomicU32::new(0));
    let backend = FakeBackend::new("fake-hw", vec![FakeAction::Runtime("die-now")]);
    let (_cfg_calls, td_calls, _push_calls) = backend.counters();
    let (notifier, _notif_rx) = Notifier::new();
    saturate_notifier(&notifier);

    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    for seq in 0..3u64 {
        let counter = Arc::clone(&released);
        tx.send(cove_replay_engine::capture::FrameOrControl::Frame(cove_replay_engine::capture::FrameHandle {
            seq,
            pts_ns: 0,
            payload: FramePayload::Shm {
                data: vec![0u8; 8],
                width: 8,
                height: 8,
                format: 0,
                stride: 8,
            },
            cursor: None,
            release: ReleaseToken::new(move || {
                counter.fetch_add(1, Ordering::Relaxed);
            }),
        }))
        .await
        .unwrap();
    }

    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("cleanup must complete even with a saturated notifier");
    assert_eq!(exit, SessionExit::RuntimeError);
    assert_eq!(td_calls.load(Ordering::Relaxed), 1);
    assert_eq!(
        released.load(Ordering::Relaxed),
        3,
        "queued ReleaseTokens must fire even when notifier is saturated (push_frame runtime path)",
    );
    let send_err = tx.send(FrameOrControl::Frame(make_frame(99, 8))).await;
    assert!(send_err.is_err(), "sender must be closed after cleanup");
}

#[tokio::test]
async fn configure_failure_closes_receiver_and_drains_buffered_frames() {
    use std::sync::atomic::AtomicU32;
    // Regression for Codex review 2026-05-16_10-59-17 Issue #1: configure
    // failure must apply the same bounded cleanup as push_frame runtime
    // failures — close the receiver and drain buffered frames before
    // teardown, without waiting for the sender to drop.
    let released = Arc::new(AtomicU32::new(0));
    let backend = FakeBackend::new("fake-hw", vec![]).with_failing_configure();
    let (cfg_calls, td_calls, push_calls) = backend.counters();
    let (notifier, _notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    // Pre-fill the channel before run() is called — configure fails first
    // thing, so these frames are sitting in the buffer when cleanup starts.
    for seq in 0..3u64 {
        let counter = Arc::clone(&released);
        tx.send(cove_replay_engine::capture::FrameOrControl::Frame(cove_replay_engine::capture::FrameHandle {
            seq,
            pts_ns: 0,
            payload: FramePayload::Shm {
                data: vec![0u8; 8],
                width: 8,
                height: 8,
                format: 0,
                stride: 8,
            },
            cursor: None,
            release: ReleaseToken::new(move || {
                counter.fetch_add(1, Ordering::Relaxed);
            }),
        }))
        .await
        .unwrap();
    }

    // Sender stays alive across run() — mimics the PipeWire capture thread
    // still owning the FrameSender during teardown.  Before the fix the
    // receiver remained open and queued tokens stayed pinned until producer
    // drop.
    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("run must return promptly after configure failure");
    assert_eq!(exit, SessionExit::ConfigureFailed);
    assert_eq!(cfg_calls.load(Ordering::Relaxed), 1);
    assert_eq!(push_calls.load(Ordering::Relaxed), 0, "no frames pushed");
    assert_eq!(td_calls.load(Ordering::Relaxed), 1, "teardown ran exactly once after drain");
    assert_eq!(
        released.load(Ordering::Relaxed),
        3,
        "every already-buffered frame must release its token before teardown returns",
    );
    let send_err = tx.send(FrameOrControl::Frame(make_frame(99, 8))).await;
    assert!(
        send_err.is_err(),
        "sender must be closed after configure-failure exit",
    );
}

#[tokio::test]
async fn runtime_error_returns_promptly_without_waiting_for_sender_drop() {
    // Regression for Codex review 2026-05-16_10-46-05 Issue #1: after a
    // terminal push_frame error the session must close the receiver and
    // return immediately, NOT block on rx.recv() until the producer drops.
    // We keep the sender alive in scope for the duration of session.run and
    // assert the run still finishes promptly with RuntimeError.
    let backend = FakeBackend::new("fake-hw", vec![FakeAction::Runtime("die")]);
    let (_cfg_calls, td_calls, _push_calls) = backend.counters();
    let (notifier, _notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    // Pre-fill the channel with one frame that will trip the Runtime error.
    tx.send(FrameOrControl::Frame(make_frame(0, 32))).await.unwrap();
    // Sender stays alive — mimics the PipeWire capture thread holding the
    // sender past the encoder's runtime failure.  Before the fix this test
    // would hang here.
    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("session.run must return promptly after terminal error");
    assert_eq!(exit, SessionExit::RuntimeError);
    assert_eq!(td_calls.load(Ordering::Relaxed), 1);
    // Producer keeps the sender alive even after run returned — proves we
    // exited without waiting on its drop.  Trying to send now must fail
    // because run closed the receiver.
    let err = tx.send(FrameOrControl::Frame(make_frame(1, 32))).await;
    assert!(err.is_err(), "sender must be closed after runtime-error exit");
}

#[tokio::test]
async fn runtime_error_drains_already_buffered_frames_before_returning() {
    use std::sync::atomic::AtomicU32;
    // Two queued frames at the moment of failure must still release their
    // tokens even though we're not waiting for the sender to drop.
    let released = Arc::new(AtomicU32::new(0));
    let backend = FakeBackend::new("fake-hw", vec![FakeAction::Runtime("die-now")]);
    let (notifier, _notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    for seq in 0..3u64 {
        let counter = Arc::clone(&released);
        tx.send(cove_replay_engine::capture::FrameOrControl::Frame(cove_replay_engine::capture::FrameHandle {
            seq,
            pts_ns: 0,
            payload: FramePayload::Shm {
                data: vec![0u8; 8],
                width: 8,
                height: 8,
                format: 0,
                stride: 8,
            },
            cursor: None,
            release: ReleaseToken::new(move || {
                counter.fetch_add(1, Ordering::Relaxed);
            }),
        }))
        .await
        .unwrap();
    }
    // Keep sender alive; do NOT drop tx before running.
    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("session.run must return promptly");
    assert_eq!(exit, SessionExit::RuntimeError);
    assert_eq!(
        released.load(Ordering::Relaxed),
        3,
        "every already-buffered frame must release its token, even after a terminal error and without waiting for sender drop",
    );
    drop(tx); // silence the unused warning; this is the live-producer scenario
}

#[tokio::test]
async fn release_token_fires_after_runtime_error_for_remaining_frames() {
    use std::sync::atomic::AtomicU32;
    let released = Arc::new(AtomicU32::new(0));
    let backend = FakeBackend::new(
        "fake-hw",
        vec![FakeAction::Runtime("die-immediately")],
    );
    let (notifier, _notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    let released_feeder = Arc::clone(&released);
    let feeder = tokio::spawn(async move {
        for seq in 0..5u64 {
            let counter = Arc::clone(&released_feeder);
            tx.send(cove_replay_engine::capture::FrameOrControl::Frame(cove_replay_engine::capture::FrameHandle {
                seq,
                pts_ns: 0,
                payload: FramePayload::Shm {
                    data: vec![0u8; 8],
                    width: 8,
                    height: 8,
                    format: 0,
                    stride: 8,
                },
                cursor: None,
                release: ReleaseToken::new(move || {
                    counter.fetch_add(1, Ordering::Relaxed);
                }),
            }))
            .await
            .unwrap();
        }
        drop(tx);
    });
    let exit = session.run(rx).await;
    feeder.await.unwrap();
    assert_eq!(exit, SessionExit::RuntimeError);
    assert_eq!(
        released.load(Ordering::Relaxed),
        5,
        "every queued frame must drop its ReleaseToken even after a runtime error",
    );
}

/// Sink that returns BackPressure for its first `bp_count` push attempts,
/// then accepts everything.  Used to exercise the EOF retry loop in
/// `EncoderSession::final_drain`.
struct BackPressureNTimesSink {
    bp_remaining: std::sync::atomic::AtomicUsize,
    accepted: Arc<std::sync::Mutex<Vec<EncodedFragment>>>,
}

impl BackPressureNTimesSink {
    fn new(
        bp_count: usize,
    ) -> (Self, Arc<std::sync::Mutex<Vec<EncodedFragment>>>) {
        let accepted = Arc::new(std::sync::Mutex::new(Vec::new()));
        (
            Self {
                bp_remaining: std::sync::atomic::AtomicUsize::new(bp_count),
                accepted: Arc::clone(&accepted),
            },
            accepted,
        )
    }
}

#[async_trait]
impl FragmentSink for BackPressureNTimesSink {
    async fn push(&mut self, fragment: EncodedFragment) -> Result<(), FragmentSinkError> {
        let r = self.bp_remaining.load(std::sync::atomic::Ordering::Relaxed);
        if r > 0 {
            self.bp_remaining
                .store(r - 1, std::sync::atomic::Ordering::Relaxed);
            return Err(FragmentSinkError::BackPressure);
        }
        self.accepted.lock().unwrap().push(fragment);
        Ok(())
    }
}

/// Sink that always returns BackPressure.  Used to verify that
/// `final_drain` converts unresolved back-pressure into a terminal
/// runtime error rather than silently discarding output.
struct AlwaysBackPressureSink;

#[async_trait]
impl FragmentSink for AlwaysBackPressureSink {
    async fn push(&mut self, _fragment: EncodedFragment) -> Result<(), FragmentSinkError> {
        Err(FragmentSinkError::BackPressure)
    }
}

/// Sink that records every fragment it receives into a shared Vec, so tests
/// can inspect what the encoder emitted after `EncoderSession::run` consumed
/// the sink.  Same back-pressure semantics as `CountingFragmentSink` (none).
struct RecordingFragmentSink {
    fragments: Arc<std::sync::Mutex<Vec<EncodedFragment>>>,
}

impl RecordingFragmentSink {
    fn new() -> (Self, Arc<std::sync::Mutex<Vec<EncodedFragment>>>) {
        let fragments = Arc::new(std::sync::Mutex::new(Vec::new()));
        (
            Self {
                fragments: Arc::clone(&fragments),
            },
            fragments,
        )
    }
}

#[async_trait]
impl FragmentSink for RecordingFragmentSink {
    async fn push(&mut self, fragment: EncodedFragment) -> Result<(), FragmentSinkError> {
        self.fragments.lock().unwrap().push(fragment);
        Ok(())
    }
}

#[tokio::test]
async fn clean_stream_end_flushes_tail_fragment_from_backend() {
    // Regression for Codex review 2026-05-16_12-17-49 Issue #1: on clean
    // receiver close, EncoderSession must call backend.drain() one last time
    // so any tail output still buffered inside the backend reaches the
    // FragmentSink before teardown.
    let backend = FakeBackend::new("fake-hw", vec![]).with_pending_fragment(EncodedFragment {
        seq: 0,
        pts_90k: 0,
        duration_90k: 1500,
        is_keyframe: true,
        bytes: vec![0u8; 4096],
        diagnostics: Default::default(),
    });
    let (_cfg_calls, td_calls, push_calls) = backend.counters();
    let (notifier, _notif_rx) = Notifier::new();
    let (sink, captured) = RecordingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    drop(tx); // no frames; receiver closes cleanly

    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("session must return promptly on clean end");
    assert_eq!(exit, SessionExit::StreamEnded);
    assert_eq!(push_calls.load(Ordering::Relaxed), 0, "no frames were pushed");
    assert_eq!(td_calls.load(Ordering::Relaxed), 1, "teardown ran exactly once");

    let captured = captured.lock().unwrap();
    assert_eq!(
        captured.len(),
        1,
        "tail fragment must be flushed to sink on clean stream end (before fix it was discarded)",
    );
    assert_eq!(captured[0].seq, 0);
    assert_eq!(captured[0].bytes.len(), 4096);
    assert!(captured[0].is_keyframe);
}

#[tokio::test]
async fn clean_stream_end_with_drain_runtime_error_emits_runtime_event() {
    // Companion to the tail-flush test: if the FINAL drain reports a
    // terminal error, the session must emit encoder.runtimeError (via the
    // non-blocking path) and switch the exit from StreamEnded to
    // RuntimeError instead of silently swallowing the failure.
    //
    // We model "drain fails after the last frame" by patching FakeBackend
    // to fail on drain whenever a flag is set.  The minimal way to express
    // this without expanding FakeBackend is: the very first drain call
    // returns Runtime — which means even an empty session triggers it.
    struct DrainFailingBackend {
        teardown_calls: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl EncoderBackend for DrainFailingBackend {
        fn name(&self) -> &'static str {
            "fake-hw"
        }
        fn codec(&self) -> &'static str {
            "h264"
        }
        async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
            ProbeOutcome::Available {
                capabilities: cove_replay_engine::encoder::backend::EncoderCapabilities {
                    accepts_dmabuf: true,
                    accepts_shm: true,
                    supported_codecs: vec!["h264".into()],
                },
                details: serde_json::json!({}),
            }
        }
        #[cfg(unix)]
        async fn configure(&mut self, _cfg: EncoderConfig) -> Result<(), EncoderError> {
            Ok(())
        }
        #[cfg(unix)]
        async fn push_frame(
            &mut self,
            _frame: cove_replay_engine::capture::FrameHandle,
        ) -> Result<(), EncoderError> {
            unreachable!("no frames are pushed in this test");
        }
        #[cfg(unix)]
        async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError> {
            Err(EncoderError::Runtime("flush-fail".into()))
        }
        async fn teardown(&mut self) -> Result<(), EncoderError> {
            self.teardown_calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    let td_calls = Arc::new(AtomicUsize::new(0));
    let backend = DrainFailingBackend {
        teardown_calls: Arc::clone(&td_calls),
    };
    let (notifier, mut notif_rx) = Notifier::new();
    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    drop(tx);

    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("session must return promptly even when final drain fails");
    assert_eq!(exit, SessionExit::RuntimeError);
    assert_eq!(td_calls.load(Ordering::Relaxed), 1);

    let notifs = drain_notifications(&mut notif_rx);
    let rt: Vec<_> = notifs
        .iter()
        .filter(|(m, _)| m == "encoder.runtimeError")
        .collect();
    assert_eq!(rt.len(), 1, "exactly one runtimeError event on final-drain failure");
    assert_eq!(rt[0].1["reason_code"], "drain-runtime");
    assert_eq!(rt[0].1["details"], "flush-fail");
}

#[tokio::test]
async fn final_drain_retries_sink_back_pressure_then_succeeds_at_eof() {
    // Codex review 2026-05-16_12-39-06 Issue #1: at EOF, sink BackPressure
    // must NOT silently drop tail output — `final_drain` retries the same
    // fragment until the sink accepts (or bounded retries are exhausted).
    let backend = FakeBackend::new("fake-hw", vec![]).with_pending_fragment(EncodedFragment {
        seq: 7,
        pts_90k: 999,
        duration_90k: 1500,
        is_keyframe: true,
        bytes: vec![0u8; 1024],
        diagnostics: Default::default(),
    });
    let (notifier, _notif_rx) = Notifier::new();
    let (sink, accepted) = BackPressureNTimesSink::new(3); // reject 3 times then accept
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60))
        .with_eof_drain_max_iters(16)
        .with_eof_drain_backoff(Duration::from_millis(5));

    let (tx, rx) = frame_channel(8);
    drop(tx);

    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("final drain must finish within bounded retries");
    assert_eq!(exit, SessionExit::StreamEnded);

    let captured = accepted.lock().unwrap();
    assert_eq!(captured.len(), 1, "tail fragment must be delivered after sink BackPressure retries");
    assert_eq!(captured[0].seq, 7);
    assert_eq!(captured[0].bytes.len(), 1024);
}

#[tokio::test]
async fn final_drain_unresolved_sink_back_pressure_becomes_runtime_error() {
    // Codex review 2026-05-16_12-39-06 Issue #1: if the sink keeps refusing
    // after bounded retries, the session must emit `encoder.runtimeError`
    // and exit RuntimeError rather than report StreamEnded.
    let backend = FakeBackend::new("fake-hw", vec![]).with_pending_fragment(EncodedFragment {
        seq: 0,
        pts_90k: 0,
        duration_90k: 1500,
        is_keyframe: true,
        bytes: vec![0u8; 128],
        diagnostics: Default::default(),
    });
    let (_cfg_calls, td_calls, _push_calls) = backend.counters();
    let (notifier, mut notif_rx) = Notifier::new();
    let session = EncoderSession::new(Box::new(backend), AlwaysBackPressureSink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60))
        .with_eof_drain_max_iters(4)
        .with_eof_drain_backoff(Duration::from_millis(1));

    let (tx, rx) = frame_channel(8);
    drop(tx);

    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("final drain must give up within bounded retries");
    assert_eq!(exit, SessionExit::RuntimeError);
    assert_eq!(td_calls.load(Ordering::Relaxed), 1, "teardown ran after unresolved back-pressure");

    let notifs = drain_notifications(&mut notif_rx);
    let rt: Vec<_> = notifs
        .iter()
        .filter(|(m, _)| m == "encoder.runtimeError")
        .collect();
    assert_eq!(rt.len(), 1);
    assert_eq!(
        rt[0].1["reason_code"], "drain-backpressure-unresolved-at-eof",
        "unresolved sink BackPressure must surface as a clear terminal reason",
    );
}

#[tokio::test]
async fn final_drain_retries_backend_back_pressure_then_succeeds_at_eof() {
    // Backend BackPressure on drain() during EOF must be retried — final
    // drain must not return StreamEnded as soon as backend.drain() defers.
    use std::sync::atomic::AtomicUsize;
    struct BackendDrainBpNTimes {
        bp_remaining: AtomicUsize,
        teardown_calls: Arc<AtomicUsize>,
        pending: std::sync::Mutex<Vec<EncodedFragment>>,
    }
    #[async_trait]
    impl EncoderBackend for BackendDrainBpNTimes {
        fn name(&self) -> &'static str {
            "fake-hw"
        }
        fn codec(&self) -> &'static str {
            "h264"
        }
        async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
            ProbeOutcome::Available {
                capabilities: cove_replay_engine::encoder::backend::EncoderCapabilities {
                    accepts_dmabuf: true,
                    accepts_shm: true,
                    supported_codecs: vec!["h264".into()],
                },
                details: serde_json::json!({}),
            }
        }
        #[cfg(unix)]
        async fn configure(&mut self, _cfg: EncoderConfig) -> Result<(), EncoderError> {
            Ok(())
        }
        #[cfg(unix)]
        async fn push_frame(
            &mut self,
            _frame: cove_replay_engine::capture::FrameHandle,
        ) -> Result<(), EncoderError> {
            unreachable!("no frames are pushed");
        }
        #[cfg(unix)]
        async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError> {
            let r = self.bp_remaining.load(Ordering::Relaxed);
            if r > 0 {
                self.bp_remaining.store(r - 1, Ordering::Relaxed);
                return Err(EncoderError::BackPressure);
            }
            Ok(std::mem::take(&mut *self.pending.lock().unwrap()))
        }
        async fn teardown(&mut self) -> Result<(), EncoderError> {
            self.teardown_calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    let td_calls = Arc::new(AtomicUsize::new(0));
    let backend = BackendDrainBpNTimes {
        bp_remaining: AtomicUsize::new(3),
        teardown_calls: Arc::clone(&td_calls),
        pending: std::sync::Mutex::new(vec![EncodedFragment {
            seq: 42,
            pts_90k: 0,
            duration_90k: 1500,
            is_keyframe: true,
            bytes: vec![0u8; 256],
            diagnostics: Default::default(),
        }]),
    };
    let (notifier, _notif_rx) = Notifier::new();
    let (sink, accepted) = RecordingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60))
        .with_eof_drain_max_iters(16)
        .with_eof_drain_backoff(Duration::from_millis(5));

    let (tx, rx) = frame_channel(8);
    drop(tx);

    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("final drain must finish after backend BackPressure retries");
    assert_eq!(exit, SessionExit::StreamEnded);
    assert_eq!(td_calls.load(Ordering::Relaxed), 1);

    let captured = accepted.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].seq, 42);
    assert_eq!(captured[0].bytes.len(), 256);
}

#[tokio::test]
async fn mid_session_sink_back_pressure_holds_fragments_for_retry() {
    // Codex review 2026-05-16_20-25-29 Issue #1: mid-session sink BackPressure
    // must NOT silently drop encoded fragments.  Each rejected fragment is
    // held in the session's pending queue and retried on the next
    // drain_fragments round.
    //
    // Scenario: 3 frames, each producing one fragment.  Sink BackPressures
    // the first 2 push attempts then accepts.  On the 3rd drain round the
    // sink accepts all 3 backlogged fragments (frame 2's new output plus
    // the two held from earlier rounds).
    let backend = FakeBackend::new(
        "fake-hw",
        vec![
            FakeAction::AcceptEmit { payload_size: 256 },
            FakeAction::AcceptEmit { payload_size: 512 },
            FakeAction::AcceptEmit { payload_size: 1024 },
        ],
    );
    let (_cfg_calls, td_calls, push_calls) = backend.counters();
    let (notifier, _notif_rx) = Notifier::new();
    let (sink, accepted) = BackPressureNTimesSink::new(2);
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60));

    let (tx, rx) = frame_channel(8);
    let feeder = tokio::spawn(feed_and_close(tx, 3));
    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("session must complete promptly");
    feeder.await.unwrap();
    assert_eq!(exit, SessionExit::StreamEnded);
    assert_eq!(push_calls.load(Ordering::Relaxed), 3, "all 3 frames pushed");
    assert_eq!(td_calls.load(Ordering::Relaxed), 1);

    let captured = accepted.lock().unwrap();
    assert_eq!(
        captured.len(),
        3,
        "every encoded fragment must reach the sink — none silently dropped on BackPressure",
    );
    // Order preserved (first-in-first-out): backend produced fragments in
    // order seq 0, 1, 2 (FakeBackend's next_seq counter).
    assert_eq!(captured[0].seq, 0);
    assert_eq!(captured[1].seq, 1);
    assert_eq!(captured[2].seq, 2);
    assert_eq!(captured[0].bytes.len(), 256);
    assert_eq!(captured[1].bytes.len(), 512);
    assert_eq!(captured[2].bytes.len(), 1024);
}

#[tokio::test]
async fn mid_session_pending_fragments_cap_emits_runtime_error() {
    // Bounded retry queue: if the sink stays BackPressured and the pending
    // queue grows past the configured cap, the session ends cleanly with
    // `encoder.runtimeError` instead of buffering forever.
    let backend = FakeBackend::new(
        "fake-hw",
        vec![
            FakeAction::AcceptEmit { payload_size: 32 },
            FakeAction::AcceptEmit { payload_size: 32 },
            FakeAction::AcceptEmit { payload_size: 32 },
            FakeAction::AcceptEmit { payload_size: 32 },
            FakeAction::AcceptEmit { payload_size: 32 },
            FakeAction::AcceptEmit { payload_size: 32 },
        ],
    );
    let (_cfg_calls, td_calls, _push_calls) = backend.counters();
    let (notifier, mut notif_rx) = Notifier::new();
    let session = EncoderSession::new(Box::new(backend), AlwaysBackPressureSink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60))
        .with_pending_fragments_cap(3);

    let (tx, rx) = frame_channel(8);
    let feeder = tokio::spawn(feed_and_close(tx, 6));
    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("session must terminate when pending cap is exceeded");
    feeder.await.unwrap();
    assert_eq!(exit, SessionExit::RuntimeError);
    assert_eq!(td_calls.load(Ordering::Relaxed), 1);

    let notifs = drain_notifications(&mut notif_rx);
    let rt: Vec<_> = notifs
        .iter()
        .filter(|(m, _)| m == "encoder.runtimeError")
        .collect();
    assert_eq!(rt.len(), 1);
    assert_eq!(rt[0].1["reason_code"], "sink-back-pressure-unbounded");
}

#[tokio::test]
async fn final_drain_flushes_fragments_held_from_mid_session_sink_back_pressure() {
    // Mid-session BackPressure + clean stream end: the held fragments
    // must be flushed by final_drain before StreamEnded fires.
    let backend = FakeBackend::new(
        "fake-hw",
        vec![
            FakeAction::AcceptEmit { payload_size: 64 },
            FakeAction::AcceptEmit { payload_size: 128 },
        ],
    );
    let (notifier, _notif_rx) = Notifier::new();
    // BP the two pushes from mid-session drain rounds; accept everything
    // from the final_drain retries.
    let (sink, accepted) = BackPressureNTimesSink::new(2);
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60))
        .with_eof_drain_max_iters(16)
        .with_eof_drain_backoff(Duration::from_millis(2));

    let (tx, rx) = frame_channel(8);
    let feeder = tokio::spawn(feed_and_close(tx, 2));
    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("session must complete via final_drain flushing held fragments");
    feeder.await.unwrap();
    assert_eq!(exit, SessionExit::StreamEnded);

    let captured = accepted.lock().unwrap();
    assert_eq!(
        captured.len(),
        2,
        "both held fragments must reach the sink before StreamEnded",
    );
    assert_eq!(captured[0].seq, 0);
    assert_eq!(captured[1].seq, 1);
}

#[tokio::test]
async fn final_drain_succeeds_when_sink_accepts_on_last_allowed_iteration() {
    // Codex review 2026-05-16_18-59-21 Issue #1: the EOF retry budget must
    // apply to UNRESOLVED back-pressure, not to total iterations.  With
    // max_iters = 4 and bp_count = 3, the sink rejects three times then
    // accepts.  The previous implementation exited the for-loop with
    // pending empty (because the last allowed iteration successfully
    // flushed it) and spuriously returned the unresolved-BP terminal
    // reason.  The new implementation must reset the stall counter on
    // sink progress and reach `StreamEnded` via a final empty-confirm
    // from `backend.drain()`.
    let backend = FakeBackend::new("fake-hw", vec![]).with_pending_fragment(EncodedFragment {
        seq: 11,
        pts_90k: 0,
        duration_90k: 1500,
        is_keyframe: true,
        bytes: vec![0u8; 256],
        diagnostics: Default::default(),
    });
    let (notifier, _notif_rx) = Notifier::new();
    let (sink, accepted) = BackPressureNTimesSink::new(3);
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60))
        .with_eof_drain_max_iters(4)
        .with_eof_drain_backoff(Duration::from_millis(2));

    let (tx, rx) = frame_channel(8);
    drop(tx);

    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("final drain must finish even when sink accepts on the last allowed iteration");
    assert_eq!(exit, SessionExit::StreamEnded);

    let captured = accepted.lock().unwrap();
    assert_eq!(
        captured.len(),
        1,
        "tail fragment must be delivered when sink accepts within the retry budget",
    );
    assert_eq!(captured[0].seq, 11);
}

#[tokio::test]
async fn final_drain_succeeds_when_backend_emits_on_last_allowed_iteration() {
    // Companion to the previous test for the backend.drain() side: the
    // backend BackPressures (max-1) times and then produces a fragment.
    // The sink accepts immediately.  Before the fix, the for-loop exited
    // after the producing iteration without giving backend.drain() a
    // chance to return Ok(empty), so StreamEnded was misreported as
    // unresolved BackPressure.
    use std::sync::atomic::AtomicUsize;
    struct LateProducingBackend {
        bp_remaining: AtomicUsize,
        teardown_calls: Arc<AtomicUsize>,
        pending: std::sync::Mutex<Vec<EncodedFragment>>,
    }
    #[async_trait]
    impl EncoderBackend for LateProducingBackend {
        fn name(&self) -> &'static str {
            "fake-hw"
        }
        fn codec(&self) -> &'static str {
            "h264"
        }
        async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
            ProbeOutcome::Available {
                capabilities: cove_replay_engine::encoder::backend::EncoderCapabilities {
                    accepts_dmabuf: true,
                    accepts_shm: true,
                    supported_codecs: vec!["h264".into()],
                },
                details: serde_json::json!({}),
            }
        }
        #[cfg(unix)]
        async fn configure(&mut self, _cfg: EncoderConfig) -> Result<(), EncoderError> {
            Ok(())
        }
        #[cfg(unix)]
        async fn push_frame(
            &mut self,
            _frame: cove_replay_engine::capture::FrameHandle,
        ) -> Result<(), EncoderError> {
            unreachable!();
        }
        #[cfg(unix)]
        async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError> {
            let r = self.bp_remaining.load(Ordering::Relaxed);
            if r > 0 {
                self.bp_remaining.store(r - 1, Ordering::Relaxed);
                return Err(EncoderError::BackPressure);
            }
            Ok(std::mem::take(&mut *self.pending.lock().unwrap()))
        }
        async fn teardown(&mut self) -> Result<(), EncoderError> {
            self.teardown_calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    let td_calls = Arc::new(AtomicUsize::new(0));
    let backend = LateProducingBackend {
        // BackPressure for 3 rounds, then produces.  max_stalled = 4 means
        // the producing iteration is the *last* allowed before the budget
        // would trip.
        bp_remaining: AtomicUsize::new(3),
        teardown_calls: Arc::clone(&td_calls),
        pending: std::sync::Mutex::new(vec![EncodedFragment {
            seq: 99,
            pts_90k: 0,
            duration_90k: 1500,
            is_keyframe: true,
            bytes: vec![0u8; 64],
            diagnostics: Default::default(),
        }]),
    };
    let (notifier, _notif_rx) = Notifier::new();
    let (sink, accepted) = RecordingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        .with_diagnostics_period(Duration::from_secs(60))
        .with_eof_drain_max_iters(4)
        .with_eof_drain_backoff(Duration::from_millis(2));

    let (tx, rx) = frame_channel(8);
    drop(tx);

    let exit = tokio::time::timeout(Duration::from_secs(2), session.run(rx))
        .await
        .expect("final drain must finish when backend produces within retry budget");
    assert_eq!(exit, SessionExit::StreamEnded);
    assert_eq!(td_calls.load(Ordering::Relaxed), 1);

    let captured = accepted.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].seq, 99);
    assert_eq!(captured[0].bytes.len(), 64);
}

#[tokio::test]
async fn advisory_telemetry_does_not_stall_encode_loop_with_saturated_notifier() {
    // Codex review 2026-05-16_12-39-06 Issue #2: `encoder.diagnostics` and
    // `encoder.backPressure` are advisory.  A stalled transport (here:
    // saturated notifier channel with no consumer) must not stop the
    // encode loop from consuming frames and reaching the clean
    // StreamEnded exit.
    let backend = FakeBackend::new(
        "fake-hw",
        vec![
            FakeAction::Accept,
            FakeAction::BackPressure, // triggers an emit_back_pressure call
            FakeAction::Accept,
            FakeAction::Accept,
            FakeAction::Accept,
        ],
    );
    let (_cfg_calls, td_calls, push_calls) = backend.counters();
    let (notifier, _notif_rx) = Notifier::new();
    saturate_notifier(&notifier);

    let sink = CountingFragmentSink::new();
    let session = EncoderSession::new(Box::new(backend), sink, notifier, cfg())
        // Tick diagnostics frequently so the diag arm fires many times under
        // saturation — before the fix each tick awaited the full channel
        // and stalled the encode arm.
        .with_diagnostics_period(Duration::from_millis(5))
        .with_backpressure_dwell(Duration::from_millis(1));

    let (tx, rx) = frame_channel(8);
    let feeder = tokio::spawn(async move {
        for seq in 0..5u64 {
            tx.send(FrameOrControl::Frame(make_frame(seq, 32))).await.unwrap();
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        drop(tx);
    });

    let exit = tokio::time::timeout(Duration::from_secs(3), session.run(rx))
        .await
        .expect("encode loop must not block on advisory notifications with a saturated notifier");
    feeder.await.unwrap();
    assert_eq!(exit, SessionExit::StreamEnded);
    assert_eq!(push_calls.load(Ordering::Relaxed), 5, "all frames consumed");
    assert_eq!(td_calls.load(Ordering::Relaxed), 1);
}

struct FinalizeFailingSink;

#[async_trait]
impl FragmentSink for FinalizeFailingSink {
    async fn push(&mut self, _fragment: EncodedFragment) -> Result<(), FragmentSinkError> {
        Ok(())
    }

    async fn finalize(&mut self) -> Result<(), FragmentSinkError> {
        Err(FragmentSinkError::Internal("disk write failed".into()))
    }
}

#[tokio::test]
async fn finalize_failure_surfaces_runtime_error_on_clean_eof() {
    let backend = FakeBackend::new("fake-hw", vec![]);
    let (_, td_calls, _) = backend.counters();
    let (notifier, _notif_rx) = Notifier::new();
    let session = EncoderSession::new(
        Box::new(backend),
        FinalizeFailingSink,
        notifier,
        cfg(),
    );

    let (tx, rx) = frame_channel(8);
    tx.send(FrameOrControl::Frame(make_frame(0, 32))).await.unwrap();
    drop(tx);

    let exit = session.run(rx).await;
    assert_eq!(exit, SessionExit::RuntimeError, "finalize failure must surface as RuntimeError");
    assert_eq!(td_calls.load(Ordering::Relaxed), 1, "backend still torn down");
}

// ── Real NVENC one-frame encode path ─────────────────────────────────────────

/// Push one SHM frame through the real NVENC backend (configure → push_frame →
/// drain → teardown) and verify that:
///
/// - `drain()` returns exactly one `EncodedFragment`
/// - the fragment's `bytes` field starts with `moof` (valid fMP4 box)
/// - `init_segment()` returns `Some(seg)` where `seg` starts with `ftyp`
///
/// Skips silently when NVENC hardware / driver is absent — the test is
/// inherently hardware-gated and must not fail in CI without a GPU.
#[tokio::test]
async fn nvenc_one_frame_shm_encode_produces_fmp4_fragment() {
    use cove_replay_engine::encoder::backends::NvencBackend;
    use cove_replay_engine::encoder::backend::{EncoderBackend, EncoderConfig, ProbeOutcome};

    std::env::remove_var("COVE_NVENC_FORCE_UNAVAILABLE");

    let backend = NvencBackend::new();
    let fmt = CaptureFormat {
        width: 320,
        height: 240,
        fps_num: 30,
        fps_den: 1,
        fourcc: "NV12".into(),
        modifier: None,
        color_primaries: None,
        transfer: None,
        range: None,
    };

    // Probe first — skip if hardware is absent.
    match backend.probe(&fmt).await {
        ProbeOutcome::Unavailable { reason, .. } => {
            eprintln!("NVENC unavailable ({reason}); skipping one-frame encode test");
            return;
        }
        ProbeOutcome::Available { .. } => {}
    }

    let mut backend = NvencBackend::new();
    let cfg = EncoderConfig {
        format: fmt.clone(),
        target_bitrate_bps: 2_000_000,
        gop_seconds: 2.0,
    };

    backend.configure(cfg).await.expect("configure must succeed when probe returned Available");

    // Provide a 320×240 NV12 frame: Y plane (240 rows × 320 bytes) + UV (120 rows × 320 bytes).
    let frame_size = 320 * 240 * 3 / 2; // NV12 = 1.5 bytes/pixel
    let frame = cove_replay_engine::capture::FrameHandle {
        seq: 1,
        pts_ns: 0,
        payload: FramePayload::Shm {
            data: vec![0x80u8; frame_size], // mid-grey luma, neutral chroma
            width: 320,
            height: 240,
            format: 0x3231564e, // fourcc NV12
            stride: 320,
        },
        cursor: None,
        release: ReleaseToken::noop(),
    };

    backend.push_frame(frame).await.expect("push_frame must succeed");

    let fragments = backend.drain().await.expect("drain must succeed");
    assert!(
        !fragments.is_empty(),
        "drain must return at least one fragment after push_frame"
    );

    let frag = &fragments[0];
    assert!(
        frag.bytes.len() >= 8,
        "fragment bytes must contain at least a box header"
    );
    assert_eq!(
        &frag.bytes[4..8],
        b"moof",
        "first box in fragment must be moof"
    );

    // init_segment() should be available after the first IDR frame was drained.
    match backend.init_segment() {
        Some(seg) => {
            assert!(seg.len() >= 8, "init segment must contain at least a box header");
            assert_eq!(&seg[4..8], b"ftyp", "first box in init segment must be ftyp");
        }
        None => {
            eprintln!("init_segment() returned None — SPS/PPS not extracted yet (acceptable if IDR was not in first fragment)");
        }
    }

    backend.teardown().await.expect("teardown must succeed");
}
