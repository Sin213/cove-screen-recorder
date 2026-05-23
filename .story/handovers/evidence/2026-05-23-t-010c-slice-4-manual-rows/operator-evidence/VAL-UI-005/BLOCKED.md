# VAL-UI-005 — BLOCKED

## N-008 criterion (verbatim, row 284)
> | VAL-UI-005 | **Region overlay flow (Issue #1 proof)** | smoke / must-pass / regression | manual | `capture.mode === "region"` opens portal monitor pick, then frameless overlay with draggable rect; "Share region" string never appears in the UI; "Adjust region" mid-recording is hot | ui / capture |

## Disposition: BLOCKED

The v2 renderer UI (`VITE_COVE_V2_UI=1`) does not implement a region capture mode. The v2 "Start replay buffer" flow only initiates monitor capture via `v2StartCapture()` → `window.coveApi.capture.requestSession()` → PipeWire portal (full monitor pick). There is no `capture.mode === "region"` path, no frameless overlay, no draggable rect in the v2 code.

### Evidence

**Helper-side:** The helper supports `capture.setRegion` RPC (`helper/src/capture/pipewire.rs:2216`) and the protocol types define `region: Option<Rect>` (`helper/src/protocol/types.rs:93`). The IPC contract exists.

**Renderer-side:** Zero references to `region`, `setRegion`, `overlay`, or `capture.mode` in `src/v2/`. The v2 engine.ts `startCapture()` calls `window.coveApi.capture.requestSession()` without region parameters. The App.tsx v2 path (`v2UiEnabled && v2StartPending`) directly invokes `v2StartCapture()` with no mode selection.

**v1 path:** The v1 "Crop" mode (`mode === "area"`) uses the system portal crop feature on Wayland, which shows "Share region" in the system dialog — the exact string the criterion says must NOT appear. The v1 path cannot satisfy this criterion.

### Code references
- `src/v2/engine.ts:startCapture()` — no region/mode parameter
- `src/App.tsx:829` — v2 Start replay buffer onClick, no mode selection
- `helper/src/capture/pipewire.rs:2216` — `capture.setRegion` RPC handler exists but is unused by renderer
- `helper/src/protocol/types.rs:91-93` — `region: Option<Rect>` in protocol types

### Blocking reason
Region capture mode UI is not implemented in the v2 renderer. The helper IPC contract exists but the renderer does not expose it. This row requires v2 region capture implementation before it can be executed.

## Date: 2026-05-23
