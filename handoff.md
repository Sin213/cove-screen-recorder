# GitHub Issues #7 and #8 - Desktop-file removal + unified toast system

## Task

Fix the two open GitHub issues:

- **#7** - Duplicate desktop shortcuts: `installLinuxDesktopFile()` collides with AppImageLauncher and its hardcoded `Exec=` path breaks after electron-updater replaces the AppImage. Fix per issue: remove the function and its call site entirely.
- **#8** - Unified toast notification system: Zustand-based toast queue, `ToastContainer` component, CSS variants, toast calls at v1 recording lifecycle points in `App.tsx`, and v2 engine lifecycle points in `src/v2/engine.ts`. Zero new dependencies.

## Scope (files changed)

| File | Change |
|------|--------|
| `electron/main.ts` | #7: removed `installLinuxDesktopFile()` (former lines 1426-1477) and its call in `app.whenReady()` |
| `src/store.ts` | #8: `Toast`/`ToastType` types, `toasts` state, `addToast` (per-type auto-dismiss defaults, stack capped at 5, oldest dropped), `removeToast` |
| `src/components/ToastContainer.tsx` | #8: new component - stacked toasts at fixed bottom-center, per-toast auto-dismiss timer (duration 0 = persistent), click to dismiss |
| `src/index.css` | #8: `.toast-stack` (z-index 60, below modals at 70), `.toast-item` + 4 type variants; removed now-dead `.hotkey-toast` rule (kept `toast-in` keyframes) |
| `src/App.tsx` | #8: removed `hotkeyToast` state/effect/render, mounted `<ToastContainer />`; toasts for ffmpeg-missing, recording start (all 4 v1 start paths), start failure, finalize save success/failure, replay buffer start/stop/fail, v1 replay save (persistent while in flight, then success/error); v2 hotkey path no longer sets the old toast (engine owns it) |
| `src/v2/engine.ts` | #8: toasts for engine ready / crashed, session lost (suppressed on user-requested stop via `stopCapture` flag), v2 recording started, persistent "Saving replay" toast in `saveReplay()` cleared on every terminal path (export completed/failed/cancelled, watchdog timeout, RPC rejection, no-snapshot, engine crash/unavailable) |

## Design decisions

- Toast durations per issue #8 table: info 3s, success 4s, warning 5s, error 6s, `duration: 0` persistent.
- The persistent v2 "Saving replay" toast lives in `engine.ts` (module-level id), because the export terminal events - not the `saveReplay()` promise - mark completion.
- `_userStopRequested` flag in `engine.ts` prevents a spurious "Capture session lost" warning toast when the operator stops capture intentionally.
- "Recording engine ready" success toast fires on BOOTING/ENGINE_DOWN/ENGINE_UNAVAILABLE -> IDLE transitions only (guard already existed), so it cannot repeat while IDLE.
- Existing log-panel entries, recording HUD, status pill, and `lastOutput`/`lastError` panel sections are unchanged (regression criterion in #8).

## Out of scope

- No new npm dependencies (criterion of #8).
- No changes to Gallery, Diagnostics, LogPanel, or release tooling.
- Pre-existing modified `handoff.md` was replaced by this handoff (it documented a completed prior pass).

## Verification

- `npm run typecheck` - PASS (renderer + electron + validation tsconfigs)
- `npm run build:renderer` - PASS
