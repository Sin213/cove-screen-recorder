# T-032 — ISS-014 Replay Path Provenance Instrumentation

**Date:** 2026-05-23
**Ticket:** T-032 (complete). **Issue:** ISS-014 (open, untouched).

## Summary

Added exactly one authoritative provenance log line for the V1 MediaRecorder→libx264 replay path. The line fires via `opts.onLog` on successful ffmpeg encode exit, routing through the same established recorder logger as all other finalize/remux diagnostics. Logging only — zero behavior change.

## Files Changed

- `electron/ffmpeg.ts` — 8 insertions, 2 deletions (close handler restructure + provenance tag)
- `.story/tickets/T-032.json` — ticket created and marked complete

## What the Log Line Emits

```
[iss-014][provenance] route=v1-mediarecorder input_container=webm output_codec=<enc> output_pix_fmt=yuv420p encode_mode=reencode is_replay=<bool> output_path=<abs-path>
```

Fields:
- `route=v1-mediarecorder` — identifies V1 path (contrast: V2 helper/NVENC path never calls remux)
- `input_container=webm` — MediaRecorder always produces WebM
- `output_codec` — dynamically resolved from `enc` (libx264, h264_nvenc, etc.)
- `output_pix_fmt=yuv420p` — always set in mp4 branch (line 497)
- `encode_mode=reencode` — distinguishes from stream-copy paths
- `is_replay` — derived from `!!opts.trimLastMs`; replay saves always set trimLastMs
- `output_path` — absolute output artifact path

`input_codec` was intentionally omitted: MediaRecorder may negotiate VP8, VP9, or H264 depending on browser/preset; hardcoding would misattribute. Renderer already logs the actual codec.

## Implementation Detail

The provenance tag is captured into a closure variable (`let provenanceTag`) at the start of the Promise executor. It is assigned inside the `opts.format === "mp4"` block after `enc` is resolved and `pix_fmt` is set. It remains `undefined` for webm/gif paths. On successful ffmpeg exit (`code === 0`), `opts.onLog?.(provenanceTag)` emits the line, then `resolve()` is called. Failed encode attempts do NOT emit the line.

## Codex Review Loop

- **Review 1:** `patch is incorrect` — `input_codec=vp8` hardcode can misattribute VP9 or H264 captures. Patched: removed `input_codec` field.
- **Review 2:** `patch is incorrect` — (1) Log fired before spawn, could emit for failed attempts in encoder fallback loop; (2) `console.log` bypasses `opts.onLog` recorder evidence path. Patched: moved tag capture to close handler success branch, replaced `console.log` with `opts.onLog`.
- **Review 3:** `patch is correct`

Newest review: `/home/sin/Desktop/Codex-Reviews/codex-review-2026-05-23_14-23-00.txt`

## Verification Results

- `npm run typecheck`: pass
- `npm run build`: pass
- `storybloq validate`: 0 errors / 0 warnings / 0 info
- `git diff --cached --check`: clean
- `grep -R "[iss-014][provenance]" dist-electron`: confirmed (in ffmpeg.js as template-literal assignment)
- Forbidden surfaces diff (`helper/ src/ validation/ dist-validation/ packaging/ .github/ package.json Cargo.toml Cargo.lock`): empty

## Invariants Confirmed

- ffmpeg args unchanged
- codec selection unchanged
- pix_fmt unchanged
- encoder ordering unchanged
- route behavior unchanged
- no new probe calls
- no new IPC surfaces

## Expected V1 Provenance Signature (grep target)

```
[iss-014][provenance] route=v1-mediarecorder
```

## Expected V2 Signature Absence

V2 helper/NVENC path never calls `remux()`. No `[iss-014][provenance]` line will appear for V2 saves. The T-031 encode-boundary diagnostics (`[iss-014]` with NVENC fields) remain the V2 evidence surface.

## Ticket State

- T-030: inprogress (classification — unchanged)
- T-031: complete (NVENC boundary diagnostics — untouched)
- T-032: complete (this ticket)

## Final Git Status

```
AM .story/tickets/T-032.json
M  electron/ffmpeg.ts
```

## Exact Commit Command

```
git commit -m "Add T-032 ISS-014 V1 replay path provenance instrumentation"
```

## Next Phase

T-030 remains inprogress (classification) — next ticket in the ISS-014 investigation chain.
