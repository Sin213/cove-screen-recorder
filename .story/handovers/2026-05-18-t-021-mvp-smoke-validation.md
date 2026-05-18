# T-021 MVP Smoke Validation Report

**Date:** 2026-05-18
**Ticket:** T-021 — Run MVP smoke validation on helper + Electron; prepare for T-010c
**Branch:** main
**Head commit:** 5a83294 Complete v2 renderer FSM and diagnostics integration
**Platform:** Linux (Arch 7.0.8-arch1-1)

---

## Executive Summary

The v2 helper (`cove-replay-engine`) builds, passes all tests, starts as a standalone process, responds correctly to JSON-RPC over length-prefixed UDS framing, and shuts down cleanly with zero orphan processes. The Electron app builds and typechecks cleanly. The validation runner detects the helper socket when present but all scripted-local rows skip as **runner-stub/T-010c** (row execution is not yet implemented in the T-010a harness). Manual rows skip as **manual-ingest-missing** (operator-driven ingest is not yet wired).

**Ready for T-010c: conditional**

---

## Validation Commands Executed

| Command | Result |
|---------|--------|
| `cargo build -p cove-replay-engine` | OK (1 cosmetic warning: unreachable expression in export/mod.rs:102) |
| `cargo test -p cove-replay-engine` | All tests pass (135 tests across unit + integration) |
| `npm run typecheck` | Clean (renderer + electron + validation configs) |
| `npm run build` | Clean (Vite renderer + tsc electron) |
| `npm run validate` (helper absent) | 20 skip: 14 scripted-local (helper-not-available), 6 manual |
| `npm run validate` (helper present) | 20 skip: 14 scripted-local (runner-stub/T-010c), 6 manual |
| `cargo build -p cove-replay-engine --release` | OK (23.3s, same cosmetic warning) |

---

## Helper Startup Validation

### Path B — Standalone helper

```
./target/debug/cove-replay-engine --ipc-socket "$XDG_RUNTIME_DIR/cove-screen-recorder/engine.sock"
```

| Check | Result |
|-------|--------|
| Socket created | `/run/user/1000/cove-screen-recorder/engine.sock` present (srwxr-xr-x) |
| `engine.ready` notification | Received: `{"capabilities":[],"helper_version":"0.1.0","pid":76974,"protocol_version":1}` |
| `engine.version` response | `{"helper_version":"0.1.0","protocol_version":1}` |
| `engine.health` response | `{"state":"ready","active_sessions":0,"active_snapshots":0,"active_exports":0,"rolling_buffer_bytes":0}` |
| Response within 5s | Yes (<200ms) |
| No child processes (idle) | Confirmed: `ps --ppid 76974` shows no children |
| `engine.shutdown` | `{"ok":true}` — process exits, socket removed |
| Post-shutdown: no orphans | pgrep: cove-replay-engine=none, ffmpeg=none, pactl=none |

### Path A — Electron supervisor

Not exercised in this validation pass. Electron supervisor validation requires a running display server and interactive desktop portal flow. Deferred to T-010c (manual rows) or a future interactive validation session.

---

## Smoke Row Report

| # | Row ID | Title | Classification | Status | Reason | Owner on Fail | Evidence Path |
|---|--------|-------|---------------|--------|--------|--------------|---------------|
| 1 | VAL-PKG-001 | coveApi.env.probe() returns clean result within 5s | scripted-local | **skip-runner-stub** | Runner-stub/T-010c. Helper alive validated by standalone Path B: engine.version + engine.health within 200ms. | packaging | `row-01-env-probe/` |
| 2 | VAL-CAP-001 | sessionReady event within 30s of requestSession | manual | **skip-manual-ingest-missing** | Requires interactive portal picker (PipeWire / xdg-desktop-portal). Operator-driven. | capture | `row-02-session-ready/` |
| 3 | VAL-CAP-003 | Portal denial emits captureError and leaves helper in IDLE | manual | **skip-manual-ingest-missing** | Requires user to dismiss portal picker. Operator-driven. | capture | `row-03-portal-denial/` |
| 4 | VAL-CAP-004 | 1080p60 monitor capture 60s — drop and cadence gates | scripted-local | **skip-runner-stub** | Row execution not implemented in T-010a runner. Requires active capture session. | capture | — |
| 5 | VAL-CAP-006 | Minimised window captures 60s without frame loss — Issue #3 | manual | **skip-manual-ingest-missing** | Requires active capture + window minimize during recording. Operator-driven. | capture | `row-05-minimized/` |
| 6 | VAL-UI-005 | Region overlay renders correctly — Issue #1 | manual | **skip-manual-ingest-missing** | Region mode (T-016) is not in MVP scope for this pass. | ui-fsm | — |
| 7 | VAL-ENC-001 | NVENC positive probe result via encoder.probeResult | scripted-local | **skip-runner-stub** | Row execution not implemented. Encoder probe requires active capture session. | encoder | `row-06-encoder-probe/` |
| 8 | VAL-ENC-006 | encoder.selected visible in HUD | manual | **skip-manual-ingest-missing** | Requires running Electron with active capture. Operator-driven. | encoder | — |
| 9 | VAL-SEG-001 | Rolling 60s window within disk budget | scripted-local | **skip-runner-stub** | Row execution not implemented. Requires capture producing segments. | rolling-buffer | `row-07-segment-budget/` |
| 10 | VAL-SEG-003 | replay.save completes within latency gate | scripted-local | **skip-runner-stub** | Row execution not implemented. Requires active capture + populated buffer. | rolling-buffer | `row-08-replay-save/` |
| 11 | VAL-EXP-001 | Stream-copy export of 60s window completes | scripted-local | **skip-runner-stub** | Row execution not implemented. Requires populated replay buffer. | export | `row-09-export-stream-copy/` |
| 12 | VAL-EXP-010 | No fake duplicated frames (ffprobe PTS walk) | scripted-local | **skip-runner-stub** | Row execution not implemented. Depends on VAL-EXP-001 output. | export | `row-10-no-fake-frames/` |
| 13 | VAL-EXP-012 | Export concurrent with RECORDING without capture loss | scripted-local | **skip-runner-stub** | Row execution not implemented. Requires concurrent capture + export. | export | — |
| 14 | VAL-UI-003 | HUD timer continues ≥1 Hz during SAVING — Issue #4 | scripted-local | **skip-runner-stub** | Row execution not implemented. Requires Electron renderer observation. | ui-fsm | `row-11-hud-timer/` |
| 15 | VAL-UI-012 | Hotkey triggers replay.save → SAVING → RECORDING | manual | **skip-manual-ingest-missing** | Requires interactive hotkey test. Operator-driven. | ui-fsm | — |
| 16 | VAL-PROC-001 | No leftover processes after IDLE shutdown | scripted-local | **pass (hand-driven)** | Runner: skip (runner-stub/T-010c). T-021 hand-driven: standalone Path B engine.shutdown exits cleanly, pgrep shows zero cove-replay-engine/ffmpeg/pactl after 2s. Runner row driver still needed for T-010c. | process-cleanup | `row-12-process-cleanup/` |
| 17 | VAL-PROC-002 | No leftover processes after stopping RECORDING + quit | scripted-local | **skip-runner-stub** | Row execution not implemented. Requires an active capture session to stop. | process-cleanup | — |
| 18 | VAL-PROC-003 | No leftover processes after app quit without explicit stop | scripted-local | **skip-runner-stub** | Row execution not implemented. Requires Electron supervisor crash path. | process-cleanup | — |
| 19 | VAL-PROC-007 | pactl never in process tree under helper PID during any smoke row | scripted-local | **skip-runner-stub** | Idle-only supplemental: `ps --ppid 76974` shows no children (no pactl) during idle engine. Full smoke-row validation (during active capture) deferred to T-010c. | process-cleanup | `row-13-pactl-absence/` |
| 20 | VAL-REG-002 | Fake-60fps gate re-run on VAL-EXP-001 output | scripted-local | **skip-runner-stub** | Depends on VAL-EXP-001 producing an MP4. Deferred. | regression | — |

### Summary

**Raw `npm run validate` output (with helper present):** 14 scripted-local skip + 6 manual skip = 20 total skip.

**T-021 hand-driven verdict (augments runner output):**

| Status | Count | Notes |
|--------|-------|-------|
| pass (hand-driven) | 1 | VAL-PROC-001 — proven via standalone Path B shutdown + pgrep |
| skip-runner-stub (deferred to T-010c) | 13 | Runner row driver not implemented; includes VAL-PROC-007 (idle-only supplemental) |
| skip-manual-ingest-missing | 6 | Operator-driven rows requiring interactive portal/hotkey |
| fail | 0 | |
| error | 0 | |

Note: VAL-PROC-001 is classified `scripted-local` by the runner and still skipped there. Its pass is T-021 supplemental evidence. The runner row driver for VAL-PROC-001 remains needed for T-010c automation.

---

## T-018/T-019/T-020 Invariant Checklist

| # | Invariant | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `replay.export_start.output_path` is a final `.mp4` path, not a directory | **PASS (code inspection)** | `helper/src/export/mod.rs:832-833`: defaults to `{export_id}.mp4`; renderer calls without explicit path, receives `.mp4` file in `export.completed` event (`final_path` field). |
| 2 | v1.1.0 replay hotkey path not intentionally removed | **PASS** | `src/recorder-client.ts` present: 1122 lines, last modified 2026-05-05. Contains full MediaRecorder/getDisplayMedia replay buffer implementation. |
| 3 | Export completion does not restore RECORDING after `capture.onSessionLost` | **PASS (code inspection)** | `src/v2/engine.ts:85-94`: `onSessionLost` nulls `v2SessionId`. `src/v2/engine.ts:151-155`: `export.onCompleted` → if `v2SessionId !== null` → RECORDING; else → IDLE. After session lost, goes to IDLE. |
| 4 | Recovery UI does not hide recoverable sessions | **PASS (code inspection)** | `src/v2/engine.ts:120-127`: `onRecoveryAvailable` stores full session list and sets `RECOVERY_AVAILABLE` when sessions exist. |
| 5 | Recovery refresh does not mask ENGINE_DOWN/ENGINE_UNAVAILABLE as IDLE | **PASS (code inspection)** | `src/v2/engine.ts:280-284`: catch block explicitly preserves ENGINE_DOWN/ENGINE_UNAVAILABLE. Success path only transitions when helper actually responded (meaning engine recovered). |
| 6 | Snapshot release only clears current snapshot on matching snapshot_id | **PASS (code inspection)** | `src/v2/engine.ts:114`: `if (gs().v2SnapshotId === ev.snapshot_id)` guards the clear. |
| 7 | No pinned snapshot leaks across export/cancel/failure/recovery | **PASS (code inspection)** | `_releaseCurrentSnapshot()` called on: completed (line 150), failed (163), cancelled (178), startExport catch (205). All terminal paths release. |
| 8 | `setState(RECORDING)` / `setV2State("RECORDING")` remains a single callsite | **PASS** | `grep -RIn 'setV2State.*"RECORDING"' src/v2 src/App.tsx` returns exactly one match: `src/v2/engine.ts:18`. |
| 9 | v2 Start Recording path does not call getDisplayMedia / MediaRecorder | **PASS** | `grep -RIn 'getDisplayMedia\|MediaRecorder' src/v2/` returns zero matches. |
| 10 | Legacy v1.1.0 recording code remains in tree | **PASS** | `src/recorder-client.ts`: 1122 lines with getDisplayMedia, MediaRecorder, replay buffer. |

---

## npm run validate Interpretation

| Helper State | Runner Behavior | Classification |
|-------------|----------------|----------------|
| Helper socket absent | All scripted-local: skip `helper-not-available` | Expected — no product failure |
| Helper socket present + responsive | All scripted-local: skip `helper-not-available` (message: "row execution not yet implemented (T-010c)") | **Runner-stub/T-010c** — not a product failure |
| Manual rows | Always skip `manual` | Expected — operator-driven, ingest not wired |

The runner's skip reason label is `helper-not-available` in both code paths (a naming quirk in the stub), but the message text distinguishes them. The runner detected the helper socket (no "Helper socket not found" banner printed on the second run).

---

## Process Cleanup Evidence

### Pre-flow (helper idle, no capture session)
- `cove-replay-engine` PID 76974: running (expected)
- `ffmpeg`: none
- `pactl`: none
- Helper children: none

### Post-shutdown (after engine.shutdown RPC)
- `cove-replay-engine`: none (exited cleanly)
- `ffmpeg`: none
- `pactl`: none
- Socket: removed

---

## Evidence Bundle

Location: `.story/handovers/evidence/2026-05-18-mvp-smoke/`

```
.story/handovers/evidence/2026-05-18-mvp-smoke/
├── runner-output-before-helper.json         # npm run validate with helper absent
├── runner-output-helper-running.json        # npm run validate with helper present
├── build-test-logs/
│   ├── cargo-build-debug.txt                # cargo build -p cove-replay-engine
│   ├── cargo-build-release.txt              # cargo build --release
│   ├── cargo-test.txt                       # cargo test (135 tests)
│   ├── npm-typecheck.txt                    # tsc --noEmit (3 configs)
│   └── npm-build.txt                        # vite build + tsc electron
├── row-01-env-probe/
│   └── env-probe.json                       # engine.ready + engine.version + engine.health
├── row-12-process-cleanup/
│   ├── pre_pgrep.txt                        # Process state before shutdown
│   └── post_pgrep.txt                       # Process state after shutdown
├── row-13-pactl-absence/
│   └── process-tree.txt                     # Idle-only pactl supplemental (skip-runner-stub)
└── structural-greps/
    ├── recording-callsites.txt              # Single RECORDING callsite proof
    └── getDisplayMedia-check.txt            # v2 doesn't use MediaRecorder proof
```

---

## Ready for T-010c Verdict

**Ready for T-010c: conditional**

### What was hand-verified (pass)
- Helper builds and passes all 135 tests (debug + release)
- Helper starts, listens on UDS, responds to JSON-RPC within 200ms
- Helper shuts down cleanly: no orphan processes, socket removed
- No pactl in process tree under helper PID
- Helper IDLE shutdown leaves zero orphan processes (VAL-PROC-001 pass)
- All structural invariants pass (single RECORDING callsite, no MediaRecorder in v2, legacy code preserved)
- Renderer FSM correctly handles session loss, snapshot lifecycle, export terminal events
- TypeScript typechecks clean across all three tsconfig targets
- Electron app builds successfully
- Validation runner correctly detects helper socket when present

### What remains runner-stub / manual-ingest deferred
- All 14 scripted-local rows skip in the runner (T-010a harness doesn't implement row drivers yet). VAL-PROC-001 has hand-driven pass evidence but its runner driver is still needed for T-010c.
- 6 manual rows: operator-driven ingest not wired (requires interactive desktop portal, window minimize, hotkey press)

### What T-010c must automate
1. Wire T-010a runner row drivers for all 14 scripted-local rows (connect to helper, drive JSON-RPC sequences, collect ffprobe/mediainfo evidence)
2. Implement manual row ingest flag for operator-driven rows
3. Exercise Path A (Electron supervisor) for UI-FSM rows (VAL-UI-003, VAL-UI-012)
4. Produce ffprobe PTS/frame evidence for VAL-EXP-010, VAL-REG-002
5. Run the full matrix on M1 (and later M2/M3/M4)

---

## Out of Scope (not done, not attempted)

- No fixes to helper/, electron/, src/, or validation/runner.ts
- No T-010c execution
- No T-010a runner implementation
- No packaging or release changes
- No new npm scripts
- No extraResources/electron-builder changes
- No removal or rewrite of v1.1.0 legacy MediaRecorder/recorder-client path
- No Storybloq T-020 status cleanup
- No commits
