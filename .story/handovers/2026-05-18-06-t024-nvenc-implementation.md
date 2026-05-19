# T-024 / ISS-002 — Real NVENC Backend Implementation

Date: 2026-05-18

## What was done

Implemented a real NVENC H.264 encoder backend, replacing the `not-implemented-yet` stub. This resolves ISS-002 (VAL-CAP-004 gate failure) and satisfies T-017a requirements.

## Files changed

| File | Change |
|---|---|
| `helper/Cargo.toml` | Added `libloading = "0.8"` |
| `helper/src/encoder/backends/nvenc.rs` | **Deleted** (replaced by directory module) |
| `helper/src/encoder/backends/nvenc/mod.rs` | **New** — real NVENC backend (probe + configure + push_frame + drain + teardown) |
| `helper/src/encoder/backends/nvenc/ffi.rs` | **New** — CUDA + NvEncodeAPI FFI types (libloading, NV_ENCODE_API_FUNCTION_LIST) |
| `helper/src/encoder/backends/nvenc/fmp4.rs` | **New** — inline ISOBMFF writer: ftyp+moov init segment, moof+mdat per fragment |
| `helper/tests/encoder_selection.rs` | Replaced T-017a marker test with env-flag test + hardware-gated available test |
| `helper/tests/encoder_session.rs` | Added `nvenc_one_frame_shm_encode_produces_fmp4_fragment` integration test |

## Architecture

```
NvencBackend
├── probe()        → cuInit → cuDeviceGetCount → NvEncodeAPICreateInstance → nvEncOpenEncodeSessionEx (destroy immediately)
├── configure()    → real session, nvEncInitializeEncoder H.264 CBR
├── push_frame()   → SHM memcpy into NVENC input buffer → nvEncEncodePicture
├── drain()        → nvEncLockBitstream → fmp4::build_fragment (moof+mdat) → EncodedFragment
├── init_segment() → fmp4::build_init_segment (ftyp+moov with SPS/PPS from first IDR)
└── teardown()     → nvEncDestroyEncoder → cuCtxDestroy
```

- Libraries loaded at runtime via `libloading` — no link-time dependency on CUDA or NVENC SDK
- `COVE_NVENC_FORCE_UNAVAILABLE=1` env var bypasses hardware probe for CI/test isolation
- DMA-BUF input deferred to follow-up ticket
- `encoder.selected` schema in `mod.rs::run_session` unchanged

## Probe outcome reasons

| Reason | Meaning |
|---|---|
| `no-cuda-driver` | `libcuda.so.1` not found |
| `cuinit-failed:N` | `cuInit()` returned code N |
| `no-cuda-device` | `cuDeviceGetCount()` returned 0 |
| `no-nvenc-library` | `libnvidia-encode.so.1` not found |
| `nvenc-api-create-failed:N` | `NvEncodeAPICreateInstance` returned code N |
| `session-create-failed:N` | `nvEncOpenEncodeSessionEx` returned code N |
| `force-unavailable-by-env` | `COVE_NVENC_FORCE_UNAVAILABLE=1` set |

## Test results

139 tests, 0 failures.  
`nvenc_probe_available_when_hardware_present` — passed on real hardware (NVIDIA Driver 595.71.05, CUDA 13.2).  
`nvenc_one_frame_shm_encode_produces_fmp4_fragment` — passed: drain returned 1 fragment with `moof` box.

## What remains (not in scope for T-024)

- x264 backend (`not-implemented-yet` unchanged)
- DMA-BUF zero-copy input path for NVENC
- NVENC HEVC codec support
- T-021 green verdict / T-010c gate — unblocked, can now run
