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

        // Try Adrenalin 21+ DLL first, fall back to legacy name.
        let lib = unsafe { libloading::Library::new("amf-core-x64.dll") }
            .or_else(|_| unsafe { libloading::Library::new("amf-core.dll") });
        let lib = match lib {
            Ok(l) => l,
            Err(e) => return ProbeOutcome::Unavailable {
                reason: format!("amf-load-failed:{e}"),
                details: serde_json::Value::Null,
            },
        };

        // AMF_FULL_VERSION = major(1)<<48 | minor(4)<<32 | release(0)<<16 | build(0)
        const AMF_FULL_VERSION: u64 =
            (1u64 << 48) | (4u64 << 32) | (0u64 << 16) | 0u64;

        type AmfInitFn =
            unsafe extern "C" fn(u64, *mut *mut std::ffi::c_void) -> i32;
        let amf_init: libloading::Symbol<AmfInitFn> =
            match unsafe { lib.get(b"AMFInit\0") } {
                Ok(s) => s,
                Err(e) => return ProbeOutcome::Unavailable {
                    reason: format!("AMFInit-missing:{e}"),
                    details: serde_json::Value::Null,
                },
            };

        let mut factory: *mut std::ffi::c_void = std::ptr::null_mut();
        let result = unsafe { amf_init(AMF_FULL_VERSION, &mut factory) };
        if result != 0 {
            return ProbeOutcome::Unavailable {
                reason: format!("AMFInit-failed:{result}"),
                details: serde_json::Value::Null,
            };
        }

        ProbeOutcome::Available {
            capabilities: crate::encoder::backend::EncoderCapabilities {
                accepts_dmabuf: false,
                accepts_shm: true,
                accepts_d3d11: true,
                supported_codecs: vec!["h264".into(), "hevc".into()],
            },
            details: serde_json::json!({ "platform": "windows" }),
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
