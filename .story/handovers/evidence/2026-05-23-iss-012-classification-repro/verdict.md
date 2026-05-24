# T-037 Partial Result — ISS-012 Classification (INCOMPLETE)

**Date:** 2026-05-23
**Result:** PARTIAL — window-source qualifying condition not met; T-037 remains inprogress

Current T-037 evidence shows ISS-015-style interception across 5 attempts in 3 sessions, including 2 attempts at >60s elapsed. However, window source is not available for the replay buffer path on this system (Wayland portal offers only whole-screen or region). No qualifying window-source attempt has occurred. T-037 remains open pending a qualifying controlled repro attempt.

## Run Summary

| Run | Attempt | Session | Elapsed | SAVING duration | SnapshotId | ExportId | Qualifying |
|-----|---------|---------|---------|-----------------|------------|----------|------------|
| 01 | 1 | 1779600144509 | ~32s | 6s | null | null | No (under 60s) |
| 01 | 2 | 1779600144509 | ~56s | 1s | null | null | No (under 60s) |
| 01 | 3 | 1779600276513 | 4m 21s | 7s | null | null | No (Screen source) |
| 02 | 1 | 1779603851364 | **8m 54s** | 13s | null | null | No (Screen source) |
| 02 | 2 | 1779603851364 | **10m 7s** | 1s | null | null | No (Screen source) |

Window source not available for replay buffer path on this system — all attempts used Screen/monitor source.

## Decision Tree Application (Informational — Not Conclusive)

All 5 save attempts:
- v2State transitions: RECORDING → SAVING → RECORDING (never → EXPORTING)
- v2SnapshotId=null throughout (start AND return from save)
- v2ExportId=null throughout
- No `export.queued` observed
- No `export.completed received` in renderer logs

Branch 5 pattern observed on all 5 attempts. Whether this reflects ISS-015 blocking ISS-012 under qualifying window-source conditions is unresolved.

## T-036 Log Analysis

Engine subscriptions registered correctly in all sessions: `subs=12 v2State=BOOTING`.
NO `export.completed received` in any attempt — failure is pre-renderer (snapshot IPC / helper boundary).

## Additional Finding: Run-01 Session 2 Zero Segments

Run-01 session 2 (1779600276513): 0 on-disk segments despite 4m21s at ~16 Mbps.
Run-01 session 1 (1779600144509): 1 segment (9.7MB, 24.4s) — buffer DID persist.
Hypothesis: rolling buffer writer initialization fails for some sessions.

## Classification

**ISS-012 status:** UNRESOLVED — window-source qualifying condition not met.
- All 5 attempts used Screen/monitor source; window source unavailable for replay buffer path.
- ISS-015-style interception observed but NOT under qualifying conditions.
- ISS-012 is NOT confirmed blocked on ISS-015.
- T-037 remains inprogress pending a qualifying window-source attempt.

**DO NOT add watchdogs/timeouts/retries.**
**DO NOT treat these observations as a final ISS-012 classification.**

## Scope Compliance

No source files were modified. All writes in `.story/` only.
T-036 renderer logs are in place and will classify ISS-012 on first genuine EXPORTING-reach repro.
