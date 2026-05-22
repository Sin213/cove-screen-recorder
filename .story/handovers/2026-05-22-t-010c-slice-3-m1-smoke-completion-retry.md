# T-010c Slice 3 — M1 §22 manual-row retry under v2 UI gate (PARTIAL — blocked pre-VAL-CAP-001)

## Scope confirmation
Retry only the five §22 manual rows previously reblocked by ISS-008, using `VITE_COVE_V2_UI=1 npm run dev`. Manual/evidence execution pass only. Implementation only — no source/runtime/validation/release-policy edits. Did not rerun VAL-PKG-001, the rerun-27 scripted-local rows, the full §22 smoke suite, or the §23 RC suite.

## Outcome
Pass aborted before VAL-CAP-001. The v2 UI gate added in commit 6a4c1b1 reintroduces a Start-replay-buffer disable condition that triggers on `v2State = RECOVERY_AVAILABLE`, which is set on every cold start while the helper's segments directory contains any unsaved sessions. Filed as ISS-009 (severity high, owner-on-fail layer ui, primary affected row VAL-CAP-001 — by extension all five §22 manual rows). ISS-008 left inprogress and unresolved. T-010c open and untouched. ISS-007 untouched. No must-pass row marked pass.

## Current HEAD
`6a4c1b1` — Gate v2 capture UI path for smoke validation.

## Authoritative sources (read-only)
- `.story/notes/N-008.json`
- `.story/tickets/T-010c.json`
- `.story/handovers/2026-05-22-t-010c-slice-1-rc-orchestration.md`
- `.story/handovers/2026-05-22-t-010c-slice-2-m1-smoke-completion.md`
- `.story/handovers/2026-05-21-11-t-021-mvp-smoke-rerun-27.md`
- `.story/handovers/evidence/2026-05-21-t-021-mvp-smoke-rerun-27/`

## Reused-not-rerun evidence (unchanged this slice)
- `.story/handovers/evidence/2026-05-22-t-010c-slice-2-m1-smoke-completion/VAL-PKG-001/` — Slice 2 VAL-PKG-001 helper-readiness pass.
- `.story/handovers/evidence/2026-05-21-t-021-mvp-smoke-rerun-27/` — MVP scripted-local rerun-27 evidence (runner-exit-code, runner-stdout, runner-stderr, smoke-evidence-tree, operator-evidence, pre/post env).

## New evidence root
`.story/handovers/evidence/2026-05-22-t-010c-slice-3-m1-smoke-completion-retry/`

Slice-level artifacts at the root:
- `kscreen-doctor-pre-before-modeset.{txt,json}` — initial DP-4 state (3840x2160@239.99).
- `kscreen-doctor-pre.{txt,json}` — after DP-4 modeset to 1920x1080@60.
- `dp4-modeset-cmd.txt` — `kscreen-doctor output.DP-4.mode.1920x1080@60` output.
- `nvidia-smi-pre.txt`, `pgrep-cove-pre.txt`, `pgrep-ffmpeg-pre.txt`, `uptime-pre.txt` — post-cleanup pre-run baselines.
- `helper-launch.txt`, `runtime-note.md` — helper launch path reconciliation (see Environment notes below).
- `helper.txt` — first external-helper attempt (abandoned; supervisor-spawn conflict). `.log` extension would be gitignored, so the artifact is committed as `.txt`.
- `electron-dev.txt` — first `VITE_COVE_V2_UI=1 npm run dev` attempt log (supervisor restart-budget exhaustion). `.log` extension would be gitignored, so the artifact is committed as `.txt`.
- `kscreen-doctor-post.{txt,json}`, `nvidia-smi-post.txt`, `pgrep-cove-post.txt`, `pgrep-ffmpeg-post.txt`, `uptime-post.txt`.

Per-row dirs (each carries a single `NOT-ATTEMPTED.md` marker so the dir survives commit; no row was executed):
- `operator-evidence/VAL-CAP-001/NOT-ATTEMPTED.md`
- `operator-evidence/VAL-CAP-006/NOT-ATTEMPTED.md`
- `operator-evidence/VAL-UI-005/NOT-ATTEMPTED.md`
- `operator-evidence/VAL-ENC-006/NOT-ATTEMPTED.md`
- `operator-evidence/VAL-UI-012/NOT-ATTEMPTED.md`

Blocker analysis dir:
- `blocker-VAL-CAP-001/analysis.md` — full root-cause narrative, code refs, evidence map.
- `blocker-VAL-CAP-001/code-refs.txt` — grep slice for the v2 gate derivation, recovery FSM transitions, RecoveryBanner controls.
- `blocker-VAL-CAP-001/helper-recovery-scan.txt` — engine.log excerpt: 51 recoverable sessions discovered at 15:17:35Z.
- `blocker-VAL-CAP-001/segments-dir-listing.txt` — 64 entries under `$XDG_RUNTIME_DIR/cove-screen-recorder/segments/`.

## Five-row table
| Row | Status | Evidence path | Notes |
|---|---|---|---|
| VAL-CAP-001 | BLOCKED (pre-execution) | `…/operator-evidence/VAL-CAP-001/NOT-ATTEMPTED.md`; root-cause tree at `…/blocker-VAL-CAP-001/` | Start replay buffer disabled under v2 UI gate; root cause = `v2State = RECOVERY_AVAILABLE` → `startBufferDisabled` (src/App.tsx:521-523). Filed ISS-009. |
| VAL-CAP-006 | NOT ATTEMPTED | `…/operator-evidence/VAL-CAP-006/NOT-ATTEMPTED.md` | Same blocker. Per failure-handling, later rows not advanced. |
| VAL-UI-005 | NOT ATTEMPTED | `…/operator-evidence/VAL-UI-005/NOT-ATTEMPTED.md` | Same blocker. |
| VAL-ENC-006 | NOT ATTEMPTED | `…/operator-evidence/VAL-ENC-006/NOT-ATTEMPTED.md` | Same blocker. |
| VAL-UI-012 | NOT ATTEMPTED | `…/operator-evidence/VAL-UI-012/NOT-ATTEMPTED.md` | Same blocker. |

No row marked pass. No row faked.

## Pre/post environment summary
- DP-4: pre-before-modeset 3840x2160@239.99; pre 1920x1080@60 (operator matrix mode); post 3840x2160@239.99 (KDE auto-restored its preferred mode after Electron quit — acceptable, not part of any §22 assertion).
- GPU: RTX 4080 SUPER, driver 595.71.05, CUDA 13.2. Pre-run idle 16W / 46°C; post-run idle (no NVENC sessions ever started this slice).
- No active recordings pre-run after operator-confirmed cleanup of prior v1 dev session + v1 ffmpeg audio capture.
- Helper recovery directory at `$XDG_RUNTIME_DIR/cove-screen-recorder/segments/` holds 64 entries (51 deemed recoverable by helper) — load-bearing for the ISS-009 reproduction.

## Leak summary
Post-run pgrep shows no `cove-replay-engine`, no `cove-screen-recorder` Electron, no `/usr/bin/ffmpeg` survivors. Engine socket `/run/user/1000/cove-screen-recorder/engine.sock` removed (supervisor cleaned up on shutdown). No leftover pactl streams observed.

## Environment notes (runtime reconciliation)
The prompt-prescribed sequence `target/release/cove-replay-engine --socket …` then `VITE_COVE_V2_UI=1 npm run dev` does not align with the current dev-mode supervisor: (1) the helper CLI flag is `--ipc-socket`, not `--socket` (verified via `--help`); (2) `electron/engine-supervisor.ts` (spawnFresh L209, adoptOrSpawn L284, resolvePidPath L160-161) shows the dev-mode supervisor spawns and manages the helper itself, keying adoption off `$XDG_RUNTIME_DIR/cove-screen-recorder/engine.pid` (which an externally-launched helper does not write). An external helper without a written PID file causes the supervisor's `spawnFresh` to attempt over the bound socket; the spawn fails and the supervisor exhausts its restart budget, taking the dev tree down with it (visible in the first `electron-dev.txt`). Recovery: the operator relaunched `VITE_COVE_V2_UI=1 npm run dev` alone; the supervisor spawned its own helper (PID 996598, `target/debug/cove-replay-engine --ipc-socket … --log-dir "/home/sin/.config/Cove Screen Recorder/logs" --log-level info`) and reached the listening state at 15:17:35Z. Helper-log evidence for any row excerpts would come from the external file at `~/.config/Cove Screen Recorder/logs/engine.log` (outside the repo, not part of this patch). `helper.txt` at the evidence root preserves the first external-helper PID 993826 lifetime unchanged. Full reconciliation in `runtime-note.md`.

## ISS-008 status
Open → inprogress (this slice). NOT resolved. No resolution set. The five §22 manual rows it gated remain unsatisfied because ISS-009 reblocks them under the same gate that was supposed to unblock them.

## ISS-009 (new this slice)
Severity high, components ui+renderer, owner-on-fail layer ui, related T-010c+T-020. Files cited: src/App.tsx:521-523 (startBufferDisabled), :755 (button), :118-120 (v2Busy derivation), src/v2/engine.ts:120-127 (onRecoveryAvailable subscriber), :361-386 (_refreshRecoverableSessions FSM), src/v2/Diagnostics.tsx:19-44 (RecoveryBanner — per-row only, no bulk-clear or skip path). Distinct from but downstream of ISS-008; both must clear before the §22 manual rows are reachable through the visible operator UI.

## Statement
No source, runtime, validation, or release-policy files changed this slice. `git status` confirms tracked changes are limited to `.story/issues/ISS-008.json` (status flip), new `.story/issues/ISS-009.json`, and new untracked evidence under the slice-3 evidence root. `git diff --check` clean. `git diff` against `src/ helper/ validation/ electron/ packaging/ dist-validation/ .github/ .story/tickets/ .story/notes/ .story/issues/ISS-007.json` is empty.

## T-010c status
Open and untouched. blockedBy unchanged. No description edit. No status change.
