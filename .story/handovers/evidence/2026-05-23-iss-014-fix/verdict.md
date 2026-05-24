# ISS-014 Fix Verification — T-034

## Automated Verification

### Unit Tests
- `cargo test -p cove-replay-engine --lib`: **112 passed**, 0 failed
- New conversion tests (12 tests): all pass
  - `convert_white_yields_y235`: Y=235, U/V≈128 ±1
  - `convert_black_yields_y16`: Y=16, U/V=128
  - `convert_pure_red`: Y=63, U=102, V=240 ±1
  - `convert_pure_green`: Y=172, U=41, V=26 ±1
  - `convert_pure_blue`: Y=32, U=240, V=118 ±1
  - `convert_padded_stride`: extra stride bytes ignored
  - `convert_enc_larger_than_src_pads`: Y=16, U/V=128 padding
  - `convert_checkerboard_2x2_averaging`: 2×2 block chroma averaging
  - `convert_truncated_src_len_no_panic`: clamped reads, no panic
  - `convert_zero_src_dims_no_panic`: all-padding output
  - `drm_fourcc_constants_match_expected`: XR24, AR24, NV12

### Build
- `cargo build -p cove-replay-engine`: 0 errors, 70 warnings (all pre-existing FFI naming)

### Clippy
- No new warnings introduced (pre-existing FFI naming/style warnings only)

### Forbidden Surface
- `git diff -- helper/src/capture helper/src/export helper/src/segment electron src validation dist-validation packaging .github package.json Cargo.toml Cargo.lock`: **empty**

### git diff --check
- Clean (no whitespace issues)

### storybloq validate
- Passed (0 errors, 0 warnings)

### Codex Review
- 1 finding: false positive (stale T-032 handoff context vs T-034 changes)
- No code-level findings

## Implementation Summary

### Changes (single file: `helper/src/encoder/backends/nvenc/mod.rs`)
1. Added DRM fourcc constants: `DRM_FORMAT_XR24`, `DRM_FORMAT_AR24`, `DRM_FORMAT_NV12`
2. Added `convert_packed_bgra_to_nv12()` — pure scalar BT.709 limited-range conversion
3. Modified `push_frame()` — explicit format match:
   - XR24 → convert (has_alpha=false)
   - AR24 → convert (has_alpha=true)
   - _ (NV12, P010, etc.) → existing copy loops verbatim
4. Added `path="convert"|"copy"` field to `[iss-014][encode-boundary]` logs
5. Added 12 unit tests for conversion correctness

### Invariants Preserved
- NV12 fast path: `_` match arm uses original copy loops verbatim
- P010 behavior: unchanged (falls through to `_` arm)
- Export/remux: untouched
- No new allocations in hot path
- No new dependencies

## Visual Repro Evidence

**Status: PASS**

### Boundary log confirmation
```json
{"incoming_fourcc":"XR24","nvenc_buffer_fmt":"NV12","path":"convert","frame_stride":15360,"locked_pitch":4096}
```
- PipeWire delivers XR24 (packed BGRx, 3840×4=15360 stride)
- NVENC allocates NV12 (locked_pitch=4096)
- `path="convert"` confirms conversion path is active

### Extracted frames
- `frame0-post-fix.png` — first frame, desktop with multiple windows
- `frame-mid-post-fix.png` — frame 30, same session with visible text

### PASS criteria
- No vertical striping: **PASS** (clean frame content, no column artifacts)
- Geometry intact: **PASS** (windows, text, UI elements correctly positioned)
- Colors visually correct: **PASS** (dark theme, text contrast, taskbar icons all render correctly)
- Boundary log shows path=convert: **PASS**

### Note on replay save
The V2 replay save button triggered but did not produce an export file (v2ExportOutputPath remained null).
This is a pre-existing export pipeline issue unrelated to the XR24→NV12 conversion fix.
Frames were extracted directly from the rolling-buffer segments instead (init.mp4 + segment concatenation).

### Reference
- V1 reference frames: `.story/handovers/evidence/2026-05-23-iss-014-dual-path-repro/v1/frames/`
- Before-fix V2 frames (with striping): `.story/handovers/evidence/2026-05-23-iss-014-dual-path-repro/v2/frames/`
