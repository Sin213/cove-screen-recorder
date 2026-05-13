# Cove Screen Recorder — Project State

**Date:** 2026-05-13
**Current release:** v1.1.0 (stable)
**Next major:** v2.0.0 (planning)

---

## v1.1.0 stable baseline

v1.1.0 is the stable baseline for the current Electron / Chromium MediaRecorder replay architecture. It is shipped, tagged, and pushed. Treat it as the line below which v2 must not regress.

### Verified working in v1.1.0

- Recording works.
- Replay works.
- Audio works.
- `npm run typecheck` passes.
- `npm run build` passes.
- No leftover `ffmpeg` / `pactl` processes after stop.
- Code is committed and pushed.

### Major work landed in v1.1.0

- Stabilized recording and instant replay on Linux/Wayland.
- Fixed replay corruption.
- Fixed fake duplicated-frame 60fps output.
- Fixed replay freeze during save.
- Fixed broken Linux hardware encoder fallback loops.
- Fixed audio sidecar stability.
- Fixed replay save state handling.
- Added replay source diagnostics.
- Added replay FPS/cadence detection.
- Fixed process cleanup issues.
- Balanced preset reaches stable 1080p60 replay on Linux/Wayland.
- Replay save skips broken Linux hardware encoder chains and uses `libx264` directly for replay finalization.

### Current recommended preset

**Balanced:**

- 1920x1080
- 60fps
- VP8 replay buffer
- `libx264` final encode

---

## Architecture ceiling (the reason for v2)

The current Electron / Chromium MediaRecorder replay architecture has a hard ceiling.

**Stable:**

- 1080p60 replay

**Not stable:**

- 1440p60 replay
- 4K60 replay

**Why:** the bottleneck is Chromium / Electron MediaRecorder capture and canvas processing, **not** RTX 4080 Super hardware capability. Dropped frames happen before `ffmpeg` / NVENC ever sees them. The current pipeline:

```
Electron getDisplayMedia
  -> canvas scaling
  -> MediaRecorder VP8/WebM
  -> ffmpeg final MP4
```

No amount of NVENC tuning fixes a frame that the capture layer dropped. This is why v2 cannot be more hacks on the existing replay system.

---

## v2.0.0 direction

Move away from Electron MediaRecorder replay buffering toward a native or native-like replay engine.

**Target architecture:**

```
Electron UI
  -> native/helper replay engine
     -> PipeWire capture (Linux; DXGI/WGC later for Windows)
     -> hardware encoder backend
     -> rolling replay segments
     -> instant replay export/remux
```

**Encoder support goals:**

- NVIDIA → NVENC
- AMD → VAAPI (Linux) / AMF (Windows)
- Intel / Arc → QSV / VAAPI
- CPU fallback → `libx264`

**Hard constraint:** do not keep patching the current MediaRecorder replay architecture. v1.1.0 is stable enough; v2.0.0 is an architectural shift, not a tuning pass.

---

## Open issue triage

| Issue | Title | Disposition |
| ----- | ----- | ----------- |
| #1 | Crop area selection unclear/missing | **Fold into v2** — handled by PipeWire capture region selection (T-004). |
| #2 | Instant replay keybind not configurable / not colocated | **Candidate for v1.1.1** maintenance (T-002). |
| #3 | Source does not record until hovered | **Fold into v2** — DOM/canvas hover dependency disappears with the native capture path. |
| #4 | Crop/replay timer state weirdness | **Candidate for v1.1.1** UI-state cleanup only (T-002). Do not chase deeper MediaRecorder causes. |

If v1.1.1 is skipped, Issues #2 and #4 carry into v2 scope and must be addressed by the new UI/engine integration (T-008).

---

## Phases

- **p0-maintenance** — Optional v1.1.1 cleanup (T-002). May be skipped.
- **p1-research** — v2 architecture boundary + replay engine choice (T-001, T-003).
- **p2-design** — Capture, encoder matrix, rolling buffer, export pipeline (T-004..T-007).
- **p3-integration** — UI ↔ engine contract and full validation matrix (T-008, T-009).
- **p4-release** — v2.0.0 release checklist (T-010).

---

## Authoritative inputs

Per `CLAUDE.md`:

- `CLAUDE.md`, `WORKFLOW.md`, `RELEASES.md`, the current handover, git diff, and tests are authoritative.
- This `.story/` tree is repo memory and planning; it must be confirmed against the repo before acting.
- Per global rule: every shipped release artifact gets a `.sha256` sidecar (Portable.exe, Setup.exe, AppImage, .deb, etc.).

---

## Non-goals (explicit)

- No further MediaRecorder rework after v1.1.0.
- No new features outside the v2 architectural shift.
- No release notes, screenshots, or extra docs unless explicitly requested.
- No commits, tags, or publishes without explicit user request.
