# ISS-014 Evidence Verdict — 2026-05-23

## Verdict: INCONCLUSIVE (partial confirmation, wrong code path)

## Classification Finding

The ISS-014 encode-boundary instrumentation (T-031) targets the **helper engine's NVENC push_frame path**. However, the "Save Replay" button routes through a **completely different code path** — Electron-side encoding via libx264 — that bypasses the helper engine entirely. The instrumentation cannot fire from the Save Replay flow.

Two independent encode/export pipelines exist:

| Property | Helper Engine Path | Save Replay Path |
|---|---|---|
| Encoder | NVENC (hardware H.264) | libx264 (software H.264) |
| Resolution | 3840×2160 (native) | 2560×1440 (scaled) |
| Bitrate | ~47.7 Mbps | ~2.1 Mbps |
| B-frames | 0 | 2 |
| Output dir | /run/user/1000/cove-screen-recorder/exports/ | ~/Videos/Cove Recordings/ |
| Export log | export-lifecycle.log | (not logged) |
| ISS-014 instrumentation | present, can fire | not present, cannot fire |

## Diagnostic Values Extracted (from prior engine sessions)

These values come from PW stream metadata in the engine log (prior sessions, pre-rebuild binary), NOT from the ISS-014 instrumentation:

- **incoming_fourcc**: XR24 (confirmed across all capture sessions)
- **buffer_type**: Shm (DMA-BUF negotiation hard-failed every session)
- **resolution**: 3840×2160
- **nvenc_probe**: session creation succeeded (NVENC available)
- **DMA-BUF fallback**: consistent — PW stream errors during DMA-BUF-only negotiation, falls back to SHM-only (MemFd|MemPtr, data_type_mask=6)

### Computed values (not from instrumentation, derived from XR24 format):
- **stride_per_px_x1000**: 4000 (XR24 = 4 bytes/pixel)
- **expected_packed_bytes**: 3840 × 2160 × 4 = 33,177,600
- **expected_nv12_bytes**: 3840 × 2160 × 1.5 = 12,441,600
- **expected_nv12_bytes ≠ expected_packed_bytes**: true (12.4M vs 33.2M)

### Confirming signature check (from PW stream metadata):
- incoming_fourcc is XR24 → **CONFIRMING** ✓
- buffer_type is Shm → **CONFIRMING** ✓
- stride_per_px_x1000 ≈ 4000 → **CONFIRMING** ✓ (derived)
- nvenc_buffer_fmt is NV12 → **UNKNOWN** (instrumentation didn't fire)
- expected_packed_bytes ≈ shm_size → **UNKNOWN** (no shm_size logged)
- expected_nv12_bytes ≠ shm_size → **UNKNOWN** (no shm_size logged)

### Refuting signature check:
- incoming_fourcc = NV12 → **NO** (XR24)
- stride_per_px_x1000 ≈ 1000-1500 → **NO** (4000)
- buffer_type = DmaBuf → **NO** (Shm)

**No refuting signals detected.**

## Analysis

1. The helper engine path (PW → NVENC) consistently receives XR24/4bpp frames via SHM. This is the confirming signature pattern for stride/pixel-format mismatch at the NVENC encode boundary.

2. The Save Replay path (Electron → libx264) operates independently, at different resolution, with different encoder. The ISS-014 instrumentation is irrelevant to this path.

3. The original ISS-014 report mentioned "codec=vp8", suggesting the corruption may have been observed in a THIRD code path (MediaRecorder/VP8/WebM) that is neither the helper engine nor the current Save Replay (libx264/mp4) path.

4. **Which code path produced the original corrupted artifact is undetermined.** Until this is established, the NVENC encode-boundary hypothesis cannot be definitively confirmed or refuted for the user-facing corruption.

## Next-Step Recommendation

1. **Determine which code path produced the original ISS-014 corrupted artifact** — check the original corruption screenshot/report against the three identified paths (NVENC/helper, libx264/SaveReplay, VP8/MediaRecorder).

2. **If helper engine path**: re-run repro by triggering a NEW PW capture session through the helper engine (not Save Replay), then export via the helper's export flow. The instrumentation will fire.

3. **If Save Replay path**: the NVENC hypothesis does not apply. New instrumentation is needed in the Electron-side encode path. The stride/format mismatch may exist there instead.

4. **If VP8/MediaRecorder path**: same as #3 — different code path entirely. Check if VP8/WebM path is still active or has been replaced by libx264.
