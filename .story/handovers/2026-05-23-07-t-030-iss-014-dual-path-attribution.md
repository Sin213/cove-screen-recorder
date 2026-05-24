# T-030 — ISS-014 Dual-Path Attribution Pass

**Date:** 2026-05-23
**Ticket:** T-030 (complete). **Issue:** ISS-014 (open — fix scope separate).

## Verdict: V2 Confirmed (Bucket 2)

The V2 helper/NVENC path is definitively responsible for ISS-014.

## What Happened This Session

Ran a controlled dual-path repro pass with both T-031 (encode-boundary) and T-032 (provenance) instrumentation confirmed in the running binaries.

### V1 Leg (npm run dev, no VITE_COVE_V2_UI)

- V1 IS alive — 35.7–73.7 MB webm produced, 4 clean saves
- codec=vp8 (MediaRecorder) → libx264 (remux), 2560×1440, yuv420p
- Frames: clean (no striping)
- No format mismatch risk in this chain (YUV420 → YUV420)
- Provenance tag (T-032) fires via `sendProgress()` — not file-logged, only transient muxing status
- **V1 not the source of ISS-014**

### V2 Leg (VITE_COVE_V2_UI=1 npm run dev)

T-031 encode-boundary instrumentation fired on first frame (seq=1):

```
incoming_fourcc=XR24      ← PipeWire delivers BGRx (4 bytes/pixel)
nvenc_buffer_fmt=NV12     ← NVENC buffer expects NV12 (1.5 bytes/pixel)
frame_stride=15360        ← 3840 × 4 = XR24 confirmed
locked_pitch=4096         ← NV12 luma pitch (256-aligned)
shm_size=33,177,600       ← 3840 × 2160 × 4 = XR24 exact
No color conversion exists in helper
```

- DMA-BUF hard-failed again (consistent with all prior sessions)
- Export: 75.4 MB, 3840×2160, h264, 22.1 Mbps, 27.2s — healthy FSM
- Frames: visually clean (content-dependent; striping appears under high horizontal color contrast)

## Fix Required (not in scope for T-030)

`helper/src/encoder/backends/nvenc/mod.rs` — add BGRx→NV12 conversion before pushing XR24 SHM frames to NVENC. Must handle stride difference (frame_stride=15360 src, locked_pitch=4096 dst). CUDA-accelerated libyuv or manual conversion.

## Side Ticket

T-033 created: remove recovery/unsaved-sessions dialog on app startup (user request).

## Important Finding: Provenance Log Routing

T-032's `[iss-014][provenance]` tag routes through `opts.onLog` → `captureLog` → `sendProgress()` in main.ts with `stage: "muxing"`. It is NOT persisted to any file log — only appears as a transient muxing progress message. Future sessions: don't expect it in engine.log or export-lifecycle.log.

## Evidence Paths

All evidence: `.story/handovers/evidence/2026-05-23-iss-014-dual-path-repro/`
- `baseline.md` — system info, instrumentation verification
- `v1/step0-v1-alive.md` — V1 gate result
- `v1/verdict.md` — V1 leg findings
- `v1/frames/` — 2 clean frames
- `v2/encode-boundary.log` — raw T-031 log lines
- `v2/verdict.md` — V2 leg findings with mismatch analysis
- `v2/frames/` — 2 frames (clean, content-dependent)
- `verdict.md` — top-level attribution verdict

## Commits

- `9eb94e4` — T-030 evidence + T-030.json complete + ISS-014.json updated + T-033.json
- `b5a9a5b` — T-032 handover (prior session, committed separately)

## Ticket State

- T-030: **complete**
- T-031: complete (encode-boundary instrumentation — fired this session)
- T-032: complete (provenance instrumentation — routing caveat documented above)
- T-033: open (recovery dialog removal)
- ISS-014: **open** — attributed to V2 NVENC path, fix not yet implemented
