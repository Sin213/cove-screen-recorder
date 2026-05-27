//! Intel Quick Sync (QSV / oneVPL) encoder backend stub — T-055.
//!
//! QSV on Windows uses Intel Media SDK / oneVPL with a D3D11 device allocator
//! for zero-copy surface sharing from DXGI capture.  The impl block is
//! #[cfg(windows)]-gated; the struct is still compilable cross-platform so it
//! can be named in backend lists without a cfg guard at the call site.

use async_trait::async_trait;

use crate::encoder::backend::{EncoderBackend, EncoderConfig, EncoderError, ProbeOutcome};
use crate::protocol::types::CaptureFormat;

#[cfg(any(unix, windows))]
use crate::capture::FrameHandle;
#[cfg(any(unix, windows))]
use crate::encoder::fragment::EncodedFragment;

pub struct QsvBackend;

impl QsvBackend {
    pub fn new() -> Self { Self }
}

impl Default for QsvBackend {
    fn default() -> Self { Self::new() }
}

#[cfg(windows)]
#[async_trait]
impl EncoderBackend for QsvBackend {
    fn name(&self) -> &'static str { "qsv" }
    fn codec(&self) -> &'static str { "h264" }

    async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
        if std::env::var("COVE_QSV_FORCE_UNAVAILABLE").is_ok() {
            return ProbeOutcome::Unavailable {
                reason: "force-unavailable-by-env".into(),
                details: serde_json::Value::Null,
            };
        }
        // Real probe (MFXCreateSession / VPL dispatcher init) deferred.
        ProbeOutcome::Unavailable {
            reason: "not-implemented-yet: qsv-windows-probe".into(),
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
        Err(EncoderError::NotImplementedYet("qsv-windows-configure".into()))
    }

    #[cfg(any(unix, windows))]
    async fn push_frame(&mut self, _frame: FrameHandle) -> Result<(), EncoderError> {
        Err(EncoderError::NotImplementedYet("qsv-windows-push-frame".into()))
    }

    #[cfg(any(unix, windows))]
    async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError> {
        Err(EncoderError::NotImplementedYet("qsv-windows-drain".into()))
    }

    async fn teardown(&mut self) -> Result<(), EncoderError> {
        Ok(())
    }
}
