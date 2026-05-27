//! WASAPI audio capture backend — stub (T-047).
//! Real implementation lands in T-057.

#[cfg(windows)]
use async_trait::async_trait;
#[cfg(windows)]
use tokio::sync::mpsc;

#[cfg(windows)]
use crate::audio::backend::{
    AudioCaptureBackend, AudioDevice, AudioError, AudioFrame, AudioProbeOutcome,
    AudioStreamConfig,
};

pub struct WasapiBackend;

impl WasapiBackend {
    pub fn new() -> Self {
        Self
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
