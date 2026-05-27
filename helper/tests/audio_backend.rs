//! T-047 — AudioCaptureBackend trait contract tests.
//!
//! Uses in-process stub backends — no OS audio resources required.

use async_trait::async_trait;
use cove_replay_engine::audio::backend::{
    AudioCapabilities, AudioCaptureBackend, AudioDevice, AudioError, AudioFrame,
    AudioProbeOutcome, AudioStreamConfig,
};
use cove_replay_engine::audio::backends::default_backends;
use tokio::sync::mpsc;

// ── Stub backends ─────────────────────────────────────────────────────────────

struct AvailableBackend {
    name: &'static str,
}

#[async_trait]
impl AudioCaptureBackend for AvailableBackend {
    fn name(&self) -> &'static str {
        self.name
    }

    async fn probe(&self) -> AudioProbeOutcome {
        AudioProbeOutcome::Available {
            capabilities: AudioCapabilities {
                supports_loopback: true,
                supports_microphone: true,
                supports_device_selection: true,
                supports_mixed_capture: false,
            },
            details: serde_json::json!({"stub": true}),
        }
    }

    async fn enumerate_devices(&self) -> Result<Vec<AudioDevice>, AudioError> {
        Ok(vec![AudioDevice {
            id: "default".into(),
            name: "Default Loopback".into(),
            is_loopback: true,
            is_microphone: false,
            default_sample_rate: 48000,
            default_channels: 2,
        }])
    }

    async fn open_stream(
        &mut self,
        _config: AudioStreamConfig,
        _tx: mpsc::Sender<AudioFrame>,
    ) -> Result<(), AudioError> {
        Ok(())
    }

    async fn stop_stream(&mut self) -> Result<(), AudioError> {
        Ok(())
    }

    async fn teardown(&mut self) -> Result<(), AudioError> {
        Ok(())
    }
}

struct UnavailableBackend {
    reason: &'static str,
}

#[async_trait]
impl AudioCaptureBackend for UnavailableBackend {
    fn name(&self) -> &'static str {
        "unavailable-stub"
    }

    async fn probe(&self) -> AudioProbeOutcome {
        AudioProbeOutcome::Unavailable {
            reason: self.reason.into(),
            details: serde_json::json!({}),
        }
    }

    async fn enumerate_devices(&self) -> Result<Vec<AudioDevice>, AudioError> {
        Err(AudioError::NotImplementedYet("unavailable-stub".into()))
    }

    async fn open_stream(
        &mut self,
        _config: AudioStreamConfig,
        _tx: mpsc::Sender<AudioFrame>,
    ) -> Result<(), AudioError> {
        Err(AudioError::NotImplementedYet("unavailable-stub".into()))
    }

    async fn stop_stream(&mut self) -> Result<(), AudioError> {
        Ok(())
    }

    async fn teardown(&mut self) -> Result<(), AudioError> {
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_available_returns_capabilities() {
    let backend = AvailableBackend { name: "test" };
    match backend.probe().await {
        AudioProbeOutcome::Available { capabilities, .. } => {
            assert!(capabilities.supports_loopback);
            assert!(capabilities.supports_microphone);
            assert!(capabilities.supports_device_selection);
            assert!(!capabilities.supports_mixed_capture);
        }
        other => panic!("expected Available, got {other:?}"),
    }
}

#[tokio::test]
async fn probe_unavailable_reason_roundtrips() {
    let backend = UnavailableBackend { reason: "no-hardware" };
    match backend.probe().await {
        AudioProbeOutcome::Unavailable { reason, .. } => {
            assert_eq!(reason, "no-hardware");
        }
        other => panic!("expected Unavailable, got {other:?}"),
    }
}

#[tokio::test]
async fn not_implemented_yet_errors_on_open_stream() {
    // Real stub backends (pipewire-audio / wasapi) return NotImplementedYet.
    let mut backends = default_backends();
    for backend in &mut backends {
        let (tx, _rx) = mpsc::channel(8);
        let cfg = AudioStreamConfig {
            device_id: None,
            sample_rate_hint: 48000,
            channels_hint: 2,
        };
        let err = backend.open_stream(cfg, tx).await.unwrap_err();
        assert!(
            matches!(err, AudioError::NotImplementedYet(_)),
            "backend {} should return NotImplementedYet, got: {err}",
            backend.name()
        );
    }
}

#[tokio::test]
async fn stop_stream_before_open_is_ok() {
    let mut backends = default_backends();
    for backend in &mut backends {
        backend.stop_stream().await.expect("stop_stream is idempotent");
    }
}

#[tokio::test]
async fn teardown_before_open_is_ok() {
    let mut backends = default_backends();
    for backend in &mut backends {
        backend.teardown().await.expect("teardown is idempotent");
    }
}

#[tokio::test]
async fn enumerate_devices_stub_returns_not_implemented() {
    let mut backends = default_backends();
    for backend in &mut backends {
        let err = backend.enumerate_devices().await.unwrap_err();
        assert!(
            matches!(err, AudioError::NotImplementedYet(_)),
            "backend {} enumerate_devices should return NotImplementedYet",
            backend.name()
        );
    }
}

#[tokio::test]
async fn default_backends_names() {
    let backends = default_backends();

    #[cfg(unix)]
    {
        assert!(
            backends.iter().any(|b| b.name() == "pipewire-audio"),
            "pipewire-audio must be in default_backends on unix"
        );
    }

    #[cfg(windows)]
    {
        assert!(
            backends.iter().any(|b| b.name() == "wasapi"),
            "wasapi must be in default_backends on windows"
        );
    }

    // On neither platform, the list is empty — that's fine for now.
    let _ = backends;
}

/// Compile-time object-safety check — instantiate Box<dyn AudioCaptureBackend>.
#[tokio::test]
async fn dyn_dispatch_compiles() {
    let backend: Box<dyn AudioCaptureBackend> = Box::new(AvailableBackend { name: "dyn-test" });
    assert_eq!(backend.name(), "dyn-test");
    assert!(backend.probe().await.is_available());
}
