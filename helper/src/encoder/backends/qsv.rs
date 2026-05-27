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

        // Path 1: Intel oneVPL dispatcher ("vpl.dll" on Windows).
        if let Ok(lib) = unsafe { libloading::Library::new("vpl.dll") } {
            type MfxLoadFn = unsafe extern "C" fn() -> *mut std::ffi::c_void;
            type MfxCreateSessionFn =
                unsafe extern "C" fn(*mut std::ffi::c_void, u32, *mut *mut std::ffi::c_void) -> i32;
            type MfxUnloadFn = unsafe extern "C" fn(*mut std::ffi::c_void);
            if let (Ok(mfx_load), Ok(mfx_create), Ok(mfx_unload)) = (
                unsafe { lib.get::<MfxLoadFn>(b"MFXLoad\0") },
                unsafe { lib.get::<MfxCreateSessionFn>(b"MFXCreateSession\0") },
                unsafe { lib.get::<MfxUnloadFn>(b"MFXUnload\0") },
            ) {
                let loader = unsafe { mfx_load() };
                if !loader.is_null() {
                    let mut session: *mut std::ffi::c_void = std::ptr::null_mut();
                    let status = unsafe { mfx_create(loader, 0, &mut session) };
                    unsafe { mfx_unload(loader) };
                    if status == 0 {
                        return ProbeOutcome::Available {
                            capabilities: crate::encoder::backend::EncoderCapabilities {
                                accepts_dmabuf: false,
                                accepts_shm: true,
                                accepts_d3d11: true,
                                supported_codecs: vec!["h264".into(), "hevc".into()],
                            },
                            details: serde_json::json!({ "platform": "windows", "api": "vpl" }),
                        };
                    }
                }
            }
        }

        // Path 2: Legacy Intel Media SDK ("libmfxhw64.dll" exports MFXInit, not MFXLoad).
        if let Ok(lib) = unsafe { libloading::Library::new("libmfxhw64.dll") } {
            type MfxInitFn =
                unsafe extern "C" fn(i32, *mut [u16; 2], *mut *mut std::ffi::c_void) -> i32;
            if let Ok(mfx_init) = unsafe { lib.get::<MfxInitFn>(b"MFXInit\0") } {
                let mut ver: [u16; 2] = [0, 1]; // [minor=0, major=1]
                let mut session: *mut std::ffi::c_void = std::ptr::null_mut();
                const MFX_IMPL_AUTO_ANY: i32 = 3;
                let status = unsafe { mfx_init(MFX_IMPL_AUTO_ANY, &mut ver, &mut session) };
                if status == 0 {
                    return ProbeOutcome::Available {
                        capabilities: crate::encoder::backend::EncoderCapabilities {
                            accepts_dmabuf: false,
                            accepts_shm: true,
                            accepts_d3d11: true,
                            supported_codecs: vec!["h264".into()],
                        },
                        details: serde_json::json!({ "platform": "windows", "api": "msdk" }),
                    };
                }
            }
        }

        ProbeOutcome::Unavailable {
            reason: "qsv-not-available-on-this-system".into(),
            details: serde_json::Value::Null,
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
