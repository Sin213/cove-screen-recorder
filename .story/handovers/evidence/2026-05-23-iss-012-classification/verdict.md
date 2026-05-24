# ISS-012 Classification Pass — Verdict

**Date:** 2026-05-23
**Ticket:** T-035
**Runs attempted:** 2
**Decision tree result:** Branch A — NOT ISS-012

## Summary

Both save attempts (run-01 at 17:53:05 and run-02 at 18:15:34) failed with no MP4
produced. The UI transitioned RECORDING → SAVING → RECORDING with v2SnapshotId=null and
v2ExportId=null throughout. No export.queued, export.started, export.completed, or
export.failed appeared in export-lifecycle.log. ISS-012 was NOT reproduced.

## Decision Tree Classification

**Branch A:** No valid file present, no export.failed present.
→ NOT ISS-012. Classify as export orchestration failure. Recommend NEW issue.

## Failure Boundary

Boundary 2 (export orchestration): The snapshot IPC to the helper returned no snapshot
ID despite valid rolling buffer segments existing.

- run-01: 1 segment, 12.9MB, 18.24s content — save held SAVING for ~17s, no snapshot
- run-02: 1 segment, 2.6MB, 5.01s content — save held SAVING for ~5s, no snapshot

The SAVING duration roughly matches the rolling buffer segment duration in both samples
(~17s SAVING / 18.24s segment; ~5s SAVING / 5.01s segment). **Hypothesis only — 2 data
points, not proven.** This may suggest the save function waits for the current segment to
finalize before requesting a snapshot, then silently bails; but the correlation could be
coincidental at this sample size.

No error was logged in engine.log, export-lifecycle.log, or renderer console during
either attempt. The failure is silent.

## Key Correlation

The `[iss-014][encode-boundary] shm frame` diagnostic only fired for seq=1 per portal
session (frame_count=0 at seq=1). Despite this, rolling buffer segments were written
(evidenced by segment files existing). This means the per-frame diagnostic is
throttled to seq=1 — the helper IS encoding subsequent frames.

However, the snapshot IPC never surfaced a snapshot_id to the renderer, leaving
v2SnapshotId=null in both start and finally handlers of v2SaveReplay.

## ISS-012 Repro Rate (cumulative)

| Session | Runs | Outcome |
|---------|------|---------|
| 2026-05-22 VAL-CAP-006 retry-2 | 1 | ISS-012 reproduced (original discovery) |
| 2026-05-22 repro pass 1 | 1 | non-repro |
| 2026-05-23 repro campaign | 6 | non-repro (all) |
| 2026-05-23 classification (this) | 2 | Branch A — different failure (not ISS-012) |

ISS-012 repro rate: 1 confirmed occurrence out of 10+ attempts.
In this session specifically: 0/2, Branch A (different failure mode).

## New Issue Recommended

**Title:** v2 save silently fails: SAVING→RECORDING with no snapshot ID despite
valid rolling buffer segments (boundary 2 export orchestration)

**Severity:** high  
**Components:** export, helper, renderer  
**Impact:** User triggers a replay save, the UI transitions briefly to SAVING state,
then silently returns to RECORDING with no MP4 produced and no error displayed.
The helper has valid rolling buffer content but no snapshot_id is returned to the
renderer. The failure is entirely silent — no toast, no log entry visible to the user.
Distinct from ISS-012 (which requires a valid MP4 to exist).

**Distinguishing from ISS-012:**
- ISS-012: valid MP4 on disk, renderer stuck in EXPORTING
- NEW: no MP4, SAVING→RECORDING silent drop, no export ever queued

## ISS-012 Status

ISS-012 remains OPEN. The classification goal (identify which boundary breaks during
a stuck-EXPORTING failure) was NOT achievable in this pass because ISS-012 was not
reproduced. The original failure (VAL-CAP-006 retry-2) occurred under different
conditions (longer recording, different source type).

Prior repro campaign analysis (2026-05-23-iss-012-render-diagnostics) already
identified the classification buckets and instrumentation needed. The render
diagnostics (T-029) are present in the current build and verified.

## Recommendation

1. Create new issue for the silent SAVING→RECORDING drop (boundary 2 failure)
2. Keep ISS-012 open — requires dedicated repro pass under original conditions
   (longer buffer duration, portal session with different source type)
3. Do NOT add renderer instrumentation yet — the silent drop is a pre-renderer
   failure (snapshot IPC); renderer-side logging won't help classify it
4. For ISS-012 instrumentation: when it does repro, the T-029 diagnostics already
   present will classify it against the decision tree in classification-buckets.md
