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

## v2.0.0 encoder backend matrix and fallback policy (T-005, 2026-05-13)

The encoder layer of the v2 helper is locked. Full design in `.story/notes/N-004.json`. Summary:

- **Backend matrix (live capture / rolling write):** NVIDIA → NVENC (`h264_nvenc`, `hevc_nvenc`; `av1_nvenc` deferred). AMD on Linux → VAAPI (`h264_vaapi`, `hevc_vaapi`). AMD on Windows → AMF is a **future path only** in v2.0.0 — slot reserved, never probed, falls straight through to libx264 with a visible `encoder.fallbackEngaged(windows-amd-deferred)` indicator. Intel Arc on Linux → QSV (VAAPI as sub-fallback). Intel iGPU gen < 12 on Linux → VAAPI only. Intel on Windows → QSV. Universal fallback → libx264. **At most one HW backend per session.**
- **Probe order (Linux):** vendor detection from `/sys/class/drm/card*/device/vendor` and `/proc/driver/nvidia/version`, then per-vendor probe (NVIDIA→NVENC, AMD→VAAPI, Intel Arc→QSV→VAAPI, Intel iGPU→VAAPI), then libx264. Probe is a real minimum-cost encode (open device + tiny NV12 + two-frame encode + close), runs **once at session start**, and **never mid-stream**.
- **Capability probe cache:** `$XDG_CACHE_HOME/cove-screen-recorder/encoder-probe.json` keyed by (platform, vendor, GPU PCI ID, driver version, kernel version, app version). Positive results cached 7 days; **negative results cached 30 days and never auto-retried** — this is the explicit fix for the v1.1.0 broken Linux fallback loop that re-tried the same HW path on every recording. Manual override: `--reset-encoder-probe` or an advanced-settings button.
- **Per-vendor accepted inputs:** NV12 preferred everywhere. P010 only when source is 10-bit AND backend supports it AND HEVC is chosen. RGB accepted with per-backend conversion cost (CUDA shader / VAAPI VPP / libswscale).
- **DMA-BUF / modifier import expectations:** NVENC via CUDA external memory; practical floor is **linear NV12 DMA-BUF**; tiled formats opportunistic on the proprietary driver. VAAPI via `vaCreateSurfaces` + `DRM_PRIME_2`, accepts the modifiers Mesa advertises (Y-tiled, AMD GFX9 tiling, linear). QSV on Linux is VAAPI-backed (same modifier surface). AMF + Windows-QSV use D3D11 NT handles. libx264 consumes SHM only.
- **SHM fallback policy (binding):** **SHM frames go to libx264 only.** If the capture layer is forced to SHM, the encoder layer switches to libx264 at session start with `encoder.fallbackEngaged(shm-forced)` *before any frame flows*. No hardware encoder is fed SHM frames in v2.0.0. The hidden upload cost is exactly what produced v1.1.0's bandwidth ceiling.
- **Rate control defaults (rolling replay):** NVENC = CBR-HQ `p5` no-lookahead, `bf=0`. VAAPI = CBR balanced, `bf=0`. QSV = VBR with `maxrate = target + 25%`, `target_usage=4`, `bf=0`. libx264 = `veryfast` VBR with maxrate cap. Bitrate ladder = 12 / 25 / 50 Mbps H.264 and 8 / 18 / 35 Mbps HEVC at 1080p60 / 1440p60 / 4K60. `vbv-bufsize ≈ 2 × target`.
- **GOP / keyframe policy:** closed GOP, length = `2 × fps` (IDR every 2 s), `scenecut` disabled, `refs=1`, `bf=0` during rolling capture. Force-IDR at every segment boundary and on every `formatChanged`. Open GOP is refused — every segment must be independently decodable from its first frame.
- **PTS expectations from `CaptureSource`:** input is `FrameHandle::pts_ns` (monotonic ns). First-frame anchored at `t0`. Encoder timebase = `1/90000`. VFR allowed; out-of-order frames dropped (no reorder); PTS gaps surfaced via a diagnostic, never hidden. DTS == PTS during rolling capture (no B-frames live). No wall-clock anywhere.
- **Container for the rolling segment buffer:** **fragmented MP4 (fMP4)**. Init segment written once (`+empty_moov`). ~250 ms fragments (`+frag_keyframe+default_base_moof+separate_moof`). Sample-table-indexed so T-006 doesn't have to parse NAL units. Rejected alternatives recorded: raw ES (no PTS), MPEG-TS (~2% framing overhead + PCR/PMT cost), Matroska (less-mature concat path; final container is MP4 anyway).
- **Container / codec for final export:** plain MP4 with `moov` at front (`+faststart`). Same codec as captured. **Stream copy by default.** AAC-LC for audio when the audio path lands.
- **Replay finalisation / remux policy:** (a) trim on IDR → pure stream copy; (b) trim mid-GOP → head and tail GOPs re-encoded with **libx264 only**; (c) trim spans a `formatChanged` → cross-boundary re-encode with libx264; (d) muxer validation fails → full libx264 re-encode + diagnostic; (e) "Maximum compatibility" toggle → full libx264 re-encode. **Every Linux re-encode path uses libx264. The hardware encoder is never asked to re-encode.** This is the v1.1.0 lesson preserved explicitly.
- **When Linux HW encode runs vs falls back:** HW for live capture and rolling write (when probe passed and DMA-BUF was negotiated). CPU (libx264) for every finalisation re-encode case, categorically. Three-line rule: **HW for live, CPU for re-encode, no exceptions.**
- **Diagnostics counters (1 Hz tick + state-change events):** backend, state, fragment index, gop_count, idr_forced/unforced, frames_in/encoded/dropped (split into back-pressure, format-mismatch, pts-regression), pts_gap_events_total, encode_latency_ms (p50/p95/p99), bitrate observed vs target, vbv_underruns_total, dmabuf_import_success/failure_total, shm_copy_bytes_total, convert_cost_ms_per_frame, hwenc_runtime_errors_total, encoder_uptime_ms. Pairs with N-003 §14 capture counters and T-006 segment counters so a dropped frame can be attributed to capture vs encode vs segment write without re-running.
- **Error/failure reason codes:** `encoder-probe-failed`, `encoder-init-failed`, `encoder-format-rejected`, `encoder-import-failed`, `encoder-runtime-error`, `encoder-disconnected`, `encoder-back-pressure` (diagnostic, not fatal), `encoder-fallback-engaged` (informational). Every `sessionLost` carries backend + last `frames_encoded_total` + `encode_latency_ms.p99` + last 30 s of encoder counters into `$XDG_STATE_HOME/cove-screen-recorder/diagnostics/<sessionId>.json`.
- **Encoder fallback reporting (loud, never silent):** `encoder.probeResult` (full matrix), `encoder.selected` (chosen backend + codec), `encoder.fallbackEngaged` with reason (`no-hw-vendor` | `probe-failed` | `shm-forced` | `negative-cache-hit` | `windows-amd-deferred`), `encoder.runtimeError`, `encoder.backPressure`. **UI MUST display the selected backend + fallback indicator in the recording status bar at all times.**
- **Mid-session encoder switching is forbidden.** On `encoder-runtime-error`: end the session, mark the cached HW path negative, surface the error. The user retries; the cached negative routes the next session straight to libx264 with the fallback indicator. Three clicks, full transparency, no silent SPS/VPS change inside a single bitstream.
- **T-006 consumption contract (binding):** `EncoderBackend` exposes `init_segment() -> Bytes` (once) and a channel of `EncodedFragment { fragment_index, pts_start_90k, pts_end_90k, duration_90k, is_keyframe_first, moof_offset_in_buf, mdat_offset_in_buf, bytes, sample_table }`. T-006 does not parse NAL units. Back-pressure: `SegmentSink::push_fragment` returns `Pending` when disk queue is full; encoder drops the **oldest unflushed fragment** (replay buffer prioritises recency) and increments the back-pressure counter.
- **Deferred:** AV1 (any vendor), AMF on Windows, HDR end-to-end tone-mapping, user-facing rate-control overrides, audio encode (AAC-LC planned, separate ticket), macOS VideoToolbox, mid-session encoder reconfig beyond IDR forcing, per-source encoder choice in multi-stream.

Validation cases are enumerated in N-004 §20 (probe phase, live capture, fragment/segment contract, export/finalisation, fallback transparency) and feed T-009 directly.

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
