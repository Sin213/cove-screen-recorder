//! Encoder probe / selection MVP (T-017 skeleton slice).
//!
//! What this module ships in the T-017 skeleton slice:
//!
//! - `EncoderBackend` trait surface (N-004 §4) consuming [`FrameHandle`]
//!   without importing PipeWire types.
//! - `FragmentSink` trait + `CountingFragmentSink` terminator (T-018 replaces
//!   the counting sink with the rolling segment buffer).
//! - Probe orchestrator with per-session negative cache (N-004 §6, N-008 §6.8).
//! - NVENC + libx264 backend stubs that probe `not-implemented-yet`.
//! - `run_session` entry point invoked by the PipeWire capture path at the
//!   point where `capture.sessionReady` would otherwise just spawn a counting
//!   sink — it now runs the probe sequence, emits `encoder.probeResult`, emits
//!   `encoder.selected` exactly once if a backend was selected, and then
//!   consumes frames from the `FrameReceiver`.  When no backend is available
//!   (the current state with both stubs returning `not-implemented-yet`) it
//!   falls back to draining the receiver — the same observable behaviour the
//!   PipeWire path had before, so all T-022 guarantees stay intact.
//!
//! What T-017a adds:
//!
//! - Real NvEncodeAPI session creation + CUDA external-memory import (DMA-BUF
//!   zero-copy path before SHM memcpy fallback).
//! - Real `ffmpeg-next` / libx264 encode loop with Annex-B → fMP4 wrapping.
//! - `encoder.diagnostics` 1 Hz loop with real frame counters.
//! - `encoder.backPressure` wired to the real frame-channel choked condition.
//! - `encoder.runtimeError` on terminal encoder faults + session teardown.

pub mod backend;
pub mod backends;
pub mod fragment;
pub mod probe;

pub use backend::{
    EncoderBackend, EncoderCapabilities, EncoderConfig, EncoderError, ProbeOutcome,
};
pub use fragment::{CountingFragmentSink, EncodedFragment, FragmentSink, FragmentSinkError};
pub use probe::{build_probe_event, run_probes, NegativeProbeCache, ProbeSession};

use crate::protocol::events::{EncoderFallbackEvent, EncoderSelectedEvent};
use crate::protocol::types::CaptureFormat;
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
    format: CaptureFormat,
) {
    let backends = default_backends();
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

            // T-017a wires the real encoder loop here.  For now: drain frames so
            // PipeWire buffers are released promptly and the task exits when
            // capture.stopSession drops the FrameSender on the PW thread.
            while rx.recv().await.is_some() {}
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
