//! NVENC backend stub.
//!
//! T-017a will replace this with a real NvEncodeAPI session creation path that
//! prefers zero-copy DMA-BUF import via CUDA external memory and falls back to
//! memcpy upload only when the modifier is unsupported.  For the T-017 skeleton
//! slice, `probe` always returns `Unavailable { reason: "not-implemented-yet" }`
//! so the slot is reserved without claiming availability.

use async_trait::async_trait;
use serde_json::json;

use crate::encoder::backend::{EncoderBackend, EncoderConfig, EncoderError, ProbeOutcome};
use crate::protocol::types::CaptureFormat;

#[cfg(unix)]
use crate::capture::FrameHandle;
#[cfg(unix)]
use crate::encoder::fragment::EncodedFragment;

pub struct NvencBackend;

impl NvencBackend {
    pub fn new() -> Self {
        Self
    }
}

impl Default for NvencBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl EncoderBackend for NvencBackend {
    fn name(&self) -> &'static str {
        "nvenc"
    }

    fn codec(&self) -> &'static str {
        "h264"
    }

    async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
        ProbeOutcome::Unavailable {
            reason: "not-implemented-yet".into(),
            details: json!({
                "slot": "nvenc",
                "follow_up_ticket": "T-017a",
            }),
        }
    }

    #[cfg(unix)]
    async fn configure(&mut self, _cfg: EncoderConfig) -> Result<(), EncoderError> {
        Err(EncoderError::NotImplementedYet("nvenc.configure".into()))
    }

    #[cfg(unix)]
    async fn push_frame(&mut self, _frame: FrameHandle) -> Result<(), EncoderError> {
        Err(EncoderError::NotImplementedYet("nvenc.push_frame".into()))
    }

    #[cfg(unix)]
    async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError> {
        Err(EncoderError::NotImplementedYet("nvenc.drain".into()))
    }

    async fn teardown(&mut self) -> Result<(), EncoderError> {
        Ok(())
    }
}
