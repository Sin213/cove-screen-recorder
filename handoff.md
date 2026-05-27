# Handoff: GIF hotkey crop overlay timing fix

## Scope

Fix the global GIF hotkey path so the CropOverlay modal never appears in captured GIF frames. Bounded to `confirmCrop` in `src/App.tsx` only.

## Problem

When the GIF hotkey fires, it calls `beginCrop("gif")` which on Wayland acquires a portal stream and shows the CropOverlay. On confirm, `setPendingCrop(null)` unmounts the overlay in React, but recording starts immediately — before React renders the removal and before the compositor removes it from the screen. The portal stream captures the entire screen including the Cove window, so the first GIF frames contain the crop-selection modal.

## Fix

In `confirmCrop`, after `setPendingCrop(null)`, await one `requestAnimationFrame` (React paint) plus a 150ms `setTimeout` (compositor settle) before starting capture. This ensures the overlay is fully gone from the screen before the first frame is recorded.

## Files changed

- `src/App.tsx` — 1 line added in `confirmCrop`

## Not touched

- Normal GIF mode flow, replay recording, MP4 recording, export pipeline, X11 crop path, validation artifacts
