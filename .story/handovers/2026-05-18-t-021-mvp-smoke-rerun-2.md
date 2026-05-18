# T-021 MVP Smoke Validation — Rerun 2 Report

**Date:** 2026-05-18
**Ticket:** T-021 — Run MVP smoke validation on helper + Electron; prepare for T-010c
**Repo path:** /home/sin/Projects/cove-screen-recorder
**Branch:** main
**Head commit tested:** `c5a6f92 Refresh MVP smoke validation verdict`
**Platform:** Linux (Arch 7.0.8-arch1-1) — Wayland (`WAYLAND_DISPLAY=wayland-0`), X11 bridge (`DISPLAY=:1`), KDE Plasma portal backend
**GPU:** NVIDIA RTX 4080 SUPER (driver 595.71.05)

This rerun supersedes the prior conditional `2026-05-18-t-021-mvp-smoke-rerun.md` verdict only as a *progress update*. The old handover is preserved unchanged.

---

## Why this rerun

The prior T-021 rerun (commit `ff0a1d5`) returned **CONDITIONAL** because VAL-PKG-001 was skipping — the external helper on the canonical socket was not started in that pass (runner-owned-vs-external invariant prevented claiming an unclean canonical socket path with a stale `engine.sock.lock`). All capture-dependent rows also skipped due to the portal D-Bus path being inaccessible from a non-interactive session.

This rerun:
1. Removed the stale `engine.sock.lock` from 2026-05-17 17:47 (no process owned it — confirmed via `kill -0` and `ps`).
2. Started the external helper (`./target/release/cove-replay-engine --ipc-socket $XDG_RUNTIME_DIR/cove-screen-recorder/engine.sock`, PID 471721) before the smoke run.
3. Ran the full `npm run validate` smoke suite.

Key improvement: **VAL-PKG-001 now PASSES** (up from skip in the previous rerun). Pass count is 6 (up from 5).

---

## Preflight

| Check | Result |
|---|---|
| `git status --short --untracked-files=all` | clean |
| `git log --oneline -3` top commit | `c5a6f92 Refresh MVP smoke validation verdict` (expected) |
| `ff0a1d5 Implement HUD timer saving validation row` in history | confirmed |
| `git diff --check` | clean |
| `.story/tickets/T-010a.json` | open |
| `.story/tickets/T-010b.json` | complete (marked in prior rerun) |
| `.story/tickets/T-020.json` | complete (marked in prior rerun) |
| `.story/tickets/T-021.json` | open (this pass) |
| `.story/tickets/T-010c.json` | blocked by T-010a, T-010b, T-021 |
| `XDG_RUNTIME_DIR` set | `/run/user/1000` |
| Canonical socket dir | exists: `$XDG_RUNTIME_DIR/cove-screen-recorder/` |
| Stale `engine.sock.lock` from 2026-05-17 | **removed** (no process owned it) |
| Real `engine.sock` socket | absent before start, created by helper at start |
| Live cove-replay-engine before start | none (confirmed pgrep) |

---

## Phase 1 — Build verification

| Command | Result |
|---|---|
| `cargo build -p cove-replay-engine --release` | OK (1 pre-existing cosmetic `unreachable_code` warning in `helper/src/export/mod.rs:102`) |
| `npm run typecheck` | clean (3 tsconfig targets) |
| `npm run build` | clean (Vite renderer + tsc electron) |

---

## Phase 2 — External helper startup

**Method:** Path B — standalone helper on canonical socket.

```
./target/release/cove-replay-engine --ipc-socket "$XDG_RUNTIME_DIR/cove-screen-recorder/engine.sock"
```

Helper started as PID 471721. Socket appeared within 0.5s at `srwxr-xr-x /run/user/1000/cove-screen-recorder/engine.sock`.

Helper log (`.story/handovers/evidence/2026-05-18-t-021-mvp-smoke-rerun-2/helper-startup.txt`):
```json
{"message":"cove-replay-engine started","version":"0.1.0","protocol_version":1}
{"message":"listening","socket":"/run/user/1000/cove-screen-recorder/engine.sock"}
{"message":"signal received, shutting down"}
```

The runner connected to the external helper for VAL-PKG-001, ran health+version checks, then the runner's own PROC rows used separate runner-owned socket paths. After the smoke run, the external helper was shut down via SIGTERM (I started it; I cleaned it up). PID 471721 exited cleanly, socket removed.

---

## Phase 3 — Smoke run

**Command:** `npm run validate` (runs `validate:build` then `node dist-validation/runner.js smoke`)

**Suite runtime:** 2026-05-18T22:43:19.532Z → 2026-05-18T22:53:03.823Z (~9m44s)

**Runner verdict:** `PASS` (no must-pass red; pass=6, fail=0, skip=14, error=0)

---

## Row-by-row results

| # | Row ID | Title | Class | Status | Evidence | Skip/Fail reason |
|---|---|---|---|---|---|---|
| 1 | VAL-PKG-001 | Helper readiness — coveApi.env.probe() within 5s | scripted-local | **PASS** | `VAL-PKG-001/engine-health.json`, `VAL-PKG-001/engine-version.json` | — |
| 2 | VAL-CAP-001 | sessionReady event within 30s of requestSession | manual | skip | — | `manual` — operator-driven; `--ingest` not yet implemented. |
| 3 | VAL-CAP-003 | Portal denial emits sessionLost(portal-denied); IDLE | scripted-local | **PASS** | `VAL-CAP-003/sessionLost-notification.json`, `VAL-CAP-003/engine-health.json` | — |
| 4 | VAL-CAP-004 | 1080p60 monitor capture 60s — drop & cadence gates | scripted-local | skip | `VAL-CAP-004/` | `helper-not-available`: `capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session` |
| 5 | VAL-CAP-006 | Minimized-window capture 60s — Issue #3 | manual | skip | — | `manual` — operator-driven. |
| 6 | VAL-UI-005 | Region overlay renders correctly — Issue #1 | manual | skip | — | `manual` — region mode deferred. |
| 7 | VAL-ENC-001 | NVENC positive probe via encoder.probeResult | scripted-local | skip | `VAL-ENC-001/` | `helper-not-available`: same portal D-Bus root cause as #4. |
| 8 | VAL-ENC-006 | encoder.selected visible in HUD | manual | skip | — | `manual` — operator-observed HUD. |
| 9 | VAL-SEG-001 | Rolling 60s window within disk budget | scripted-local | skip | `VAL-SEG-001/` | `helper-not-available`: same portal D-Bus root cause. |
| 10 | VAL-SEG-003 | replay.save within latency gate | scripted-local | skip | `VAL-SEG-003/` | `helper-not-available`: same portal D-Bus root cause. |
| 11 | VAL-EXP-001 | Stream-copy export of 60s window | scripted-local | skip | `VAL-EXP-001/` | `helper-not-available`: same portal D-Bus root cause. |
| 12 | VAL-EXP-010 | No fake duplicated frames (ffprobe PTS walk) | scripted-local | skip | `VAL-EXP-010/` | `helper-not-available`: depends on VAL-EXP-001. |
| 13 | VAL-EXP-012 | Export concurrent with RECORDING without capture loss | scripted-local | skip | `VAL-EXP-012/` | `helper-not-available`: same portal D-Bus root cause. |
| 14 | VAL-UI-003 | HUD timer continues ≥1 Hz during SAVING — Issue #4 | scripted-local | skip | `VAL-UI-003/` | `helper-not-available`: driver requires active SAVING transition, which requires portal pick. |
| 15 | VAL-UI-012 | Hotkey: saveReplay → SAVING → RECORDING | manual | skip | — | `manual` — operator-driven hotkey press. |
| 16 | VAL-PROC-001 | No leftover processes after IDLE shutdown | scripted-local | **PASS** | `VAL-PROC-001/` | — |
| 17 | VAL-PROC-002 | No leftover processes after stopSession+shutdown | scripted-local | **PASS** | `VAL-PROC-002/` | — |
| 18 | VAL-PROC-003 | No leftover processes after app quit without explicit stop | scripted-local | **PASS** | `VAL-PROC-003/` | — |
| 19 | VAL-PROC-007 | pactl never in helper process tree | scripted-local | **PASS** | `VAL-PROC-007/` | — |
| 20 | VAL-REG-002 | Fake-60fps gate re-run on VAL-EXP-001 output | scripted-local | skip | `VAL-REG-002/` | `helper-not-available`: depends on VAL-EXP-001 MP4. |

### Summary

| Bucket | Count | Row IDs |
|---|---|---|
| pass | 6 | VAL-PKG-001, VAL-CAP-003, VAL-PROC-001, VAL-PROC-002, VAL-PROC-003, VAL-PROC-007 |
| skip — scripted-local, portal D-Bus inaccessible | 9 | VAL-CAP-004, VAL-ENC-001, VAL-SEG-001, VAL-SEG-003, VAL-EXP-001, VAL-EXP-010, VAL-EXP-012, VAL-UI-003, VAL-REG-002 |
| skip — manual | 5 | VAL-CAP-001, VAL-CAP-006, VAL-UI-005, VAL-ENC-006, VAL-UI-012 |
| fail | 0 | — |
| error | 0 | — |

**Progress vs prior rerun:** VAL-PKG-001 promoted from skip to pass. All other outcomes unchanged.

---

## Environment summary

| Probe field | Value |
|---|---|
| `WAYLAND_DISPLAY` | `wayland-0` |
| `DISPLAY` | `:1` |
| `XDG_RUNTIME_DIR` | `/run/user/1000` |
| Portal services running | `true` (xdg-desktop-portal + kde + gtk backends live) |
| GPU | NVIDIA RTX 4080 SUPER, driver 595.71.05 |
| Portal D-Bus accessible from runner | **NO** — runner spawned from non-interactive session; `capture.requestSession` times out with "portal D-Bus path inaccessible" |
| Interactive operator present at desktop | **NO** — runner is invoked from Claude Code session, not from the user's interactive graphical D-Bus context |

---

## Helper / Electron launch method

| Path | Method | Used? |
|---|---|---|
| Path A — Electron supervisor | Start built Electron; supervisor spawns helper | NO — not exercised |
| Path B — Standalone helper on canonical socket | `./target/release/cove-replay-engine --ipc-socket ...engine.sock` | YES — PID 471721, for VAL-PKG-001 |
| Path C — Runner-owned helper | Runner spawns per-row helper on `runner-<rand>.sock` | YES — for VAL-CAP-003 and all PROC rows |

---

## Manual checks

- **VAL-CAP-003 (portal denial):** PASSED automatically (scripted-local driver, no operator interaction needed).
- **VAL-CAP-006 (Issue #3 minimize):** NOT run — manual row, requires operator. Not faked.
- **VAL-UI-003 (Issue #4 HUD during SAVING):** Driver wired (`ff0a1d5`), but portal pick is prerequisite — skipped with `helper-not-available`. Supplemental visual UI check NOT performed (no interactive session). Recorded as not-run.
- **VAL-UI-012 (hotkey path):** NOT run — manual row, requires operator hotkey during RECORDING state. Not faked.

No fake results recorded anywhere.

---

## Process cleanup result (post-run)

```
$ pgrep -u $UID -f 'cove-replay-engine' || echo "(none)"
(none)
$ pgrep -u $UID -f 'ffmpeg' || echo "(none)"
(none)
$ pgrep -u $UID -f 'pactl' || echo "(none)"
(none)
$ ls $XDG_RUNTIME_DIR/cove-screen-recorder/engine.sock
ls: cannot access ... engine.sock: No such file or directory
```

PID 471721 exited cleanly after SIGTERM. Socket removed. No leaks.

(Note: transient bash PIDs matching pgrep `-f` patterns due to the command text containing 'cove-replay-engine' were observed and verified as the pgrep command itself — not real helper processes.)

---

## Ready for T-010c verdict

**Ready for T-010c: CONDITIONAL.**

### Progress since prior rerun

- VAL-PKG-001: skip → **PASS** (external helper on canonical socket now correctly detected and verified)
- All other rows: unchanged

### Why not green

The 9 scripted-local capture-dependent rows (VAL-CAP-004, VAL-ENC-001, VAL-SEG-001, VAL-SEG-003, VAL-EXP-001, VAL-EXP-010, VAL-EXP-012, VAL-UI-003, VAL-REG-002) all time out with:

> `capture.requestSession timed out — portal D-Bus path inaccessible; run in an interactive user session`

This is an environment/session boundary issue: the xdg-desktop-portal screencast D-Bus API is only accessible from within the interactive graphical session's D-Bus context. A subprocess spawned from a non-interactive process (like Claude Code) does not inherit that context and cannot reach the portal.

Separately, 5 manual rows (VAL-CAP-001, VAL-CAP-006, VAL-UI-005, VAL-ENC-006, VAL-UI-012) remain operator-driven.

### Why not red

- Zero product failures.
- Zero harness failures.
- Zero process leaks.
- All 6 passing rows provide real evidence.
- All skipped rows have accurate structured skip reasons — environment limitation, not product defect.

### Exact remaining blockers for T-010c gate

1. **Run the smoke from the user's interactive graphical session** — the runner must be launched from a terminal running under the same D-Bus session as the desktop. This would allow `capture.requestSession` to reach the portal and get an operator-granted screencast source. This unblocks all 9 scripted-local capture rows (same root cause).
2. **Operator present at portal picker** — for the above to produce a pass, the user must click "Share screen" / select a monitor when the portal prompt appears for each capture row.
3. **Manual row ingest** (`--ingest` flag) — VAL-CAP-001, VAL-CAP-006, VAL-UI-005, VAL-ENC-006, VAL-UI-012 remain `manual` until T-010c implements the ingest path. Can only be addressed in T-010c.

### Status decisions

| Ticket | Decision | Rationale |
|---|---|---|
| T-021 | **stay open** | Conditional verdict — not green. |
| T-010a | **stay open** | Conditional verdict on T-021; cannot close. |
| T-010b | complete (prior rerun) | Not touched. |
| T-020 | complete (prior rerun) | Not touched. |
| T-010c | **stay blocked** | Still blocked by T-010a and T-021. |

---

## Issues filed

None. No product or harness defects discovered.

---

## Allowed files actually touched

- `.story/handovers/2026-05-18-t-021-mvp-smoke-rerun-2.md` — this file (new)
- `.story/handovers/evidence/2026-05-18-t-021-mvp-smoke-rerun-2/**` — evidence bundle (new)

No file under `validation/`, `electron/`, `helper/`, `src/`, `packaging/`, GitHub Actions, `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, version files, or existing `.story/handovers/*.md` files was modified. No issue file created (no defects).

---

## Out of scope (confirmed not done)

- No code patches of any kind.
- No validation harness patches.
- No product/helper/Electron fixes.
- No release/packaging work.
- No T-010c execution.
- No editing prior handovers.
- No v1.1.0 legacy paths touched.
- No broad retroactive Storybloq rewrites.
- No .story ticket metadata changes (T-010a and T-021 remain open; T-010b and T-020 already complete from prior rerun).

---

## Codex review focus

1. VAL-PKG-001 now passes: real evidence in `VAL-PKG-001/engine-health.json` + `engine-version.json`. Not synthesized.
2. All 9 scripted-local capture skips are environment skips (portal D-Bus inaccessible), not faked passes.
3. 5 manual skips remain manual — not faked.
4. T-010a and T-021 NOT marked complete (verdict is conditional, not green).
5. T-010b and T-020 remain complete from prior rerun — not touched here.
6. No source/harness/electron/helper/packaging files changed.
7. Existing handovers not edited.
8. Row table matches evidence directory file-by-file.
9. Process cleanup verified: PID 471721 gone, socket cleaned, no leaks.
10. T-010c not started.
11. v1.1.0 legacy path not removed.
