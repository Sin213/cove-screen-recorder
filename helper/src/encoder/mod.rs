//! Encoder probe / selection + session lifecycle (T-017 in-progress).
//!
//! What this module already ships (probe/selection scaffolding slice, commit
//! `56aba87`):
//!
//! - `EncoderBackend` trait surface (N-004 §4) consuming [`FrameHandle`]
//!   without importing PipeWire types.
//! - `FragmentSink` trait + `CountingFragmentSink` terminator (T-018 replaces
//!   the counting sink with the rolling segment buffer).
//! - Probe orchestrator with per-session negative cache (N-004 §6, N-008 §6.8).
//! - NVENC + libx264 backend stubs that probe `not-implemented-yet`.
//! - `run_session` entry point invoked by the PipeWire capture path that
//!   runs the probe sequence, emits `encoder.probeResult`, emits
//!   `encoder.selected` exactly once if a backend was selected, and emits
//!   `encoder.fallbackEngaged` when applicable.
//!
//! What this current slice adds (session lifecycle):
//!
//! - [`session::EncoderSession`] driver that runs the
//!   `configure → push_frame → drain → sink.push → teardown` loop for one
//!   selected backend over the lifetime of a capture stream.
//! - 1 Hz `encoder.diagnostics` emission with frame / latency / bitrate
//!   counters.
//! - `encoder.backPressure` event wired to `EncoderError::BackPressure` from
//!   `push_frame`, with a dwell filter so single-frame blips don't fire.
//! - `encoder.runtimeError` on terminal backend faults; session ends, no
//!   mid-session switch (N-008 §6.8), `teardown()` is called best-effort.
//!
//! Production behaviour is unchanged in this slice: both shipped stubs still
//! probe `not-implemented-yet` so the "no backend selected" branch is taken
//! and the receiver is drained exactly as the previous slice did, preserving
//! every T-022 PipeWire guarantee.  The new `EncoderSession` machinery is
//! exercised by tests with synthetic test-only backends; it becomes
//! production-active in the final T-017 slice that flips a stub to a real
//! implementation.
//!
//! What the final T-017 slice still needs to add:
//!
//! - Real NvEncodeAPI session creation + CUDA external-memory import (DMA-BUF
//!   zero-copy path before SHM memcpy fallback).
//! - Real `ffmpeg-next` / libx264 encode loop with Annex-B → fMP4 wrapping.

pub mod backend;
pub mod backends;
pub mod fragment;
pub mod probe;
// `session` consumes `crate::capture::FrameReceiver` and exercises the
// `EncoderBackend::push_frame` / `drain` / `configure` methods, all of which
// are `#[cfg(unix)]`.  Matching that boundary keeps Windows helper builds
// green; the real encoder pipeline only runs on unix targets today.
#[cfg(unix)]
pub mod session;

pub use backend::{
    EncoderBackend, EncoderCapabilities, EncoderConfig, EncoderError, ProbeOutcome,
};
pub use fragment::{CountingFragmentSink, EncodedFragment, FragmentSink, FragmentSinkError};
pub use probe::{build_probe_event, run_probes, NegativeProbeCache, ProbeSession};
#[cfg(unix)]
pub use session::{EncoderSession, SessionCounters, SessionExit};

use crate::protocol::events::{EncoderFallbackEvent, EncoderSelectedEvent, SessionLostEvent};
use crate::protocol::types::CaptureFormat;
use crate::segment::buffer::{SegmentBuffer, SegmentBufferConfig};
use crate::segment::recovery::resolve_segments_root;
use crate::transport::notifier::Notifier;

/// MVP probe order per T-017: NVENC → libx264.  VAAPI / QSV / AMF are out of
/// scope for T-017 and land in follow-up tickets.
pub fn default_backends() -> Vec<Box<dyn EncoderBackend>> {
    vec![
        Box::new(backends::NvencBackend::new()),
        Box::new(backends::X264Backend::new()),
    ]
}

/// Drive a single encoder session attached to one PipeWire capture stream.
///
/// Lifecycle:
/// 1. Probe every backend in order, emit one `encoder.probeResult` event with
///    all results.
/// 2. If at least one backend probed Available, emit `encoder.selected` once
///    naming the first Available backend.  If any earlier backend probed
///    Unavailable, emit `encoder.fallbackEngaged { from, to, reason }`.
/// 3. Consume frames from the receiver.  In the T-017 skeleton slice, the
///    selected branch still drains without encoding — T-017a wires the real
///    `configure` → `push_frame` → `drain` → `FragmentSink::push` loop.
/// 4. When the receiver closes (PipeWire stream stopped), the task exits.
///
/// **Invariant preserved from T-022**: when no backend is selected, observable
/// behaviour matches the previous PipeWire frame-drain exactly — frames are
/// pulled from the receiver and dropped (so their `ReleaseToken` closures fire
/// and re-queue the PW buffers), and no encoder events are emitted.
#[cfg(unix)]
pub async fn run_session(
    mut rx: crate::capture::FrameReceiver,
    notifier: Notifier,
    stream_id: String,
    session_id: String,
    format: CaptureFormat,
    format_change_rx: tokio::sync::mpsc::Receiver<()>,
) {
    let mut backends = default_backends();
    let mut cache = NegativeProbeCache::new();
    let session = run_probes(&backends, &format, &mut cache).await;

    let probe_event = build_probe_event(&session, &backends);
    if let Ok(v) = serde_json::to_value(&probe_event) {
        let _ = notifier.notify("encoder.probeResult", v).await;
    }

    match session.selected {
        Some(idx) => {
            let selected_name = backends[idx].name().to_string();
            let selected_codec = backends[idx].codec().to_string();

            if let Some(ref from) = session.fallback_from {
                if from != &selected_name {
                    let evt = EncoderFallbackEvent {
                        reason: "probe-failed".into(),
                        from_backend: from.clone(),
                        to_backend: selected_name.clone(),
                    };
                    if let Ok(v) = serde_json::to_value(&evt) {
                        let _ = notifier.notify("encoder.fallbackEngaged", v).await;
                    }
                }
            }

            let selected_evt = EncoderSelectedEvent {
                backend: selected_name.clone(),
                codec: selected_codec,
                parameters: serde_json::json!({
                    "stream_id": stream_id,
                    "width": format.width,
                    "height": format.height,
                    "fps_num": format.fps_num,
                    "fps_den": format.fps_den,
                    "fourcc": format.fourcc,
                }),
                reason_for_choice: "first-available".into(),
            };
            if let Ok(v) = serde_json::to_value(&selected_evt) {
                let _ = notifier.notify("encoder.selected", v).await;
            }

            // Take ownership of the selected backend and drive the encode loop
            // via EncoderSession with a rolling segment buffer as the sink.
            let backend = backends.swap_remove(idx);
            drop(backends);

            let segments_root = resolve_segments_root();
            let session_dir = segments_root.join(&session_id);
            let sink = match SegmentBuffer::new(
                session_id.clone(),
                Some(stream_id.clone()),
                &session_dir,
                SegmentBufferConfig::default(),
                notifier.clone(),
            ) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "failed to create segment buffer");
                    let evt = SessionLostEvent {
                        session_id: session_id.clone(),
                        stream_id: Some(stream_id.clone()),
                        reason: "segment-sink-state-dir-unwritable".into(),
                        details: e.to_string(),
                        diagnostics_path: String::new(),
                    };
                    if let Ok(v) = serde_json::to_value(&evt) {
                        let _ = notifier.try_notify("capture.sessionLost", v);
                    }
                    while rx.recv().await.is_some() {}
                    return;
                }
            };

            let cfg = EncoderConfig {
                format: format.clone(),
                target_bitrate_bps: 5_000_000,
                gop_seconds: 2.0,
            };
            let _ = EncoderSession::new(backend, sink, notifier, cfg)
                .run(rx, format_change_rx)
                .await;
        }
        None => {
            // No backend available — preserve T-022 behaviour exactly.  No
            // `encoder.selected`, no `encoder.fallbackEngaged`, no encoder
            // diagnostics; just drain the receiver.
            while rx.recv().await.is_some() {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_backends_are_ordered_nvenc_first_then_x264() {
        let backends = default_backends();
        assert_eq!(backends.len(), 2);
        assert_eq!(backends[0].name(), "nvenc");
        assert_eq!(backends[1].name(), "libx264");
    }
}
