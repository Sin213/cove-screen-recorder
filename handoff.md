# Handoff: GitHub Issues #1, #3, #4, #6

## Scope

Address all 4 open GitHub issues filed by external user kraibse against v1.1.0 on CachyOS (KDE Wayland).

## Changes

### Issue #3 — Recording doesn't start until hover on KDE Wayland
**File**: `src/recorder-client.ts`

- Disabled mute-based `markTargetLost()` on Linux (line ~963). PipeWire fires `mute` when the source window isn't focused — normal behavior, not window closure.
- Increased frame-watchdog tolerance on Linux from 5s to 60s (line ~992). PipeWire may pause frame delivery when a window isn't composited. Track `ended` event remains the reliable closure signal.

### Issue #4 — Timer doesn't reset / counts incorrectly in replay buffer
**Files**: `src/recorder-client.ts`, `src/App.tsx`

- Added 1s `setInterval` timer tick so the timer updates independently of MediaRecorder chunk arrival (fixes timer stuck at 0 before hover).
- Removed `Math.min(opts.lengthSeconds, ...)` cap — timer now shows session duration, not buffer fill.
- Removed `chunks > 0` gate on `state()` — timer starts immediately.
- Added `setReplayBuffered(0)` at start of `startReplayWithSource` — ensures reset between sessions.
- Clear timer interval in `handleStop`.
- New `formatReplayTime()` in App.tsx — shows `1min 30s` instead of raw `90s`.

### Issue #1 — Crop region selector on Wayland
**Files**: `src/recorder-client.ts`, `src/App.tsx`, `src/components/CropOverlay.tsx` (new)

- Refactored `startCaptureViaDisplayMedia` into `acquireDisplayMediaStream` + `startCaptureFromAcquiredStream` to support acquiring the portal stream first, previewing for crop selection, then starting recording with the crop rect — avoids double portal prompts.
- New `CropOverlay` component: drag-to-draw rectangle on live video preview with dimension display, dark overlay mask, confirm/cancel buttons.
- Modified `beginCrop` on Wayland: acquires stream → shows CropOverlay → starts recording with selected CropRect (replaces old "use system dialog" hint).
- Added `confirmCrop` and `cancelCrop` callbacks; `cancelCrop` stops the preview stream tracks.

### Issue #6 — GitHub Actions CI/CD
**Files**: `.github/workflows/ci.yml` (new), `.github/workflows/release.yml` (new), `package.json`

- CI workflow: runs on push/PR to main — TypeScript type-check, Rust clippy + build, electron-builder dry-run.
- Release workflow: runs on v* tag push — Linux (AppImage + deb) and Windows builds, `.sha256` checksums, GitHub Release.
- Added Windows helper binary + checksum to `win.extraResources` in `package.json` so `electron-builder --win` packages the helper at the runtime path `EngineSupervisor` resolves.

## Verification

- `tsc --noEmit` passes for all 3 tsconfigs (renderer, electron, validation)
- `vite build` succeeds (54 modules, no errors)

## Design notes

- `waitForFirstFrame` is intentionally NOT changed. The reporter's logs show it succeeds ("Replay buffer started") — the blocker is post-startup frame absence, which the mute-handler and watchdog-tolerance changes address. Changing `waitForFirstFrame` would break the portal-picker flow where the wait gates on user source selection.
- `confirmCrop` failure path now stops the acquired stream tracks to prevent portal session leak.
- Windows release job now includes the Rust helper build. The helper's Linux-only deps (pipewire, ashpd) are behind `cfg(target_os = "linux")`, so it compiles on Windows.
- Windows `win.extraResources` in package.json now includes `cove-replay-engine.exe` and its checksum, matching the Linux config.
- Release workflow includes `*.yml` updater metadata files in the GitHub Release upload for electron-updater compatibility.

## Out of scope

- Manual testing on KDE Wayland (requires the target environment)
- Rust helper changes
- Release artifacts or version bumps
