# Handoff: GIF hotkey overlay lifecycle ordering fix

## Scope

Fix the global GIF hotkey crop overlay teardown ordering so:
1. Overlay unmounts completely before any recording state transition
2. One drag auto-starts recording (no confirm click needed)
3. Crop UI never visible during recording

## Root cause

`setPendingCrop(null)` and `setStatus("preparing")` were batched in the same React render. The overlay removal and recording-HUD transition painted simultaneously, so the crop modal was still visible when capture began.

## Fix

**`src/App.tsx` — `confirmCrop`**: Split into three phases:
1. `setPendingCrop(null)` — unmount overlay (this render only)
2. `await rAF + 200ms` — React paints removal, compositor settles
3. `setStatus("preparing")` + start capture — recording state begins after overlay is gone

**`src/App.tsx` — `beginCrop`**: Accept explicit `autoStart` parameter. Only the GIF hotkey call site (`action === "gif"`) passes `true`. Manual crop mode is unchanged.

**`src/components/CropOverlay.tsx`**:
- `autoStart` prop: `onPointerUp` auto-confirms drawn region, no button click
- Pointer capture ensures release outside overlay still confirms
- Manual mode unchanged: draw region, click "Start recording"

## Files changed

- `src/App.tsx`
- `src/components/CropOverlay.tsx`
