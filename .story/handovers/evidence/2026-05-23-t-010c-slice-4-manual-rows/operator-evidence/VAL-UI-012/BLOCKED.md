# VAL-UI-012 — BLOCKED

## N-008 criterion (verbatim, row 291)
> | VAL-UI-012 | Hotkey `saveReplay` fires `replay.save` and shows toast | smoke / must-pass | manual | `Ctrl+Shift+R` fires save; `hotkeys.triggered` toast | ui |

## Disposition: BLOCKED

The hotkey fires the save action correctly, but the `hotkeys.triggered` toast notification system does not exist.

### What works

**Hotkey wiring:** The `replay` hotkey (default F8, configurable) is registered via `globalShortcut` in `electron/main.ts:693`. When pressed, electron sends `cove:hotkey` with action `"replay"` to the renderer (`electron/main.ts:694`).

**v2 save action:** The renderer handler in `src/App.tsx:490-505` correctly routes `action === "replay"` to `v2SaveReplay(replay.lengthSeconds)` when `v2State === "RECORDING"`. This calls `window.coveApi.replay.save()` which sends `replay.save` RPC to the helper.

**UI state transition:** After save, the UI transitions from "Save last X min" button → "Saving replay… (encoding to mp4)" text → export progress bar. This is visible feedback but is NOT a toast.

### What's missing

**No toast notification system:** The criterion requires a `hotkeys.triggered` toast — a transient notification confirming the hotkey was recognized. Zero references to `toast`, `Toast`, `Notification`, `snackbar`, `hotkeys.triggered`, or `hotkeys.refused` exist anywhere in `src/`. No toast component or notification container exists in the app.

**Hotkey binding note:** The criterion text says "Ctrl+Shift+R" but the actual default binding is F8 (`src/store.ts:46`, `DEFAULT_HOTKEY_BINDINGS.replay`). This is a matrix spec vs implementation mismatch but not the blocking issue — the binding is configurable and F8 works functionally.

### Code references
- `electron/main.ts:693-694` — globalShortcut register + IPC send
- `src/App.tsx:483-508` — onHotkey handler, routes `replay` to v2SaveReplay
- `src/v2/engine.ts:243` — `saveReplay()` sends `replay.save` RPC
- `src/store.ts:46` — default replay hotkey is F8

### Blocking reason
The hotkey → save pipeline is functional. The criterion's second leg — `hotkeys.triggered` toast — requires a toast/notification UI component that has not been implemented. The row cannot PASS without visible toast confirmation per the criterion.

### Partial evidence available
If the toast requirement were waived, the functional hotkey → save → export pipeline is exercisable. The save action, RPC to helper, and SAVING/EXPORTING state transitions are all wired and the UI reflects the save in progress.

## Date: 2026-05-23
