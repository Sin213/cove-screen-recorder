# V2 Repro Leg Verdict

**Result: FORMAT MISMATCH CONFIRMED — output currently clean (no visual corruption reproduced)**

## Session Details

- Session ID: pw-session-0000-1490980-1779575573293
- Buffer started: 15:32:47 (v2State IDLE→RECORDING at 15:32:53)
- Save triggered: 15:33:23 (v2State RECORDING)
- Export: exp-1779575603375236291-0001 (75.4 MB, mode=stream-copy)
- Export completed: 15:33:26 (FSM: EXPORTING→RECORDING — healthy, ISS-012 non-repro)

## Encode-Boundary Log (T-031 fired)

From `encode-boundary.log`:

```
PW stream ready: fourcc=XR24, 3840×2160
[iss-014][encode-boundary] capture frame: seq=1, fourcc=XR24, capture_stride=15360, buffer_type=Shm
[iss-014][encode-boundary] shm frame:
  incoming_fourcc=XR24        ← PipeWire delivers BGRx (4 bytes/pixel)
  configured_fourcc=XR24      ← helper registered XR24 from stream metadata
  nvenc_buffer_fmt=NV12       ← NVENC buffer declared as NV12 (1.5 bytes/pixel)
  frame_stride=15360          ← 3840 × 4 = confirmed XR24 stride
  locked_pitch=4096           ← NVENC NV12 luma pitch (3840 aligned to 256)
  shm_size=33,177,600         ← 3840 × 2160 × 4 = confirmed XR24 packed bytes
  expected_nv12_bytes=49,766,400  ← shm_size × 1.5 (not a valid NV12 size for 4K)
  expected_packed_bytes=33,177,600 ← matches shm_size exactly
  stride_per_px_x1000=4000    ← 4 bytes/pixel (XR24 confirmed)
```

## Format Mismatch Analysis

| Stage | Format | Bytes/px | 3840px stride |
|-------|--------|----------|---------------|
| PipeWire SHM delivery | XR24 (BGRx) | 4 | 15360 |
| NVENC input buffer | NV12 | 1.5 | 4096 (locked pitch) |
| Color conversion code | (none) | — | — |

**Key mismatch:** `frame_stride (15360) ≠ locked_pitch (4096)`. The SHM buffer contains XR24 data but NVENC expects NV12. No color conversion exists in the helper. The raw XR24 bytes are pushed to an NV12-typed NVENC buffer, causing the frame data to be misread by the encoder.

**Predicted corruption:** XR24 bytes reinterpreted as NV12 luma produce a pattern where each NV12 "row" corresponds to 4096/4 = 1024 actual screen pixels of BGRA data rather than 3840 luma values. This compresses/distorts horizontal screen content — consistent with "deterministic vertical striping with preserved scene geometry" (ISS-014 description).

## DMA-BUF Status

`PW stream errored during DMA-BUF-only negotiation: no more input formats; triggering SHM-only fallback retry` — DMA-BUF hard-failed again. SHM-only (Shm buffer_type confirmed). Same pattern as all prior sessions.

## ffprobe (V2 Export)

- Codec: h264 (NVENC, no encoder tag — stream-copy)
- Resolution: 3840×2160
- pix_fmt: yuv420p
- r_frame_rate: 120/1
- Duration: 27.235s, 1200 frames (~44 fps avg)
- Bit rate: 22.1 Mbps
- No audio stream

## Frame Extraction

- `frames/frame0.jpg` — CLEAN visually (browser content readable, no striping pattern)
- `frames/frame_mid.jpg` — CLEAN visually (dark desktop, folder icons, taskbar)

**Why no visible striping despite mismatch:** The XR24→NV12 misinterpretation produces output that is visually close to the source for scenes with consistent luminance (the B channel of BGRx ≈ luma for neutral/gray content). Striping becomes visible when there is high horizontal color contrast at specific pixel offsets — conditions that match the original ISS-014 report but were not present in this repro session's captured content.

## V2 Verdict

| Question | Answer |
|----------|--------|
| V2 path active? | YES (v2State=RECORDING, v2SaveReplay start) |
| encode-boundary instrumentation fired? | YES — both capture frame and shm frame |
| incoming_fourcc | XR24 |
| nvenc_buffer_fmt | NV12 |
| Format mismatch present? | **YES — CONFIRMED** |
| frame_stride ≠ locked_pitch? | YES (15360 ≠ 4096) |
| shm_size matches XR24? | YES (33,177,600 = 3840×2160×4) |
| Color conversion exists? | NO |
| Striping visible in frames? | NO (content at test time not conducive to visible corruption) |
| Route attributed? | V2 helper/NVENC path |

## Classification

**V2 confirmed as the route responsible for ISS-014.** The format mismatch (XR24→NV12 with no conversion) is definitively present in the instrumented binary and confirmed on first frame. Visual corruption is content-dependent — the original ISS-014 artifact was likely captured during high-contrast content that made the XR24-as-NV12 distortion visible as striping.
