# T-035 — ISS-012 Classification Pass

**Date:** 2026-05-23
**Ticket:** T-035 (complete). **Issues:** ISS-012 (open, unchanged), ISS-015 (new, open).

## Session Goal

Reproduce ONE stuck-EXPORTING failure (ISS-012) and classify which single boundary
breaks via log correlation. Max ~5 attempts. If not reproducible, stop and record
repro rate.

## Result: Non-Repro — Branch A (Different Failure)

ISS-012 was NOT reproduced. Both save attempts (2 total) hit a DIFFERENT failure mode:
**SAVING→RECORDING with no snapshot ID despite valid rolling buffer segments.**

This is now filed as ISS-015.

## What Happened

The app was already running with `VITE_COVE_V2_UI=1` (PID 1523242) when the session
started. T-034's XR24→NV12 conversion was active (`path=convert` confirmed in engine.log).

### Run-01 (17:53:05 local)

- Portal session `pw-session-0000-1523385-1779583964285` (opened 17:52:44)
- Rolling buffer: 1 segment (index=2), 12.9MB, 18.24s content
- Save triggered via button press
- UI: RECORDING → SAVING (~17s) → RECORDING
- v2SnapshotId=null and v2ExportId=null throughout (start and finally)
- No export.queued in export-lifecycle.log
- No errors in engine.log
- Branch A: no valid file, no export.failed → NOT ISS-012

### Run-02 (18:15:34 local)

- Portal session `pw-session-0000-1523385-1779585302277` (opened 18:15:02)
- Rolling buffer: 1 segment (index=2), 2.6MB, 5.01s content
- Save triggered via button press
- UI: RECORDING → SAVING (~5s) → RECORDING
- Same null IDs, same no-export result
- Branch A → NOT ISS-012

## Key Observations

1. **SAVING duration ≈ segment duration (hypothesis)** — ~17s SAVING with 18.24s segment;
   ~5s SAVING with 5.01s segment. Two-data-point correlation only — not proven. Hedged
   accordingly in verdict.md.

2. **Helper only logs seq=1 per portal session** — frame_count=0 at seq=1. But segments
   DO exist, so frames ARE being encoded. The `[iss-014][encode-boundary]` diagnostic is
   throttled to seq=1 (not a capture failure).

3. **Snapshot IPC completely silent** — no snapshot RPC visible in engine.log, no
   snapshot_id returned to renderer, no error emitted. Failure is boundary 2
   (export orchestration), specifically the snapshot creation / IPC response.

4. **T-029 diagnostics confirmed present** — 7 `[export lifecycle][render]` strings in
   renderer bundle. Ready for ISS-012 classification when it does repro.

## New Issue: ISS-015

Title: "v2 save silently fails: SAVING→RECORDING with no snapshot ID despite valid
rolling buffer segments"
- Severity: high
- Components: export, helper, renderer
- Boundary: 2 (export orchestration / snapshot IPC)
- Distinct from ISS-012: no valid MP4 exists here

## Why Only 2 Attempts

The session brief set a ceiling of ~5 attempts. Both attempts hit the same ISS-015
failure mode (snapshot IPC silent drop). A third attempt would have reproduced ISS-015
again — not ISS-012 — so stopping at 2 was correct. Further ISS-012 attempts require
matching the original VAL-CAP-006 conditions (longer recording, different session setup).

## ISS-012 Status

Open. Repro rate: 1 confirmed occurrence / 10+ attempts cumulative.
- Original: VAL-CAP-006 retry-2 (2026-05-22) — longer session, different source
- This pass: 0/2, different failure mode (ISS-015)
- T-029 diagnostics present and will classify on next genuine ISS-012 repro

## Evidence Root

`.story/handovers/evidence/2026-05-23-iss-012-classification/`
- `session-baseline.md` — log positions, build state
- `run-01/`: operator-note.md, render-snapshot.txt, export-lifecycle.log, engine-snapshot.log, rolling-buffer.txt
- `run-02/`: operator-note.md, render-snapshot.txt, rolling-buffer.txt
- `verdict.md` — full decision tree application

## Verification

- `git diff --stat`: shows only `.story/` files (ISS-012.json + new evidence dir + ISS-015.json + T-035.json)
- Forbidden surfaces (helper/ electron/ src/ validation/ packaging/ .github/ Cargo.* package.json): empty/clean

## Tickets Changed

- T-035: complete
- ISS-012: impact annotation added (T-035 classification result, repro rate 1/10+)
- ISS-015: created (new silent-save failure, boundary 2)

## Observations Out of Scope

- **`recordingLabel="Ready"` while `v2State=RECORDING`** — both runs showed the UI label
  staying "Ready" while the FSM was in RECORDING state. This is a separate UI label drift
  issue, not related to ISS-012 or ISS-015. Not filed; noted here for future triage.

## Codex Review Loop

Skipped. This was an evidence-only pass — zero source file changes, no diff to review.
The Codex review loop applies to implementation passes only.

## Next Steps

1. Investigate ISS-015 — snapshot IPC silent failure. Likely in main process or
   helper's snapshot handler. Check `electron/recorder.ts` snapshot RPC path
   (scoped investigation, not in this pass scope).
2. For ISS-012: next repro attempt should use longer recording duration (>60s)
   and match original VAL-CAP-006 conditions (portal session active, window source).
   T-029 diagnostics will classify it automatically.
