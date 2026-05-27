//! libx264 backend stub.
//!
//! T-017a will replace this with a real `ffmpeg-next` (or direct `x264-sys`)
//! encode loop producing Annex-B H.264 NALUs wrapped into fMP4 fragments at
//! ~500 ms boundaries.  For the T-017 skeleton slice, `probe` always returns
//! `Unavailable { reason: "not-implemented-yet" }` so the slot is reserved
//! without claiming availability.
//!
//! Per N-007 §17 / N-008 §6 libx264 is the only Linux CPU re-encode option;
//! this stub reserves that role for the eventual real implementation.

use async_trait::async_trait;
use serde_json::json;

use crate::encoder::backend::{EncoderBackend, EncoderConfig, EncoderError, ProbeOutcome};
use crate::protocol::types::CaptureFormat;

#[cfg(any(unix, windows))]
use crate::capture::FrameHandle;
#[cfg(any(unix, windows))]
use crate::encoder::fragment::EncodedFragment;

pub struct X264Backend;

impl X264Backend {
    pub fn new() -> Self {
        Self
    }
}

impl Default for X264Backend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl EncoderBackend for X264Backend {
    fn name(&self) -> &'static str {
        "libx264"
    }

    fn codec(&self) -> &'static str {
        "h264"
    }

    async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
        ProbeOutcome::Unavailable {
            reason: "not-implemented-yet".into(),
            details: json!({
                "slot": "libx264",
                "follow_up_ticket": "T-017a",
            }),
        }
    }

    #[cfg(any(unix, windows))]
    async fn configure(&mut self, _cfg: EncoderConfig) -> Result<(), EncoderError> {
        Err(EncoderError::NotImplementedYet("libx264.configure".into()))
    }

    #[cfg(any(unix, windows))]
    async fn push_frame(&mut self, _frame: FrameHandle) -> Result<(), EncoderError> {
        Err(EncoderError::NotImplementedYet("libx264.push_frame".into()))
    }

    #[cfg(any(unix, windows))]
    async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError> {
        Err(EncoderError::NotImplementedYet("libx264.drain".into()))
    }

    async fn teardown(&mut self) -> Result<(), EncoderError> {
        Ok(())
    }
}
