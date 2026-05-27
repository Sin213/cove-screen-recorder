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
use std::time::Instant;

use async_trait::async_trait;
use libloading::{Library, Symbol};
use tracing::{debug, info, warn};

use crate::capture::FrameHandle;
use crate::encoder::backend::{
    EncoderBackend, EncoderCapabilities, EncoderConfig, EncoderError, ProbeOutcome,
};
use crate::encoder::fragment::{EncodedFragment, FragmentDiagnostics};
use crate::encoder::h264::scan_nal_types;
use crate::protocol::types::CaptureFormat;

use ffi::*;

// ── Helper ────────────────────────────────────────────────────────────────────

/// Width × height alignment required by NVENC (16-pixel macroblocks).
fn align16(v: u32) -> u32 { (v + 15) & !15 }

/// Returns a nominal fps_num for use when PipeWire reports variable-rate (fps_num == 0).
/// Variable-rate PipeWire streams use 60 fps as the nominal cadence for gop_size and
/// NVENC frameRateNum; real frame timing comes from pts_ns in push_frame.
fn nominal_fps_num(fps_num: u32) -> u32 {
    if fps_num == 0 { 60 } else { fps_num }
}

/// Convert a nanosecond capture timestamp to 90 kHz ticks.
/// Clamps negative values to 0. Uses i128 intermediate to avoid overflow.
fn ns_to_pts_90k(pts_ns: i64) -> u64 {
    if pts_ns <= 0 {
        return 0;
    }
    let ticks = (pts_ns as i128 * 90_000_i128) / 1_000_000_000_i128;
    ticks.min(u64::MAX as i128) as u64
}

/// Enforce monotonic PTS. Returns `candidate` if it strictly advances past `last`,
/// otherwise returns `last + 1` (saturating) so muxed fragments never repeat or regress.
fn next_monotonic_pts(candidate: u64, last: u64) -> u64 {
    if candidate > last { candidate } else { last.saturating_add(1) }
}

fn drm_fourcc_to_str(v: u32) -> String {
    String::from_utf8_lossy(&[
        (v & 0xff) as u8,
        ((v >> 8) & 0xff) as u8,
        ((v >> 16) & 0xff) as u8,
        ((v >> 24) & 0xff) as u8,
    ])
    .trim_end_matches('\0')
    .to_string()
}

// ── DRM fourcc constants (local to this module) ──────────────────────────────

#[cfg(test)]
const DRM_FORMAT_NV12: u32 = 0x3231564E;
const DRM_FORMAT_XR24: u32 = 0x34325258;
const DRM_FORMAT_AR24: u32 = 0x34325241;

/// Convert packed BGRx/BGRa SHM frame to planar NV12 using BT.709 limited range.
///
/// # Safety
/// `src` must be valid for reads up to `src_len` bytes.
/// `dst` must be valid for writes of `enc_h * dst_pitch * 3 / 2` bytes.
/// `src` and `dst` must not alias.
#[allow(clippy::too_many_arguments)]
fn convert_packed_bgra_to_nv12(
    src: *const u8,
    src_len: usize,
    src_stride: usize,
    src_w: usize,
    src_h: usize,
    dst: *mut u8,
    dst_pitch: usize,
    enc_w: usize,
    enc_h: usize,
    has_alpha: bool,
) {
    let _ = has_alpha;

    // Y plane
    for y in 0..enc_h {
        for x in 0..enc_w {
            let luma = if y < src_h && x < src_w {
                let off = y * src_stride + x * 4;
                if off + 2 < src_len {
                    let b = unsafe { *src.add(off) } as i32;
                    let g = unsafe { *src.add(off + 1) } as i32;
                    let r = unsafe { *src.add(off + 2) } as i32;
                    (16 + ((47 * r + 157 * g + 16 * b + 128) >> 8)).clamp(16, 235) as u8
                } else {
                    16u8
                }
            } else {
                16u8
            };
            unsafe { *dst.add(y * dst_pitch + x) = luma; }
        }
    }

    // UV plane — interleaved NV12, half resolution, 2×2 block averaging
    let chroma_base = enc_h * dst_pitch;
    let chroma_h = enc_h / 2;
    let chroma_w = enc_w / 2;
    for cy in 0..chroma_h {
        for cx in 0..chroma_w {
            let mut r_sum: i32 = 0;
            let mut g_sum: i32 = 0;
            let mut b_sum: i32 = 0;
            let mut count: i32 = 0;

            for dy in 0..2usize {
                for dx in 0..2usize {
                    let sy = cy * 2 + dy;
                    let sx = cx * 2 + dx;
                    if sy < src_h && sx < src_w {
                        let off = sy * src_stride + sx * 4;
                        if off + 2 < src_len {
                            b_sum += unsafe { *src.add(off) } as i32;
                            g_sum += unsafe { *src.add(off + 1) } as i32;
                            r_sum += unsafe { *src.add(off + 2) } as i32;
                            count += 1;
                        }
                    }
                }
            }

            let (u, v) = if count > 0 {
                let r = r_sum / count;
                let g = g_sum / count;
                let b = b_sum / count;
                (
                    (128 + ((-26 * r - 87 * g + 112 * b + 128) >> 8)).clamp(16, 240) as u8,
                    (128 + ((112 * r - 102 * g - 10 * b + 128) >> 8)).clamp(16, 240) as u8,
                )
            } else {
                (128u8, 128u8)
            };

            unsafe {
                *dst.add(chroma_base + cy * dst_pitch + cx * 2) = u;
                *dst.add(chroma_base + cy * dst_pitch + cx * 2 + 1) = v;
            }
        }
    }
}

// ── Active encode session state ───────────────────────────────────────────────

struct EncodeSession {
    /// Loaded libraries kept alive for the lifetime of the session.
    /// Option because the D3D11 path does not load CUDA; None = skip drop.
    _cuda_lib: Option<Library>,
    _nvenc_lib: Library,

    cuda_ctx: CUcontext,
    /// None on the D3D11 path (no CUDA context to destroy).
    cu_ctx_destroy: Option<FnCuCtxDestroy>,

    encoder: *mut c_void,
    fn_list: NV_ENCODE_API_FUNCTION_LIST,

    cfg: EncoderConfig,

    /// Sequence number incremented per drained fragment.
    seq: u64,
    /// Last monotonic real PipeWire PTS in 90 kHz ticks (not a fake accumulator).
    /// Updated each push_frame call; used by next_monotonic_pts to enforce forward progress.
    dts_90k: u64,

    /// SPS and PPS extracted from the first encoder output (IDR frame).
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,

    /// Frames queued for encoding but not yet drained.
    pending_frames: Vec<PendingFrame>,

    /// Width / height actually configured in the encoder (aligned).
    enc_width: u32,
    enc_height: u32,

    /// IDR cadence in frames. Derived from `fps * cfg.gop_seconds`, clamped to
    /// `>= 1`. ISS-005 phase 1: `push_frame` ORs `NV_ENC_PIC_FLAG_FORCEIDR` into
    /// `encodePicFlags` whenever `frame_count % gop_size == 0` so NVENC emits
    /// real periodic IDRs instead of a session-start-only IDR.
    gop_size: u32,

    /// Count of frames submitted to NVENC. Drives only the FORCEIDR cadence;
    /// independent of `seq` (drained fragments) and `dts_90k` (90 kHz wall-time).
    frame_count: u64,

    /// Per-GOP XR24/AR24→NV12 conversion timing (ISS-020 instrumentation).
    conv_total_us: u64,
    conv_max_us: u64,
    conv_gop_frames: u32,
}

struct PendingFrame {
    input_buf: *mut c_void,   // NV_ENC_INPUT_PTR
    output_buf: *mut c_void,  // NV_ENC_OUTPUT_PTR
    pts_90k: u64,
    duration_90k: u32,
}

// ── NVENC structures needed for configure / push_frame / drain ────────────────

/// NV_ENC_PIC_STRUCT
const NV_ENC_PIC_STRUCT_FRAME: u32 = 1;

/// NV_ENC_PIC_FLAGS — see SDK 12.x `nvEncodeAPI.h`.
const NV_ENC_PIC_FLAG_FORCEIDR: u32 = 0x2;

/// NV_ENC_CODEC_H264_GUID — bytes confirmed via nvEncGetEncodeGUIDs at runtime
/// (driver 595.71.05 / RTX 4080 SUPER).
const NV_ENC_CODEC_H264_GUID: [u8; 16] = [
    0x62, 0x27, 0xc8, 0x6b, 0x63, 0x4e, 0xa4, 0x4c,
    0xaa, 0x85, 0x1e, 0x50, 0xf3, 0x21, 0xf6, 0xbf,
];

/// NV_ENC_PRESET_P4_GUID (latency-tolerant quality) — bytes confirmed via
/// nvEncGetEncodePresetGUIDs at runtime (driver 595.71.05 / RTX 4080 SUPER).
const NV_ENC_PRESET_P4_GUID: [u8; 16] = [
    0x26, 0xb8, 0xa7, 0x90, 0x06, 0xdf, 0x62, 0x48,
    0xb9, 0xd2, 0xcd, 0x6d, 0x73, 0xa0, 0x86, 0x81,
];

// The NVENC API types below are sized per SDK 12.1 NvEncodeAPI.h.

/// NV_ENC_INITIALIZE_PARAMS — core session config (SDK 12.1 layout).
///
/// The SDK packs the following ten bit-field members into a *single* `uint32_t`
/// word immediately after `enablePTD`:
///
/// ```text
///   bit 0  : reportSliceOffsets       (1)
///   bit 1  : enableSubFrameWrite      (1)
///   bit 2  : enableExternalMEHints    (1)
///   bit 3  : enableMEOnlyMode         (1)
///   bit 4  : enableWeightedPrediction (1)
///   bit 5  : enableOutputInVidmem     (1)
///   bits 6-31 : reservedBitFields     (26)
/// ```
///
/// Rust does not expose C bit fields, so the whole word is represented as a
/// single `flags: u32`.  Setting individual flags is done by OR-ing the
/// corresponding bit value in `configure()`; zero-init means "all disabled".
///
/// Note: SDK 13+ extends this bit field with `splitEncodeMode (4 bits)`,
/// `enableReconFrameOutput (1)`, and `enableOutputStats (1)`; the file comment
/// in `ffi.rs` and this struct target SDK 12.1, so those bits remain inside
/// the SDK-12.1 `reservedBitFields:26` slot and are not exposed here.
///
/// `maxMEHintCountsPerBlockRow` is two `NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKROW`
/// structs of 4 × `u32` each (16 bytes/element).  We don't use ME hints, so
/// this is declared as `[u32; 8]` and zero-initialised.
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
    /// Packed bit field — see struct doc above.  Bit 0 = reportSliceOffsets,
    /// bit 1 = enableSubFrameWrite, bit 2 = enableExternalMEHints,
    /// bit 3 = enableMEOnlyMode, bit 4 = enableWeightedPrediction,
    /// bit 5 = enableOutputInVidmem, bits 6-31 = reservedBitFields.
    flags: u32,
    privDataSize: u32,
    privData: *mut c_void,
    encodeConfig: *mut c_void, // NV_ENC_CONFIG*
    maxEncodeWidth: u32,
    maxEncodeHeight: u32,
    maxMEHintCountsPerBlockRow: [u32; 8],
    tuningInfo: u32,   // NV_ENC_TUNING_INFO
    bufferFormat: u32, // NV_ENC_BUFFER_FORMAT
    reserved1: [u32; 287],
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
    bufferFmt: u32,       // NV_ENC_BUFFER_FORMAT — added in SDK 12.x
    pictureStruct: u32,
    pictureType: u32, // NV_ENC_PIC_TYPE — 0 = auto
    codecPicParams: [u8; 1024], // NV_ENC_CODEC_PIC_PARAMS union: uint32_t reserved[256] = 1024 bytes
    meHintCountsPerBlock: [u8; 32], // NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE[2]: 16 bytes each
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
    flags: u32,           // doNotWait:1 | ltrFrame:1 | getRCStats:1 | reserved:29
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

// Version macros for the encode-path structs live in `ffi.rs` (centralised via
// `nvencapi_struct_version()`); they are pulled in via `use ffi::*` above.

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

type FnNvEncLockInputBuffer = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_LOCK_INPUT_BUFFER,
) -> NVENCSTATUS;

type FnNvEncUnlockInputBuffer = unsafe extern "C" fn(
    encoder: *mut c_void,
    buf: *mut c_void,
) -> NVENCSTATUS;

// ── Compile-time layout guards (SDK 12.1 on x86-64 Linux) ────────────────────
const _: () = assert!(std::mem::size_of::<NV_ENC_INITIALIZE_PARAMS>() == 1808);
const _: () = assert!(std::mem::size_of::<NV_ENC_CREATE_INPUT_BUFFER>() == 776);
const _: () = assert!(std::mem::size_of::<NV_ENC_CREATE_BITSTREAM_BUFFER>() == 776);
const _: () = assert!(std::mem::size_of::<NV_ENC_PIC_PARAMS>() == 2832);
const _: () = assert!(std::mem::size_of::<NV_ENC_LOCK_BITSTREAM>() == 1544);

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

#[cfg(unix)]
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
                        accepts_d3d11: false,
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
        // Use nominal_fps_num so a variable-rate PipeWire stream (fps_num=0) configures
        // NVENC at 60/1 instead of 1/1, giving a correct GOP size and rate hint.
        let fps_num = nominal_fps_num(cfg.format.fps_num);
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
        init_params.tuningInfo = NV_ENC_TUNING_INFO_LOW_LATENCY;
        // bufferFormat is documented as DX12-only in SDK 12.1; leave as 0 for CUDA sessions.

        let init_status = unsafe { init_fn(encoder, &mut init_params) };
        if init_status != NV_ENC_SUCCESS {
            if let Some(destroy) = fn_list.nvEncDestroyEncoder {
                unsafe { destroy(encoder) };
            }
            unsafe { cu_ctx_destroy(cuda_ctx) };
            return Err(EncoderError::Runtime(format!("nvenc-init-failed:{init_status}")));
        }

        self.session = Some(Box::new(EncodeSession {
            _cuda_lib: Some(cuda_lib),
            _nvenc_lib: nvenc_lib,
            cuda_ctx,
            cu_ctx_destroy: Some(cu_ctx_destroy),
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
            gop_size: gop_size.max(1),
            frame_count: 0,
            conv_total_us: 0,
            conv_max_us: 0,
            conv_gop_frames: 0,
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

        let (shm_ptr, shm_size, stride, incoming_width, incoming_height, incoming_format) = match &frame.payload {
            crate::capture::FramePayload::Shm { data, width, height, format, stride } => {
                (data.as_ptr(), data.len(), *stride, *width, *height, *format)
            }
            #[cfg(unix)]
            crate::capture::FramePayload::DmaBuf { .. } => {
                return Err(EncoderError::Runtime("DMA-BUF not implemented in NVENC backend yet".into()));
            }
            #[cfg(windows)]
            crate::capture::FramePayload::D3D11Texture { .. } => {
                return Err(EncoderError::Runtime("D3D11Texture requires DX11 interop path (T-053)".into()));
            }
        };

        let nvenc_fmt = match incoming_format {
            DRM_FORMAT_XR24 | DRM_FORMAT_AR24 => NV_ENC_BUFFER_FORMAT_ARGB,
            _ => NV_ENC_BUFFER_FORMAT_NV12,
        };

        // Allocate an input buffer.
        let create_input_buf: FnNvEncCreateInputBuffer = unsafe {
            std::mem::transmute(sess.fn_list.nvEncCreateInputBuffer)
        };
        let mut create_in = unsafe { std::mem::zeroed::<NV_ENC_CREATE_INPUT_BUFFER>() };
        create_in.version = NV_ENC_CREATE_INPUT_BUFFER_VER;
        create_in.width = sess.enc_width;
        create_in.height = sess.enc_height;
        create_in.bufferFmt = nvenc_fmt;
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

        let h = sess.enc_height as usize;
        let w = sess.enc_width as usize;
        let pitch = locked_pitch as usize;
        let frame_stride = stride as usize;

        let copy_path = match incoming_format {
            DRM_FORMAT_XR24 | DRM_FORMAT_AR24 => "direct-argb",
            _ => "copy",
        };
        let nvenc_buf_fmt_str = if nvenc_fmt == NV_ENC_BUFFER_FORMAT_ARGB { "ARGB" } else { "NV12" };

        if sess.frame_count == 0 {
            info!(
                seq = frame.seq,
                frame_count = sess.frame_count,
                incoming_fourcc = %drm_fourcc_to_str(incoming_format),
                configured_fourcc = %sess.cfg.format.fourcc,
                nvenc_buffer_fmt = %nvenc_buf_fmt_str,
                path = copy_path,
                src_width = incoming_width,
                src_height = incoming_height,
                enc_width = sess.enc_width,
                enc_height = sess.enc_height,
                frame_stride,
                locked_pitch,
                shm_size,
                expected_nv12_bytes = frame_stride * (incoming_height as usize) * 3 / 2,
                expected_packed_bytes = frame_stride * (incoming_height as usize),
                stride_per_px_x1000 = (frame_stride * 1000) / (incoming_width as usize).max(1),
                "[iss-014][encode-boundary] shm frame",
            );
        } else if sess.frame_count % sess.gop_size as u64 == 0 {
            if sess.conv_gop_frames > 0 {
                let mean_us = sess.conv_total_us / sess.conv_gop_frames as u64;
                warn!(
                    mean_us,
                    max_us = sess.conv_max_us,
                    frame_count = sess.conv_gop_frames,
                    format = %drm_fourcc_to_str(incoming_format),
                    width = incoming_width,
                    height = incoming_height,
                    "[iss-020] argb-copy cost per GOP",
                );
                sess.conv_total_us = 0;
                sess.conv_max_us = 0;
                sess.conv_gop_frames = 0;
            }
            debug!(
                seq = frame.seq,
                frame_count = sess.frame_count,
                incoming_fourcc = %drm_fourcc_to_str(incoming_format),
                configured_fourcc = %sess.cfg.format.fourcc,
                nvenc_buffer_fmt = %nvenc_buf_fmt_str,
                path = copy_path,
                src_width = incoming_width,
                src_height = incoming_height,
                enc_width = sess.enc_width,
                enc_height = sess.enc_height,
                frame_stride,
                locked_pitch,
                shm_size,
                expected_nv12_bytes = frame_stride * (incoming_height as usize) * 3 / 2,
                expected_packed_bytes = frame_stride * (incoming_height as usize),
                stride_per_px_x1000 = (frame_stride * 1000) / (incoming_width as usize).max(1),
                "[iss-014][encode-boundary] shm frame",
            );
        }

        match incoming_format {
            DRM_FORMAT_XR24 | DRM_FORMAT_AR24 => {
                // Direct packed copy: XR24/AR24 [B,G,R,X/A] matches NVENC ARGB buffer layout.
                // Use frame_stride.min(pitch) to avoid over-reading when enc_width is
                // align16-padded beyond incoming_width. Bottom-padding rows are skipped
                // by the shm_size bound (NVENC crops via SPS to the declared encode height).
                let t0 = Instant::now();
                for row in 0..h {
                    let src_off = row * frame_stride;
                    let dst_off = row * pitch;
                    let copy_len = frame_stride.min(pitch).min(if src_off < shm_size { shm_size - src_off } else { 0 });
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
                let us = t0.elapsed().as_micros() as u64;
                sess.conv_total_us += us;
                if us > sess.conv_max_us {
                    sess.conv_max_us = us;
                }
                sess.conv_gop_frames += 1;
            }
            _ => {
                // NV12, P010, and all other formats: existing byte copy (verbatim).
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
        // nominal fps for duration: 60/1 → 1500 ticks; variable-rate PipeWire (fps_num=0)
        // gets 60 fps nominal so duration is realistic even when the stream has no declared rate.
        let fps_num = nominal_fps_num(sess.cfg.format.fps_num);
        let fps_den = sess.cfg.format.fps_den.max(1);
        let duration_90k = ((90_000 * fps_den) / fps_num) as u32;
        // Drive PTS from the real capture timestamp rather than the accumulated fake counter.
        let candidate = ns_to_pts_90k(frame.pts_ns);
        let pts_90k = next_monotonic_pts(candidate, sess.dts_90k);

        // ISS-005 phase 1: force a real periodic IDR every `gop_size` frames so
        // the rolling-buffer commit predicate can fire more than once. The old
        // "first-frame-only" heuristic (`pending_frames.is_empty() && sps.is_none()`)
        // is gone — the actual `is_keyframe` for emitted fragments is derived
        // from the H.264 bitstream in `drain` (nal_counts.idr > 0).
        let is_idr_boundary = sess.frame_count % sess.gop_size as u64 == 0;

        let mut pic_params = unsafe { std::mem::zeroed::<NV_ENC_PIC_PARAMS>() };
        pic_params.version = NV_ENC_PIC_PARAMS_VER;
        pic_params.inputWidth = sess.enc_width;
        pic_params.inputHeight = sess.enc_height;
        pic_params.inputPitch = locked_pitch;
        pic_params.inputBuffer = input_buf;
        pic_params.outputBitstream = output_buf;
        pic_params.bufferFmt = nvenc_fmt;
        pic_params.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
        pic_params.inputTimeStamp = pts_90k;
        if is_idr_boundary {
            pic_params.encodePicFlags |= NV_ENC_PIC_FLAG_FORCEIDR;
        }

        let enc_status = unsafe { encode_pic(sess.encoder, &mut pic_params) };
        if enc_status != NV_ENC_SUCCESS {
            // NV_ENC_ERR_NEED_MORE_INPUT (17) must not occur in the LOW_LATENCY
            // tuning profile since B-frames are disabled.  Any non-success
            // status is fatal here because we have no flush path for delayed
            // output.
            return Err(EncoderError::Runtime(format!("encode-picture-failed:{enc_status}")));
        }

        // The EMITTED `EncodedFragment.is_keyframe` is derived from the
        // bitstream in `drain` (`nal_counts.idr > 0`), so the encoder-side
        // intent (`is_idr_boundary`) does not need to ride along on
        // `PendingFrame`. This keeps the rolling buffer's commit predicate
        // driven by ground truth, not encoder hints.
        sess.pending_frames.push(PendingFrame {
            input_buf,
            output_buf,
            pts_90k,
            duration_90k,
        });
        // Track the last monotonic real PipeWire PTS in 90k ticks so the next
        // frame's next_monotonic_pts call can enforce forward progress.
        sess.dts_90k = pts_90k;
        sess.frame_count += 1;
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
                // input_buf is null for D3D11 frames (texture unmap/unregister already done).
                if !pf.input_buf.is_null() {
                    unsafe { destroy_in(sess.encoder, pf.input_buf) };
                }
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

            // Record NVENC pictureType and scan NAL types in the Annex-B AU.
            // ISS-005 phase 1: `is_keyframe` for emitted fragments is derived
            // from `nal_counts.idr > 0` — ground truth from the actual bitstream,
            // not the encoder-side input intent carried on `PendingFrame`. This
            // is what drives the rolling-buffer commit predicate. `picture_type`
            // remains diagnostic-only.
            let picture_type_raw: u32 = lock_params.pictureType;
            let nal_counts = scan_nal_types(&au_bytes);
            let nal_is_keyframe = nal_counts.idr > 0;

            // Extract SPS/PPS from the first IDR frame if not yet captured.
            if sess.sps.is_none() {
                if let Some((sps, pps)) = extract_sps_pps(&au_bytes) {
                    sess.sps = Some(sps);
                    sess.pps = Some(pps);
                }
            }

            unsafe { unlock_bs(sess.encoder, pf.output_buf) };
            if !pf.input_buf.is_null() {
                unsafe { destroy_in(sess.encoder, pf.input_buf) };
            }
            unsafe { destroy_out(sess.encoder, pf.output_buf) };

            if au_bytes.is_empty() {
                continue;
            }

            sess.seq += 1;
            let frag_bytes = fmp4::build_fragment(
                sess.seq,
                pf.pts_90k,
                pf.duration_90k,
                nal_is_keyframe,
                &au_bytes,
            );

            fragments.push(EncodedFragment {
                seq: sess.seq,
                pts_90k: pf.pts_90k,
                duration_90k: pf.duration_90k,
                is_keyframe: nal_is_keyframe,
                bytes: frag_bytes,
                diagnostics: FragmentDiagnostics {
                    nal_counts,
                    picture_type: picture_type_raw,
                },
            });
        }

        Ok(fragments)
    }

    async fn teardown(&mut self) -> Result<(), EncoderError> {
        if let Some(sess) = self.session.take() {
            if let Some(destroy) = sess.fn_list.nvEncDestroyEncoder {
                unsafe { destroy(sess.encoder) };
            }
            if let Some(destroy_ctx) = sess.cu_ctx_destroy {
                unsafe { destroy_ctx(sess.cuda_ctx) };
            }
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

// ── Windows impl ──────────────────────────────────────────────────────────────

#[cfg(windows)]
#[async_trait]
impl EncoderBackend for NvencBackend {
    fn name(&self) -> &'static str { "nvenc" }
    fn codec(&self) -> &'static str { "h264" }

    async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
        if std::env::var("COVE_NVENC_FORCE_UNAVAILABLE").is_ok() {
            return ProbeOutcome::Unavailable {
                reason: "force-unavailable-by-env".into(),
                details: serde_json::Value::Null,
            };
        }

        // 1. Load nvcuda.dll (CUDA runtime on Windows).
        let cuda_lib = match unsafe { libloading::Library::new("nvcuda.dll") } {
            Ok(l) => l,
            Err(e) => return ProbeOutcome::Unavailable {
                reason: format!("cuda-load-failed:{e}"),
                details: serde_json::Value::Null,
            },
        };

        // 2. Call cuInit to confirm CUDA is initializable.
        let cu_init: libloading::Symbol<unsafe extern "C" fn(u32) -> i32> =
            match unsafe { cuda_lib.get(b"cuInit\0") } {
                Ok(s) => s,
                Err(e) => return ProbeOutcome::Unavailable {
                    reason: format!("cuInit-symbol-missing:{e}"),
                    details: serde_json::Value::Null,
                },
            };
        let status = unsafe { cu_init(0) };
        if status != 0 {
            return ProbeOutcome::Unavailable {
                reason: format!("cuInit-failed:{status}"),
                details: serde_json::Value::Null,
            };
        }

        // 3. Check at least one CUDA device is present.
        let cu_device_get_count: libloading::Symbol<unsafe extern "C" fn(*mut i32) -> i32> =
            match unsafe { cuda_lib.get(b"cuDeviceGetCount\0") } {
                Ok(s) => s,
                Err(_) => return ProbeOutcome::Unavailable {
                    reason: "cuDeviceGetCount-missing".into(),
                    details: serde_json::Value::Null,
                },
            };
        let mut count: i32 = 0;
        if unsafe { cu_device_get_count(&mut count) } != 0 || count == 0 {
            return ProbeOutcome::Unavailable {
                reason: "no-cuda-device".into(),
                details: serde_json::Value::Null,
            };
        }

        // 4. Load nvEncodeAPI64.dll and confirm NvEncodeAPICreateInstance is exported.
        let nvenc_lib = match unsafe { libloading::Library::new("nvEncodeAPI64.dll") } {
            Ok(l) => l,
            Err(e) => return ProbeOutcome::Unavailable {
                reason: format!("nvenc-load-failed:{e}"),
                details: serde_json::Value::Null,
            },
        };
        let _create: libloading::Symbol<ffi::FnNvEncodeAPICreateInstance> =
            match unsafe { nvenc_lib.get(b"NvEncodeAPICreateInstance\0") } {
                Ok(s) => s,
                Err(e) => return ProbeOutcome::Unavailable {
                    reason: format!("NvEncodeAPICreateInstance-missing:{e}"),
                    details: serde_json::Value::Null,
                },
            };

        ProbeOutcome::Available {
            capabilities: crate::encoder::backend::EncoderCapabilities {
                accepts_dmabuf: false,
                accepts_shm: true,
                accepts_d3d11: true,
                supported_codecs: vec!["h264".into()],
            },
            details: serde_json::json!({
                "platform": "windows",
                "accepts_d3d11": true,
            }),
        }
    }

    async fn configure(&mut self, cfg: EncoderConfig) -> Result<(), EncoderError> {
        use crate::encoder::d3d11_device::shared_device;
        use windows::core::Interface as _;

        let d3d = shared_device()
            .map_err(|e| EncoderError::Runtime(format!("d3d11-device-failed:{e}")))?;

        let nvenc_lib = unsafe { Library::new("nvEncodeAPI64.dll") }
            .map_err(|e| EncoderError::Runtime(format!("nvenc-load-failed:{e}")))?;
        let fn_list = load_nvenc(&nvenc_lib)
            .map_err(EncoderError::Runtime)?;

        let open_session = fn_list.nvEncOpenEncodeSessionEx
            .ok_or_else(|| EncoderError::Runtime("null-open-fn".into()))?;

        // Pass the D3D11 device COM pointer; use DIRECTX device type.
        let device_ptr: *mut c_void = d3d.device.as_raw() as *mut c_void;
        let mut params = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
            version: NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER,
            deviceType: NV_ENC_DEVICE_TYPE_DIRECTX,
            device: device_ptr,
            reserved: ptr::null_mut(),
            apiVersion: NVENCAPI_VERSION,
            reserved1: [0u32; 253],
            reserved2: [ptr::null_mut(); 64],
        };

        let mut encoder: *mut c_void = ptr::null_mut();
        let status = unsafe { open_session(&mut params, &mut encoder) };
        if status != NV_ENC_SUCCESS {
            return Err(EncoderError::Runtime(format!("session-create-failed:{status}")));
        }

        let init_fn: FnNvEncInitializeEncoder = unsafe {
            std::mem::transmute(fn_list.nvEncInitializeEncoder)
        };
        let enc_width = align16(cfg.format.width);
        let enc_height = align16(cfg.format.height);
        let fps_num = nominal_fps_num(cfg.format.fps_num);
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
        init_params.tuningInfo = NV_ENC_TUNING_INFO_LOW_LATENCY;

        let init_status = unsafe { init_fn(encoder, &mut init_params) };
        if init_status != NV_ENC_SUCCESS {
            if let Some(destroy) = fn_list.nvEncDestroyEncoder {
                unsafe { destroy(encoder) };
            }
            return Err(EncoderError::Runtime(format!("nvenc-init-failed:{init_status}")));
        }

        self.session = Some(Box::new(EncodeSession {
            _cuda_lib: None,            // D3D11 path: no CUDA
            _nvenc_lib: nvenc_lib,
            cuda_ctx: ptr::null_mut(),
            cu_ctx_destroy: None,       // D3D11 path: no CUDA context to destroy
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
            gop_size: gop_size.max(1),
            frame_count: 0,
            conv_total_us: 0,
            conv_max_us: 0,
            conv_gop_frames: 0,
        }));
        Ok(())
    }

    async fn push_frame(&mut self, frame: FrameHandle) -> Result<(), EncoderError> {
        match &frame.payload {
            crate::capture::FramePayload::D3D11Texture {
                texture_ptr, width: _, height: _, dxgi_format, subresource,
            } => {
                self.push_frame_d3d11(*texture_ptr, *dxgi_format, *subresource, &frame)
            }
            crate::capture::FramePayload::Shm { .. } => {
                Err(EncoderError::NotImplementedYet("nvenc-windows-shm-path".into()))
            }
        }
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

            let picture_type_raw: u32 = lock_params.pictureType;
            let nal_counts = scan_nal_types(&au_bytes);
            let nal_is_keyframe = nal_counts.idr > 0;

            if sess.sps.is_none() {
                if let Some((sps, pps)) = extract_sps_pps(&au_bytes) {
                    sess.sps = Some(sps);
                    sess.pps = Some(pps);
                }
            }

            unsafe { unlock_bs(sess.encoder, pf.output_buf) };
            unsafe { destroy_out(sess.encoder, pf.output_buf) };

            if au_bytes.is_empty() {
                continue;
            }

            sess.seq += 1;
            let frag_bytes = fmp4::build_fragment(
                sess.seq,
                pf.pts_90k,
                pf.duration_90k,
                nal_is_keyframe,
                &au_bytes,
            );

            fragments.push(EncodedFragment {
                seq: sess.seq,
                pts_90k: pf.pts_90k,
                duration_90k: pf.duration_90k,
                is_keyframe: nal_is_keyframe,
                bytes: frag_bytes,
                diagnostics: FragmentDiagnostics {
                    nal_counts,
                    picture_type: picture_type_raw,
                },
            });
        }

        Ok(fragments)
    }

    async fn teardown(&mut self) -> Result<(), EncoderError> {
        if let Some(sess) = self.session.take() {
            if let Some(destroy) = sess.fn_list.nvEncDestroyEncoder {
                unsafe { destroy(sess.encoder) };
            }
            // cu_ctx_destroy is None on the D3D11 path; no CUDA context to clean up.
        }
        Ok(())
    }
}

// ── D3D11 zero-copy push helper ────────────────────────────────────────────────

#[cfg(windows)]
impl NvencBackend {
    /// Register, map, encode, unmap, and unregister one D3D11 texture.
    ///
    /// The input texture is NOT owned by NVENC; we borrow it for one frame submission.
    /// After `nvEncEncodePicture` returns the GPU has ingested the surface data, so it is
    /// safe to unmap/unregister immediately.  The output bitstream buffer is kept alive
    /// in `pending_frames` for `drain()` to retrieve.
    fn push_frame_d3d11(
        &mut self,
        texture_ptr: *mut c_void,
        dxgi_format: u32,
        subresource: u32,
        frame: &FrameHandle,
    ) -> Result<(), EncoderError> {
        let sess = self.session.as_mut()
            .ok_or_else(|| EncoderError::Runtime("push_frame before configure".into()))?;

        let register_fn: FnNvEncRegisterResource = unsafe {
            std::mem::transmute(sess.fn_list.nvEncRegisterResource)
        };
        let unregister_fn: FnNvEncUnregisterResource = unsafe {
            std::mem::transmute(sess.fn_list.nvEncUnregisterResource)
        };
        let map_fn: FnNvEncMapInputResource = unsafe {
            std::mem::transmute(sess.fn_list.nvEncMapInputResource)
        };
        let unmap_fn: FnNvEncUnmapInputResource = unsafe {
            std::mem::transmute(sess.fn_list.nvEncUnmapInputResource)
        };

        // DXGI_FORMAT_B8G8R8A8_UNORM = 87 maps to NV_ENC_BUFFER_FORMAT_ARGB.
        // All other formats fall back to NV12 (encoder performs CSC internally).
        let buf_fmt: NV_ENC_BUFFER_FORMAT = if dxgi_format == 87 {
            NV_ENC_BUFFER_FORMAT_ARGB
        } else {
            NV_ENC_BUFFER_FORMAT_NV12
        };

        // 1. Register the D3D11 texture as an NVENC input resource.
        let mut reg = NV_ENC_REGISTER_RESOURCE {
            version: NV_ENC_REGISTER_RESOURCE_VER,
            resourceType: NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX,
            width: sess.enc_width,
            height: sess.enc_height,
            pitch: 0,
            subResourceIndex: subresource,
            resourceToRegister: texture_ptr,
            registeredResource: ptr::null_mut(),
            bufferFormat: buf_fmt,
            bufferUsage: NV_ENC_INPUT_IMAGE,
            reserved1: [0u32; 247],
            reserved2: [ptr::null_mut(); 59],
        };
        let reg_status = unsafe { register_fn(sess.encoder, &mut reg) };
        if reg_status != NV_ENC_SUCCESS {
            return Err(EncoderError::Runtime(
                format!("nvenc-register-resource-failed:{reg_status}")
            ));
        }
        let registered = reg.registeredResource;

        // 2. Map the registered resource to get a NV_ENC_INPUT_PTR.
        let mut map_params = NV_ENC_MAP_INPUT_RESOURCE {
            version: NV_ENC_MAP_INPUT_RESOURCE_VER,
            subResourceIndex: 0,
            inputResource: registered,
            mappedResource: ptr::null_mut(),
            mappedBufferFmt: buf_fmt,
            reserved1: [0u32; 251],
            reserved2: [ptr::null_mut(); 64],
        };
        let map_status = unsafe { map_fn(sess.encoder, &mut map_params) };
        if map_status != NV_ENC_SUCCESS {
            unsafe { unregister_fn(sess.encoder, registered) };
            return Err(EncoderError::Runtime(
                format!("nvenc-map-resource-failed:{map_status}")
            ));
        }
        let mapped = map_params.mappedResource;

        // 3. Allocate an output bitstream buffer.
        let create_bs_buf: FnNvEncCreateBitstreamBuffer = unsafe {
            std::mem::transmute(sess.fn_list.nvEncCreateBitstreamBuffer)
        };
        let mut create_out = unsafe { std::mem::zeroed::<NV_ENC_CREATE_BITSTREAM_BUFFER>() };
        create_out.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
        let bs_status = unsafe { create_bs_buf(sess.encoder, &mut create_out) };
        if bs_status != NV_ENC_SUCCESS {
            unsafe { unmap_fn(sess.encoder, mapped) };
            unsafe { unregister_fn(sess.encoder, registered) };
            return Err(EncoderError::Runtime(
                format!("create-bitstream-buffer-failed:{bs_status}")
            ));
        }
        let output_buf = create_out.bitstreamBuffer;

        // 4. Submit the frame to the encoder.
        let encode_pic: FnNvEncEncodePicture = unsafe {
            std::mem::transmute(sess.fn_list.nvEncEncodePicture)
        };
        let fps_num = nominal_fps_num(sess.cfg.format.fps_num);
        let fps_den = sess.cfg.format.fps_den.max(1);
        let duration_90k = ((90_000 * fps_den) / fps_num) as u32;
        let candidate = ns_to_pts_90k(frame.pts_ns);
        let pts_90k = next_monotonic_pts(candidate, sess.dts_90k);
        let is_idr_boundary = sess.frame_count % sess.gop_size as u64 == 0;

        let mut pic_params = unsafe { std::mem::zeroed::<NV_ENC_PIC_PARAMS>() };
        pic_params.version = NV_ENC_PIC_PARAMS_VER;
        pic_params.inputWidth = sess.enc_width;
        pic_params.inputHeight = sess.enc_height;
        pic_params.inputPitch = 0; // pitch derived from registered resource
        pic_params.inputBuffer = mapped;
        pic_params.outputBitstream = output_buf;
        pic_params.bufferFmt = buf_fmt;
        pic_params.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
        pic_params.inputTimeStamp = pts_90k;
        if is_idr_boundary {
            pic_params.encodePicFlags |= NV_ENC_PIC_FLAG_FORCEIDR;
        }

        let enc_status = unsafe { encode_pic(sess.encoder, &mut pic_params) };

        // 5. Unmap and unregister regardless of encode status (texture is no longer needed).
        unsafe { unmap_fn(sess.encoder, mapped) };
        unsafe { unregister_fn(sess.encoder, registered) };

        if enc_status != NV_ENC_SUCCESS {
            unsafe {
                let destroy_out: FnNvEncDestroyBitstreamBuffer =
                    std::mem::transmute(sess.fn_list.nvEncDestroyBitstreamBuffer);
                destroy_out(sess.encoder, output_buf);
            }
            return Err(EncoderError::Runtime(format!("encode-picture-failed:{enc_status}")));
        }

        // input_buf is null: D3D11 texture was already unregistered above; drain() skips
        // nvEncDestroyInputBuffer for null input_buf.
        sess.pending_frames.push(PendingFrame {
            input_buf: ptr::null_mut(),
            output_buf,
            pts_90k,
            duration_90k,
        });
        sess.dts_90k = pts_90k;
        sess.frame_count += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nominal_fps_num_uses_60_for_variable_rate() {
        assert_eq!(nominal_fps_num(0), 60);
    }

    #[test]
    fn nominal_fps_num_passthrough_for_nonzero() {
        assert_eq!(nominal_fps_num(30), 30);
        assert_eq!(nominal_fps_num(60), 60);
        assert_eq!(nominal_fps_num(120), 120);
    }

    #[test]
    fn ns_to_pts_90k_converts_one_second_to_90000() {
        assert_eq!(ns_to_pts_90k(1_000_000_000), 90_000);
    }

    #[test]
    fn ns_to_pts_90k_clamps_negative_to_zero() {
        assert_eq!(ns_to_pts_90k(-1), 0);
        assert_eq!(ns_to_pts_90k(i64::MIN), 0);
    }

    #[test]
    fn next_monotonic_pts_accepts_forward_candidate() {
        assert_eq!(next_monotonic_pts(1000, 500), 1000);
        assert_eq!(next_monotonic_pts(1, 0), 1);
    }

    #[test]
    fn next_monotonic_pts_advances_when_candidate_repeats_or_goes_backward() {
        // Same as last → advance by 1
        assert_eq!(next_monotonic_pts(500, 500), 501);
        // Behind last → advance by 1
        assert_eq!(next_monotonic_pts(100, 500), 501);
        // Saturating on u64::MAX
        assert_eq!(next_monotonic_pts(0, u64::MAX), u64::MAX);
    }

    #[test]
    fn variable_rate_produces_correct_duration_and_pts_from_ns() {
        // fps_num=0, fps_den=1 → nominal 60/1 → duration_90k = 90000*1/60 = 1500
        let fps_num = nominal_fps_num(0);
        let fps_den = 1u32;
        let duration_90k = (90_000 * fps_den / fps_num) as u32;
        assert_eq!(duration_90k, 1500);

        // Two frames 16.667 ms apart → ~1500 ticks apart
        let pts0 = ns_to_pts_90k(0);
        let pts1 = ns_to_pts_90k(16_666_667);
        // First frame: candidate == last (both 0) → monotonic enforcer bumps to 1
        let r0 = next_monotonic_pts(pts0, 0);
        assert_eq!(r0, 1);
        // 16.667 ms ≈ 1499–1500 ticks (integer division)
        assert!(pts1 >= 1499 && pts1 <= 1501, "pts1={pts1}");
    }

    // ── convert_packed_bgra_to_nv12 tests ────────────────────────────────────

    fn make_bgrx(pixels: &[(u8, u8, u8)], w: usize, stride: usize) -> Vec<u8> {
        let h = pixels.len() / w;
        let mut buf = vec![0u8; h * stride];
        for (i, &(b, g, r)) in pixels.iter().enumerate() {
            let y = i / w;
            let x = i % w;
            let off = y * stride + x * 4;
            buf[off] = b;
            buf[off + 1] = g;
            buf[off + 2] = r;
            buf[off + 3] = 0; // X
        }
        buf
    }

    fn run_convert(src: &[u8], src_stride: usize, src_w: usize, src_h: usize,
                   enc_w: usize, enc_h: usize, dst_pitch: usize) -> Vec<u8> {
        let dst_size = enc_h * dst_pitch + (enc_h / 2) * dst_pitch;
        let mut dst = vec![0xFFu8; dst_size];
        convert_packed_bgra_to_nv12(
            src.as_ptr(), src.len(), src_stride,
            src_w, src_h,
            dst.as_mut_ptr(), dst_pitch,
            enc_w, enc_h,
            false,
        );
        dst
    }

    #[test]
    fn convert_white_yields_y235() {
        let src = make_bgrx(&[(255,255,255); 4], 2, 8);
        let dst = run_convert(&src, 8, 2, 2, 2, 2, 2);
        for i in 0..4 { assert_eq!(dst[i], 235, "Y[{i}]"); }
        assert!((dst[4] as i32 - 128).unsigned_abs() <= 1, "U={}", dst[4]);
        assert!((dst[5] as i32 - 128).unsigned_abs() <= 1, "V={}", dst[5]);
    }

    #[test]
    fn convert_black_yields_y16() {
        let src = make_bgrx(&[(0,0,0); 4], 2, 8);
        let dst = run_convert(&src, 8, 2, 2, 2, 2, 2);
        for i in 0..4 { assert_eq!(dst[i], 16, "Y[{i}]"); }
        assert_eq!(dst[4], 128, "U");
        assert_eq!(dst[5], 128, "V");
    }

    #[test]
    fn convert_pure_red() {
        // B=0, G=0, R=255
        let src = make_bgrx(&[(0,0,255); 4], 2, 8);
        let dst = run_convert(&src, 8, 2, 2, 2, 2, 2);
        let y_expected = 16 + ((47 * 255 + 128) >> 8); // 63
        for i in 0..4 {
            assert!((dst[i] as i32 - y_expected).unsigned_abs() <= 1, "Y[{i}]={} expected {y_expected}", dst[i]);
        }
        let u_expected = 128 + ((-26 * 255 + 128) >> 8); // 102
        let v_expected = 128 + ((112 * 255 + 128) >> 8); // 240
        assert!((dst[4] as i32 - u_expected).unsigned_abs() <= 1, "U={} expected {u_expected}", dst[4]);
        assert!((dst[5] as i32 - v_expected).unsigned_abs() <= 1, "V={} expected {v_expected}", dst[5]);
    }

    #[test]
    fn convert_pure_green() {
        // B=0, G=255, R=0
        let src = make_bgrx(&[(0,255,0); 4], 2, 8);
        let dst = run_convert(&src, 8, 2, 2, 2, 2, 2);
        let y_expected = 16 + ((157 * 255 + 128) >> 8); // 172
        for i in 0..4 {
            assert!((dst[i] as i32 - y_expected).unsigned_abs() <= 1, "Y[{i}]={} expected {y_expected}", dst[i]);
        }
        let u_expected = 128 + ((-87 * 255 + 128) >> 8); // 41
        let v_expected = 128 + ((-102 * 255 + 128) >> 8); // 26
        assert!((dst[4] as i32 - u_expected).unsigned_abs() <= 1, "U={} expected {u_expected}", dst[4]);
        assert!((dst[5] as i32 - v_expected).unsigned_abs() <= 1, "V={} expected {v_expected}", dst[5]);
    }

    #[test]
    fn convert_pure_blue() {
        // B=255, G=0, R=0
        let src = make_bgrx(&[(255,0,0); 4], 2, 8);
        let dst = run_convert(&src, 8, 2, 2, 2, 2, 2);
        let y_expected = 16 + ((16 * 255 + 128) >> 8); // 32
        for i in 0..4 {
            assert!((dst[i] as i32 - y_expected).unsigned_abs() <= 1, "Y[{i}]={} expected {y_expected}", dst[i]);
        }
        let u_expected = 128 + ((112 * 255 + 128) >> 8); // 240
        let v_expected = 128 + ((-10 * 255 + 128) >> 8); // 118
        assert!((dst[4] as i32 - u_expected).unsigned_abs() <= 1, "U={} expected {u_expected}", dst[4]);
        assert!((dst[5] as i32 - v_expected).unsigned_abs() <= 1, "V={} expected {v_expected}", dst[5]);
    }

    #[test]
    fn convert_padded_stride() {
        // 2px wide, but stride=16 (extra padding bytes after each row)
        let stride = 16;
        let mut src = vec![0u8; 2 * stride]; // 2 rows
        // Row 0: white, white + padding
        for x in 0..2 {
            let off = x * 4;
            src[off] = 255; src[off+1] = 255; src[off+2] = 255;
        }
        // Row 1: white, white + padding
        for x in 0..2 {
            let off = stride + x * 4;
            src[off] = 255; src[off+1] = 255; src[off+2] = 255;
        }
        let dst = run_convert(&src, stride, 2, 2, 2, 2, 2);
        for i in 0..4 { assert_eq!(dst[i], 235, "Y[{i}]"); }
    }

    #[test]
    fn convert_enc_larger_than_src_pads() {
        // src=2×2, enc=4×4 → extra pixels padded with Y=16, UV=128
        let src = make_bgrx(&[(255,255,255); 4], 2, 8);
        let enc_w = 4;
        let enc_h = 4;
        let pitch = 4;
        let dst = run_convert(&src, 8, 2, 2, enc_w, enc_h, pitch);
        // Source pixels → Y=235
        assert_eq!(dst[0 * pitch + 0], 235);
        assert_eq!(dst[0 * pitch + 1], 235);
        assert_eq!(dst[1 * pitch + 0], 235);
        assert_eq!(dst[1 * pitch + 1], 235);
        // Padding pixels → Y=16
        assert_eq!(dst[0 * pitch + 2], 16);
        assert_eq!(dst[0 * pitch + 3], 16);
        assert_eq!(dst[2 * pitch + 0], 16);
        assert_eq!(dst[3 * pitch + 3], 16);
        // UV padding: chroma_base = 4*4 = 16, block (1,0) and (1,1) are out of src
        let cb = enc_h * pitch;
        // Block (0,0) covers src pixels → U/V from white (±1 rounding)
        assert!((dst[cb] as i32 - 128).unsigned_abs() <= 1, "U(0,0)={}", dst[cb]);
        assert!((dst[cb + 1] as i32 - 128).unsigned_abs() <= 1, "V(0,0)={}", dst[cb + 1]);
        // Block (1,0) is fully outside src → padded 128
        assert_eq!(dst[cb + 2], 128, "U(1,0)");
        assert_eq!(dst[cb + 3], 128, "V(1,0)");
        // Block (0,1) row 1 of chroma
        assert_eq!(dst[cb + pitch], 128, "U(0,1)");
        assert_eq!(dst[cb + pitch + 1], 128, "V(0,1)");
    }

    #[test]
    fn convert_checkerboard_2x2_averaging() {
        // 2×2: top-left=red, top-right=green, bottom-left=blue, bottom-right=white
        // B,G,R
        let src = make_bgrx(&[
            (0,0,255),   (0,255,0),
            (255,0,0),   (255,255,255),
        ], 2, 8);
        let dst = run_convert(&src, 8, 2, 2, 2, 2, 2);
        // UV should be average of all 4 pixels
        let avg_r = (255 + 0 + 0 + 255) / 4; // 127
        let avg_g = (0 + 255 + 0 + 255) / 4; // 127
        let avg_b = (0 + 0 + 255 + 255) / 4; // 127
        let u_expected = (128 + ((-26 * avg_r - 87 * avg_g + 112 * avg_b + 128) >> 8)).clamp(16, 240);
        let v_expected = (128 + ((112 * avg_r - 102 * avg_g - 10 * avg_b + 128) >> 8)).clamp(16, 240);
        assert!((dst[4] as i32 - u_expected).unsigned_abs() <= 1, "U={} expected {u_expected}", dst[4]);
        assert!((dst[5] as i32 - v_expected).unsigned_abs() <= 1, "V={} expected {v_expected}", dst[5]);
    }

    #[test]
    fn convert_truncated_src_len_no_panic() {
        // src_len truncated so some pixels are unreadable
        let src = make_bgrx(&[(255,255,255); 4], 2, 8);
        // Only give 5 bytes (enough for 1 pixel + partial second)
        let dst = run_convert(&src[..5], 8, 2, 2, 2, 2, 2);
        // First pixel readable → Y=235
        assert_eq!(dst[0], 235);
        // Second pixel at offset 4: off+2=6 >= src_len=5 → Y=16
        assert_eq!(dst[1], 16);
        // Row 1 entirely out of range → Y=16
        assert_eq!(dst[2], 16);
        assert_eq!(dst[3], 16);
    }

    #[test]
    fn convert_zero_src_dims_no_panic() {
        let src: Vec<u8> = vec![];
        let dst = run_convert(&src, 0, 0, 0, 2, 2, 2);
        // All padding
        for i in 0..4 { assert_eq!(dst[i], 16, "Y[{i}]"); }
        assert_eq!(dst[4], 128, "U");
        assert_eq!(dst[5], 128, "V");
    }

    #[test]
    fn drm_fourcc_constants_match_expected() {
        assert_eq!(drm_fourcc_to_str(DRM_FORMAT_XR24), "XR24");
        assert_eq!(drm_fourcc_to_str(DRM_FORMAT_AR24), "AR24");
        assert_eq!(drm_fourcc_to_str(DRM_FORMAT_NV12), "NV12");
    }
}
