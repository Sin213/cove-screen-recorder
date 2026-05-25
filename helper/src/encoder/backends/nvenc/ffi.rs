//! Minimal CUDA and NvEncodeAPI FFI bindings via libloading.
//!
//! Only the symbols used by the probe + encode path are declared here.  All
//! types are sized per NVIDIA Video Codec SDK 12.1 headers.

#![allow(non_camel_case_types, non_snake_case, dead_code)]

use std::ffi::c_void;

// ── CUDA ─────────────────────────────────────────────────────────────────────

pub type CUresult = i32;
pub type CUdevice = i32;
pub type CUcontext = *mut c_void;

pub const CUDA_SUCCESS: CUresult = 0;

pub type FnCuInit = unsafe extern "C" fn(flags: u32) -> CUresult;
pub type FnCuDeviceGetCount = unsafe extern "C" fn(count: *mut i32) -> CUresult;
pub type FnCuDeviceGet = unsafe extern "C" fn(device: *mut CUdevice, ordinal: i32) -> CUresult;
pub type FnCuCtxCreate = unsafe extern "C" fn(
    pctx: *mut CUcontext,
    flags: u32,
    dev: CUdevice,
) -> CUresult;
pub type FnCuCtxDestroy = unsafe extern "C" fn(ctx: CUcontext) -> CUresult;

// ── NvEncodeAPI ──────────────────────────────────────────────────────────────

/// Windows GUID as a flat 16-byte array (matches the in-memory layout the NVENC
/// runtime fills when returning codec/preset GUIDs).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GUID {
    pub data: [u8; 16],
}

impl GUID {
    pub fn from_bytes(b: [u8; 16]) -> Self { Self { data: b } }
}

/// NvEncodeAPI version for SDK 12.1.
pub const NVENCAPI_VERSION: u32 = 12 | (1 << 24);

/// Compute the NVENCAPI struct version word for a struct of version `ver`.
///
/// Matches the SDK 12.1 NVENCAPI_STRUCT_VERSION macro:
///     NVENCAPI_VERSION | (ver << 16) | (0x7 << 28)
///
/// The `0x7 << 28` magic tag is required by the NVIDIA runtime; omitting it
/// causes NvEncodeAPICreateInstance / nvEncOpenEncodeSessionEx to reject
/// the struct with NV_ENC_ERR_INVALID_VERSION (15).
pub const fn nvencapi_struct_version(ver: u32) -> u32 {
    NVENCAPI_VERSION | (ver << 16) | (0x7u32 << 28)
}

/// Status codes returned by NvEncode functions (NV_ENC_STATUS).
pub type NVENCSTATUS = i32;
pub const NV_ENC_SUCCESS: NVENCSTATUS = 0;
pub const NV_ENC_ERR_INVALID_VERSION: NVENCSTATUS = 15;

pub type NV_ENC_DEVICE_TYPE = u32;
/// SDK 12.1 NV_ENC_DEVICE_TYPE enum: DIRECTX=0, CUDA=1, OPENGL=2, VULKAN=3.
/// We pass a CUDA `CUcontext` in `NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS::device`,
/// so the device-type tag must be `1`.  Passing `2` (OPENGL) makes the runtime
/// reject the session with NV_ENC_ERR_INVALID_DEVICE (4).
pub const NV_ENC_DEVICE_TYPE_CUDA: NV_ENC_DEVICE_TYPE = 1;

/// Parameters for nvEncOpenEncodeSessionEx.
/// Sized per SDK 12.1 NvEncodeAPI.h (version field at struct offset 0).
#[repr(C)]
pub struct NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
    /// Must be set to NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER.
    pub version: u32,
    pub deviceType: NV_ENC_DEVICE_TYPE,
    /// CUcontext cast to *mut c_void.
    pub device: *mut c_void,
    pub reserved: *mut c_void,
    pub apiVersion: u32,
    pub reserved1: [u32; 253],
    pub reserved2: [*mut c_void; 64],
}

/// Version constant for NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS.
///
/// Struct version 1 with the SDK struct-version tag; bit 31 is NOT set for
/// this struct (it is set only on NV_ENCODE_API_FUNCTION_LIST_VER).
/// Expected value: 0x7011000C.
pub const NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER: u32 = nvencapi_struct_version(1);

/// Typed function list returned by NvEncodeAPICreateInstance.
///
/// Only the first two pointers are used by the probe (nvEncOpenEncodeSessionEx
/// + nvEncDestroyEncoder).  The remaining 390+ entries are declared as padding
/// so the struct is exactly the size NVIDIA's runtime expects.
#[repr(C)]
pub struct NV_ENCODE_API_FUNCTION_LIST {
    pub version: u32,
    pub reserved: u32,
    pub nvEncOpenEncodeSession: *mut c_void,
    pub nvEncGetEncodeGUIDCount: Option<
        unsafe extern "C" fn(encoder: *mut c_void, count: *mut u32) -> NVENCSTATUS,
    >,
    pub nvEncGetEncodeProfileGUIDCount: *mut c_void,
    pub nvEncGetEncodeProfileGUIDs: *mut c_void,
    pub nvEncGetEncodeGUIDs: Option<
        unsafe extern "C" fn(
            encoder: *mut c_void,
            guids: *mut GUID,
            guid_array_size: u32,
            guid_count: *mut u32,
        ) -> NVENCSTATUS,
    >,
    pub nvEncGetInputFormatCount: Option<
        unsafe extern "C" fn(encoder: *mut c_void, encodeGUID: GUID, count: *mut u32) -> NVENCSTATUS,
    >,
    pub nvEncGetInputFormats: Option<
        unsafe extern "C" fn(
            encoder: *mut c_void,
            encodeGUID: GUID,
            inputFmts: *mut u32,
            inputFmtArraySize: u32,
            inputFmtCount: *mut u32,
        ) -> NVENCSTATUS,
    >,
    pub nvEncGetEncodeCaps: *mut c_void,
    pub nvEncGetEncodePresetCount: Option<
        unsafe extern "C" fn(encoder: *mut c_void, encodeGUID: GUID, count: *mut u32) -> NVENCSTATUS,
    >,
    pub nvEncGetEncodePresetGUIDs: Option<
        unsafe extern "C" fn(
            encoder: *mut c_void,
            encodeGUID: GUID,
            presetGUIDs: *mut GUID,
            guidArraySize: u32,
            guidCount: *mut u32,
        ) -> NVENCSTATUS,
    >,
    pub nvEncGetEncodePresetConfig: *mut c_void,
    pub nvEncInitializeEncoder: *mut c_void,
    pub nvEncCreateInputBuffer: *mut c_void,
    pub nvEncDestroyInputBuffer: *mut c_void,
    pub nvEncCreateBitstreamBuffer: *mut c_void,
    pub nvEncDestroyBitstreamBuffer: *mut c_void,
    pub nvEncEncodePicture: *mut c_void,
    pub nvEncLockBitstream: *mut c_void,
    pub nvEncUnlockBitstream: *mut c_void,
    pub nvEncLockInputBuffer: *mut c_void,
    pub nvEncUnlockInputBuffer: *mut c_void,
    pub nvEncGetEncodeStats: *mut c_void,
    pub nvEncGetSequenceParams: *mut c_void,
    pub nvEncRegisterAsyncEvent: *mut c_void,
    pub nvEncUnregisterAsyncEvent: *mut c_void,
    pub nvEncMapInputResource: *mut c_void,
    pub nvEncUnmapInputResource: *mut c_void,
    pub nvEncDestroyEncoder: Option<
        unsafe extern "C" fn(encoder: *mut c_void) -> NVENCSTATUS,
    >,
    pub nvEncInvalidateRefFrames: *mut c_void,
    pub nvEncOpenEncodeSessionEx: Option<
        unsafe extern "C" fn(
            params: *mut NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS,
            encoder: *mut *mut c_void,
        ) -> NVENCSTATUS,
    >,
    pub nvEncRegisterResource: *mut c_void,
    pub nvEncUnregisterResource: *mut c_void,
    pub nvEncReconfigureEncoder: *mut c_void,
    pub reserved2: *mut c_void,
    pub nvEncCreateMVBuffer: *mut c_void,
    pub nvEncDestroyMVBuffer: *mut c_void,
    pub nvEncRunMotionEstimationOnly: *mut c_void,
    pub nvEncGetLastErrorString: Option<
        unsafe extern "C" fn(encoder: *mut c_void) -> *const std::ffi::c_char,
    >,
    pub nvEncSetIOCudaStreams: *mut c_void,
    pub nvEncGetEncodePresetConfigEx: *mut c_void,
    pub nvEncGetSequenceParamEx: *mut c_void,
    pub nvEncRestoreEncoderState: *mut c_void,
    pub nvEncLookaheadPicture: *mut c_void,
    pub reserved3: [*mut c_void; 209],
}

/// Version constant for NV_ENCODE_API_FUNCTION_LIST.
///
/// Struct version 2 with the SDK struct-version tag plus the high bit
/// (`1u32 << 31`) that NVENCAPI_STRUCT_VERSION_API marks on this list.
/// Expected value: 0xF012000C.
pub const NV_ENCODE_API_FUNCTION_LIST_VER: u32 =
    nvencapi_struct_version(2) | (1u32 << 31);

pub type FnNvEncodeAPICreateInstance =
    unsafe extern "C" fn(functionList: *mut NV_ENCODE_API_FUNCTION_LIST) -> NVENCSTATUS;

// ── Encode-path struct version constants (SDK 12.1) ──────────────────────────
//
// These mirror the NV_ENC_*_VER macros in NvEncodeAPI.h.  Centralising them in
// ffi.rs alongside `nvencapi_struct_version()` keeps the version-formula bug
// class from recurring as parallel definitions in mod.rs.
//
// Macros that include `(1<<31)` in the SDK retain it here verbatim; the
// remaining macros are bare `NVENCAPI_STRUCT_VERSION(ver)`.

/// `NV_ENC_INITIALIZE_PARAMS_VER` — `NVENCAPI_STRUCT_VERSION(5) | (1<<31)`.
pub const NV_ENC_INITIALIZE_PARAMS_VER: u32 =
    nvencapi_struct_version(5) | (1u32 << 31);

/// `NV_ENC_CREATE_INPUT_BUFFER_VER` — `NVENCAPI_STRUCT_VERSION(1)`.
pub const NV_ENC_CREATE_INPUT_BUFFER_VER: u32 = nvencapi_struct_version(1);

/// `NV_ENC_CREATE_BITSTREAM_BUFFER_VER` — `NVENCAPI_STRUCT_VERSION(1)`.
pub const NV_ENC_CREATE_BITSTREAM_BUFFER_VER: u32 = nvencapi_struct_version(1);

/// `NV_ENC_PIC_PARAMS_VER` — `NVENCAPI_STRUCT_VERSION(4) | (1<<31)`.
pub const NV_ENC_PIC_PARAMS_VER: u32 =
    nvencapi_struct_version(4) | (1u32 << 31);

/// `NV_ENC_LOCK_BITSTREAM_VER` — `NVENCAPI_STRUCT_VERSION(1)`.
pub const NV_ENC_LOCK_BITSTREAM_VER: u32 = nvencapi_struct_version(1);

/// `NV_ENC_LOCK_INPUT_BUFFER_VER` — `NVENCAPI_STRUCT_VERSION(1)`.
pub const NV_ENC_LOCK_INPUT_BUFFER_VER: u32 = nvencapi_struct_version(1);

// ── Encode-path constants (SDK 12.1) ─────────────────────────────────────────

/// `NV_ENC_TUNING_INFO_LOW_LATENCY` — SDK 12.1 enum value 2.
/// Must be set on `NV_ENC_INITIALIZE_PARAMS::tuningInfo`; value 0
/// (NV_ENC_TUNING_INFO_UNDEFINED) causes nvEncInitializeEncoder to return
/// NV_ENC_ERR_UNSUPPORTED_PARAM (12).
pub const NV_ENC_TUNING_INFO_LOW_LATENCY: u32 = 2;

/// `NV_ENC_BUFFER_FORMAT_NV12` — 4:2:0 planar, semi-planar NV12 (0x10).
pub const NV_ENC_BUFFER_FORMAT_NV12: u32 = 0x00000010;

/// `NV_ENC_BUFFER_FORMAT_ARGB` — 32-bit word-ordered A8R8G8B8 (B in byte 0, A in byte 3).
/// Matches XR24/AR24 SHM memory layout; NVENC discards alpha during H.264 encode.
pub const NV_ENC_BUFFER_FORMAT_ARGB: u32 = 0x01000000;

/// `NV_ENC_ERR_NEED_MORE_INPUT` — SDK 12.1 status 17.
/// Returned by nvEncEncodePicture when the encoder is buffering B-frames;
/// not an error, just means no output is ready yet.
pub const NV_ENC_ERR_NEED_MORE_INPUT: NVENCSTATUS = 17;
