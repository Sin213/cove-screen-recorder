//! Real NVENC backend — T-017a.
//!
//! Probe exercises actual CUDA context creation and NvEncodeAPI session
//! creation.  Returns `ProbeOutcome::Available` only when a session is
//! successfully opened and immediately destroyed.
//!
//! Frame input path: SHM only (DMA-BUF deferred to a follow-up ticket).
//! Output: real H.264 NALs wrapped in fMP4 moof+mdat pairs via `fmp4.rs`.

pub mod ffi;
pub mod fmp4;

use std::ffi::c_void;
use std::ptr;

use async_trait::async_trait;
use libloading::{Library, Symbol};
use tracing::{debug, warn};

use crate::capture::FrameHandle;
use crate::encoder::backend::{
    EncoderBackend, EncoderCapabilities, EncoderConfig, EncoderError, ProbeOutcome,
};
use crate::encoder::fragment::EncodedFragment;
use crate::protocol::types::CaptureFormat;

use ffi::*;

// ── Helper ────────────────────────────────────────────────────────────────────

/// Width × height alignment required by NVENC (16-pixel macroblocks).
fn align16(v: u32) -> u32 { (v + 15) & !15 }

// ── Active encode session state ───────────────────────────────────────────────

struct EncodeSession {
    /// Loaded libraries kept alive for the lifetime of the session.
    _cuda_lib: Library,
    _nvenc_lib: Library,

    cuda_ctx: CUcontext,
    cu_ctx_destroy: FnCuCtxDestroy,

    encoder: *mut c_void,
    fn_list: NV_ENCODE_API_FUNCTION_LIST,

    cfg: EncoderConfig,

    /// Sequence number incremented per drained fragment.
    seq: u64,
    /// DTS in 90 kHz ticks accumulated across frames.
    dts_90k: u64,

    /// SPS and PPS extracted from the first encoder output (IDR frame).
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,

    /// Frames queued for encoding but not yet drained.
    pending_frames: Vec<PendingFrame>,

    /// Width / height actually configured in the encoder (aligned).
    enc_width: u32,
    enc_height: u32,
}

struct PendingFrame {
    input_buf: *mut c_void,   // NV_ENC_INPUT_PTR
    output_buf: *mut c_void,  // NV_ENC_OUTPUT_PTR
    pts_90k: u64,
    duration_90k: u32,
    is_keyframe: bool,
}

// ── NVENC structures needed for configure / push_frame / drain ────────────────

/// NV_ENC_BUFFER_FORMAT values.
const NV_ENC_BUFFER_FORMAT_NV12: u32 = 0x00000010;

/// NV_ENC_PIC_STRUCT
const NV_ENC_PIC_STRUCT_FRAME: u32 = 1;

/// NV_ENC_PIC_FLAGS
const NV_ENC_PIC_FLAG_FORCEINTRA: u32 = 0x1;

/// NV_ENC_CODEC_H264_GUID — from SDK headers (hard-coded bytes)
const NV_ENC_CODEC_H264_GUID: [u8; 16] = [
    0x6b, 0xc8, 0x27, 0x44, 0x4d, 0x64, 0x4d, 0x18,
    0x9d, 0x68, 0x09, 0xa5, 0x0a, 0x03, 0x21, 0x68,
];

/// NV_ENC_PRESET_P4_GUID (latency-tolerant quality)
const NV_ENC_PRESET_P4_GUID: [u8; 16] = [
    0x90, 0x54, 0xd4, 0x1f, 0x2e, 0xd3, 0x42, 0x96,
    0x9a, 0x4e, 0x14, 0x0d, 0x60, 0x28, 0x0e, 0xed,
];

// The NVENC API types below are sized per SDK 12.1 NvEncodeAPI.h.

/// GUID (16 bytes, matches Windows GUID layout used by NVENC).
#[repr(C)]
#[derive(Copy, Clone)]
struct GUID {
    data: [u8; 16],
}

impl GUID {
    fn from_bytes(b: [u8; 16]) -> Self { Self { data: b } }
}

/// NV_ENC_INITIALIZE_PARAMS — core session config.
/// Full struct per SDK 12.1 (version field + all mandatory padding).
#[repr(C)]
struct NV_ENC_INITIALIZE_PARAMS {
    version: u32,
    encodeGUID: GUID,
    presetGUID: GUID,
    encodeWidth: u32,
    encodeHeight: u32,
    darWidth: u32,
    darHeight: u32,
    frameRateNum: u32,
    frameRateDen: u32,
    enableEncodeAsync: u32,
    enablePTD: u32,
    reportSliceOffsets: u32,
    enableSubFrameWrite: u32,
    enableExternalMEHints: u32,
    enableMEOnlyMode: u32,
    enableWeightedPrediction: u32,
    enableOutputInVidmem: u32,
    reserved: u32,
    privDataSize: u32,
    privData: *mut c_void,
    encodeConfig: *mut c_void, // NV_ENC_CONFIG*
    maxEncodeWidth: u32,
    maxEncodeHeight: u32,
    maxMEHintCountsPerBlock: [u32; 2],
    reserved1: [u32; 289],
    reserved2: [*mut c_void; 64],
}

/// NV_ENC_CREATE_INPUT_BUFFER
#[repr(C)]
struct NV_ENC_CREATE_INPUT_BUFFER {
    version: u32,
    width: u32,
    height: u32,
    memoryHeap: u32,   // NV_ENC_MEMORY_HEAP (deprecated but still required)
    bufferFmt: u32,
    reserved: u32,
    inputBuffer: *mut c_void,  // out: NV_ENC_INPUT_PTR
    pSysMemBuffer: *mut c_void,
    reserved1: [u32; 57],
    reserved2: [*mut c_void; 63],
}

/// NV_ENC_CREATE_BITSTREAM_BUFFER
#[repr(C)]
struct NV_ENC_CREATE_BITSTREAM_BUFFER {
    version: u32,
    size: u32,       // reserved / deprecated
    memoryHeap: u32, // reserved / deprecated
    reserved: u32,
    bitstreamBuffer: *mut c_void, // out: NV_ENC_OUTPUT_PTR
    bitstreamBufferPtr: *mut c_void,
    reserved1: [u32; 58],
    reserved2: [*mut c_void; 64],
}

/// NV_ENC_PIC_PARAMS
#[repr(C)]
struct NV_ENC_PIC_PARAMS {
    version: u32,
    inputWidth: u32,
    inputHeight: u32,
    inputPitch: u32,
    encodePicFlags: u32,
    frameIdx: u32,
    inputTimeStamp: u64,
    inputDuration: u64,
    inputBuffer: *mut c_void,  // NV_ENC_INPUT_PTR
    outputBitstream: *mut c_void, // NV_ENC_OUTPUT_PTR
    completionEvent: *mut c_void,
    pictureStruct: u32,
    pictureType: u32, // NV_ENC_PIC_TYPE — 0 = auto
    codecPicParams: [u8; 256], // union, zeroed for auto
    meHintCountsPerBlock: [u32; 2],
    meExternalHints: *mut c_void,
    reserved1: [u32; 6],
    reserved2: [*mut c_void; 2],
    qpDeltaMap: *mut i8,
    qpDeltaMapSize: u32,
    reservedBitFields: u32,
    meHintRefPicDist: [u16; 2],
    reservedBitFields2: u32,
    reserved3: [u32; 286],
    reserved4: [*mut c_void; 60],
}

/// NV_ENC_LOCK_BITSTREAM
#[repr(C)]
struct NV_ENC_LOCK_BITSTREAM {
    version: u32,
    doNotWait: u32,       // bit 0
    ltrFrame: u32,        // bit 0 of next field in union — zeroed
    reservedBitFields: u32,
    outputBitstream: *mut c_void,
    sliceOffsets: *mut u32,
    frameIdx: u32,
    hwEncodeStatus: u32,
    numSlices: u32,
    bitstreamSizeInBytes: u32,
    outputTimeStamp: u64,
    outputDuration: u64,
    bitstreamBufferPtr: *mut c_void, // out
    pictureType: u32,
    pictureStruct: u32,
    frameAvgQP: u32,
    frameSatd: u32,
    ltrFrameIdx: u32,
    ltrFrameBitmap: u32,
    reserved: [u32; 13],
    intraMBCount: u32,
    interMBCount: u32,
    averageMVX: i32,
    averageMVY: i32,
    reserved1: [u32; 219],
    reserved2: [*mut c_void; 64],
}

// Version macros (SDK 12.1)
const NV_ENC_INITIALIZE_PARAMS_VER: u32 = NVENCAPI_VERSION | (5 << 31);
const NV_ENC_CREATE_INPUT_BUFFER_VER: u32 = NVENCAPI_VERSION | (1 << 31);
const NV_ENC_CREATE_BITSTREAM_BUFFER_VER: u32 = NVENCAPI_VERSION | (1 << 31);
const NV_ENC_PIC_PARAMS_VER: u32 = NVENCAPI_VERSION | (6 << 31);
const NV_ENC_LOCK_BITSTREAM_VER: u32 = NVENCAPI_VERSION | (1 << 31);

// ── NV_ENC_INITIALIZE_PARAMS typed function aliases ───────────────────────────

type FnNvEncInitializeEncoder = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_INITIALIZE_PARAMS,
) -> NVENCSTATUS;

type FnNvEncCreateInputBuffer = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_CREATE_INPUT_BUFFER,
) -> NVENCSTATUS;

type FnNvEncDestroyInputBuffer = unsafe extern "C" fn(
    encoder: *mut c_void,
    buf: *mut c_void,
) -> NVENCSTATUS;

type FnNvEncCreateBitstreamBuffer = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_CREATE_BITSTREAM_BUFFER,
) -> NVENCSTATUS;

type FnNvEncDestroyBitstreamBuffer = unsafe extern "C" fn(
    encoder: *mut c_void,
    buf: *mut c_void,
) -> NVENCSTATUS;

type FnNvEncEncodePicture = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_PIC_PARAMS,
) -> NVENCSTATUS;

type FnNvEncLockBitstream = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_LOCK_BITSTREAM,
) -> NVENCSTATUS;

type FnNvEncUnlockBitstream = unsafe extern "C" fn(
    encoder: *mut c_void,
    buf: *mut c_void,
) -> NVENCSTATUS;

/// NV_ENC_LOCK_INPUT_BUFFER — per SDK 12.1 NvEncodeAPI.h.
#[repr(C)]
struct NV_ENC_LOCK_INPUT_BUFFER {
    version: u32,
    /// Bit 0 = doNotWait; bits 1-31 reserved.
    doNotWait: u32,
    /// NV_ENC_INPUT_PTR to lock.
    inputBuffer: *mut c_void,
    /// [out] Pointer to the locked buffer data.
    bufferDataPtr: *mut c_void,
    /// [out] Pitch of the locked buffer.
    pitch: u32,
    reserved1: [u32; 251],
    reserved2: [*mut c_void; 64],
}
const NV_ENC_LOCK_INPUT_BUFFER_VER: u32 = NVENCAPI_VERSION | (1 << 31);

type FnNvEncLockInputBuffer = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_LOCK_INPUT_BUFFER,
) -> NVENCSTATUS;

type FnNvEncUnlockInputBuffer = unsafe extern "C" fn(
    encoder: *mut c_void,
    buf: *mut c_void,
) -> NVENCSTATUS;

// ── NvencBackend ──────────────────────────────────────────────────────────────

/// NVENC H.264 encoder backend.
///
/// `session` is `None` before `configure()` and after `teardown()`.
pub struct NvencBackend {
    session: Option<Box<EncodeSession>>,
}

impl NvencBackend {
    pub fn new() -> Self {
        Self { session: None }
    }
}

// ── Probe helpers ─────────────────────────────────────────────────────────────

/// Try loading libcuda.so.1 and running cuInit + cuDeviceGetCount.
/// Returns the loaded library on success, or an Unavailable reason string.
fn load_cuda() -> Result<(Library, FnCuInit, FnCuDeviceGetCount, FnCuDeviceGet, FnCuCtxCreate, FnCuCtxDestroy), String> {
    let lib = unsafe {
        Library::new("libcuda.so.1")
            .map_err(|_| "no-cuda-driver".to_string())?
    };

    let cu_init: FnCuInit = unsafe {
        *lib.get::<FnCuInit>(b"cuInit\0")
            .map_err(|e| format!("no-cuda-driver: {e}"))? as FnCuInit
    };
    let cu_device_get_count: FnCuDeviceGetCount = unsafe {
        *lib.get::<FnCuDeviceGetCount>(b"cuDeviceGetCount\0")
            .map_err(|e| format!("no-cuda-driver: {e}"))? as FnCuDeviceGetCount
    };
    let cu_device_get: FnCuDeviceGet = unsafe {
        *lib.get::<FnCuDeviceGet>(b"cuDeviceGet\0")
            .map_err(|e| format!("no-cuda-driver: {e}"))? as FnCuDeviceGet
    };
    let cu_ctx_create: FnCuCtxCreate = unsafe {
        *lib.get::<FnCuCtxCreate>(b"cuCtxCreate_v2\0")
            .or_else(|_| lib.get::<FnCuCtxCreate>(b"cuCtxCreate\0"))
            .map_err(|e| format!("no-cuda-driver: {e}"))? as FnCuCtxCreate
    };
    let cu_ctx_destroy: FnCuCtxDestroy = unsafe {
        *lib.get::<FnCuCtxDestroy>(b"cuCtxDestroy_v2\0")
            .or_else(|_| lib.get::<FnCuCtxDestroy>(b"cuCtxDestroy\0"))
            .map_err(|e| format!("no-cuda-driver: {e}"))? as FnCuCtxDestroy
    };

    Ok((lib, cu_init, cu_device_get_count, cu_device_get, cu_ctx_create, cu_ctx_destroy))
}

/// Try loading libnvidia-encode.so.1 and getting NvEncodeAPICreateInstance.
fn load_nvenc(lib: &Library) -> Result<NV_ENCODE_API_FUNCTION_LIST, String> {
    let create_instance: Symbol<FnNvEncodeAPICreateInstance> = unsafe {
        lib.get::<FnNvEncodeAPICreateInstance>(b"NvEncodeAPICreateInstance\0")
            .map_err(|e| format!("no-nvenc-library: {e}"))?
    };

    let mut fn_list = unsafe { std::mem::zeroed::<NV_ENCODE_API_FUNCTION_LIST>() };
    fn_list.version = NV_ENCODE_API_FUNCTION_LIST_VER;

    let status = unsafe { create_instance(&mut fn_list) };
    if status != NV_ENC_SUCCESS {
        return Err(format!("nvenc-api-create-failed:{status}"));
    }

    Ok(fn_list)
}

/// Open a probe-only NVENC session and immediately destroy it.
/// Returns `Ok(fn_list)` so the caller can reuse the already-created function
/// list for the real configure path.
fn probe_nvenc_session(
    fn_list: &NV_ENCODE_API_FUNCTION_LIST,
    cuda_ctx: CUcontext,
) -> Result<(), String> {
    let open_session = fn_list.nvEncOpenEncodeSessionEx
        .ok_or_else(|| "nvenc-api-create-failed:null-open-fn".to_string())?;
    let destroy = fn_list.nvEncDestroyEncoder
        .ok_or_else(|| "nvenc-api-create-failed:null-destroy-fn".to_string())?;

    let mut params = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
        version: NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
        deviceType: NV_ENC_DEVICE_TYPE_CUDA,
        device: cuda_ctx as *mut c_void,
        reserved: ptr::null_mut(),
        apiVersion: NVENCAPI_VERSION,
        reserved1: [0u32; 253],
        reserved2: [ptr::null_mut(); 64],
    };

    let mut encoder: *mut c_void = ptr::null_mut();
    let status = unsafe { open_session(&mut params, &mut encoder) };
    if status != NV_ENC_SUCCESS {
        return Err(format!("session-create-failed:{status}"));
    }

    // Probe succeeded — destroy the probe session immediately
    let _ = unsafe { destroy(encoder) };
    Ok(())
}

// ── EncoderBackend impl ───────────────────────────────────────────────────────

#[cfg_attr(not(unix), allow(unused))]
#[async_trait]
impl EncoderBackend for NvencBackend {
    fn name(&self) -> &'static str { "nvenc" }
    fn codec(&self) -> &'static str { "h264" }

    async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
        let unavail = |reason: String| ProbeOutcome::Unavailable {
            reason,
            details: serde_json::Value::Null,
        };

        // Allow tests to force-unavailable via env var.
        if std::env::var("COVE_NVENC_FORCE_UNAVAILABLE").is_ok() {
            return unavail("force-unavailable-by-env".into());
        }

        // 1. Load CUDA and run cuInit.
        let (cuda_lib, cu_init, cu_device_get_count, cu_device_get, cu_ctx_create, cu_ctx_destroy) =
            match load_cuda() {
                Ok(v) => v,
                Err(reason) => {
                    debug!(reason, "nvenc probe: cuda load failed");
                    return unavail(reason);
                }
            };

        let init_status = unsafe { cu_init(0) };
        if init_status != CUDA_SUCCESS {
            debug!(status = init_status, "nvenc probe: cuInit failed");
            return unavail(format!("cuinit-failed:{init_status}"));
        }

        // 2. Check that at least one CUDA device is present.
        let mut count: i32 = 0;
        let count_status = unsafe { cu_device_get_count(&mut count) };
        if count_status != CUDA_SUCCESS || count == 0 {
            debug!(status = count_status, count, "nvenc probe: no CUDA device");
            return unavail("no-cuda-device".into());
        }

        // 3. Create a CUDA context on device 0.
        let mut device: CUdevice = 0;
        let dev_status = unsafe { cu_device_get(&mut device, 0) };
        if dev_status != CUDA_SUCCESS {
            return unavail(format!("cuinit-failed:{dev_status}"));
        }

        let mut cuda_ctx: CUcontext = ptr::null_mut();
        let ctx_status = unsafe { cu_ctx_create(&mut cuda_ctx, 0, device) };
        if ctx_status != CUDA_SUCCESS {
            debug!(status = ctx_status, "nvenc probe: cuCtxCreate failed");
            return unavail(format!("cuctxcreate-failed:{ctx_status}"));
        }

        // 4. Load libnvidia-encode and get the API function list.
        let nvenc_lib = match unsafe { Library::new("libnvidia-encode.so.1") } {
            Ok(l) => l,
            Err(_) => {
                unsafe { cu_ctx_destroy(cuda_ctx) };
                return unavail("no-nvenc-library".into());
            }
        };

        let fn_list = match load_nvenc(&nvenc_lib) {
            Ok(fl) => fl,
            Err(reason) => {
                unsafe { cu_ctx_destroy(cuda_ctx) };
                return unavail(reason);
            }
        };

        // 5. Open and immediately destroy a real encode session.
        let probe_result = probe_nvenc_session(&fn_list, cuda_ctx);
        unsafe { cu_ctx_destroy(cuda_ctx) };

        match probe_result {
            Ok(()) => {
                debug!("nvenc probe: session creation succeeded");
                ProbeOutcome::Available {
                    capabilities: EncoderCapabilities {
                        accepts_dmabuf: false, // DMA-BUF deferred
                        accepts_shm: true,
                        supported_codecs: vec!["h264".into()],
                    },
                    details: serde_json::Value::Null,
                }
            }
            Err(reason) => {
                warn!(reason, "nvenc probe: session creation failed");
                unavail(reason)
            }
        }
    }

    async fn configure(&mut self, cfg: EncoderConfig) -> Result<(), EncoderError> {
        // Load CUDA again for the real session.
        let (cuda_lib, cu_init, cu_device_get_count, cu_device_get, cu_ctx_create, cu_ctx_destroy) =
            load_cuda().map_err(|r| EncoderError::Runtime(r))?;

        let init_status = unsafe { cu_init(0) };
        if init_status != CUDA_SUCCESS {
            return Err(EncoderError::Runtime(format!("cuinit-failed:{init_status}")));
        }

        let mut count: i32 = 0;
        unsafe { cu_device_get_count(&mut count) };
        if count == 0 {
            return Err(EncoderError::Runtime("no-cuda-device".into()));
        }

        let mut device: CUdevice = 0;
        unsafe { cu_device_get(&mut device, 0) };

        let mut cuda_ctx: CUcontext = ptr::null_mut();
        let ctx_status = unsafe { cu_ctx_create(&mut cuda_ctx, 0, device) };
        if ctx_status != CUDA_SUCCESS {
            return Err(EncoderError::Runtime(format!("cuctxcreate-failed:{ctx_status}")));
        }

        let nvenc_lib = unsafe { Library::new("libnvidia-encode.so.1") }
            .map_err(|_| EncoderError::Runtime("no-nvenc-library".into()))?;

        let fn_list = load_nvenc(&nvenc_lib)
            .map_err(|r| EncoderError::Runtime(r))?;

        // Open the real encode session.
        let open_session = fn_list.nvEncOpenEncodeSessionEx
            .ok_or_else(|| EncoderError::Runtime("null-open-fn".into()))?;

        let mut params = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
            version: NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
            deviceType: NV_ENC_DEVICE_TYPE_CUDA,
            device: cuda_ctx as *mut c_void,
            reserved: ptr::null_mut(),
            apiVersion: NVENCAPI_VERSION,
            reserved1: [0u32; 253],
            reserved2: [ptr::null_mut(); 64],
        };

        let mut encoder: *mut c_void = ptr::null_mut();
        let status = unsafe { open_session(&mut params, &mut encoder) };
        if status != NV_ENC_SUCCESS {
            unsafe { cu_ctx_destroy(cuda_ctx) };
            return Err(EncoderError::Runtime(format!("session-create-failed:{status}")));
        }

        // Initialize the encoder (H.264 CBR).
        let init_fn: FnNvEncInitializeEncoder = unsafe {
            std::mem::transmute(fn_list.nvEncInitializeEncoder)
        };

        let enc_width = align16(cfg.format.width);
        let enc_height = align16(cfg.format.height);
        let fps_num = cfg.format.fps_num.max(1);
        let fps_den = cfg.format.fps_den.max(1);
        let gop_size = ((fps_num as f32 / fps_den as f32) * cfg.gop_seconds).round() as u32;

        let mut init_params = unsafe { std::mem::zeroed::<NV_ENC_INITIALIZE_PARAMS>() };
        init_params.version = NV_ENC_INITIALIZE_PARAMS_VER;
        init_params.encodeGUID = GUID::from_bytes(NV_ENC_CODEC_H264_GUID);
        init_params.presetGUID = GUID::from_bytes(NV_ENC_PRESET_P4_GUID);
        init_params.encodeWidth = enc_width;
        init_params.encodeHeight = enc_height;
        init_params.darWidth = cfg.format.width;
        init_params.darHeight = cfg.format.height;
        init_params.frameRateNum = fps_num;
        init_params.frameRateDen = fps_den;
        init_params.enablePTD = 1;
        init_params.maxEncodeWidth = enc_width;
        init_params.maxEncodeHeight = enc_height;

        let init_status = unsafe { init_fn(encoder, &mut init_params) };
        if init_status != NV_ENC_SUCCESS {
            if let Some(destroy) = fn_list.nvEncDestroyEncoder {
                unsafe { destroy(encoder) };
            }
            unsafe { cu_ctx_destroy(cuda_ctx) };
            return Err(EncoderError::Runtime(format!("nvenc-init-failed:{init_status}")));
        }

        self.session = Some(Box::new(EncodeSession {
            _cuda_lib: cuda_lib,
            _nvenc_lib: nvenc_lib,
            cuda_ctx,
            cu_ctx_destroy,
            encoder,
            fn_list,
            cfg,
            seq: 0,
            dts_90k: 0,
            sps: None,
            pps: None,
            pending_frames: Vec::new(),
            enc_width,
            enc_height,
        }));

        Ok(())
    }

    fn init_segment(&self) -> Option<Vec<u8>> {
        let sess = self.session.as_ref()?;
        let sps = sess.sps.as_ref()?;
        let pps = sess.pps.as_ref()?;
        Some(fmp4::build_init_segment(
            sess.cfg.format.width,
            sess.cfg.format.height,
            90000,
            sps,
            pps,
        ))
    }

    async fn push_frame(&mut self, frame: FrameHandle) -> Result<(), EncoderError> {
        let sess = self.session.as_mut()
            .ok_or_else(|| EncoderError::Runtime("push_frame before configure".into()))?;

        let (shm_ptr, shm_size, stride) = match &frame.payload {
            crate::capture::FramePayload::Shm { data, width: _, height: _, format: _, stride } => {
                (data.as_ptr(), data.len(), *stride)
            }
            crate::capture::FramePayload::DmaBuf { .. } => {
                return Err(EncoderError::Runtime("DMA-BUF not implemented in NVENC backend yet".into()));
            }
        };

        // Allocate an input buffer.
        let create_input_buf: FnNvEncCreateInputBuffer = unsafe {
            std::mem::transmute(sess.fn_list.nvEncCreateInputBuffer)
        };
        let mut create_in = unsafe { std::mem::zeroed::<NV_ENC_CREATE_INPUT_BUFFER>() };
        create_in.version = NV_ENC_CREATE_INPUT_BUFFER_VER;
        create_in.width = sess.enc_width;
        create_in.height = sess.enc_height;
        create_in.bufferFmt = NV_ENC_BUFFER_FORMAT_NV12;
        let status = unsafe { create_input_buf(sess.encoder, &mut create_in) };
        if status != NV_ENC_SUCCESS {
            return Err(EncoderError::Runtime(format!("create-input-buffer-failed:{status}")));
        }
        let input_buf = create_in.inputBuffer;

        // Lock, copy frame data, unlock.
        let lock_input: FnNvEncLockInputBuffer = unsafe {
            std::mem::transmute(sess.fn_list.nvEncLockInputBuffer)
        };
        let unlock_input: FnNvEncUnlockInputBuffer = unsafe {
            std::mem::transmute(sess.fn_list.nvEncUnlockInputBuffer)
        };

        let mut lock_in_params = NV_ENC_LOCK_INPUT_BUFFER {
            version: NV_ENC_LOCK_INPUT_BUFFER_VER,
            doNotWait: 0,
            inputBuffer: input_buf,
            bufferDataPtr: ptr::null_mut(),
            pitch: 0,
            reserved1: [0u32; 251],
            reserved2: [ptr::null_mut(); 64],
        };
        let lock_status = unsafe { lock_input(sess.encoder, &mut lock_in_params) };
        if lock_status != NV_ENC_SUCCESS {
            return Err(EncoderError::Runtime(format!("lock-input-buffer-failed:{lock_status}")));
        }

        let locked_ptr = lock_in_params.bufferDataPtr;
        let locked_pitch = lock_in_params.pitch;

        // NV12: luma plane (height rows) + chroma plane (height/2 rows of interleaved UV).
        // SHM frame arrives as NV12 (fourcc=NV12) or similar — copy luma + chroma.
        let h = sess.enc_height as usize;
        let w = sess.enc_width as usize;
        let pitch = locked_pitch as usize;
        let frame_stride = stride as usize;

        // Copy luma rows.
        for row in 0..h {
            let src_off = row * frame_stride;
            let dst_off = row * pitch;
            let copy_len = w.min(if src_off < shm_size { shm_size - src_off } else { 0 });
            if copy_len > 0 {
                unsafe {
                    ptr::copy_nonoverlapping(
                        shm_ptr.add(src_off),
                        (locked_ptr as *mut u8).add(dst_off),
                        copy_len,
                    );
                }
            }
        }

        // Copy chroma (UV interleaved, half height).
        let chroma_src_off = h * frame_stride;
        let chroma_dst_off = h * pitch;
        let chroma_rows = h / 2;
        for row in 0..chroma_rows {
            let src_off = chroma_src_off + row * frame_stride;
            let dst_off = chroma_dst_off + row * pitch;
            let copy_len = w.min(if src_off < shm_size { shm_size - src_off } else { 0 });
            if copy_len > 0 {
                unsafe {
                    ptr::copy_nonoverlapping(
                        shm_ptr.add(src_off),
                        (locked_ptr as *mut u8).add(dst_off),
                        copy_len,
                    );
                }
            }
        }

        unsafe { unlock_input(sess.encoder, input_buf) };

        // Allocate output (bitstream) buffer.
        let create_bs_buf: FnNvEncCreateBitstreamBuffer = unsafe {
            std::mem::transmute(sess.fn_list.nvEncCreateBitstreamBuffer)
        };
        let mut create_out = unsafe { std::mem::zeroed::<NV_ENC_CREATE_BITSTREAM_BUFFER>() };
        create_out.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
        let status = unsafe { create_bs_buf(sess.encoder, &mut create_out) };
        if status != NV_ENC_SUCCESS {
            return Err(EncoderError::Runtime(format!("create-bitstream-buffer-failed:{status}")));
        }
        let output_buf = create_out.bitstreamBuffer;

        // Submit the frame.
        let encode_pic: FnNvEncEncodePicture = unsafe {
            std::mem::transmute(sess.fn_list.nvEncEncodePicture)
        };
        let fps_num = sess.cfg.format.fps_num.max(1);
        let fps_den = sess.cfg.format.fps_den.max(1);
        let duration_90k = ((90000 * fps_den) / fps_num) as u32;
        let pts_90k = sess.dts_90k;
        let is_keyframe = sess.pending_frames.is_empty() && sess.sps.is_none();

        let mut pic_params = unsafe { std::mem::zeroed::<NV_ENC_PIC_PARAMS>() };
        pic_params.version = NV_ENC_PIC_PARAMS_VER;
        pic_params.inputWidth = sess.enc_width;
        pic_params.inputHeight = sess.enc_height;
        pic_params.inputPitch = locked_pitch;
        pic_params.inputBuffer = input_buf;
        pic_params.outputBitstream = output_buf;
        pic_params.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
        pic_params.inputTimeStamp = pts_90k;
        if is_keyframe {
            pic_params.encodePicFlags = NV_ENC_PIC_FLAG_FORCEINTRA;
        }

        let enc_status = unsafe { encode_pic(sess.encoder, &mut pic_params) };
        // NV_ENC_ERR_NEED_MORE_INPUT (= 15) is valid for B-frame buffering.
        if enc_status != NV_ENC_SUCCESS && enc_status != 15 {
            return Err(EncoderError::Runtime(format!("encode-picture-failed:{enc_status}")));
        }

        sess.pending_frames.push(PendingFrame {
            input_buf,
            output_buf,
            pts_90k,
            duration_90k,
            is_keyframe,
        });
        sess.dts_90k += duration_90k as u64;
        Ok(())
    }

    async fn drain(&mut self) -> Result<Vec<EncodedFragment>, EncoderError> {
        let sess = self.session.as_mut()
            .ok_or_else(|| EncoderError::Runtime("drain before configure".into()))?;

        let lock_bs: FnNvEncLockBitstream = unsafe {
            std::mem::transmute(sess.fn_list.nvEncLockBitstream)
        };
        let unlock_bs: FnNvEncUnlockBitstream = unsafe {
            std::mem::transmute(sess.fn_list.nvEncUnlockBitstream)
        };
        let destroy_in: FnNvEncDestroyInputBuffer = unsafe {
            std::mem::transmute(sess.fn_list.nvEncDestroyInputBuffer)
        };
        let destroy_out: FnNvEncDestroyBitstreamBuffer = unsafe {
            std::mem::transmute(sess.fn_list.nvEncDestroyBitstreamBuffer)
        };

        let mut fragments = Vec::new();
        let pending = std::mem::take(&mut sess.pending_frames);

        for pf in pending {
            let mut lock_params = unsafe { std::mem::zeroed::<NV_ENC_LOCK_BITSTREAM>() };
            lock_params.version = NV_ENC_LOCK_BITSTREAM_VER;
            lock_params.outputBitstream = pf.output_buf;

            let lock_status = unsafe { lock_bs(sess.encoder, &mut lock_params) };
            if lock_status != NV_ENC_SUCCESS {
                // Destroy buffers even on failure.
                unsafe { destroy_in(sess.encoder, pf.input_buf) };
                unsafe { destroy_out(sess.encoder, pf.output_buf) };
                return Err(EncoderError::Runtime(format!("lock-bitstream-failed:{lock_status}")));
            }

            let bs_ptr = lock_params.bitstreamBufferPtr as *const u8;
            let bs_size = lock_params.bitstreamSizeInBytes as usize;
            let au_bytes = if !bs_ptr.is_null() && bs_size > 0 {
                unsafe { std::slice::from_raw_parts(bs_ptr, bs_size).to_vec() }
            } else {
                Vec::new()
            };

            // Extract SPS/PPS from the first IDR frame if not yet captured.
            if sess.sps.is_none() {
                if let Some((sps, pps)) = extract_sps_pps(&au_bytes) {
                    sess.sps = Some(sps);
                    sess.pps = Some(pps);
                }
            }

            unsafe { unlock_bs(sess.encoder, pf.output_buf) };
            unsafe { destroy_in(sess.encoder, pf.input_buf) };
            unsafe { destroy_out(sess.encoder, pf.output_buf) };

            if au_bytes.is_empty() {
                continue;
            }

            sess.seq += 1;
            let frag_bytes = fmp4::build_fragment(
                sess.seq,
                pf.pts_90k,
                pf.duration_90k,
                pf.is_keyframe,
                &au_bytes,
            );

            fragments.push(EncodedFragment {
                seq: sess.seq,
                pts_90k: pf.pts_90k,
                duration_90k: pf.duration_90k,
                is_keyframe: pf.is_keyframe,
                bytes: frag_bytes,
            });
        }

        Ok(fragments)
    }

    async fn teardown(&mut self) -> Result<(), EncoderError> {
        if let Some(sess) = self.session.take() {
            if let Some(destroy) = sess.fn_list.nvEncDestroyEncoder {
                unsafe { destroy(sess.encoder) };
            }
            unsafe { (sess.cu_ctx_destroy)(sess.cuda_ctx) };
        }
        Ok(())
    }
}

/// Extract raw SPS and PPS NAL units (without start codes) from an Annex-B
/// H.264 bitstream.  Returns `None` if neither is found.
fn extract_sps_pps(data: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut sps: Option<Vec<u8>> = None;
    let mut pps: Option<Vec<u8>> = None;

    let mut i = 0;
    while i < data.len() {
        // Scan for start code.
        if i + 3 < data.len() && data[i] == 0 && data[i + 1] == 0 {
            let skip = if data[i + 2] == 0 && i + 3 < data.len() && data[i + 3] == 1 { 4 }
                       else if data[i + 2] == 1 { 3 }
                       else { i += 1; continue; };
            i += skip;
            if i >= data.len() { break; }

            let nal_type = data[i] & 0x1f;
            let end = find_nal_end(data, i + 1).unwrap_or(data.len());

            match nal_type {
                7 => sps = Some(data[i..end].to_vec()),
                8 => pps = Some(data[i..end].to_vec()),
                _ => {}
            }
            i = end;
        } else {
            i += 1;
        }
    }

    match (sps, pps) {
        (Some(s), Some(p)) => Some((s, p)),
        _ => None,
    }
}

fn find_nal_end(data: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 2 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && (data[i + 2] == 1 || (data[i + 2] == 0 && i + 3 < data.len() && data[i + 3] == 1)) {
            return Some(i);
        }
        i += 1;
    }
    None
}

// Safety: EncodeSession holds raw pointers to GPU resources managed
// exclusively through the NVENC/CUDA APIs with explicit lifetime coupling to
// the loaded libraries.  The session is never shared across threads.
unsafe impl Send for NvencBackend {}
unsafe impl Sync for NvencBackend {}
