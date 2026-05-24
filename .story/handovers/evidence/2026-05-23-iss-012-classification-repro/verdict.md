# T-037 Partial Result — ISS-012 Classification (INCOMPLETE)

**Date:** 2026-05-24
**Result:** PARTIAL — qualifying conditions not met; T-037 remains inprogress

Current T-037 evidence shows ISS-015-style interception under non-qualifying repro conditions. Because no attempt satisfied the required >60s window-source condition, this pass does not complete ISS-012 boundary classification. T-037 remains open pending a qualifying controlled repro attempt.

## Condition Qualification

VAL-CAP-006 required conditions: >60s recording, window source, 4K, portal active.
Attempts 1 and 2 were ~32s and ~56s (too short). Attempt 3 was 4m21s but used Screen (monitor) mode, not Window source.

No qualifying >60s window-source attempt was performed. Attempts 1–2 were under 60s; attempt 3 used Screen (monitor) source. The VAL-CAP-006 gate (>60s, window source, 4K, portal active) was not met in any attempt. Whether a qualifying window-source attempt would also hit Branch 5 is unresolved — this pass cannot determine that.

## Decision Tree Application

### Branch 5 check: Save never reaches EXPORTING

ALL 3 save attempts across 2 sessions:
- v2State transitions: RECORDING → SAVING → RECORDING (never → EXPORTING)
- v2SnapshotId=null throughout (start AND return from save)
- v2ExportId=null throughout
- No `export.queued` in export-lifecycle.log
- No valid MP4 produced

**Branch 5 fires on all 3 attempts.**

## Evidence

| Attempt | Session | Elapsed at save | SAVING duration | Snapshot ID | Export ID |
|---------|---------|-----------------|-----------------|-------------|-----------|
| 1 | 1779600144509 | ~32s | 6s | null | null |
| 2 | 1779600144509 | ~56s | 1s | null | null |
| 3 | 1779600276513 | **4m 21s** | 7s | null | null |

All hit Branch 5. Attempt 3 is the strongest evidence — 4m21s of recording with no snapshot creation.

## Additional Finding: Session 2 Zero Segments

Session 1: 1 segment (9.7MB, 24.4s on disk) — buffer DID persist to disk.
Session 2: 0 segments despite 4m21s at ~16 Mbps — buffer NOT persisted to disk.

The encoder was running (16 Mbps bitrate shown in UI, portal stream active at 3840×2160 XR24).
But no segment files written to `/run/user/1000/cove-screen-recorder/segments/pw-session-0000-1598561-1779600276513/`.
This is a secondary failure: the rolling buffer writer is not sealing segments for session 2.
This may be the direct cause of ISS-015: snapshot IPC finds no segments to pin.

## T-036 Log Analysis

All T-036 log strings were present in the bundle.
The renderer subscription was registered correctly: `subs=12 v2State=BOOTING`.
However, NO `export.completed received` log was observed in any attempt.
This confirms: the export never reached the renderer — the failure is pre-renderer (snapshot IPC / helper boundary).

Branches 1–4 do not apply because the export never entered EXPORTING state to begin with.

## Classification

**ISS-012 status:** UNRESOLVED — qualifying repro conditions not met.
- No attempt satisfied the VAL-CAP-006 gate (>60s, window source, 4K, portal active).
- ISS-015-style interception was observed but under non-qualifying conditions only.
- ISS-012 is NOT confirmed blocked on ISS-015 — that conclusion requires a qualifying attempt.
- A qualifying >60s window-source attempt is still required before T-037 can complete.

**Observations from partial evidence (informational only, not conclusive):**
- All 3 attempts showed SAVING→RECORDING with null snapshot ID (ISS-015-pattern).
- Session 2 zero-segments anomaly: 4m21s at ~16 Mbps, zero on-disk segments — may warrant separate investigation.
- No `export.completed received` in any attempt — export never reached EXPORTING state.

**DO NOT add watchdogs/timeouts/retries.**
**DO NOT treat these observations as a final ISS-012 classification.**

## Scope Compliance

No source files were modified. All writes in `.story/` only.
T-036 renderer logs are in place and will classify ISS-012 on first genuine EXPORTING-reach repro.
