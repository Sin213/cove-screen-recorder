# ISS-014 Replay Corruption Classification — 2026-05-23

## 1. Replay Path Classification

**v2 helper/NVENC path.**

Evidence:
- v1 MediaRecorder WebM recordings: ALL empty stubs (0-1B in `~/.config/cove-screen-recorder/recordings/`)
- All exports in both helper dir (`/run/user/1000/cove-screen-recorder/exports/exp-*.mp4`) and final dir (`~/Videos/Cove Recordings/`) are H.264
- Engine.log shows `replay.save` RPC messages (v2 path)
- Export-lifecycle.log shows `mode=stream-copy` exports to helper dir
- `v2SaveReplay` is the active hotkey/button handler in `src/App.tsx`

The "codec=vp8" referenced in the ticket context is from the v1 MediaRecorder MIME type configuration in `src/recorder-client.ts:617`, not from any active replay/export path. v1 `saveReplay()` exists as a fallback in `App.tsx` but never fires because v2 state is always active.

## 2. Codec/Container Classification

**H.264 (h264_nvenc) in MP4 container.**

Helper exports:
- Codec: h264 via NVENC (TAG:encoder=Lavc62.28.101 h264_nvenc)
- Container: MP4 (Lavf62.12.101)
- Pixel format: yuv420p
- Resolution: 3840x2160 or 1920x1080
- Frame rate: 120/1 (rolling buffer rate)

Final exports:
- Mixed encoders: 9 files h264_nvenc, 4 files libx264
- libx264-tagged files have non-standard dimensions (2560x1440@2000fps) — likely v1 ffmpeg transcode remnants from earlier versions
- All recent final exports use h264_nvenc

## 3. Corruption Boundary Classification

**Most likely: ENCODING boundary — BGRx→NV12 format mismatch in NVENC push_frame.**

### The format mismatch

| Stage | Expected | Actual |
|-------|----------|--------|
| PipeWire negotiated format | — | XR24 (BGRx, 4 bytes/pixel) |
| SHM buffer transport | — | MemFd/MemPtr (SHM-only, DMA-BUF always fails) |
| NVENC push_frame format check | NV12 | format field IGNORED (bound to `_`) |
| NVENC input buffer | NV12 (hardcoded) | Raw SHM bytes copied as-is |
| Color conversion | Required (BGRx→NV12) | NONE — no conversion code or library exists |

### Code evidence

`helper/src/encoder/backends/nvenc/mod.rs:684`:
```rust
crate::capture::FramePayload::Shm { data, width: _, height: _, format: _, stride } =>
```
The `format` field is bound to `_` (ignored). The encoder does not check whether incoming data is NV12.

`helper/src/encoder/backends/nvenc/mod.rs:703`:
```rust
create_in.bufferFmt = NV_ENC_BUFFER_FORMAT_NV12;
```
Input buffer is unconditionally created as NV12.

`helper/src/encoder/backends/nvenc/mod.rs:732-733`:
```rust
// NV12: luma plane (height rows) + chroma plane (height/2 rows of interleaved UV).
// SHM frame arrives as NV12 (fourcc=NV12) or similar — copy luma + chroma.
```
Comment assumes NV12 input. PipeWire provides XR24 (BGRx).

No color conversion library exists in `helper/Cargo.toml`. No bgr→nv12 conversion code in `helper/src/`.

### Predicted corruption pattern for BGRx-as-NV12

If PipeWire delivers actual BGRx data (stride = width*4 = 15360 for 3840px):
- **Luma copy**: reads first 3840 bytes of each 15360-byte BGRx row → first 960 pixels' BGRA bytes interpreted as Y values → 4-pixel-period vertical striping (B,G,R,X brightness cycle)
- **Chroma copy**: source offset = h*stride = end of buffer → copy_len=0 → chroma plane empty → grey/desaturated output
- **Visual**: deterministic vertical striping, preserved but 4x-compressed scene geometry, no color
- **Matches**: user description of "deterministic vertical striping with preserved scene geometry"

### NVENC probe does NOT check format

`helper/src/encoder/backends/nvenc/mod.rs:465`:
```rust
async fn probe(&self, _format: &CaptureFormat) -> ProbeOutcome {
```
The `_format` parameter is ignored. NVENC is selected if CUDA/NVENC libraries load, regardless of capture format.

### Current artifacts are CLEAN

Frame extraction from 7 artifacts (4 final, 3 helper) shows no visible corruption. Possible explanations:
1. PipeWire may currently provide NV12-compatible data despite negotiating XR24 (KDE/NVIDIA may do GPU-side format conversion before SHM delivery)
2. The corruption is intermittent, triggered by specific compositor/GPU state
3. The corrupted artifact was from a prior session whose exports were cleaned up

## 4. Evidence Sufficiency

**INSUFFICIENT for definitive classification. Additive instrumentation required.**

### What we know
- The code path contains a confirmed format mismatch risk
- The predicted corruption pattern matches the user's description exactly
- Current exports are clean (corruption not reproducible in available artifacts)

### What we don't know
- The actual byte format of PipeWire SHM frames at the NVENC boundary
- Whether PipeWire/KDE performs an undocumented NV12 conversion before SHM delivery
- The stride value at runtime (not logged)
- The SHM buffer size at runtime (not logged — would distinguish BGRx from NV12)
- Conditions that trigger actual BGRx delivery vs NV12-compatible delivery

### Required instrumentation (Phase 2, if authorized)
One `tracing::info!` in `helper/src/encoder/backends/nvenc/mod.rs` at the push_frame entry:
```
info!(format = ?frame_format, stride, shm_size, enc_width = w, enc_height = h, "nvenc push_frame");
```
This would capture the format, stride, and buffer size on every frame, enabling definitive format classification on the next capture session.

One `tracing::info!` in `helper/src/capture/pipewire.rs` at frame delivery:
```
info!(format = drm_format, stride, data_len = data.len(), width, height, "SHM frame payload");
```
This would capture the actual SHM frame format before it reaches the encoder.

## 5. Summary

| Question | Answer |
|----------|--------|
| Replay path | v2 helper/NVENC |
| Codec/container | H.264 (h264_nvenc) / MP4 |
| Corruption boundary | Encoding (BGRx→NV12 mismatch at NVENC push_frame) |
| Corruption in current artifacts | Not found |
| "codec=vp8" source | v1 MediaRecorder MIME config (inactive) |
| Format conversion exists | NO |
| Instrumentation required | YES |
| Fix required | YES (but OUT OF SCOPE for T-030) |

## Evidence files
- `ffprobe-artifact.txt` — ffprobe output for latest helper and final exports
- `ffprobe-frames.txt` — frame-level ffprobe for latest helper export
- `frame-hex.txt` — raw NV12 hex dump of first decoded frame
- `log-correlation.txt` — VP8 reference tracing, format mismatch evidence, path determination
- `artifact-paths.txt` — all artifact locations, sizes, visual inspection results
- `helper-log-excerpts.txt` — engine.log excerpts for PW format/SHM/export events
