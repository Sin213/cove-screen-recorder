# VAL-ENC-006 — BLOCKED

## N-008 criterion (verbatim, row 223)
> | VAL-ENC-006 | Selected backend visible in UI | smoke / must-pass | manual | any | `Settings → Diagnostics` shows current `encoder.selected`; HUD shows compact badge | encoder / ui |

## Disposition: BLOCKED

The v2 renderer does not display encoder selection information anywhere in the UI.

### Evidence

**Helper emits the notification:** `helper/src/encoder/mod.rs:149` emits `encoder.selected` after probe completion.

**Electron forwards it:** `electron/main.ts:102` forwards `encoder.selected` → `cove/encoder/selected` to renderer.

**Preload exposes it:** `electron/preload.ts:132` provides `onSelected` callback under `coveApi.encoder`.

**Renderer does NOT subscribe:** Zero references to `encoder.selected`, `coveApi.encoder`, or `onSelected` in `src/v2/`. The v2 engine.ts does not subscribe to any encoder notifications.

**No Settings → Diagnostics panel exists:** The app has no "Settings" page. The v2 `<Diagnostics />` component (`src/v2/Diagnostics.tsx:90-148`) shows only: engine crash/unavailable banner, export progress bar, and recovery banner. No encoder selection display.

**No HUD encoder badge:** During RECORDING, the HUD shows `REC · {time}` (`src/App.tsx:1267`) and the action bar shows `Recording · {time}` (`src/App.tsx:879`). Neither includes an encoder badge. The status subtitle shows `{mode} · {preset} · {codec}` (`src/App.tsx:890`) but this reflects the v1 preset codec name (e.g. "h264"), not the v2 helper's `encoder.selected` backend (e.g. "nvenc").

### Code references
- `helper/src/encoder/mod.rs:149` — `encoder.selected` notification emitted
- `electron/main.ts:102` — forwarded to renderer
- `electron/preload.ts:132` — `onSelected` callback exposed
- `src/v2/engine.ts` — no subscription to `encoder.*` notifications
- `src/v2/Diagnostics.tsx` — no encoder display

### Blocking reason
The IPC pipeline for encoder selection exists (helper → electron → preload) but the v2 renderer does not consume it and the UI does not display it. Both criterion legs (Settings → Diagnostics display AND HUD compact badge) require UI implementation.

## Date: 2026-05-23
