//! T-054 — AMF Windows probe shape tests.

fn make_capture_format() -> cove_replay_engine::protocol::types::CaptureFormat {
    cove_replay_engine::protocol::types::CaptureFormat {
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

#[cfg(windows)]
mod windows_tests {
    use super::make_capture_format;
    use cove_replay_engine::encoder::backend::{EncoderBackend, ProbeOutcome};
    use cove_replay_engine::encoder::backends::amf::AmfBackend;

    #[tokio::test]
    async fn amf_windows_probe_returns_unavailable_not_implemented() {
        std::env::remove_var("COVE_AMF_FORCE_UNAVAILABLE");
        let backend = AmfBackend::new();
        let fmt = make_capture_format();
        let outcome = backend.probe(&fmt).await;
        assert!(
            matches!(outcome, ProbeOutcome::Unavailable { ref reason, .. }
                if reason.contains("not-implemented-yet")),
            "expected not-implemented-yet unavailable, got {:?}", outcome
        );
    }

    #[tokio::test]
    async fn amf_windows_teardown_returns_ok() {
        let mut backend = AmfBackend::new();
        backend.teardown().await.expect("teardown must return Ok on stub");
    }
}

// On non-Windows platforms these tests do not apply.
#[cfg(not(windows))]
#[test]
fn amf_windows_tests_only_run_on_windows() {}
