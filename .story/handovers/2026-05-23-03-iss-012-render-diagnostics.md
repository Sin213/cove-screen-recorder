# T-029 — ISS-012 renderer render/derived-state export diagnostics + main forwarding observability

**Date:** 2026-05-23
**Scope:** Evidence-only diagnostics. NO runtime behavior change except logging. Does NOT fix ISS-012.
**Ticket:** T-029 (open). **Issue:** ISS-012 (open, untouched).

## Why this is evidence-only
T-026 instruments the v2 export FSM (`src/v2/engine.ts`). But the visible stuck/disabled UI in a
stuck-EXPORTING occurrence also depends on App.tsx render/derived inputs (`replaySaving`, computed
disabled props, derived HUD `recordingState`/`recordingLabel`) that the FSM layer never sees — that
layer was blind. T-029 adds additive logging so the next occurrence can be classified to one owning
input (FSM state vs a render/derived selector holding the UI). No FSM rewrite, no fix-by-timeout, no
helper/ffmpeg/replay/validation change.

## Files changed
- `src/App.tsx` — additive `[export lifecycle][render]` logging: new store selectors
  (v2ExportId/SnapshotId/SessionId/ExportProgress/ExportOutputPath); render-snapshot effect; v1
  saveReplay start/finally; v2 saveReplay call-site start/finally (hotkey + button); `log` added to
  hotkey effect deps. `saveControlsDisabled` mirrors the Save button's inline disabled prop
  (logging-only; button JSX unchanged).
- `electron/main.ts` — additive `exportLog(line)` file sink (console.log + appendFileSync to
  `app.getPath("logs")/export-lifecycle.log`, best-effort try/catch). 5 existing `[export lifecycle]`
  lines routed through it; one new `export.rejected` line added (named buckets stale-rejected /
  duplicate re-entry were blind). NO IPC channel/payload change — every `send(...)` identical.
- `.story/tickets/T-029.json` — ticket (open).
- Evidence dir `.story/handovers/evidence/2026-05-23-iss-012-render-diagnostics/`:
  `diagnostic-scope.md`, `classification-buckets.md`, `manual-evidence.md`.

## Verification (one line per check)
- `npm run typecheck`: pass (renderer + electron + validation tsconfigs, `--noEmit`).
- `npm run build`: pass (vite + tsc electron; only pre-existing deprecation warnings).
- `storybloq validate`: 0 errors / 0 warnings / 0 info.
- `git diff --check`: clean.
- forbidden-path diff (`helper/ validation/ dist-validation/ packaging/ .github/ package.json Cargo.toml Cargo.lock`): empty.
- `git diff -- src/v2/engine.ts`: empty (no transition/guard change).
- Diagnostics shipped: renderer bundle has 7 `[export lifecycle][render]` strings; `dist-electron/main.js` has the `[export lifecycle]` lines incl. `export.rejected`.
- ISS-012: open (untouched). T-029: open.

## Manual evidence
NON-REPRO this session — diagnostics present/shipped; full ISS-012 repro requires an interactive
operator session (GUI + Wayland/KDE portal capture + window minimize/occlude under SHM-fallback),
not scriptable here. Not required to complete per ticket. Operator runbook + classification mapping:
`.story/handovers/evidence/2026-05-23-iss-012-render-diagnostics/manual-evidence.md` and
`classification-buckets.md`.

## Classification buckets (render-snapshot is the decisive line)
not received / stale-rejected / received+v2State-transitioned-but-replaySaving-or-selector-held-UI /
handler threw / duplicate re-entry / inconclusive(only if capture failed). At the hang: `v2State=EXPORTING`
⇒ FSM owns it; `v2State=RECORDING|IDLE` but `saveControlsDisabled|replaySaving=true` ⇒ render/derived owns it.

## Codex review focus
Confirm: (1) additive-only — no runtime behavior change, no FSM/guard edit, no IPC channel/payload
change; (2) `saveControlsDisabled` mirror does not drift from / is not wired into the button;
(3) file sink is best-effort and cannot disrupt forwarding; (4) `export.rejected` addition is in
the allowed "additive forwarding-log" surface and serves the named buckets.

## Status / next
T-029 open. ISS-012 open. Not committed (per instruction). Next: operator runs the bounded repro
pass and classifies a real stuck-EXPORTING occurrence using the render snapshot.
