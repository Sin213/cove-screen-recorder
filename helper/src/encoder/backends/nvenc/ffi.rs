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

/// NvEncodeAPI version for SDK 12.1.
pub const NVENCAPI_VERSION: u32 = 12 | (1 << 24);

/// Status codes returned by NvEncode functions (NV_ENC_STATUS).
pub type NVENCSTATUS = i32;
pub const NV_ENC_SUCCESS: NVENCSTATUS = 0;
pub const NV_ENC_ERR_INVALID_VERSION: NVENCSTATUS = 7;

pub type NV_ENC_DEVICE_TYPE = u32;
pub const NV_ENC_DEVICE_TYPE_CUDA: NV_ENC_DEVICE_TYPE = 2;

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
pub const NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER: u32 =
    NVENCAPI_VERSION | (1 << 31);

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
    pub nvEncGetEncodeGUIDCount: *mut c_void,
    pub nvEncGetEncodeProfileGUIDCount: *mut c_void,
    pub nvEncGetEncodeProfileGUIDs: *mut c_void,
    pub nvEncGetEncodeGUIDs: *mut c_void,
    pub nvEncGetInputFormatCount: *mut c_void,
    pub nvEncGetInputFormats: *mut c_void,
    pub nvEncGetEncodeCaps: *mut c_void,
    pub nvEncGetEncodePresetCount: *mut c_void,
    pub nvEncGetEncodePresetGUIDs: *mut c_void,
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
    pub nvEncGetLastErrorString: *mut c_void,
    pub nvEncSetIOCudaStreams: *mut c_void,
    pub nvEncGetEncodePresetConfigEx: *mut c_void,
    pub nvEncGetSequenceParamEx: *mut c_void,
    pub nvEncRestoreEncoderState: *mut c_void,
    pub nvEncLookaheadPicture: *mut c_void,
    pub reserved3: [*mut c_void; 209],
}

/// Version constant for NV_ENCODE_API_FUNCTION_LIST.
pub const NV_ENCODE_API_FUNCTION_LIST_VER: u32 = NVENCAPI_VERSION | (2 << 31);

pub type FnNvEncodeAPICreateInstance =
    unsafe extern "C" fn(functionList: *mut NV_ENCODE_API_FUNCTION_LIST) -> NVENCSTATUS;
