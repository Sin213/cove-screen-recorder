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

## v2.0.0 replay engine decision (T-003, 2026-05-13)

**Primary:** persistent native **Rust sidecar** helper process. Electron launches it on app start and talks to it over **length-prefixed JSON-RPC** on a **UNIX domain socket** (Linux/macOS) or **named pipe** (Windows). The sidecar owns capture, encode, rolling segments, and export/remux. Electron remains UI + control plane only.

**Fallback:** **ffmpeg-driven helper process** with PipeWire input. Same sidecar shape and same IPC contract, but the inner engine is a managed `ffmpeg` child driven by carefully chosen flags (`-f pipewire` input, hardware encoder selection, `-f segment` rolling buffer, separate concat for export). The fallback exists so the project can ship if any encoder backend implementation in the Rust path slips, and as the Linux-first viability check.

**Rejected:**

- On-demand standalone native binary (launch-per-command): cannot hold a continuous rolling replay buffer.
- Node N-API addon: per-Electron-version ABI coupling, per-platform prebuild matrix, and a native crash takes the UI down with it. Hostile to solo maintenance.

**Why primary wins:** the v1.1.0 ceiling is frames dropped *before* any encoder sees them, inside Chromium MediaRecorder + canvas scaling. Only an out-of-process native engine with its own scheduler, a dmabuf/shm capture-to-encoder path, and structural crash isolation from Electron escapes that path.

**Encoder backend abstraction (detailed design = T-005):**

- `EncoderBackend` trait with `NvencEncoder`, `VaapiEncoder`, `QsvEncoder`, `AmfEncoder` (Windows, later), `X264Encoder` (CPU fallback).
- Implementation strategy: bind libavcodec via the `ffmpeg-next` Rust crate so the engine inherits ffmpeg's encoder coverage without shelling out to the ffmpeg CLI. This is the technical line that separates **primary** (links libav*) from **fallback** (execs ffmpeg).
- Probe order at startup: NVENC → VAAPI / QSV → AMF → x264.

**Capture frontend (detailed design = T-004):**

- `CaptureSource` trait with `PipeWireSource` (Linux first, via xdg-desktop-portal `ScreenCast` + `pipewire-rs`) and `WgcSource` (Windows later, via `windows-rs` Windows.Graphics.Capture).
- macOS deferred. Trait shape leaves it open without committing.

**Rolling buffer (detailed design = T-006):** in-memory ring of encoded GOPs; no on-disk write amplification during normal replay-buffer operation.

**Export/remux (detailed design = T-007):** performed inside the engine via libavformat. Removes the v1.1.0 finalize-vs-encoder race.

**Packaging:** `electron-builder` `extraResources` per platform. Single statically-linked Rust binary per target. No node-gyp / electron-rebuild. The helper binary gets a `.sha256` sidecar per the global release rule.

**Failure isolation:** Electron detects IPC channel close → surfaces error → offers one-click restart. UI does not crash with the engine.

**What this decision does NOT do:**

- Does not write any Rust code or any source file.
- Does not lock the exact IPC encoding (JSON-RPC vs Cap'n Proto vs bincode); that is T-008.
- Does not pick the ring-buffer data structure; that is T-006.
- Does not pick a specific NVENC SDK version; that is T-005.

See `.story/notes/N-002.json` for the full decision record.

---

## v2.0.0 PipeWire capture backend boundary (T-004, 2026-05-13)

The Linux capture surface for the v2 sidecar is locked. Full design in `.story/notes/N-003.json`. Summary:

- **Five layers, top down:** Electron UI → IPC contract (T-008) → helper capture orchestrator → `CaptureSource` trait → xdg-desktop-portal ScreenCast + PipeWire stream. Frames cross from the trait layer into the encoder *inside the helper*; they never cross IPC. Electron never sees a frame.
- **What Electron asks for:** `capture.requestSession`, `capture.startStream`, `capture.pauseStream`/`resumeStream`, `capture.stopSession`, `capture.setRegion`, `capture.setFramerateHint`, `capture.setCursorMode`. Events back to Electron: `sessionReady` (explicit readiness — closes the v1.1.0 "guess capture is ready from a timer" gap), `formatChanged`, `streamPaused`/`Resumed`, `sessionLost`, `diagnostics`.
- **What the helper owns:** the D-Bus portal connection, PipeWire core/loop, all `pw_stream` objects, SPA param negotiation, DMA-BUF vs SHM negotiation, restore-token persistence (`$XDG_STATE_HOME/cove-screen-recorder/portal-restore.json`), in-process frame channel to the encoder, failure classification, diagnostics emission.
- **Selection vs acquisition boundary:** the portal owns the source picker and returns PipeWire node IDs + optional `restore_token`. PipeWire owns frame acquisition once nodes are bound. `sessionReady` only fires once `pw_stream` state reaches `Streaming` with a committed format.
- **`CaptureSource` trait:** abstract frame producer that exposes `caps()`, `current_format()`, `frames()` (async `FrameHandle` stream with PTS, fourcc, modifier, payload variant `DmaBuf | Shm`, optional cursor metadata, and a `ReleaseToken` for buffer return). The encoder backend imports `FrameHandle` directly — zero-copy when DMA-BUF + supported modifier are negotiated.
- **Capture modes for v2.0.0:** `monitor`, `window`, `region`. Region is composed (monitor capture + encoder-boundary crop, no portal cooperation needed — closes Issue #1). `virtual`, multi-stream replay, X11, and Wayland-without-portal are deferred.
- **DMA-BUF vs SHM:** DMA-BUF preferred with modifier list intersected against encoder-import support; linear DMA-BUF fallback before SHM; SHM only if neither negotiates. Failure to negotiate any acceptable buffer mode is a hard `sessionLost(no-acceptable-buffer-type)` — not a silent slow path.
- **Format negotiation:** NV12 preferred, P010 accepted when encoder supports 10-bit, RGB (XR24/AR24) accepted with encoder-side conversion. No colorspace conversion inside the capture layer. Source-native resolution accepted as-is; the capture layer never resizes or letterboxes.
- **Framerate hints:** advisory only. No synthetic duplicate frames generated inside capture (fixes v1.1.0 "fake duplicated 60fps"). Encoder backend decides constant-fps vs VFR.
- **Cursor handling:** maps to portal `Hidden`/`Embedded`/`Metadata`. Default `embedded` for v2.0.0; `metadata` preferred long-term but gated on compositor support detection with transparent downgrade.
- **Dynamic resolution changes:** `OnParamChanged` triggers buffer re-negotiation, emits `formatChanged`, and surfaces the new caps through the trait. Encoder/segment layer absorbs the discontinuity. The capture layer never hides a resolution change.
- **Failure surfaces:** distinct reason codes — `portal-denied`, `portal-restore-rejected`, `portal-unavailable`, `pipewire-disconnected`, `pipewire-state-error`, `source-removed`, `no-acceptable-buffer-type`, `format-renegotiation-failed`, `compositor-paused` (soft), `encoder-disconnected`. Bounded reconnect attempts for PipeWire daemon loss; everything else is a clean `sessionLost` with a structured `details` blob.
- **Diagnostics invariant:** the helper reports buffers negotiated, in flight, dropped since last tick, and total produced — plus observed cadence vs hint, compositor name, PipeWire version, and last negotiation latency. A user can prove whether a dropped frame happened at capture, encode, or segment write by correlating these counters with the encoder (T-005) and segment buffer (T-006) counters. v1.1.0 cannot distinguish these layers; v2 must. On `sessionLost`, the last 60 s of diagnostics is written to `$XDG_STATE_HOME/cove-screen-recorder/diagnostics/<sessionId>.json` for triage.
- **Issue absorption:** #1 (crop unclear) becomes the first-class `region` mode + `setRegion`. #3 (source does not record until hovered) is eliminated by removing the DOM/canvas hover dependency entirely — the validation matrix includes a 60 s minimized-preview test that must produce the expected frame count.
- **Trait symmetry:** `CaptureSource` is shaped so a future `WgcSource` (Windows DXGI/WGC, shared D3D11 textures) and `ScreenCaptureKitSource` (macOS `IOSurface`) slot in without reshaping the encoder boundary. Out of scope for T-004.

Test/validation cases are enumerated in N-003 §17 and feed directly into T-009's validation matrix.

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
