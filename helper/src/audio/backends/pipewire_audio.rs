//! PipeWire/PulseAudio audio capture backend — stub (T-047).
//! Real implementation lands in T-060.

#[cfg(unix)]
use async_trait::async_trait;
#[cfg(unix)]
use tokio::sync::mpsc;

#[cfg(unix)]
use crate::audio::backend::{
    AudioCaptureBackend, AudioDevice, AudioError, AudioFrame, AudioProbeOutcome,
    AudioStreamConfig,
};

pub struct PipeWireAudioBackend;

impl PipeWireAudioBackend {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PipeWireAudioBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(unix)]
#[async_trait]
impl AudioCaptureBackend for PipeWireAudioBackend {
    fn name(&self) -> &'static str {
        "pipewire-audio"
    }

    async fn probe(&self) -> AudioProbeOutcome {
        AudioProbeOutcome::Unavailable {
            reason: "not-implemented-yet".into(),
            details: serde_json::json!({}),
        }
    }

    async fn enumerate_devices(&self) -> Result<Vec<AudioDevice>, AudioError> {
        Err(AudioError::NotImplementedYet("pipewire-audio".into()))
    }

    async fn open_stream(
        &mut self,
        _config: AudioStreamConfig,
        _tx: mpsc::Sender<AudioFrame>,
    ) -> Result<(), AudioError> {
        Err(AudioError::NotImplementedYet("pipewire-audio".into()))
    }

    async fn stop_stream(&mut self) -> Result<(), AudioError> {
        Ok(())
    }

    async fn teardown(&mut self) -> Result<(), AudioError> {
        Ok(())
    }
}
