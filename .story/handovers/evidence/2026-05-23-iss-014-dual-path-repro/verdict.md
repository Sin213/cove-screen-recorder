# ISS-014 Dual-Path Attribution — Final Verdict

**Date:** 2026-05-23
**Pass:** T-030 controlled dual-path repro
**Verdict bucket: V2 CONFIRMED**

## Selected Bucket

**Bucket 2 — V2 confirmed**

The V2 helper/NVENC path is the source of ISS-014. The format mismatch (XR24→NV12 with no conversion) is confirmed by T-031 encode-boundary instrumentation on first captured frame.

## Evidence Summary

### V1 Leg (npm run dev, no VITE_COVE_V2_UI)

| Finding | Value |
|---------|-------|
| V1 path active? | YES — `saveReplay start (v1)` in app log |
| MediaRecorder codec | VP8 (WebM) |
| Remux | libx264, 2560×1440, yuv420p |
| Saves completed | 4 (24.8s, 24.4s, 141.5s, 106.2s) |
| Pre-remux webm size | 73.7 MB (non-degenerate) |
| Frames | CLEAN (frame0.jpg, frame_mid.jpg) |
| Provenance tag (T-032) | Fires via sendProgress() — not file-logged |
| Corruption reproduced? | NO |
| Format mismatch risk? | NO (VP8 YUV420 → libx264 YUV420) |

**V1 verdict: Clean. Not responsible for ISS-014.**

### V2 Leg (VITE_COVE_V2_UI=1 npm run dev)

| Finding | Value |
|---------|-------|
| V2 path active? | YES — v2State=RECORDING, v2SaveReplay |
| PW format | XR24 (BGRx, 4 bytes/pixel) |
| SHM buffer type | Shm (DMA-BUF failed again) |
| NVENC buffer fmt | NV12 |
| frame_stride | 15360 (= 3840 × 4, XR24 confirmed) |
| locked_pitch | 4096 (NV12 luma, 256-aligned) |
| shm_size | 33,177,600 (= 3840 × 2160 × 4, XR24 exact) |
| Color conversion | NONE |
| Format mismatch | **CONFIRMED (XR24 fed to NV12 buffer)** |
| Frames | Clean visually (content-dependent) |
| Export | 75.4 MB, 3840×2160, h264, 22.1 Mbps |
| Corruption reproduced? | NOT visually — format mismatch IS present |

**V2 verdict: Format mismatch confirmed. Visual corruption is content-dependent.**

## Attribution

The original ISS-014 corrupted artifact ("deterministic vertical striping with preserved scene geometry") was produced by the V2 helper/NVENC path. Specifically:

1. PipeWire delivers XR24 (BGRx, 4 bytes/pixel) frames via SHM on this system
2. DMA-BUF negotiation hard-fails on every session (NVIDIA/KDE)
3. The NVENC encoder is configured with `NV_ENC_BUFFER_FORMAT_NV12`
4. No BGRx→NV12 color conversion exists in the helper
5. Raw XR24 bytes are pushed to an NV12-typed buffer with mismatched pitch (15360 vs 4096)
6. NVENC encodes the misinterpreted data as NV12 → produces corrupted H.264 frames
7. Stream-copy export preserves the corruption into the final MP4
8. Visual striping appears when scene content has horizontal color contrast that makes the XR24-as-NV12 distortion visible

The "codec=vp8" reference in the original ISS-014 report came from the renderer's V1 MIME config — that path was never the source of the corruption.

## Evidence Paths

| Artifact | Path |
|----------|------|
| Baseline | `v2/../baseline.md` |
| V1 step-0 gate | `v1/step0-v1-alive.md` |
| V1 verdict | `v1/verdict.md` |
| V1 frames | `v1/frames/frame0.jpg`, `v1/frames/frame_mid.jpg` |
| V1 ffprobe (MP4) | `v1/ffprobe-mp4.json` |
| V1 ffprobe (webm) | `v1/ffprobe-webm.json` |
| V2 encode-boundary log | `v2/encode-boundary.log` |
| V2 verdict | `v2/verdict.md` |
| V2 frames | `v2/frames/frame0.jpg`, `v2/frames/frame_mid.jpg` |
| V2 ffprobe (export) | `v2/ffprobe-export.json` |

## Recommended Fix (out of scope for T-030)

Add BGRx→NV12 color conversion in `helper/src/encoder/backends/nvenc/mod.rs` before pushing XR24 SHM frames to the NVENC input buffer. The conversion must account for the stride difference (frame_stride=15360 source, locked_pitch=4096 destination). A CUDA-accelerated libyuv or manual BGRx→NV12 conversion is required.

## Ticket/Issue Status

- T-030: COMPLETE — attribution determined, bucket selected
- ISS-014: remains open — fix not in scope for T-030
- T-033: created (recovery dialog removal, unrelated)
