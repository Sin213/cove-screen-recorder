# T-010c Slice 2 — M1 §22 smoke completion (stopped early on renderer-wiring gap)

## Scope confirmation

Slice 2 mission: close the M1 §22 smoke evidence gap for six rows that rerun-27 deliberately skipped — VAL-PKG-001 (scripted-local, prior `helper-not-available`) and the five manual rows VAL-CAP-001, VAL-CAP-006, VAL-UI-005, VAL-ENC-006, VAL-UI-012 (prior `manual`). No source / runtime / validation / packaging / release-policy edits. No T-010c status change. No closure or reopen of ISS-007. No commits.

Slice 2 stopped after VAL-PKG-001 passed. The five manual rows could not be observed because the renderer's visible UI does not call the v2 helper capture trigger (root cause filed as ISS-008).

## Current HEAD

`88c2ec2 Freeze T-010c RC orchestration` — unchanged across the slice.

## Authoritative sources (read-only)

- `.story/notes/N-008.json` — §22 matrix, §11/§12 row criteria, §4 packaging row.
- `.story/tickets/T-010c.json` — execution plan + binding scope.
- `.story/tickets/T-020.json` — renderer migration scope (status mismatch — see ISS-008).
- `.story/handovers/2026-05-22-t-010c-slice-1-rc-orchestration.md` — Slice 1 orchestration freeze.
- `.story/handovers/2026-05-21-11-t-021-mvp-smoke-rerun-27.md` — rerun-27 evidence, defines the six-row gap this slice targets.

## Reused rerun-27 evidence (no re-run)

`.story/handovers/evidence/2026-05-21-t-021-mvp-smoke-rerun-27/` — scripted-local pass set, env snapshots, runner artifacts. Slice 2 does not modify or re-derive these.

## New evidence root

`.story/handovers/evidence/2026-05-22-t-010c-slice-2-m1-smoke-completion/`

## Six-row result table

| Row | Status | Evidence path | Criterion source |
|-----|--------|---------------|------------------|
| VAL-PKG-001 | pass | `evidence/2026-05-22-t-010c-slice-2-m1-smoke-completion/VAL-PKG-001/` (runner stdout, stderr, exit, copied validation-artifacts run dir, helper-logs dir) | `dist-validation/rows.js:12-20`; N-008 §4 packaging-probe gate; row linkedSourceCase `N-007` |
| VAL-CAP-001 | blocked (not executed) | none — see Stop / failure summary and ISS-008 | N-008 §11 row VAL-CAP-001 (`N-003 §5`) |
| VAL-CAP-006 | blocked (not executed) | none | N-008 §11 row VAL-CAP-006 (`N-003 §17 c.24`) |
| VAL-UI-005 | blocked (not executed) | none | N-008 §12 row VAL-UI-005 (Issue #1 absorption; UI string-table gate) |
| VAL-ENC-006 | blocked (not executed) | none | N-008 row VAL-ENC-006 (`Settings → Diagnostics` shows current `encoder.selected`) |
| VAL-UI-012 | blocked (not executed) | none | N-008 row VAL-UI-012 (hotkey `saveReplay` → `replay.save` + `hotkeys.triggered` toast) |

## Build / preflight summary

- `cargo build -p cove-replay-engine --release` — clean (0 errors, 70 warnings; binary `target/release/cove-replay-engine` 7.7 MiB).
- `npm run typecheck` — pass.
- `npm run validate:build` — pass.
- `npm run build` — pass (renderer 209 KiB / 30.6 KiB CSS; electron emit clean).
- Working tree clean after preflight; no tracked-file changes outside allowed paths.

## VAL-PKG-001 execution summary

- Long-lived helper launched from `target/release/cove-replay-engine` on `/run/user/1000/cove-screen-recorder/engine.sock`. Socket ready in ~1 s.
- `node dist-validation/runner.js row VAL-PKG-001` — verdict `pass`, exit 0, "Helper readiness confirmed via `engine.health` + `engine.version`".
- Helper SIGTERM clean shutdown ~4 s after stop; no SIGKILL escalation. Helper stdout/stderr both empty.
- Runner artifact + per-row evidence directory copied under `VAL-PKG-001/2026-05-22T06-28-00-081Z/`.

## Post-run leak summary

Pre-run pgrep + DP-4 + GPU snapshots at `evidence/.../kscreen-doctor-pre-before-modeset.{txt,json}` (DP-4 3840x2160@239.99), then `evidence/.../kscreen-doctor-pre.{txt,json}` after `kscreen-doctor output.DP-4.mode.1920x1080@60` (DP-4 mode 11 selected, marked `*`). Post-run snapshots at `evidence/.../kscreen-doctor-post.{txt,json}`, `nvidia-smi-post.txt`, `pgrep-cove-post.txt`, `pgrep-ffmpeg-post.txt`, `uptime-post.txt`.

Post-run pgrep observation: a live `cove-replay-engine` (PID 959140, `target/debug/`, spawned by the operator's `npm run dev` Electron supervisor) and an ffmpeg audio-sidecar process (PID 960212) attributable to the same operator dev session were present at snapshot time. Neither is matrix-runner-owned — the Slice 2 long-lived helper (different PID, `target/release/`) had exited cleanly with SIGTERM after VAL-PKG-001 and is not in the post-run pgrep. Matrix leak invariant ("no leaked cove-replay-engine, no runner-owned ffmpeg") therefore holds for Slice 2's own execution.

## Repo write summary

Confirmed only allowed paths changed during Slice 2:

- `.story/handovers/evidence/2026-05-22-t-010c-slice-2-m1-smoke-completion/**` (new evidence tree).
- `.story/issues/ISS-008.json` (one new issue, per failure-handling clause).
- `.story/handovers/2026-05-22-t-010c-slice-2-m1-smoke-completion.md` (this handover).

No edits to `helper/**`, `electron/**`, `src/**`, `validation/**`, `packaging/**`, `dist-validation/**` (hand-edit prohibition; runner-generated `validation-artifacts/**` and `validation-report-*.json` are gitignored). No edits to `.story/notes/**`, `.story/tickets/**`, or pre-existing `.story/handovers/**`. No ticket status change. No `ISS-007` change.

## Slice scope statement

This slice advances only the M1 §22 completion evidence surface and does not claim broader RC / GA completion. No re-derivation of rerun-27 verdicts. No §23 RC suite execution. No §16 / §17 / §18 / §21 / §24 readout. No release policy change.

## Stop / failure summary

Slice 2 stopped after the first attempt at VAL-CAP-001. The operator launched the v2 dev path (`npm run dev`) and confirmed the v2 helper booted, listened on `/run/user/1000/cove-screen-recorder/engine.sock`, and emitted no errors; but pressing "Start replay buffer" / F8 produced only legacy v1 log lines (codec=vp8, audio sidecar starting, libx264 save) and zero new `capture.sessionReady`, `capture.*`, `tsNs`, or error events in the helper log.

Root cause traced in the renderer/main code (read-only investigation, no file edits): the visible UI control wired to start the v2 capture session does not exist. `src/App.tsx`'s "Start replay buffer" button (`onClick → startReplay → startReplayWithSource → startReplayBuffer`) imports `startReplayBuffer` from `src/recorder-client.ts` — the v1 MediaRecorder + ffmpeg-direct path that calls `window.cove.*`, not `window.coveApi.*`. `grep -rn "capture.startStream|capture.requestSession" src/` returns zero matches; `src/v2/engine.ts` is a pure subscriber + save/export module with no capture-start caller. The matching helper RPC surface IS wired through `electron/preload.ts:113-116` (`coveApi.capture.requestSession`, `coveApi.capture.startStream`), `electron/engine-rpc.ts:219,223`, and `electron/main.ts:931-940` ipcMain handlers — but with no renderer caller, the v2 helper sits listening and never receives a capture request. `electron/preload.ts:76-77` still carries the comment "v1.1.0 renderer code is untouched until T-020 migrates App.tsx to use window.coveApi." T-020 is marked `complete` (closed 2026-05-18) despite that scope being unmet. The documented T-020 escape clause ("gate the v2 flow behind a `COVE_V2_UI=1` env var") is also unimplemented — `grep -rn "COVE_V2|v2Enabled|enableV2|legacyMode|useV2" src/ electron/` surfaces only the unrelated `useV2ElapsedMs` clock hook.

Consequence for Slice 2: the five manual rows share this single root cause and are all unreachable through the visible operator UI. Re-running them in any order will reproduce the same v1 path. VAL-PKG-001 is unaffected because the runner drives the helper directly via JSON-RPC.

Single new issue filed per failure-handling clause: **ISS-008** "T-020 renderer migration not landed: v2 capture/replay RPCs have zero callers in src/; visible UI still routes through v1 MediaRecorder path" — severity high, components `ui` / `renderer` / `supervision`, related `T-020` / `T-010c`, phase `p4-release`. T-010c status unchanged. T-020 status unchanged. ISS-007 unchanged.

## Verification before Codex

- Storybloq validate: 0 errors, 0 warnings, 0 info.
- `git status --short` shows only `.story/handovers/evidence/2026-05-22-t-010c-slice-2-m1-smoke-completion/`, `.story/issues/ISS-008.json`, and `.story/handovers/2026-05-22-t-010c-slice-2-m1-smoke-completion.md`.
- `git diff --check` clean.
- `git diff -- helper/ validation/ src/ electron/ packaging/ .github/ .story/tickets/ .story/notes/` empty.
- Handover references evidence by path only; no copied artifact contents.
- No ticket status updates. No ISS-007 changes. No commits.

## Next-step pointer (no action taken by this slice)

ISS-008 resolution is out of Slice 2 scope. A future ticket / slice may either land T-020's binding scope (migrate `src/App.tsx` recording + replay paths to `window.coveApi.capture.requestSession` → `startStream` and `window.coveApi.replay.save` → `exportStart`) or implement the documented `COVE_V2_UI=1` env-gate escape clause; once either lands, the five blocked manual rows become observable through the visible UI and Slice 3 can close the §22 evidence gap.
