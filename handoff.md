# Handoff: GIF hotkey crop overlay timing fix

## Scope

Fix the global GIF hotkey path so:
1. One drag-to-select auto-starts recording on mouse release (no confirm click)
2. CropOverlay never appears in captured frames

Manual crop mode (non-GIF) is unchanged: draw region, click "Start recording."

## Problem

The GIF hotkey calls `beginCrop("gif")` which on Wayland shows the CropOverlay. Two issues:
- Recording started before React removed the overlay from the screen → overlay in first frames
- The hotkey path required a manual "Start recording" click, breaking the one-drag flow

## Fix

**`src/components/CropOverlay.tsx`**:
- Added `autoStart` prop. When true, `onMouseUp` auto-confirms the drawn rectangle (no button needed). The "Start recording" button is hidden; hint text says "recording starts on release."
- Refactored `handleConfirm` into `confirmRect(rect)` so `onMouseUp` can pass the final rect directly (avoids stale React state from batched updates).

**`src/App.tsx`**:
- `pendingCrop` state now carries `autoStart: boolean`, set to `true` when `presetId === "gif"`.
- `confirmCrop` awaits `requestAnimationFrame` + 150ms after removing the CropOverlay, before starting capture — ensures compositor settles.
- `autoStart` passed through to `<CropOverlay>`.

## Files changed

- `src/App.tsx`
- `src/components/CropOverlay.tsx`

## Not touched

- Normal (non-GIF) crop mode manual confirm flow
- Replay recording, MP4 recording, export pipeline
- X11 crop path, validation artifacts
