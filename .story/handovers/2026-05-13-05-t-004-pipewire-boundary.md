# Handover — T-004 PipeWire capture backend boundary

**Date:** 2026-05-13
**Session type:** Design only (planning, no code)
**Repo:** `/home/sin/Projects/cove-screen-recorder`
**Branch:** `main` (clean coming in; only `.story/` files changed during this session)
**Ticket:** T-004 (Design PipeWire capture backend boundary)
**Status going out:** T-004 `complete`

---

## What was decided

The Linux capture surface for the v2 sidecar is locked. PipeWire via `xdg-desktop-portal` ScreenCast is the only supported path. X11 and Wayland-without-portal are skipped entirely. The full design lives in `.story/notes/N-003.json` (the boundary, trait surface, portal flow, buffer negotiation, failure handling, diagnostics, and validation cases) and is summarised in a new section of `.story/project-state.md`.

The chosen boundary in one paragraph: Electron is reduced to a control plane that issues `requestSession` / `startStream` / `pauseStream` / `resumeStream` / `stopSession` / `setRegion` / `setFramerateHint` / `setCursorMode` and listens for `sessionReady` / `formatChanged` / `streamPaused` / `streamResumed` / `sessionLost` / `diagnostics`. Inside the helper, the capture orchestrator owns the D-Bus portal connection, the PipeWire core/loop, every `pw_stream`, SPA param negotiation, DMA-BUF/SHM negotiation, modifier handling, restore-token persistence, the in-process frame channel into the encoder, and failure classification. Frames flow from `pw_stream` -> `CaptureSource` trait -> encoder backend *inside the helper*; they never cross IPC. Electron never sees a frame.

---

## Boundary summary (single source of truth: `.story/notes/N-003.json`)

- **Five layers, top down:** Electron UI -> IPC contract (T-008) -> helper capture orchestrator -> `CaptureSource` trait -> portal session + `pw_stream`.
- **Electron-facing capture methods (names locked in T-008):** `requestSession`, `startStream`, `pauseStream` / `resumeStream`, `stopSession`, `setRegion`, `setFramerateHint`, `setCursorMode`.
- **Helper -> Electron events:** `sessionReady` (explicit readiness -- replaces the v1.1.0 timer-based guess), `formatChanged`, `streamPaused` / `streamResumed`, `sessionLost` (typed reason code), `diagnostics`.
- **`CaptureSource` trait:** `caps()`, `current_format()`, `frames()` async stream of `FrameHandle` (PTS, fourcc, modifier, `DmaBuf | Shm` payload, optional cursor meta, `ReleaseToken` for buffer return), `pause()` / `resume()` / `stop()`. The encoder backend (T-005) consumes this trait directly. No PipeWire type leaks past it. The trait is shaped so `WgcSource` (Windows) and `ScreenCaptureKitSource` (macOS) slot in without reshape -- both are out of scope for T-004.
- **Capture modes for v2.0.0:** `monitor`, `window`, `region`. Region is composed (monitor capture + encoder-boundary crop). `virtual`, multi-stream replay, X11, and non-portal Wayland are deferred.
- **Buffer negotiation:** DMA-BUF preferred with modifier list intersected against the encoder backend's import support; linear DMA-BUF fallback before SHM; SHM accepted as last resort; failure to find any acceptable mode is a hard `sessionLost(no-acceptable-buffer-type)`, never a silent slow path.
- **Format preference:** NV12 -> P010 (encoder-gated) -> RGB (encoder-side convert). No capture-layer scaling or letterboxing. Source-native resolution accepted as-is.
- **Framerate hints:** advisory only. Capture layer never synthesises duplicate frames (this fixes v1.1.0's fake-60fps failure).
- **Cursor modes:** map to portal `Hidden | Embedded | Metadata`. Default `embedded` for v2.0.0; `metadata` preferred long-term, gated on compositor capability with transparent downgrade.
- **Dynamic resolution changes:** `OnParamChanged` triggers buffer renegotiation, emits `formatChanged`, surfaces new caps through the trait. Encoder/segment layer absorbs the discontinuity. The capture layer never hides a format change.
- **Failure reason codes:** `portal-denied`, `portal-restore-rejected`, `portal-unavailable`, `pipewire-disconnected` (bounded reconnect), `pipewire-state-error`, `source-removed`, `no-acceptable-buffer-type`, `format-renegotiation-failed`, `compositor-paused` (soft), `encoder-disconnected`. Every `sessionLost` carries a structured `details` blob (compositor name, PipeWire version, last format, last cursor mode). On loss, the last 60 s of diagnostics dumps to `$XDG_STATE_HOME/cove-screen-recorder/diagnostics/<sessionId>.json`.
- **Diagnostics invariant:** capture-layer reports buffers negotiated, in flight, dropped since last tick, total produced; observed cadence vs hinted framerate; compositor name; PipeWire core version; last negotiation latency. Combined with T-005 encoder counters and T-006 segment-buffer counters, a user can prove whether a dropped frame happened at capture, encode, or segment write without re-running. v1.1.0 cannot distinguish these layers; v2 must.

### Issue absorption

- **Issue #1 (crop area selection unclear/missing):** becomes the first-class `region` capture mode + `setRegion` method. Crop happens at the encoder boundary (NVENC `inputRect`, VAAPI/QSV VPP crop, or a single GPU shader pass) -- never on a JS canvas. Mid-stream region changes do not re-prompt the portal.
- **Issue #3 (source does not record until hovered):** eliminated by deleting the DOM / canvas / `getDisplayMedia` path entirely. The validation matrix includes a 60-second minimised-preview run that must produce the expected frame count -- this is the load-bearing assertion that v2 escapes the v1.1.0 ceiling.
- **Issue #4 (timer weirdness):** not directly in T-004 scope, but the explicit `sessionReady` event replaces v1.1.0's timer-based readiness guess. Whatever survives of #4 after T-002 is now structurally answered at the engine layer.

### Validation cases now committed (full enumeration in N-003 §17)

- Selection phase: cold launch picker, cold launch with stored restore token, stale restore token, user-cancelled picker, missing portal.
- Capture phase per mode: steady 60 fps for 60 s with zero capture-side drops, idle source with no synthetic frames, DMA-BUF on Mutter/KWin/Hyprland, SHM fallback on llvmpipe.
- Lifecycle: `pause`/`resume`, drag between monitors with DPI change, resize captured window, lock-screen pause, monitor disconnect, PipeWire daemon kill.
- Cursor: `embedded`, `hidden`, `metadata`, and `metadata`-with-downgrade.
- Region: rectangle apply, mid-stream rectangle change without portal re-prompt, out-of-bounds rectangle rejected cleanly.
- Hover regression: 60 s minimised-preview run producing the expected frame count.
- Diagnostics: structured per-second tick; on-failure 60 s dump file.

These feed T-009 directly.

---

## Exact `.story` files changed this session

- `.story/notes/N-003.json` -- **created**. Full design record.
- `.story/project-state.md` -- **modified**. New section `## v2.0.0 PipeWire capture backend boundary (T-004, 2026-05-13)`.
- `.story/tickets/T-004.json` -- **modified**. Status `open` -> `inprogress` -> `complete`. Description rewritten.
- `.story/handovers/2026-05-13-04-t-004-pipewire-boundary.md` -- **created**. This file (also written to disk).

**No source files were edited.** No `package.json`, no lockfile, no Electron / renderer / recorder / ffmpeg config, no build config, no CI, no tests.

---

## Out of scope (deferred -- explicitly recorded)

- No Rust code, no PipeWire prototype.
- Audio capture boundary (separate ticket).
- Virtual sources, multi-stream replay.
- X11 capture and Wayland-without-portal -- skipped, not deferred.
- HDR / 10-bit end-to-end pipeline -- capture supports P010 in principle; full path gated on T-005.
- Restore-token encryption -- JSON for v2.0.0; release-prep follow-up.
- Windows DXGI/WGC and macOS ScreenCaptureKit implementation -- trait shape only, mentioned for symmetry.
- IPC framing details (length-prefixed JSON-RPC was chosen in T-003; exact method shapes, error envelope, async runtime choice are T-008).

---

## Recommended next ticket

**T-005 -- Design encoder backend matrix and fallback policy.** T-004 froze the only contract T-005 needs: the `CaptureSource` trait and `FrameHandle` shape. T-005 can begin without any further design from T-004.

If a second planning tab is available, T-008 (UI <-> engine integration) can also start in parallel -- it now has the full Electron-facing method and event surface from this design. T-006 should wait for T-005.

---

## Codex review

**No Codex review needed.** This session only touched `.story/` planning files. Codex review remains gated on non-`.story` changes.

---

## Verification

```bash
git status --short
git diff --name-only
find .story -maxdepth 3 -type f | sort
```

Expected: all changes confined to `.story/`. No source-file diff.
