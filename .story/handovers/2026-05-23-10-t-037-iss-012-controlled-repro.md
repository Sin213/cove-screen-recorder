# T-037 — ISS-012 Controlled Repro + Boundary Classification

**Date:** 2026-05-23
**Ticket:** T-037 (inprogress — window-source qualifying condition not met). **Issues:** ISS-012 (open, unresolved), ISS-015 (open, NOT confirmed blocking under qualifying conditions).

## Session Goal

Execute controlled repro of ISS-012 (stuck-EXPORTING after valid MP4) using T-036 renderer logs. Classify which single boundary breaks via decision tree. Budget: 1 clean classification, hard cap 5 attempts.

## Result: PARTIAL — Window-Source Qualifying Condition Not Met

Run-01: 3 attempts, all hit Branch 5 pattern, conditions not met (attempts 1-2 under 60s; attempt 3 used Screen source).

Run-02: 2 attempts at 8m54s and 10m7s elapsed, portal active, Screen source — window source unavailable for replay buffer path on this system. Both hit Branch 5 pattern.

ISS-015-style interception observed across all 5 attempts. ISS-012 boundary classification is NOT yet complete — window-source qualifying condition was never met.

## What Happened

App launched: `VITE_COVE_V2_UI=1 npm run dev`, PID 1598504 (electron main), DISPLAY=:1.

### Session 1: pw-session-0000-1598561-1779600144509

Portal established 22:22:24, 3840×2160 XR24 SHM fallback (DMA-BUF hard-failed as expected).
Rolling buffer: 1 segment (9.7MB, 24.4s on disk) — segments DID persist for this session.

**Save attempt 1 (22:22:56, ~32s elapsed):** SAVING→RECORDING in 6s. Null snapshot throughout.
**Save attempt 2 (22:23:20, ~56s elapsed):** SAVING→RECORDING in 1s. Null snapshot throughout.

### Session 2: pw-session-0000-1598561-1779600276513

Portal established 22:24:36, 3840×2160 XR24 SHM fallback.
Rolling buffer: **ZERO on-disk segments** despite 4m21s of encoding at ~16 Mbps.

**Save attempt 3 (22:28:57, 4m21s elapsed):** SAVING→RECORDING in 7s. Null snapshot throughout.

## Decision Tree

All attempts: `v2SnapshotId=null` and `v2ExportId=null` at save start AND at return. No `export.queued` in export-lifecycle.log. No `export.completed received` in renderer logs. FSM never reached EXPORTING.

**Branch 5 fires (ISS-015 interception): STOP.**

## T-036 Log Analysis

Engine subscriptions registered correctly (`subs=12 v2State=BOOTING`).
Double registration at boot (subscriptions torn down and re-registered) — noted, not new, not in scope.
NO `export.completed received` in any attempt — confirms failure is pre-EXPORTING (snapshot IPC / main process boundary).
T-036 logs will classify ISS-012 on first genuine EXPORTING-reach repro.

## Critical Finding: Session 2 Zero Segments

Session 1 persisted segments normally. Session 2 ran 4m21s at ~16 Mbps with zero segment files written to disk. The encoder was active (bitrate visible in UI, portal stream confirmed in engine.log) but the rolling buffer writer did not seal any segments. This may be the proximate cause of ISS-015 in session 2: snapshot IPC finds no segments to pin.

Hypothesis: rolling buffer writer initialization fails for some sessions. Warrants investigation in the ISS-015 pass.

## ISS-012 Status

Open. Unresolved. Window-source qualifying repro attempt still pending.
- ISS-015-style interception observed in all 5 attempts (Screen source only) — NOT a confirmed blocker
- Cumulative repro rate: 1 confirmed / 15+ attempts
- T-036 renderer logs are in place for when ISS-012 does fire

## Evidence Root

`.story/handovers/evidence/2026-05-23-iss-012-classification-repro/`
- `session-baseline.md` — build state, log routing, decision tree reference
- `run-01/operator-note.md` — all 3 save attempts, session details, segment anomaly
- `run-01/render-snapshot.txt` — full LogPanel dump (useStore.getState().logs)
- `verdict.md` — full decision tree application and classification
- `screenshot-ui-state.png` — staged (binary, 642 KB); shows ELAPSED 04:33, Source=Screen, ~16 Mbps bitrate, v2State=RECORDING
- `engine.log` — not staged (gitignored); on disk at `/home/sin/.config/Cove Screen Recorder/logs/engine.log`
- `export-lifecycle.log` — not staged (gitignored); on disk at `/home/sin/.config/Cove Screen Recorder/logs/export-lifecycle.log`
- Source=Screen (monitor) observation is visible in `run-01/render-snapshot.txt` (Screenshot note line) and `run-01/operator-note.md` (session 2 block)

## Verification

- `git diff --staged --stat`: 6 new/modified staged files in this pass (T-037.json, ISS-012.json, handover, verdict, run-02 operator-note, run-02 render-snapshot); run-01 evidence and screenshot previously staged
- Forbidden surfaces (helper/ electron/ src/ validation/ packaging/ .github/ Cargo.* package.json): EMPTY — clean

## Tickets Changed

- T-037: inprogress (window-source qualifying attempt still required)
- ISS-012: impact annotation updated — ISS-015-style interception observed under Screen source only; not confirmed blocked

## Blocker

Window source is not available for the replay buffer path on this system (Wayland portal offers only whole-screen or region for replay buffer). T-037 cannot complete until either:
- A window-source replay buffer attempt is possible, OR
- The window-source gate is explicitly lifted by the project owner
