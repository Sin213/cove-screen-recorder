# T-029 — ISS-012 render/derived-state export diagnostics: scope

**Date:** 2026-05-23
**Ticket:** T-029 (open) · **Issue:** ISS-012 (open, unchanged)
**Type:** Evidence-only diagnostics. NO runtime behavior change except logging.

## Why this is evidence-only

T-026 already instruments the v2 export FSM (`src/v2/engine.ts`, `[export lifecycle]` lines).
But the *visible* stuck/disabled UI in a stuck-EXPORTING occurrence (ISS-012) also depends on
**App.tsx render/derived inputs** that the FSM layer never sees:

- `replaySaving` (App.tsx local `useState`)
- the computed `disabled` props on the Save-replay / Start-buffer / Record controls
- the derived HUD `recordingState` / `recordingLabel`

That render/derived layer was blind. T-029 adds additive logging so the next stuck-EXPORTING
occurrence can be classified to **one owning input** (FSM state vs a render/derived selector
holding the UI), WITHOUT changing any runtime behavior, FSM, timeout, helper, ffmpeg argv,
replay semantics, or validation policy. ISS-012 is **not** fixed here.

## Allowed surfaces touched

- `src/App.tsx` — additive `[export lifecycle][render]` logging only.
- `electron/main.ts` — additive file-sink for the existing `[export lifecycle]` forwarding logs.
- `.story/tickets/T-029.json` — ticket.
- this evidence dir + the session handover.

`src/v2/engine.ts` was **not** touched (verified: `git diff -- src/v2/engine.ts` empty).

## src/App.tsx — diagnostics added

All route through the existing store `log(level, text)` → LogPanel, tagged `[export lifecycle][render]`.

1. **Render snapshot effect** (after `bigButtonDisabled`): emits one line whenever any
   export-relevant input changes — `v2State`, `v2ExportId`, `v2SnapshotId`, `v2SessionId`,
   `v2ExportProgress`, `v2ExportOutputPath`, `replaySaving`, `status`, `saveControlsDisabled`,
   `startBufferDisabled`, `bigButtonDisabled`, `recordingState`, `recordingLabel`.
   `saveControlsDisabled` mirrors the Save-replay button's inline `disabled` prop
   (`replaySaving || v2State === "SAVING" || v2State === "EXPORTING"`); it is logging-only and
   drives no behavior (the button JSX is unchanged).
2. **v1 `saveReplay` start + finally** — confirms the v1 path entered/cleared `replaySaving`.
3. **v2 `saveReplay` call sites** (hotkey handler + Save-replay button onClick) — `start` before
   the call and `finally` after the returned promise settles, reading current `v2State` /
   `v2ExportId` / `v2SnapshotId` via `useStore.getState()`. The engine's own FSM logging
   (T-026) is unchanged; this only brackets the renderer's invocation.

New store selectors (`v2ExportId`, `v2SnapshotId`, `v2SessionId`, `v2ExportProgress`,
`v2ExportOutputPath`) were added in App.tsx purely to feed the snapshot line; `log` was added to
the hotkey effect dependency array for the new `log()` reference (stable store action — no extra
re-subscription).

## electron/main.ts — forwarding observability added

- New best-effort `exportLog(line)` helper: `console.log(line)` (unchanged stdout behavior) **plus**
  `fs.appendFileSync` to `path.join(app.getPath("logs"), "export-lifecycle.log")`, wrapped in
  try/catch so a sink failure can never disrupt forwarding. Path resolved lazily/cached.
- The 5 existing `[export lifecycle]` `console.log` calls (export.queued/started/completed/
  failed/cancelled) now go through `exportLog` so the main-process forwarding record survives
  past the occurrence (stdout is lost in packaged/headless runs).
- Added one `exportLog` line for `export.rejected` (previously logged nothing). Rationale: the
  named classification buckets *stale-rejected* and *duplicate re-entry* are blind without the
  helper's rejection signal in the main log. This is "additive forwarding-log" per the allowed
  surface — **no IPC channel name or forwarded payload changed**; every `send(...)` is identical.

## Verification (one line per check)

- `npm run typecheck`: pass (renderer + electron + validation tsconfigs, `--noEmit`).
- `npm run build`: pass (vite renderer + tsc electron; only pre-existing deprecation warnings).
- `storybloq validate`: 0 errors / 0 warnings / 0 info.
- `git diff --check`: clean.
- forbidden-path diff (`helper/ validation/ dist-validation/ packaging/ .github/ package.json Cargo.toml Cargo.lock`): empty.
- `git diff -- src/v2/engine.ts`: empty.
- ISS-012: open (untouched). T-029: open.
