# T-029 — manual evidence pass result

**Date:** 2026-05-23
**Outcome:** NON-REPRO in this session — diagnostics present and shipped; full ISS-012
reproduction deferred to an interactive operator session. Per the ticket, reproducing ISS-012
is **not** required to complete this evidence-only implementation.

## Why no live repro was driven here

The bounded repro requires interactive operation at the host that this automation context
cannot perform: launch `VITE_COVE_V2_UI=1 npm run dev` with a real display, run the replay
buffer, then trigger a save under **SHM-fallback + minimized/occluded + portal-session**
conditions (click/hotkey, minimize the source window, observe the HUD/LogPanel). Driving the
Electron GUI, the Wayland/KDE portal capture handshake, and window minimize/occlusion is a
human-operator action, not a scriptable one. No evidence was fabricated.

## Diagnostics-present proof (in lieu of live repro)

- `npm run typecheck`: pass — all `[export lifecycle][render]` call sites and the `exportLog`
  sink type-check (renderer + electron tsconfigs).
- `npm run build`: pass.
- Renderer production bundle (`dist/assets/index-*.js`) contains **7** `[export lifecycle][render]`
  strings = render snapshot (1) + v1 saveReplay start/finally (2) + v2 saveReplay hotkey
  start/finally (2) + v2 saveReplay button start/finally (2).
- Compiled `dist-electron/main.js` contains the `[export lifecycle]` forwarding lines incl. the
  new `export.rejected export_id=…` sink line.

So the diagnostics are guaranteed to emit at runtime once an operator drives the path; only the
live capture of a stuck-EXPORTING occurrence remains.

## Operator runbook for the next pass

1. `VITE_COVE_V2_UI=1 npm run dev`
2. Start replay buffer; let it run.
3. Save the last N min under: SHM-fallback (NVIDIA/KDE/Wayland — the current host already forces
   this), source window **minimized/occluded**, portal session active.
4. If the UI sticks in EXPORTING / controls stay disabled, capture all three:
   - renderer **LogPanel** (`[export lifecycle][render]` snapshot + start/finally lines, plus
     T-026 engine.ts `[export lifecycle]` lines)
   - main log: `export-lifecycle.log` under `app.getPath("logs")` + stdout
   - helper engine-log
5. Classify against `classification-buckets.md` using the decisive `snapshot` line
   (`v2State` vs `saveControlsDisabled`/`replaySaving`).
6. If it does not stick, record a clean run proving the diagnostics emit, and attach the logs.
