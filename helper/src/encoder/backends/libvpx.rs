//! libvpx (VP8/VP9) software encoder backend stub — T-059.
//!
//! Serves as a universal CPU-side fallback when all hardware encoders are
//! unavailable.  Eventually wraps libvpx via vpx-sys or similar.

use async_trait::async_trait;
use serde_json::json;

use crate::encoder::backend::{EncoderBackend, EncoderConfig, EncoderError, ProbeOutcome};
use crate::protocol::types::CaptureFormat;

#[cfg(any(unix, windows))]
use crate::capture::FrameHandle;
#[cfg(any(unix, windows))]
use crate::encoder::fragment::EncodedFragment;

pub struct LibvpxBackend;

impl LibvpxBackend {
    pub fn new() -> Self { Self }
}

impl Default for LibvpxBackend {
    fn default() -> Self { Self::new() }
}

#[async_trait]
impl EncoderBackend for LibvpxBackend {
    fn name(&self) -> &'static str { "libvpx" }
    fn codec(&self) -> &'static str { "vp9" }

    async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
        ProbeOutcome::Unavailable {
            reason: "not-implemented-yet".into(),
            details: json!({
                "slot": "libvpx",
                "eventual_capabilities": {
                    "accepts_shm": true,
                    "accepts_dmabuf": false,
                    "accepts_d3d11": false,
                    "supported_codecs": ["vp8", "vp9"]
                }
            }),
        }
    }

    #[cfg(any(unix, windows))]
    async fn configure(&mut self, _cfg: EncoderConfig) -> Result<(), EncoderError> {
        Err(EncoderError::NotImplementedYet("libvpx.configure".into()))
    }

    #[cfg(any(unix, windows))]
    async fn push_frame(&mut self, _frame: FrameHandle) -> Result<(), EncoderError> {
        Err(EncoderError::NotImplementedYet("libvpx.push_frame".into()))
    }

    #[cfg(any(unix, windows))]
    async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError> {
        Err(EncoderError::NotImplementedYet("libvpx.drain".into()))
    }

    async fn teardown(&mut self) -> Result<(), EncoderError> {
        Ok(())
    }
}
