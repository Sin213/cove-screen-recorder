//! T-059 — libvpx encoder backend stub tests.

use cove_replay_engine::encoder::backend::{EncoderBackend, ProbeOutcome};
use cove_replay_engine::encoder::backends::libvpx::LibvpxBackend;

#[tokio::test]
async fn libvpx_probe_returns_unavailable_not_implemented() {
    use cove_replay_engine::protocol::types::CaptureFormat;
    let backend = LibvpxBackend::new();
    let fmt = CaptureFormat {
        width: 1920,
        height: 1080,
        fps_num: 60,
        fps_den: 1,
        fourcc: "NV12".into(),
        modifier: None,
        color_primaries: None,
        transfer: None,
        range: None,
    };
    let outcome = backend.probe(&fmt).await;
    assert!(
        matches!(outcome, ProbeOutcome::Unavailable { ref reason, .. }
            if reason.contains("not-implemented-yet")),
        "expected not-implemented-yet, got {:?}",
        outcome
    );
}

#[tokio::test]
async fn libvpx_teardown_returns_ok() {
    let mut backend = LibvpxBackend::new();
    backend.teardown().await.expect("teardown must return Ok on stub");
}
