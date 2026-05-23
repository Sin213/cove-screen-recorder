# V1 Repro Leg Verdict

**Result: CLEAN — no corruption reproduced**

## Saves Performed

| # | Timestamp | Duration | Frames | fps | Output MP4 |
|---|-----------|----------|--------|-----|------------|
| 1 | 13:41:40 buffer start | 24.8s | 1459 | 58.8 | Cove_Gaming_2026-05-23_134140_504.mp4 (5.0 MB) |
| 2 | 13:47:33 buffer start | 24.4s | 1460 | 59.8 | Cove_Gaming_2026-05-23_134733_511.mp4 (6.2 MB) |
| 3 | same buffer | 141.5s | 8432 | 59.6 | Cove_Gaming_2026-05-23_134806_642.mp4 (3.3 MB) |
| 4 | 15:16:41 buffer start | 106.2s | 6309 | 59.4 | Cove_Gaming_2026-05-23_151641_210.mp4 (2.7 MB) |

## Path Confirmed

- Source: 2648×1490 (3840×2160 at 1.45x scale) · 60fps · surface=monitor · Wayland
- Encoder: `codec=vp8` (MediaRecorder)
- Remux: `replay save: using libx264 (skipping Linux HW encoder chain)`
- Output: h264/libx264, 2560×1440, yuv420p, ~1.7 Mbps

## Pre-Remux WebM

- File: `~/.config/Cove Screen Recorder/recordings/rec_mpiwuepz_umc298.webm`
- Codec: vp8, 2560×1440, yuv420p (active buffer, still writing at evidence collection time)
- Size: 73.7 MB at check time

## Frame Extraction

- `frames/frame0.jpg` — frame 0: CLEAN (desktop/terminal content, no striping)
- `frames/frame_mid.jpg` — frame 720: CLEAN (app UI visible, no striping)

## ffprobe Summary (first save)

- Codec: h264 (libx264, `Lavc62.28.101 libx264`)
- Resolution: 2560×1440
- pix_fmt: yuv420p
- color_space: bt470bg
- b_frames: 2
- Duration: 24.816s
- Bit rate: 1,694,476 bps

## Provenance Tag (T-032)

T-032 provenance instrumentation IS present in `dist-electron/ffmpeg.js` (confirmed).
However: `opts.onLog?.(provenanceTag)` → `sendProgress()` in main.ts → transient muxing status.
**Not persisted to any file log.** Cannot be confirmed from log evidence, only from code inspection.
The provenance tag WOULD fire on successful encode (code=0 branch reached per successful saves).

## V1 Verdict

| Question | Answer |
|----------|--------|
| V1 path active? | YES (v2UiEnabled=false, saveReplay start (v1) confirmed) |
| Pre-remux webm present with size > 0? | YES (73.7 MB) |
| Input codec | VP8 (MediaRecorder, YUV420) |
| Remux codec | libx264 |
| Output pix_fmt | yuv420p |
| Striping in webm? | UNKNOWN (webm active during check; VP8 yuv420p format not a mismatch risk) |
| Striping in MP4 (frame 0)? | NO — clean |
| Striping in MP4 (mid frame)? | NO — clean |
| Provenance confirmed in log? | NO — routes to sendProgress(), not file-logged |
| Corruption reproduced? | NO |

## Classification

V1 path produces clean output on current build. Corruption not reproduced.
The V1 path involves VP8 (YUV420) → libx264 (YUV420) — no format mismatch in this chain.
If ISS-014 originated from V1, the corruption would require the VP8 encode itself to be corrupted
(which would appear in the webm). No such corruption observed in extracted frames.

## Next Step

Proceed to V2 repro leg: restart with `VITE_COVE_V2_UI=1 npm run dev`.
