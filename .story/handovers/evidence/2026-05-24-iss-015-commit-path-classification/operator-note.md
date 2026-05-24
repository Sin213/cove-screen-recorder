# T-039 — ISS-015 Commit-Path Classification Operator Note

**Date:** 2026-05-24
**Session:** pw-session-0000-1665676-1779608771513
**Source:** monitor (Wayland portal, XR24 SHM fallback — DMA-BUF hard-failed as expected)
**Buffer setting:** 0.5 min (30s)
**Capture quality:** Quality – 1440p · 60fps · 20 Mbps

## Session Timeline

- 00:42:16 UTC: App launched (`VITE_COVE_V2_UI=1 npm run dev`), engine started fresh
- 00:46:11 UTC: Portal established, PW stream ready (XR24, 3840×2160 SHM)
- 00:46:15 UTC: **Attempt 1** — hotkey (4s into session)
- 00:46:31 UTC: onSegmentDiagnostics delivery confirmed (first fragment + keyframe edge logs)
- 00:46:51 UTC: duration became eligible (edge log)
- 00:47:09 UTC: first segment committed (edge log)
- 00:47:23 UTC: **Attempt 2** — button (72s into session) ← QUALIFYING REPRO
- 00:47:33 UTC: **Attempt 3** — button (82s into session)
- 00:51:57 UTC: **Attempt 4** — button (346s into session)

## Save Attempt Results

| # | Elapsed | frags | keyframes | committed | durElig | pendDur90k | lastKfAgeMs | Result |
|---|---------|-------|-----------|-----------|---------|------------|-------------|--------|
| 1 | 4s      | 3     | 1         | 0         | false   | 4500       | 657         | FAIL   |
| 2 | 72s     | 221   | 2         | 1         | false   | 151500     | 32493       | FAIL ← B4 |
| 3 | 82s     | 249   | 3         | 2         | false   | 13500      | 2679        | FAIL ← B4 |
| 4 | 346s    | 1060  | 9         | 8         | false   | 150000     | 32563       | FAIL ← B4 |

## Classification: B4

**B4: segments_committed > 0 but replay pin empty → eviction / pin-window mismatch**

First qualifying hit: Attempt 2 (committed=1 > 0, pin reports "no committed segments available to pin").

Per stop conditions: ONE qualifying branch hit → STOP.

## Key Pattern Observations (for next-slice investigation)

1. **durElig=false is PERSISTENT** — never becomes true across any attempt, even at committed=8 (346s in)

2. **pendDur90k ceiling ~150000 (1.67s @ 90kHz)** — the current in-progress segment never exceeds ~1.67s of PTS
   duration. This recurs at attempts 2 and 4. Attempt 3 shows 13500 (0.15s) just after a new keyframe.

3. **lastKfAgeMs=~32500ms recurring** — every ~32.5 seconds a new keyframe fires, resetting the pending segment.
   This is consistent with a very low encode rate (static screen content, frame dedup) producing ~1.67s PTS per
   32.5s of wall time (approximately 5% real-time encoding rate).

4. **Hypothesis for next slice:** The helper's pin predicate may require `duration_eligible=true` for the
   in-progress segment before it will pin any committed segments. If the current segment never reaches the
   minimum PTS duration threshold (possibly ~2s or ~30s declared-fps-equivalent), no pin is ever allowed,
   explaining why even 8 committed segments remain unpinnable.

5. **onSegmentDiagnostics delivery confirmed:** Events are being emitted ~1 Hz as expected. Edge logs fired
   correctly within the first diagnostic tick after session start (first fragment + keyframe both at 00:46:31,
   16 seconds into the save RPC await).

## Instrumentation Note

The T-039 save snapshot appeared in BOTH failure paths:
- Attempt 1 (catch branch): `_lastSegDiag` was set by onSegmentDiagnostics during the RPC await (16s await)
- Attempts 2–4 (catch branch): snapshots reflect live state at moment of RPC rejection

The single-tick edge logs (first fragment, first keyframe, duration eligible, first commit) fired at correct
times and only once per session, confirming the `_resetSegDiagEdges()` reset logic works correctly.

## Not in scope for T-039

- Investigating why durElig is persistently false
- Investigating why committed segments are unpinnable
- Any helper-side investigation
