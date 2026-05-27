//! WASAPI loopback audio capture backend — stub (T-050).
//! Real IMMDeviceEnumerator / IAudioClient calls deferred to T-051.

#[cfg(windows)]
use async_trait::async_trait;
#[cfg(windows)]
use tokio::sync::mpsc;

#[cfg(windows)]
use crate::audio::backend::{
    AudioCaptureBackend, AudioDevice, AudioError, AudioFrame, AudioProbeOutcome,
    AudioStreamConfig,
};

/// WASAPI-specific device metadata.
#[cfg(windows)]
#[derive(Debug, Clone)]
pub struct WasapiDeviceInfo {
    /// IMMDevice endpoint ID string (opaque, passed back to open_stream).
    pub endpoint_id: String,
    /// Human-readable friendly name.
    pub friendly_name: String,
    pub is_default_render: bool,
    pub is_default_capture: bool,
    pub supports_loopback: bool,
    /// Native mix-format sample rate from WAVEFORMATEX.
    pub native_sample_rate: u32,
    pub native_channels: u16,
}

/// WASAPI-specific stream configuration.
#[cfg(windows)]
#[derive(Debug, Clone)]
pub struct WasapiLoopbackConfig {
    /// IMMDevice endpoint ID to open (`None` = system default render device).
    pub endpoint_id: Option<String>,
    /// Requested period in 100-ns units (`0` = let Windows choose).
    pub requested_buffer_duration_hns: u64,
    /// Mix a microphone stream into the loopback for commentary mode.
    pub mix_microphone: bool,
    /// Microphone endpoint ID (`None` = default capture device).
    pub microphone_endpoint_id: Option<String>,
}

#[cfg(windows)]
impl Default for WasapiLoopbackConfig {
    fn default() -> Self {
        Self {
            endpoint_id: None,
            requested_buffer_duration_hns: 0,
            mix_microphone: false,
            microphone_endpoint_id: None,
        }
    }
}

pub struct WasapiBackend {
    #[cfg(windows)]
    loopback_config: WasapiLoopbackConfig,
}

impl WasapiBackend {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            loopback_config: WasapiLoopbackConfig::default(),
        }
    }
}

impl Default for WasapiBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
#[async_trait]
impl AudioCaptureBackend for WasapiBackend {
    fn name(&self) -> &'static str {
        "wasapi"
    }

    async fn probe(&self) -> AudioProbeOutcome {
        // Stub: real path tries CoCreateInstance(CLSID_MMDeviceEnumerator).
        AudioProbeOutcome::Unavailable {
            reason: "not-implemented-yet".into(),
            details: serde_json::json!({}),
        }
    }

    async fn enumerate_devices(&self) -> Result<Vec<AudioDevice>, AudioError> {
        Err(AudioError::NotImplementedYet("wasapi".into()))
    }

    async fn open_stream(
        &mut self,
        _config: AudioStreamConfig,
        _tx: mpsc::Sender<AudioFrame>,
    ) -> Result<(), AudioError> {
        Err(AudioError::NotImplementedYet("wasapi".into()))
    }

    async fn stop_stream(&mut self) -> Result<(), AudioError> {
        Ok(())
    }

    async fn teardown(&mut self) -> Result<(), AudioError> {
        Ok(())
    }
}
