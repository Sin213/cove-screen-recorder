# L-MOTION-60 — Fullscreen 60fps Motion Load

Fullscreen smooth scroll at 60fps with an embedded binary frame counter.
Load-bearing for duplicate-frame detection and cadence validation.

## Validation rows served

| Row ID       | Description |
|--------------|-------------|
| VAL-CAP-004  | 1080p60 monitor capture 60 s L-MOTION-60 on NVENC — drop and cadence gates |
| VAL-EXP-010  | No fake duplicated frames in exported MP4 (ffprobe PTS walk) |
| VAL-REG-002  | Fake-60fps gate re-run on VAL-EXP-001 output confirms no duplicated PTS |

Also used as the content source during: VAL-SEG-001 (rolling disk budget), VAL-SEG-003 (replay.save latency).

## Launch

```bash
cd validation/loads/l-motion-60
chmod +x launch.sh
./launch.sh          # Wayland (default)
./launch.sh --x11    # X11 fallback
```

Requires a Chromium-based browser (`chromium`, `chromium-browser`, `google-chrome-stable`, or `google-chrome`).

## Binary frame counter protocol

All pixel coordinates are **physical pixels** (canvas backing-store pixels = MP4 frame pixels).
The canvas backing store is sized to `Math.round(window.innerWidth × devicePixelRatio)` ×
`Math.round(window.innerHeight × devicePixelRatio)` physical pixels so that the counter
region `[0,0,192,8]` is always unambiguous on any DPR or fractional Wayland scale factor.

The top-left 192×8 physical pixels encode a 24-bit unsigned frame index as pixel blocks.

| Field            | Value |
|------------------|-------|
| Counter width    | 24 bits |
| Block size       | 8×8 physical px per bit |
| Encoded region   | x=[0,191], y=[0,7] in physical pixels (= MP4 frame coordinates) |
| Bit order        | MSB first (bit 23 at x=0, block x=[0,7]) |
| White (≥128 luma) | 1 |
| Black (<128 luma) | 0 |

### Counter value

```
frameIndex = Math.round((timestamp - startTime) × 60 / 1000)
```

- `timestamp`: DOMHighResTimeStamp from `requestAnimationFrame`
- `startTime`: first rAF timestamp (set on first call)
- **Time-based**, not rAF-count-based. On a 144Hz display, consecutive rAFs in the same 16.67ms slot produce the same `frameIndex` (intentional). The captured 60fps MP4 samples one rendered frame per nominal slot.

### Decoding from captured MP4 (T-010c)

All coordinates below are **physical pixels** (MP4 frame pixel coordinates).
No DPR correction is needed in the decoder — the canvas backing store already
maps 1:1 to physical pixels before capture.

For each frame at PTS `t` seconds:

1. Crop physical pixels `[0,0,192,8]` from the decoded frame.
2. For each bit `b` in `[0..23]`:
   - Average luma of block `[b×8, 0, 8, 8]` (physical pixels).
   - `1` if average ≥ 128, `0` otherwise.
3. Reconstruct integer from MSB-first bit array.
4. Check: `counter[t+1] - counter[t] == 1` for all consecutive frames.

### Acceptance thresholds (N-008 §6.1)

| Metric         | Threshold |
|----------------|-----------|
| Mean cadence   | ±0.5% of 16.667ms |
| 95th percentile| ±2% |
| 99th percentile| ±5% |
| Duplicate frames (counter gap=0) | 0 |
| Skipped frames (counter gap≥2) | ≤1% of total |

## Visual layout

```
[0,0]────────────────────────────[191,7]  ← 24 binary counter blocks (8×8 each)
[0,8]────────────────────────── [W-1,H-1] ← scrolling dark/light stripes
                                            bright cyan bar scrolls right
                                            "f=<frameIndex>" label at center
```

## Block alignment rationale

H.264 DCT operates on 8×8 luma blocks. Counter blocks are 8×8 to align with
DCT boundaries, maximising the chance that each bit survives lossy compression
without cross-block bleeding. A per-block luma threshold of 128 is robust to
typical QP ≤ 28 encoding artefacts.
