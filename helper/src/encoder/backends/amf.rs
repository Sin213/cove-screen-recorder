//! AMD AMF encoder backend stub — T-054.
//!
//! AMF is Windows-only.  The impl block is #[cfg(windows)]-gated; on Linux/macOS
//! the struct is still compilable so it can be named in cross-platform backend
//! lists without a cfg guard at the call site.

use async_trait::async_trait;

use crate::encoder::backend::{EncoderBackend, EncoderConfig, EncoderError, ProbeOutcome};
use crate::protocol::types::CaptureFormat;

#[cfg(any(unix, windows))]
use crate::capture::FrameHandle;
#[cfg(any(unix, windows))]
use crate::encoder::fragment::EncodedFragment;

pub struct AmfBackend;

impl AmfBackend {
    pub fn new() -> Self { Self }
}

impl Default for AmfBackend {
    fn default() -> Self { Self::new() }
}

#[cfg(windows)]
#[async_trait]
impl EncoderBackend for AmfBackend {
    fn name(&self) -> &'static str { "amf" }
    fn codec(&self) -> &'static str { "h264" }

    async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
        if std::env::var("COVE_AMF_FORCE_UNAVAILABLE").is_ok() {
            return ProbeOutcome::Unavailable {
                reason: "force-unavailable-by-env".into(),
                details: serde_json::Value::Null,
            };
        }
        // Real probe (AMFCreateContext + AMFCreateComponent) deferred.
        ProbeOutcome::Unavailable {
            reason: "not-implemented-yet: amf-windows-probe".into(),
            details: serde_json::json!({
                "eventual_capabilities": {
                    "accepts_d3d11": true,
                    "accepts_dmabuf": false,
                    "accepts_shm": false,
                    "supported_codecs": ["h264", "hevc"]
                }
            }),
        }
    }

    #[cfg(any(unix, windows))]
    async fn configure(&mut self, _cfg: EncoderConfig) -> Result<(), EncoderError> {
        Err(EncoderError::NotImplementedYet("amf-windows-configure".into()))
    }

    #[cfg(any(unix, windows))]
    async fn push_frame(&mut self, _frame: FrameHandle) -> Result<(), EncoderError> {
        Err(EncoderError::NotImplementedYet("amf-windows-push-frame".into()))
    }

    #[cfg(any(unix, windows))]
    async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError> {
        Err(EncoderError::NotImplementedYet("amf-windows-drain".into()))
    }

    async fn teardown(&mut self) -> Result<(), EncoderError> {
        Ok(())
    }
}
