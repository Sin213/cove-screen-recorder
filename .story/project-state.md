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

## v2.0.0 rolling replay segment buffer (T-006, 2026-05-13)

The replay buffer layer of the v2 helper is locked. Full design in `.story/notes/N-005.json`. Summary:

- **Storage model:** **one fMP4 segment file per GOP, ~2 s, written incrementally as fragments arrive, atomically committed at GOP boundary.** Rejected alternatives recorded: in-memory-only ring (reintroduces v1.1.0 RAM ceiling and loses everything on crash); one file per 250 ms fragment (1200 files / 5 min, no upside); larger N-GOP segments (eviction loses too much head, no upside). Each `.m4s` starts with an IDR-fronted fragment and is independently decodable.
- **On-disk layout (Linux):** `$XDG_STATE_HOME/cove-screen-recorder/replay/<sessionId>/` containing `init.mp4` (init segment, fsync'd before any fragment), `manifest.json` (clean-shutdown digest), `index.jsonl` (append-only event log: add / evict / discontinuity), `current.txt` (recovery hint), `pid.lock` (live-session exclusive lock), `segments/seg-XXXXXXXX.m4s` (committed), `segments/seg-XXXXXXXX.partial` (in-flight). Windows: same shape under `%LOCALAPPDATA%`. `<sessionId>` is a UUID.
- **Segment naming:** `seg-<index>.m4s`, 8-digit zero-padded monotonic integer from 1. Lexicographic = chronological. In-memory `SegmentRecord` carries `index`, `path`, `pts_start_90k`, `pts_end_90k`, `duration_90k`, `byte_size`, `is_keyframe_first`, `discontinuity`, `fragment_count`, `sample_table`, `pinned_by`, `committed_at_ns`.
- **Atomic write/rotate protocol:** fragments appended to `.partial`; at next GOP boundary fsync, atomic `rename(.partial, .m4s)`, append + fsync `index.jsonl`, parent-dir fsync, update `current.txt`. fsync only at commit (0.5 Hz), never per-fragment. POSIX `rename(2)` / NTFS `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` give the atomicity guarantee. Crash cost is at most one GOP (~2 s) — identical to the IDR cadence the user already cannot save below.
- **Replay window presets exposed:** **30 s, 60 s, 2 m, 5 m, 10 m.** Underlying `replay_window_seconds` accepts integer `[10, 1800]`. 10 min is the longest default; longer requires advanced settings (4K60 at 30 min is ~11 GB and most users do not want to burn that). Floor of 10 s avoids GOP-rounding jitter.
- **Eviction policy:** two limits in parallel, first tripped wins. Window limit (primary): committed duration > `replay_window_seconds + 1 GOP` headroom. Byte limit (safety net): bytes > `disk_cap_bytes` = `max(window_s × target_bitrate_bps / 8 × 1.5, 1 GB)` clamped to 8 GB user-configurable ceiling. **Eviction runs after every commit, never before.** Per-segment granularity (fragments inside a GOP are not independently decodable past the first). Pinned segments cannot be evicted; eviction defers and tries again next commit.
- **Save snapshot model (the v1.1.0 freeze-during-save fix as contract):** on `replay.save(N)` — (1) call `encoder.force_idr_now()`, (2) wait for next IDR-fronted fragment (≤ 250 ms + encoder latency), (3) commit the in-flight segment, (4) pin `ReplaySnapshot { snapshot_id, session_id, init_segment_path, segments: Vec<SegmentRef>, trim_start_pts_90k, trim_end_pts_90k, codec, timescale, width, height, framerate_hint, has_discontinuity, discontinuity_at_pts_90k }`, (5) return immediately. **Snapshot is paths, not bytes.** Capture and encode continue uninterrupted; T-007 reads pinned files on a separate task. `replay.snapshot_release(snapshot_id)` ends the pin; deferred evictions then unlink.
- **Format-change handling:** encoder forces IDR + `discontinuity: true` on `formatChanged` (N-004 §19). T-006 closes current segment, opens new one with `discontinuity = true`, records it in `index.jsonl`. Snapshot exposes `has_discontinuity` and crossing PTS list. T-007 re-encodes across each crossing with libx264 only (N-004 §13.3). The session itself is not split.
- **Crash safety:** every `.m4s` is the product of completed atomic rename + fsync + parent-dir fsync; survives. Every `.partial` is discarded on recovery. `init.mp4` fsynced before any fragment; `manifest.json` written atomically (tmpfile + rename) at clean shutdown only. Recovery triage layers: `manifest.json` (trust) > `index.jsonl` replay (cross-checked against fs) > fs scan (parse fMP4 header for orphan `.m4s` files from rename-without-jsonl-append crashes). User sees a "We found a recording from your last session" prompt with Save / Discard.
- **Failure reason codes:** `segment-sink-pressure` (diagnostic), `segment-sink-disk-full` (fatal, may carry `pinned_by_save` sub-reason), `segment-sink-slow` (diagnostic), `segment-sink-fsync-failed` (fatal, retries once), `segment-sink-rename-failed` (fatal), `segment-sink-state-dir-unwritable` (refuses to start session), `segment-sink-vanished` (fatal). Every `sessionLost` carries the last 30 s of T-006 counters into `$XDG_STATE_HOME/.../diagnostics/<sessionId>.json` (matches N-003 §13 and N-004 §17).
- **I/O budget at worst case (4K60 / 50 Mbps):** 6.25 MB/s sustained, ~1.56 MB per 250 ms fragment, one fsync per 12.5 MB, file-create rate 0.5/s, ~150 inodes for 5-min buffer, ~850 KB in-memory index for 10-min buffer. Comfortable on NVMe, SATA SSD, modern HDD, USB 3.0 external. USB 2.0 is the documented boundary at 4K60.
- **Diagnostics counters (1 Hz + state transitions):** `fragments_received_total`, `fragments_dropped_orphan_total`, `segments_committed_total`, `segments_evicted_total`, `segments_pinned_count`, `segments_count_on_disk`, `bytes_on_disk_total`, `bytes_written_total`, `evict_bytes_freed_total`, `evict_blocked_by_pin_total`, `disk_write_latency_ms.{p50,p95,p99}`, `fsync_latency_ms.{p50,p95,p99}`, `rename_latency_ms.{p50,p95,p99}`, `push_fragment_pending_events_total`, `back_pressure_sustained_ms`, `save_snapshots_taken_total`, `save_snapshots_active`, `partial_segment_recovered_total`, `partial_segment_discarded_total`, `formatchange_segments_total`, `buffer_window_seconds_observed`, `buffer_bytes_pct_of_cap`. **Pairs with N-003 §14 + N-004 §16 to triangulate "where did the dropped frame happen?" — capture, encode, or segment — without re-running.**
- **v1.1.0 freeze-during-save invariant preserved by four structural choices** (in importance order): snapshot is paths not bytes; eviction defers to pins (not the reverse); encoder ↔ sink async with back-pressure so save can never starve live capture; force-IDR-on-save bounded to ≤ 250 ms. Contract owed: `replay.save(...)` returns within ≤ 250 ms + encoder fragment latency, capture rate identical before/during/after.
- **Audio future:** parallel `audio/aud-XXXXXXXX.m4s` directory slot reserved in the layout. Audio commits aligned to video segment boundaries; snapshot extends with `audio_segments: Vec<SegmentRef>`. Audio encode itself is a separate ticket.
- **T-007 consumption contract (binding):** T-007 receives `ReplaySnapshot`, reads on a separate task, calls `replay.snapshot_release` on completion (success or failure). Concat + `+faststart` for trim-on-IDR (no re-encode); head/tail GOP re-encode with libx264 for trim-mid-GOP; libx264 re-encode across each discontinuity; libx264 full re-encode under "Maximum compatibility" toggle. T-006 never reads snapshot files itself — only appends, renames, unlinks, fsyncs.
- **Deferred:** audio encode, multi-stream replay, user-facing replay-window UI (T-008), file encryption, cloud upload, manual eviction, pause/resume design beyond the trait. Open implementation items (non-blocking): muxer = ffmpeg `movenc`, Windows `FlushFileBuffers` semantics, `statvfs`/`GetDiskFreeSpaceEx` pre-session disk probe, `index.jsonl` compaction at clean shutdown only.

Validation cases are enumerated in N-005 §19 (steady-state writing, eviction, save/snapshot concurrency, crash recovery in three flavours, format-change spanning, failure surfaces, and the v1.1.0 regression assertion) and feed T-009 directly.

---

## v2.0.0 instant replay export/remux pipeline (T-007, 2026-05-13)

The export layer of the v2 helper is locked. Full design in `.story/notes/N-006.json`. Summary:

- **Responsibility scope:** consumes a `ReplaySnapshot` (T-006 §5), turns the pinned fMP4 segments into a single MP4 file with `+faststart`, on a separate Tokio task that NEVER blocks capture, encode, or segment writing. Calls `replay.snapshot_release(snapshot_id)` exactly once on terminal outcome. Read-only against the segment buffer. Does NOT implement audio encode (slot reserved), does NOT touch encoder configuration, does NOT decide UI placement (T-008).
- **State machine:** `IDLE → QUEUED → PROBING → PLANNING → EXECUTING(COPY|REENCODE_HEAD|REENCODE_BRIDGE|REENCODE_FULL) → MUXING → VALIDATING → FINALIZING → DONE`. Any state can transition to `CANCELLING → CANCELLED` (except VALIDATING / FINALIZING, where cancel is rejected) or to `FAILED`. Every transition emits an IPC event; the UI never has to infer state from elapsed time. **This is the structural answer to "the UI froze during save."**
- **Operating modes (binding, chosen once in PLANNING):**
  - **`fast`** — stream-copy concat into MP4 + `+faststart`. Preconditions: head trim on IDR/segment boundary, no discontinuity, all segments share codec/profile/level/timescale/dims/pixel_format/SPS/PPS. Sample timing preserved exactly; observed cadence = `(trim_end − trim_start) / sample_count`.
  - **`lead-reencode`** — head GOP re-encoded with **libx264 only** (Linux rule from N-004 §13: HW for live, CPU for re-encode, no exceptions); tail stream-copied; concat into MP4. Re-encoder parameters match source profile/level/colour/timebase; ends with a fresh IDR for clean concat.
  - **`discontinuity`** — bridge intervals `[Pc − 1 GOP, Pc + 1 GOP]` around each crossing re-encoded with libx264; compatible stretches stream-copied. Escape valve: if bridges exceed 60 % of total, escalate to `full-reencode` BEFORE execution starts. Mode is locked once execution begins.
  - **`full-reencode`** — user toggle "Maximum compatibility" or escape valve from `discontinuity`. Single libx264 pass, preset `medium`, CRF 20, GOP 2 s. Plain MP4 + `+faststart`. Linux NEVER asks HW to re-encode.
- **Planning matrix (first match wins):** (1) user "Max compat" toggle → `full-reencode`; (2) discontinuity present → `discontinuity` or `full-reencode` per 60 % rule; (3) any pairwise mismatch in codec/profile/level/timescale/dims/pixel_format/SPS/PPS → `full-reencode`; (4) trim mid-GOP at leading edge → `lead-reencode`; (5) otherwise → `fast`. PLANNING produces a `PlanReport { mode, copy_ranges, reencode_ranges, est_output_bytes, est_duration_s, expected_fps }` carried in `export.started`.
- **Cadence preservation (v1.1.0 lesson made structural):** fast and lead-reencode preserve sample timing exactly via the MP4 sample table — no re-stamping, no implicit CFR coercion. Discontinuity and full-reencode pass real PTS deltas through the decoder→encoder; libx264 is invoked with passthrough vsync. `samples_duplicated_total` MUST be zero; non-zero is a defect and triggers a diagnostics dump. **No fake 60 fps.** `fps_observed_out` is computed from the muxed sample table, not parsed from ffmpeg stderr.
- **Audio sidecar slot (future-proofing):** mux step has `if let Some(audio) = snapshot.audio_segments { ... }`. v2.0.0 audio plan: AAC-LC, single track, shared `t0_ns` with video (v1.1.0 audio sidecar stability fix expressed as contract). Audio is ALWAYS stream-copied even when video re-encodes; audio trim is sample-accurate via `edts/elst` edit list, not by re-encoding the head AAC frame. If `audio_segments.is_none()`, video-only MP4 with no behaviour change. Audio encode itself = separate ticket.
- **Final file naming / temp strategy:** default output dir `$XDG_VIDEOS_DIR/Cove Replays/` (Linux), `%USERPROFILE%\Videos\Cove Replays\` (Windows), created lazily, mode 0700. Final name `Replay-<YYYY-MM-DD>-<HHMMSS>-<duration>s.mp4` with `-<n>` collision suffix. Temp: `<output_dir>/.cove-replay-<snapshot_id>.partial.mp4` — same FS as final to keep rename atomic. Orphan tracking via append-only `$XDG_STATE_HOME/cove-screen-recorder/exports/manifest.jsonl` (start line before temp create, end line on terminal outcome).
- **Atomic final move:** fsync temp fd → close → SHA-256 compute (single sequential read) → POSIX `rename(2)` / Windows `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` → directory fsync (Linux) or `FlushFileBuffers` on dir handle (Windows) → manifest append `outcome = success` → emit `export.completed`.
- **Snapshot release policy (binding, exactly-once):** owned by a `SnapshotGuard(Arc<Snapshot>)` whose `Drop` releases the pin if no terminal outcome has fired. Release sites: explicit before `export.completed`; via Drop on FAILED / CANCELLED / panic / helper exit. `#[must_use]`; debug-build panic on drop-without-outcome. Pin released exactly once across success, failure, cancel, and helper crash.
- **Cancel semantics:** checked at sub-stage boundaries. COPY between segments (≤ 2 s of unfinishable work). REENCODE_* drains ffmpeg gracefully up to 5 s, then SIGKILL. MUXING discards the in-progress moov/mdat write; temp unlinked. VALIDATING / FINALIZING reject cancel (rename race window); UI disables the button. On successful cancel: temp unlinked, snapshot released, `export.cancelled` emitted. No partial-file recovery — cancel always discards.
- **Queue behaviour:** single-worker FIFO. Each `replay.save(...)` pins its own snapshot immediately (T-006 §5) — user CAN keep saving while another export runs. Queue depth cap 8; ninth submission returns `export.rejected(queue-full)` and immediately releases its snapshot. Queue is in-memory only; helper crash loses queue state but T-006 recovery offers orphaned snapshots back to the user.
- **Anti-freeze invariants (structural):** (1) snapshot is paths not bytes; (2) export runs on dedicated Tokio task with no locks shared with capture/encoder; (3) every state transition emits an IPC event — UI spinner bound to event lifecycle, not a timer; (4) watchdog per-export fires `export.stalled` if no progress for 5 s/COPY, 10 s/REENCODE_*, 2 s/MUXING+VALIDATING+FINALIZING (surfaces stall but does NOT auto-kill); (5) ffmpeg invocations are bounded one-try with structured errors — NEVER a retry loop (the v1.1.x bug); (6) capture is not paused for any export stage, even REENCODE_FULL of a 10-minute snapshot.
- **Failure modes (binding catalogue):** `snapshot-read-failed`, `probe-sps-pps-missing`, `ffmpeg-spawn-failed`, `ffmpeg-exited-nonzero` (carries last 8 KB stderr), `reencode-libx264-missing`, `mux-faststart-failed`, `validate-ffprobe-failed`, `validate-first-frame-decode-failed`, `finalize-rename-failed`, `finalize-disk-full`, `cancel-requested`, `helper-shutdown`. Each fatal dumps last 30 s of T-007 counters + the PlanReport into `$XDG_STATE_HOME/.../diagnostics/<export_id>.json` (same shape as N-003 / N-004 / N-005).
- **Helper exit mid-export:** `SnapshotGuard::Drop` releases the pin. Temp file is left as orphan. Next launch reads exports manifest, unlinks any temp whose start line lacks an end line, appends `outcome = orphan-cleaned`. T-006 recovery layers reclaim the underlying session and offer it via `replay.recoverable_sessions()`. User never sees a half-written `.mp4` in the output dir.
- **Diagnostics counters (1 Hz + transitions, pairs with N-003 §14 / N-004 §16 / N-005 §16):** `export_started_total`, `export_completed_total{mode}`, `export_failed_total{reason}`, `export_cancelled_total`, `export_queue_depth`, `export_queue_rejected_total`, `export_stage_duration_ms.{queued,probing,planning,copy,reencode_head,reencode_bridge,reencode_full,muxing,validating,finalizing}.{p50,p95,p99}`, `bytes_in_total`, `bytes_out_total`, `bytes_copied_total`, `bytes_reencoded_in_total`, `bytes_reencoded_out_total`, `samples_total`, `samples_copied_total`, `samples_reencoded_total`, `samples_duplicated_total` (must be 0), `samples_dropped_total` (must be 0 outside trim), `reencode_seconds_total`, `reencode_pixels_total`, `reencode_libx264_kfps.{p50,p95}`, `fps_observed_in`, `fps_observed_out`, `fps_divergence_pct` (> 5 % triggers dump), `ffmpeg_spawn_latency_ms.{p50,p95,p99}`, `ffmpeg_exit_code_last`, `final_file_move_latency_ms.{p50,p95,p99}`, `final_file_size_bytes`, `final_file_sha256_compute_latency_ms`, `temp_file_orphan_cleaned_total`, `exports_manifest_append_latency_ms.{p50,p95}`. **Triangulates which layer caused any delay: snapshot vs probe vs copy vs re-encode vs mux vs finalize.**
- **Event surface (binding for T-008):** `export.queued`, `export.started{plan: PlanReport}`, `export.progress{stage, pct, bytes_in, bytes_out, samples_processed, samples_total, eta_ms}` at ≥ 1 Hz, `export.stalled{stage, last_progress_ms_ago}`, `export.completed{final_path, bytes, sha256, duration_s, mode, fps_observed_out}`, `export.failed{stage, reason_code, details, diagnostics_path}`, `export.cancelled{stage, partial_bytes}`, `export.rejected{reason}`. Exactly one terminal event per `export_id`. UI spinner ends when the terminal event arrives — the freeze bug cannot reoccur.
- **T-008 consumption contract:** Electron NEVER sees frames, NEVER sees segment paths, NEVER touches ffmpeg directly. Methods: `replay.save(N) → ReplaySnapshot`, `replay.export_start(snapshot, ExportOptions{output_path, max_compat, audio_mode}) → export_id`, `replay.export_cancel(export_id)`, `replay.snapshot_release(snapshot_id)`. Renderer renders `export.*` events.
- **Deferred:** audio encode (slot reserved), HDR tone-mapping policy, AV1 export, trim-adjust UI, cloud upload, multi-track audio exports, subtitle/overlay burning, per-export bitrate override, GIF / WebM / image-sequence export. Open implementation items (non-blocking): ffmpeg subprocess vs library (default subprocess), libx264 thread count default = `min(num_cores − 2, 8)`, Windows long-path support on output dir, manifest fsync per-append vs batched (default per-append).

Validation cases enumerated in N-006 §18 cover: fast path on all four backends × {1080p60, 1440p60, 4K60} × {12, 25, 50 Mbps}; lead trim re-encode at every preset duration; discontinuity bridging (one and two crossings); 60 % escape-valve trigger; max-compat forces libx264 even when source was HW; cancel at every stage including the rejection at VALIDATING / FINALIZING; helper SIGKILL recovery; jittery capture cadence preservation; player compatibility (VLC / mpv / Chrome / WMP / QuickTime / ffprobe no-warnings); multi-save queue ordering and queue-full rejection; near-disk-full at output dir AND at state dir. These feed T-009 directly.

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
