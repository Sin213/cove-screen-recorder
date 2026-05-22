# Slice 3 must-pass blocker — pre-VAL-CAP-001

## Observed UI state (operator-reported)
Under `VITE_COVE_V2_UI=1 npm run dev` with supervisor-managed helper and `engine.sock` healthy:
- Record button: enabled
- Start replay buffer button: **disabled with blocked cursor** (before any row begins)
- Unsaved recordings panel visible with many Save/Discard rows

## Reproduction
Boot order:
1. Supervisor-spawned helper scans `$XDG_RUNTIME_DIR/cove-screen-recorder/segments/` (`helper/src/segment/recovery.rs:198`).
2. Helper finds 51 recoverable sessions (`engine.log` 2026-05-22T15:17:35Z, count=51; 64 entries on disk in `segments-dir-listing.txt`).
3. Helper emits `replay.recoveryAvailable` once the renderer subscriber attaches.
4. Renderer `engine.ts:46` (`api.engine.onReady`) calls `_refreshRecoverableSessions()` (`engine.ts:361`) which receives sessions and (`engine.ts:366-370`) sets `v2State = "RECOVERY_AVAILABLE"`.
5. `App.tsx` (commit 6a4c1b1, lines 521-523):
   ```
   const startBufferDisabled = v2UiEnabled
     ? v2StartPending || v2State !== "IDLE" || status !== "idle"
     : status !== "idle";
   ```
   With `v2State === "RECOVERY_AVAILABLE"`, `startBufferDisabled` is true. The Start replay buffer `<button>` (App.tsx L755) is rendered disabled.

## Root cause
The v2 UI gate added in commit `6a4c1b1` ("Gate v2 capture UI path for smoke validation") introduced `v2State !== "IDLE"` as a Start-replay-buffer disable condition without exempting `RECOVERY_AVAILABLE`. The pre-gate v1 path (`disabled={status !== "idle"}`) was not subject to v2 lifecycle states because v1 has no recovery FSM. The new gate treats RECOVERY_AVAILABLE as a non-startable state, but the renderer's only escape routes from RECOVERY_AVAILABLE are per-session `restoreRecovery` (which transitions SAVING → EXPORTING through the full export pipeline, `engine.ts:242-257`) and per-session `discardRecovery` (`engine.ts:236-240`). The recovery banner in `src/v2/Diagnostics.tsx:19-44` (`RecoveryBanner`) renders only per-row Save/Discard buttons — there is no bulk discard, no "Skip recovery and start a new buffer" affordance, no "ignore recovery for this session" option.

The mismatch between `v2Busy` (excludes RECOVERY_AVAILABLE; gates Record button correctly so Record stays enabled) and `startBufferDisabled` (includes RECOVERY_AVAILABLE via `v2State !== "IDLE"`; disables Start replay buffer) directly produces the operator-observed state.

With 51 unsaved sessions accumulated on the smoke machine, the operator cannot reach IDLE without sequentially restoring or discarding each one. Discard×51 is the only path that does not push 51 exports through the encoder/export pipeline (which itself transitions through SAVING/EXPORTING and would not reach IDLE in any reasonable wall time). Either path is incompatible with the §22 manual smoke wall budget and is operationally inappropriate.

## Affected rows
All five §22 manual rows blocked by ISS-008 require entering the IDLE state to click Start replay buffer:
- VAL-CAP-001 (sessionReady ordering vs HUD start — blocked first)
- VAL-CAP-006 (minimised-source soak → save)
- VAL-UI-005 (crop mode app-owned region)
- VAL-ENC-006 (encoder badge + diagnostics)
- VAL-UI-012 (saveReplay hotkey while RECORDING)

The §23 RC suite manual rows that route through the same Start replay buffer affordance are also at risk under the v2 gate — out of scope for Slice 3 to enumerate.

## Owner-on-fail layer
Primary: **ui** — the v2 gate in `src/App.tsx` (commit 6a4c1b1) treats RECOVERY_AVAILABLE as a hard-disable for Start replay buffer without providing or exempting a clear-recovery path. `src/v2/Diagnostics.tsx:RecoveryBanner` is also UI scope and is missing the bulk-clear/skip affordance.

Secondary (not the root cause; helper behavior is correct per its contract): **supervision** — the helper unconditionally surfaces recovery on boot. Any disposition of leftover recoverable segments is a UI/UX policy decision, not a helper bug.

## Severity: high
Reasoning:
- Blocks 5/5 §22 manual rows under the v2 UI gate that ISS-008 was supposed to unblock.
- Cannot be worked around by the operator without leaving the helper recovery directory clean — itself an external state mutation outside Slice 3's allowed writes.
- N-008 §3 "owner-on-fail" rules treat must-pass UI gates blocking §22 rows as high severity (consistent with ISS-008 sev=high).

Not "critical" because:
- Helper, supervisor, engine handshake, and v2 capture RPCs themselves are healthy.
- Once the recovery state is cleared (or once the UI exempts RECOVERY_AVAILABLE from startBufferDisabled), the same v2 capture path is ready to drive the §22 rows.

## Decision
Per slice-3 failure-handling: STOP. Do not advance later rows. Do not fake pass. File one new issue. Leave ISS-008 inprogress. Leave T-010c open and untouched. Write partial handover.

## Evidence in this directory
- `analysis.md` (this file)
- `code-refs.txt` (grep lines for v2 gate derivation, recovery transitions, RecoveryBanner)
- `helper-recovery-scan.txt` (excerpt of helper engine.log showing 51-session recovery scan)
- `segments-dir-listing.txt` (64 segment directories under `$XDG_RUNTIME_DIR/cove-screen-recorder/segments/`)

Live-session artifacts at the evidence root:
- `electron-dev.txt` (first npm-dev attempt with supervisor-spawn conflict; `.log` is gitignored so artifact stored as `.txt`)
- `runtime-note.md`, `helper-launch.txt` (helper lifecycle reconciliation)
- pre/post environment captures
